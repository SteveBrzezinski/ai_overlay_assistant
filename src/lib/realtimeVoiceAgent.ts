import {
  createVoiceAgentSession,
  getRecentVoiceMemory,
  onVoiceAgentTask,
  runVoiceAgentTool,
  storeVoiceSessionMemory,
  type CreateVoiceAgentSessionResult,
  type RecentVoiceMemoryResult,
  type VoiceTask,
} from './voiceOverlay.js';
import { openRealtimeTransport } from './realtimeVoiceTransport.js';
import {
  SessionMemoryTracker,
  asRecord,
  collectMessageTexts,
  firstString,
  isToolCallItem,
  normalizeMemoryText,
  type ToolCallItem,
} from './realtimeVoiceAgentSupport.js';

const FALLBACK_SESSION_DURATION_MS = 60 * 60 * 1000;
const SESSION_ROTATION_BUFFER_MS = 2 * 60 * 1000;
const MIN_SESSION_ROTATION_DELAY_MS = 30 * 1000;

export type VoiceFeedSection = 'events' | 'tasks';
export type VoiceFeedKind = 'client' | 'server' | 'lifecycle' | 'task' | 'error';
export type VoiceConnectionState =
  | 'idle'
  | 'connecting'
  | 'online_muted'
  | 'online_listening'
  | 'disconnecting'
  | 'error';

export type VoiceFeedItem = {
  id: string;
  section: VoiceFeedSection;
  kind: VoiceFeedKind;
  title: string;
  body: string;
  timestampMs: number;
};

export type VoiceAgentStatus = {
  state: VoiceConnectionState;
  detail: string;
  session?: CreateVoiceAgentSessionResult | null;
};

export type RealtimeChatEvent =
  | {
      type: 'assistant-message';
      replyToMessageId?: string | null;
      text: string;
    }
  | {
      type: 'assistant-error';
      replyToMessageId?: string | null;
      detail: string;
    };

export type RealtimeVoiceAgentCallbacks = {
  onFeedItem: (item: VoiceFeedItem) => void;
  onStatus: (status: VoiceAgentStatus) => void;
  onAssistantControlRequest?: (request: { action: 'deactivate'; reason: string }) => void;
  onChatEvent?: (event: RealtimeChatEvent) => void;
  onRemoteAudioActivityChange?: (active: boolean) => void;
};

type RealtimeResponseContext = {
  channel: string;
  messageId?: string | null;
  resumeListeningAfterDone?: boolean;
};

export class RealtimeVoiceAgentController {
  private callbacks: RealtimeVoiceAgentCallbacks;
  private peerConnection: RTCPeerConnection | null = null;
  private dataChannel: RTCDataChannel | null = null;
  private audioSender: RTCRtpSender | null = null;
  private audioElement: HTMLAudioElement | null = null;
  private inputStream: MediaStream | null = null;
  private inputTrack: MediaStreamTrack | null = null;
  private session: CreateVoiceAgentSessionResult | null = null;
  private state: VoiceConnectionState = 'idle';
  private unlistenTaskEvents: (() => void | Promise<void>) | null = null;
  private announcedFinalTasks = new Set<string>();
  private recentMemory: RecentVoiceMemoryResult | null = null;
  private memoryTracker = new SessionMemoryTracker();
  private connectPromise: Promise<void> | null = null;
  private reconnectPromise: Promise<void> | null = null;
  private sessionRotationTimer: number | null = null;
  private sessionExpiresAtMs: number | null = null;
  private rotateAfterMute = false;
  private responseContexts = new Map<string, RealtimeResponseContext>();
  private remoteAudioOutputActive = false;
  private serverResponseActive = false;
  private serverAudioBufferActive = false;
  private audioOutputEnabled = true;
  private externalAudioOutputSuppressionActive = false;
  private resumeListeningAfterOutputSuppression = false;
  private audioElementCleanup: (() => void) | null = null;
  private pendingGracefulDeactivateReason: string | null = null;

  constructor(callbacks: RealtimeVoiceAgentCallbacks) {
    this.callbacks = callbacks;
  }

  async connect(): Promise<void> {
    if ((this.state === 'online_muted' || this.state === 'online_listening') && this.isTransportReady()) {
      return;
    }
    if (this.connectPromise) {
      await this.connectPromise;
      return;
    }

    this.connectPromise = (async () => {
      this.memoryTracker.reset();
      this.setStatus('connecting', 'Realtime voice session is starting...');
      this.log('events', 'lifecycle', 'session', 'Session start is being prepared');

      try {
        this.recentMemory = await this.loadRecentMemory();
        this.session = await createVoiceAgentSession();
        this.log('events', 'lifecycle', 'session bootstrap', this.session);

        const transport = await openRealtimeTransport({
          clientSecret: this.session.clientSecret,
          onRemoteTrack: (event, audioElement) => {
            audioElement.srcObject = event.streams[0];
          },
          onMessage: (payload) => {
            void this.handleRealtimeMessage(payload);
          },
          onConnectionStateChange: (state) => {
            this.log('events', 'lifecycle', 'peer connection', state);
            if (
              (state === 'failed' || state === 'closed') &&
              this.state !== 'disconnecting' &&
              this.state !== 'idle' &&
              !this.reconnectPromise
            ) {
              void this.recoverSession(`peer-${state}`);
            }
          },
          onDataChannelOpen: () => {},
          onDataChannelClose: () => {
            this.log('events', 'lifecycle', 'session', 'Realtime data channel closed');
            if (this.state !== 'disconnecting' && this.state !== 'idle' && !this.reconnectPromise) {
              void this.recoverSession('data-channel-closed');
            }
          },
        });

        this.peerConnection = transport.peerConnection;
        this.dataChannel = transport.dataChannel;
        this.audioSender = transport.audioSender;
        this.audioElement = transport.audioElement;
        this.bindAudioElement(transport.audioElement);
        this.setAudioOutputEnabled(true, 'connect');

        this.setStatus('online_muted', 'Realtime voice session connected. Microphone is muted.');
        this.log('events', 'lifecycle', 'session', 'Realtime data channel opened');
        this.scheduleSessionRotation();
        this.injectRecentMemoryContext();

        this.unlistenTaskEvents = await onVoiceAgentTask((event) => {
          this.handleVoiceTask(event.task);
        });
      } catch (error) {
        const detail = error instanceof Error ? error.message : String(error);
        this.log('events', 'error', 'session error', detail);
        await this.disconnect('connect-error');
        this.setStatus('error', detail);
        throw error;
      } finally {
        this.connectPromise = null;
      }
    })();

    await this.connectPromise;
  }

  async startListening(reason = 'activate'): Promise<void> {
    if (this.reconnectPromise) {
      await this.reconnectPromise;
      if (this.state === 'online_listening') {
        return;
      }
    }
    if (this.state === 'idle' || this.state === 'error' || this.state === 'connecting') {
      await this.connect();
    }
    if (!this.isTransportReady()) {
      this.log(
        'events',
        'lifecycle',
        'session',
        `Realtime transport was not ready before microphone activation. Recovering session (${reason}).`,
      );
      await this.recoverSession(`${reason}-recover`, true);
      return;
    }

    this.setAudioOutputEnabled(true, `${reason}-resume-output`);

    if (this.isMicrophoneInputSuppressed()) {
      this.resumeListeningAfterOutputSuppression = true;
      this.setStatus(
        'online_muted',
        'Realtime voice session connected. Microphone is temporarily muted while app audio is playing.',
      );
      return;
    }

    await this.attachMicrophone(reason);
  }

  async sendTextMessage(text: string, messageId: string): Promise<void> {
    const normalizedText = text.trim();
    if (!normalizedText) {
      throw new Error('Chat text was empty.');
    }
    if (this.reconnectPromise) {
      await this.reconnectPromise;
    }
    if (this.state === 'idle' || this.state === 'error' || this.state === 'connecting') {
      await this.connect();
    }
    if (!this.isTransportReady()) {
      this.log(
        'events',
        'lifecycle',
        'session',
        `Realtime transport was not ready before chat send. Recovering session (${messageId}).`,
      );
      await this.recoverSession(`chat-${messageId}`, false);
    }

    this.sendRealtimeEvent({
      type: 'conversation.item.create',
      item: {
        type: 'message',
        role: 'user',
        content: [{ type: 'input_text', text: normalizedText }],
      },
    });
    this.sendRealtimeEvent({
      type: 'response.create',
      response: {
        metadata: {
          channel: 'chat',
          messageId,
        },
        output_modalities: ['text'],
      },
    });
  }

  async mute(reason = 'deactivate'): Promise<void> {
    if (this.state === 'idle' || this.state === 'disconnecting' || this.state === 'error') {
      return;
    }

    this.log('events', 'lifecycle', 'microphone', `Muting microphone (${reason})`);
    await this.detachMicrophone();

    try {
      await this.persistSessionMemory(reason);
    } catch (error) {
      this.log('tasks', 'error', 'memory store failed', error instanceof Error ? error.message : String(error));
    }

    this.memoryTracker.reset();
    this.resumeListeningAfterOutputSuppression = false;
    this.setStatus('online_muted', `Realtime voice session connected. Microphone is muted (${reason}).`);

    if (this.rotateAfterMute) {
      this.rotateAfterMute = false;
      await this.recoverSession(`${reason}-scheduled-rotation`, false);
    }
  }

  async disconnect(reason = 'disconnect'): Promise<void> {
    if (this.state === 'disconnecting' || this.state === 'idle') {
      return;
    }

    this.state = 'disconnecting';
    this.log('events', 'lifecycle', 'session', `Closing realtime connection (${reason})`);
    this.clearSessionRotationTimer();
    this.rotateAfterMute = false;
    this.sessionExpiresAtMs = null;
    this.resumeListeningAfterOutputSuppression = false;
    this.pendingGracefulDeactivateReason = null;
    this.serverResponseActive = false;
    this.serverAudioBufferActive = false;
    this.audioOutputEnabled = true;

    if (this.unlistenTaskEvents) {
      await this.unlistenTaskEvents();
      this.unlistenTaskEvents = null;
    }

    await this.detachMicrophone();

    if (this.dataChannel) {
      this.dataChannel.close();
    }
    if (this.peerConnection) {
      this.peerConnection.close();
    }
    if (this.audioElement) {
      this.audioElement.srcObject = null;
    }
    this.cleanupAudioElement();

    try {
      await this.persistSessionMemory(reason);
    } catch (error) {
      this.log('tasks', 'error', 'memory store failed', error instanceof Error ? error.message : String(error));
    }

    this.peerConnection = null;
    this.dataChannel = null;
    this.audioSender = null;
    this.audioElement = null;
    this.session = null;
    this.recentMemory = null;
    this.remoteAudioOutputActive = false;
    this.serverResponseActive = false;
    this.serverAudioBufferActive = false;
    this.externalAudioOutputSuppressionActive = false;
    this.announcedFinalTasks.clear();
    this.responseContexts.clear();
    this.memoryTracker.reset();
    this.setStatus('idle', 'Realtime voice session is disconnected.');
  }

  observeExternalUserTranscript(transcript: string): void {
    this.memoryTracker.rememberExternalUserTranscript(transcript);
  }

  setExternalAudioOutputSuppression(active: boolean, reason = 'local-audio-output'): void {
    if (this.externalAudioOutputSuppressionActive === active) {
      return;
    }

    this.externalAudioOutputSuppressionActive = active;
    void this.syncAudioOutputSuppression(reason);
  }

  async interruptAssistantSpeech(
    reason = 'user-barge-in',
    options?: { muteOutputUntilResume?: boolean; resumeListeningAfter?: boolean },
  ): Promise<void> {
    if (!this.isTransportReady()) {
      return;
    }

    if (!this.serverResponseActive && !this.serverAudioBufferActive && !this.remoteAudioOutputActive) {
      return;
    }

    this.log('events', 'lifecycle', 'assistant interruption', `Interrupting assistant speech (${reason})`);
    this.resumeListeningAfterOutputSuppression = options?.resumeListeningAfter ?? true;
    this.pendingGracefulDeactivateReason = null;
    this.setAudioOutputEnabled(!(options?.muteOutputUntilResume ?? false), reason);

    if (this.serverResponseActive) {
      this.serverResponseActive = false;
      try {
        this.sendRealtimeEvent({ type: 'response.cancel' });
      } catch (error) {
        this.log(
          'events',
          'error',
          'assistant interruption cancel failed',
          error instanceof Error ? error.message : String(error),
        );
      }
    }

    if (this.serverAudioBufferActive || this.remoteAudioOutputActive) {
      this.serverAudioBufferActive = false;
      try {
        this.sendRealtimeEvent({ type: 'output_audio_buffer.clear' });
      } catch (error) {
        this.log(
          'events',
          'error',
          'assistant interruption clear failed',
          error instanceof Error ? error.message : String(error),
        );
      }
    }

    this.setRemoteAudioOutputActive(false);

    await this.syncAudioOutputSuppression(reason);
  }

  async announceExternalSystemEvent(
    text: string,
    options?: { temporaryMute?: boolean },
  ): Promise<void> {
    if (this.reconnectPromise) {
      await this.reconnectPromise;
    }
    if (this.state === 'idle' || this.state === 'error' || this.state === 'connecting') {
      await this.connect();
    }
    if (!this.isTransportReady()) {
      await this.recoverSession('system-event-recover', false);
    }

    let resumeListeningAfterDone = false;
    if (options?.temporaryMute && this.state === 'online_listening') {
      await this.detachMicrophone();
      this.setStatus('online_muted', 'Realtime voice session connected. Microphone is muted (system-notification).');
      resumeListeningAfterDone = true;
    }

    this.announceSystemEvent(text, true, {
      channel: 'system',
      messageId: `system-${Date.now()}-${Math.random().toString(16).slice(2)}`,
      resumeListeningAfterDone,
    });
  }

  private async attachMicrophone(reason: string): Promise<void> {
    if (this.state === 'online_listening') {
      return;
    }
    if (!this.audioSender) {
      throw new Error('Realtime audio sender is not ready.');
    }
    if (this.isMicrophoneInputSuppressed()) {
      this.resumeListeningAfterOutputSuppression = true;
      this.setStatus(
        'online_muted',
        'Realtime voice session connected. Microphone is temporarily muted while app audio is playing.',
      );
      return;
    }

    this.log('events', 'lifecycle', 'microphone', `Activating microphone (${reason})`);
    const inputStream = await navigator.mediaDevices.getUserMedia({
      audio: {
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true,
      },
    });
    const inputTrack = inputStream.getAudioTracks()[0];
    if (!inputTrack) {
      throw new Error('No microphone audio track is available.');
    }

    await this.audioSender.replaceTrack(inputTrack);
    this.inputStream = inputStream;
    this.inputTrack = inputTrack;
    this.setStatus('online_listening', `Realtime voice session connected. Microphone is live (${reason}).`);
  }

  private async handleRealtimeMessage(rawPayload: string): Promise<void> {
    let event: Record<string, unknown>;
    try {
      event = JSON.parse(rawPayload) as Record<string, unknown>;
    } catch (error) {
      this.log('events', 'error', 'invalid realtime payload', error instanceof Error ? error.message : String(error));
      return;
    }

    const errorRecord = event.type === 'error' ? asRecord(event.error) : null;
    const errorCode = typeof errorRecord?.code === 'string' ? errorRecord.code : '';
    if (errorCode === 'response_cancel_not_active') {
      this.serverResponseActive = false;
      return;
    }

    this.log('events', 'server', `server -> ${firstString(event.type, 'unknown')}`, event);
    this.memoryTracker.captureMemoryFromEvent(event);
    const responseContext = this.captureResponseContext(event);

    if (event.type === 'session.created' || event.type === 'session.updated') {
      this.captureSessionLifetime(event);
    }

    if (event.type === 'response.created') {
      this.serverResponseActive = true;
    }

    if (event.type === 'output_audio_buffer.started') {
      this.serverAudioBufferActive = true;
      if (this.audioOutputEnabled) {
        this.setRemoteAudioOutputActive(true);
        void this.resumeAudioElementPlayback('output-audio-buffer-started');
      }
    }

    if (event.type === 'output_audio_buffer.stopped') {
      this.serverAudioBufferActive = false;
      this.setRemoteAudioOutputActive(false);
      this.tryFinalizeGracefulDeactivate('output-audio-buffer-stopped');
    }

    if (event.type === 'error') {
      if (errorCode === 'response_cancel_not_active') {
        this.serverResponseActive = false;
        return;
      }
      if (responseContext?.channel === 'chat') {
        this.callbacks.onChatEvent?.({
          type: 'assistant-error',
          replyToMessageId: responseContext.messageId ?? null,
          detail: firstString(errorRecord?.message, errorRecord?.type, 'Chat response failed.'),
        });
      }
      if (errorCode === 'session_expired') {
        await this.recoverSession('session-expired');
        return;
      }
    }

    if (event.type === 'response.done') {
      this.serverResponseActive = false;
      const responseRecord = asRecord(event.response);
      const responseId = firstString(responseRecord?.id);
      const output = Array.isArray(responseRecord?.output) ? responseRecord.output : [];
      const assistantText = output
        .flatMap((item) => {
          const record = asRecord(item);
          return record ? collectMessageTexts(record) : [];
        })
        .join('\n\n')
        .trim();
      let executedToolCall = false;
      let gracefulDeactivateReason: string | null = null;
      for (const item of output) {
        if (isToolCallItem(item)) {
          executedToolCall = true;
          const toolOutcome = await this.executeToolCall(item, responseContext);
          if (toolOutcome.gracefulDeactivateReason) {
            gracefulDeactivateReason = toolOutcome.gracefulDeactivateReason;
          }
        }
      }

      if (responseContext?.channel === 'chat') {
        if (assistantText) {
          this.callbacks.onChatEvent?.({
            type: 'assistant-message',
            replyToMessageId: responseContext.messageId ?? null,
            text: assistantText,
          });
        } else if (!executedToolCall) {
          this.callbacks.onChatEvent?.({
            type: 'assistant-error',
            replyToMessageId: responseContext.messageId ?? null,
            detail: 'The assistant did not return a text response.',
          });
        }
      }

      if (responseId) {
        this.responseContexts.delete(responseId);
      }

      if (gracefulDeactivateReason) {
        this.requestGracefulDeactivate(gracefulDeactivateReason);
      } else if (!executedToolCall && looksLikeAssistantFarewell(assistantText)) {
        this.requestGracefulDeactivate('assistant-farewell-fallback');
      }

      if (
        responseContext?.channel === 'system' &&
        responseContext.resumeListeningAfterDone &&
        this.state === 'online_muted'
      ) {
        try {
          if (this.isMicrophoneInputSuppressed()) {
            this.resumeListeningAfterOutputSuppression = true;
          } else {
            await this.attachMicrophone('system-notification-resume');
          }
        } catch (error) {
          this.log(
            'events',
            'error',
            'system notification resume failed',
            error instanceof Error ? error.message : String(error),
          );
        }
      }

      this.tryFinalizeGracefulDeactivate('response-done');
    }
  }

  private async executeToolCall(
    item: ToolCallItem,
    responseContext?: RealtimeResponseContext | null,
  ): Promise<{ gracefulDeactivateReason?: string }> {
    let parsedArguments: Record<string, unknown> = {};
    try {
      parsedArguments = item.arguments ? (JSON.parse(item.arguments) as Record<string, unknown>) : {};
    } catch {
      parsedArguments = {};
    }

    this.log('tasks', 'task', `tool requested: ${item.name}`, parsedArguments);
    this.memoryTracker.rememberToolEvent(
      this.memoryTracker.describeToolRequest(item.name, parsedArguments),
    );

    let toolResult: Record<string, unknown>;
    try {
      const response = await runVoiceAgentTool(item.name, parsedArguments);
      toolResult = response.result;
      this.log('tasks', 'task', `tool result: ${item.name}`, response.result);
      this.memoryTracker.rememberToolEvent(
        this.memoryTracker.describeToolResult(item.name, response.result),
      );

      if (item.name === 'update_assistant_state') {
        const sessionUpdate = response.result?.sessionUpdate as
          | { instructions?: string; voice?: string }
          | undefined;
        if (sessionUpdate?.instructions && sessionUpdate.voice) {
          this.sendRealtimeEvent({
            type: 'session.update',
            session: {
              instructions: sessionUpdate.instructions,
              audio: { output: { voice: sessionUpdate.voice } },
            },
          });
        }
      }
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      toolResult = { ok: false, toolName: item.name, message: detail };
      this.log('tasks', 'error', `tool failed: ${item.name}`, detail);
      this.memoryTracker.rememberToolEvent(`Tool ${item.name} failed: ${detail}`);
    }

    let gracefulDeactivateReason: string | undefined;

    try {
      this.sendRealtimeEvent({
        type: 'conversation.item.create',
        item: {
          type: 'function_call_output',
          call_id: item.call_id,
          output: JSON.stringify(toolResult),
        },
      });
      if (item.name !== 'deactivate_voice_assistant') {
        this.sendRealtimeEvent(
          responseContext?.channel === 'chat'
            ? {
                type: 'response.create',
                response: {
                  metadata: {
                    channel: 'chat',
                    messageId: responseContext.messageId ?? null,
                  },
                  output_modalities: ['text'],
                },
              }
            : { type: 'response.create' },
        );
      }
    } catch (error) {
      this.log('events', 'error', 'tool response dispatch failed', error instanceof Error ? error.message : String(error));
      if (responseContext?.channel === 'chat') {
        this.callbacks.onChatEvent?.({
          type: 'assistant-error',
          replyToMessageId: responseContext.messageId ?? null,
          detail: error instanceof Error ? error.message : String(error),
        });
      }
    }

    if (item.name === 'deactivate_voice_assistant') {
      gracefulDeactivateReason =
        normalizeMemoryText(firstString(toolResult.reason, toolResult.message, 'assistant-requested')) ||
        'assistant-requested';
    }

    return gracefulDeactivateReason ? { gracefulDeactivateReason } : {};
  }

  private handleVoiceTask(task: VoiceTask): void {
    this.log('tasks', 'task', `background task ${task.status}`, task);
    this.memoryTracker.rememberTaskEvent(this.memoryTracker.describeTask(task));

    if (this.announcedFinalTasks.has(task.id)) {
      return;
    }

    if (task.status === 'completed') {
      this.announcedFinalTasks.add(task.id);
      this.announceSystemEvent(
        `Background task ${task.id} completed. ${firstString(asRecord(task.result)?.message)}`,
      );
      return;
    }

    if (task.status === 'needs_clarification') {
      this.announcedFinalTasks.add(task.id);
      const result = task.result as Record<string, unknown> | undefined;
      this.announceSystemEvent(
        `Background task ${task.id} needs clarification. ${firstString(result?.question, result?.message)}`,
      );
      return;
    }

    if (task.status === 'failed') {
      this.announcedFinalTasks.add(task.id);
      const result = task.result as Record<string, unknown> | undefined;
      this.announceSystemEvent(
        `Background task ${task.id} failed. ${firstString(result?.message, 'No further details.')}`,
      );
    }
  }

  private announceSystemEvent(
    text: string,
    createResponse = true,
    metadata?: { channel?: string; messageId?: string; resumeListeningAfterDone?: boolean },
  ): void {
    try {
      this.sendRealtimeEvent({
        type: 'conversation.item.create',
        item: {
          type: 'message',
          role: 'user',
          content: [{ type: 'input_text', text: `SYSTEM_EVENT: ${text}` }],
        },
      });
      if (createResponse) {
        this.sendRealtimeEvent({
          type: 'response.create',
          response: metadata
            ? {
                metadata: {
                  channel: metadata.channel ?? '',
                  messageId: metadata.messageId ?? null,
                  resumeListeningAfterDone: metadata.resumeListeningAfterDone ?? false,
                },
              }
            : undefined,
        });
      }
    } catch (error) {
      this.log('events', 'error', 'system event dispatch failed', error instanceof Error ? error.message : String(error));
    }
  }

  private sendRealtimeEvent(event: Record<string, unknown>): void {
    if (!this.dataChannel || this.dataChannel.readyState !== 'open') {
      throw new Error('Realtime data channel is not open');
    }

    this.dataChannel.send(JSON.stringify(event));
    this.log('events', 'client', `client -> ${firstString(event.type, 'event')}`, event);
  }

  private setStatus(state: VoiceConnectionState, detail: string): void {
    this.state = state;
    this.callbacks.onStatus({ state, detail, session: this.session });
  }

  private isTransportReady(): boolean {
    return Boolean(
      this.dataChannel &&
        this.dataChannel.readyState === 'open' &&
        this.peerConnection &&
        this.peerConnection.connectionState !== 'failed' &&
        this.peerConnection.connectionState !== 'closed',
    );
  }

  private log(section: VoiceFeedSection, kind: VoiceFeedKind, title: string, body: unknown): void {
    this.callbacks.onFeedItem({
      id: `${Date.now()}-${Math.random().toString(16).slice(2)}`,
      section,
      kind,
      title,
      body: typeof body === 'string' ? body : JSON.stringify(body, null, 2),
      timestampMs: Date.now(),
    });
  }

  private async loadRecentMemory(): Promise<RecentVoiceMemoryResult | null> {
    try {
      const result = await getRecentVoiceMemory(5);
      if (result.lines.length) {
        this.log('tasks', 'task', 'memory preload', result);
      }
      return result;
    } catch (error) {
      this.log('tasks', 'error', 'memory preload failed', error instanceof Error ? error.message : String(error));
      return null;
    }
  }

  private captureSessionLifetime(event: Record<string, unknown>): void {
    const sessionRecord = asRecord(event.session);
    const expiresAtSeconds =
      typeof sessionRecord?.expires_at === 'number' ? sessionRecord.expires_at : null;
    if (!expiresAtSeconds) {
      return;
    }

    this.sessionExpiresAtMs = expiresAtSeconds * 1000;
    this.scheduleSessionRotation(this.sessionExpiresAtMs);
  }

  private scheduleSessionRotation(expiresAtMs?: number | null): void {
    this.clearSessionRotationTimer();

    const now = Date.now();
    const effectiveExpiry = expiresAtMs ?? now + FALLBACK_SESSION_DURATION_MS;
    const desiredRotateAt = Math.max(
      now + MIN_SESSION_ROTATION_DELAY_MS,
      effectiveExpiry - SESSION_ROTATION_BUFFER_MS,
    );
    const delayMs = desiredRotateAt - now;

    this.log('events', 'lifecycle', 'session', {
      message: 'Scheduled proactive realtime session rotation.',
      rotateAt: new Date(desiredRotateAt).toISOString(),
      expiresAt: new Date(effectiveExpiry).toISOString(),
      delayMs,
    });

    this.sessionRotationTimer = window.setTimeout(() => {
      if (this.state === 'idle' || this.state === 'disconnecting' || this.state === 'error') {
        return;
      }

      if (this.state === 'online_listening') {
        this.rotateAfterMute = true;
        this.log('events', 'lifecycle', 'session', 'Scheduled session rotation is waiting for the microphone to mute.');
        return;
      }

      void this.recoverSession('scheduled-rotation', false);
    }, delayMs);
  }

  private clearSessionRotationTimer(): void {
    if (this.sessionRotationTimer !== null) {
      window.clearTimeout(this.sessionRotationTimer);
      this.sessionRotationTimer = null;
    }
  }

  private captureResponseContext(event: Record<string, unknown>): RealtimeResponseContext | null {
    const responseRecord = asRecord(event.response);
    const responseId = firstString(responseRecord?.id, event.response_id);
    const responseMetadata = asRecord(responseRecord?.metadata);
    const channel = firstString(responseMetadata?.channel);
    const messageId = firstString(responseMetadata?.messageId);
    const resumeListeningAfterDone =
      typeof responseMetadata?.resumeListeningAfterDone === 'boolean'
        ? responseMetadata.resumeListeningAfterDone
        : responseMetadata?.resumeListeningAfterDone === 'true';

    if (responseId && (channel || messageId || resumeListeningAfterDone)) {
      const context = {
        channel: channel || this.responseContexts.get(responseId)?.channel || '',
        messageId: messageId || this.responseContexts.get(responseId)?.messageId || null,
        resumeListeningAfterDone:
          resumeListeningAfterDone ||
          this.responseContexts.get(responseId)?.resumeListeningAfterDone ||
          false,
      };
      this.responseContexts.set(responseId, context);
      return context;
    }

    if (responseId && this.responseContexts.has(responseId)) {
      return this.responseContexts.get(responseId) ?? null;
    }

    return null;
  }

  private async recoverSession(
    reason: string,
    resumeListening = this.state === 'online_listening',
  ): Promise<void> {
    if (this.reconnectPromise) {
      await this.reconnectPromise;
      return;
    }

    this.reconnectPromise = (async () => {
      this.log('events', 'lifecycle', 'session', `Recovering realtime session (${reason})`);
      await this.disconnect(reason);
      await this.connect();
      if (resumeListening) {
        await this.attachMicrophone(reason);
      }
    })();

    try {
      await this.reconnectPromise;
    } finally {
      this.reconnectPromise = null;
    }
  }

  private injectRecentMemoryContext(): void {
    if (!this.recentMemory?.lines.length) {
      return;
    }

    const summary = this.recentMemory.lines.map((line, index) => `${index + 1}. ${line}`).join(' ');
    this.log('tasks', 'task', 'memory resume', {
      date: this.recentMemory.date,
      filePath: this.recentMemory.filePath,
      lines: this.recentMemory.lines,
    });
    this.announceSystemEvent(
      `Silent context from daily memory ${this.recentMemory.date}. Use these points only as background context for continuity after a restart and do not read them aloud: ${summary}`,
      false,
    );
  }

  private async persistSessionMemory(reason: string): Promise<void> {
    const payload = this.memoryTracker.buildPersistPayload(reason);
    if (!payload) {
      return;
    }

    const result = await storeVoiceSessionMemory(payload);
    this.log('tasks', 'task', 'memory stored', result);
  }

  private async detachMicrophone(): Promise<void> {
    if (this.audioSender) {
      await this.audioSender.replaceTrack(null);
    }
    if (this.inputTrack) {
      this.inputTrack.stop();
      this.inputTrack = null;
    }
    if (this.inputStream) {
      for (const track of this.inputStream.getTracks()) {
        track.stop();
      }
      this.inputStream = null;
    }
  }

  private bindAudioElement(audioElement: HTMLAudioElement): void {
    this.cleanupAudioElement();

    const updatePlaybackState = (active: boolean): void => {
      if (!this.audioOutputEnabled && active) {
        return;
      }

      this.setRemoteAudioOutputActive(active);
    };

    const handlePlay = (): void => updatePlaybackState(true);
    const handleStop = (): void => updatePlaybackState(false);

    audioElement.addEventListener('play', handlePlay);
    audioElement.addEventListener('playing', handlePlay);
    audioElement.addEventListener('pause', handleStop);
    audioElement.addEventListener('ended', handleStop);
    audioElement.addEventListener('emptied', handleStop);

    this.audioElementCleanup = () => {
      audioElement.removeEventListener('play', handlePlay);
      audioElement.removeEventListener('playing', handlePlay);
      audioElement.removeEventListener('pause', handleStop);
      audioElement.removeEventListener('ended', handleStop);
      audioElement.removeEventListener('emptied', handleStop);
      updatePlaybackState(false);
    };
  }

  private cleanupAudioElement(): void {
    this.audioElementCleanup?.();
    this.audioElementCleanup = null;
  }

  private setRemoteAudioOutputActive(active: boolean): void {
    if (this.remoteAudioOutputActive === active) {
      return;
    }

    this.remoteAudioOutputActive = active;
    this.callbacks.onRemoteAudioActivityChange?.(active);
    void this.syncAudioOutputSuppression(active ? 'assistant-audio' : 'assistant-audio-ended');
    if (!active) {
      this.tryFinalizeGracefulDeactivate('audio-element-stopped');
    }
  }

  private setAudioOutputEnabled(enabled: boolean, reason: string): void {
    this.audioOutputEnabled = enabled;

    if (this.audioElement) {
      this.audioElement.muted = !enabled;
    }

    if (!enabled) {
      this.setRemoteAudioOutputActive(false);
      return;
    }

    void this.resumeAudioElementPlayback(reason);
  }

  private async resumeAudioElementPlayback(reason: string): Promise<void> {
    if (!this.audioElement || !this.audioOutputEnabled) {
      return;
    }

    if (!this.audioElement.srcObject) {
      return;
    }

    this.audioElement.muted = false;
    if (!this.audioElement.paused) {
      return;
    }

    try {
      await this.audioElement.play();
    } catch (error) {
      this.log(
        'events',
        'lifecycle',
        'assistant audio resume',
        `Audio output stayed paused during ${reason}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  private requestGracefulDeactivate(reason: string): void {
    this.pendingGracefulDeactivateReason =
      normalizeMemoryText(reason) || 'assistant-requested';
    this.log('events', 'lifecycle', 'assistant graceful deactivate', `Queued graceful deactivate (${this.pendingGracefulDeactivateReason})`);
    this.tryFinalizeGracefulDeactivate('graceful-deactivate-requested');
  }

  private tryFinalizeGracefulDeactivate(trigger: string): void {
    if (!this.pendingGracefulDeactivateReason) {
      return;
    }

    if (this.serverAudioBufferActive) {
      return;
    }

    if (this.remoteAudioOutputActive && trigger !== 'output-audio-buffer-stopped') {
      return;
    }

    const reason = this.pendingGracefulDeactivateReason;
    this.pendingGracefulDeactivateReason = null;
    this.log('events', 'lifecycle', 'assistant graceful deactivate', `Finalizing graceful deactivate (${trigger})`);
    this.callbacks.onAssistantControlRequest?.({
      action: 'deactivate',
      reason,
    });
  }

  private isMicrophoneInputSuppressed(): boolean {
    return this.externalAudioOutputSuppressionActive;
  }

  private async syncAudioOutputSuppression(reason: string): Promise<void> {
    if (this.isMicrophoneInputSuppressed()) {
      if (this.state === 'online_listening') {
        this.resumeListeningAfterOutputSuppression = true;
        await this.detachMicrophone();
        this.setStatus(
          'online_muted',
          `Realtime voice session connected. Microphone is temporarily muted while app audio is playing (${reason}).`,
        );
      }
      return;
    }

    if (
      this.resumeListeningAfterOutputSuppression &&
      this.state === 'online_muted' &&
      this.isTransportReady()
    ) {
      this.resumeListeningAfterOutputSuppression = false;
      await this.attachMicrophone(`${reason}-resume`);
    }
  }
}

function looksLikeAssistantFarewell(text: string): boolean {
  const normalized = normalizeConversationText(text);
  if (!normalized || normalized.length > 180) {
    return false;
  }

  return [
    'tschuss',
    'tschuess',
    'auf wiedersehen',
    'bis dann',
    'bis bald',
    'bis spater',
    'machs gut',
    'bye',
    'goodbye',
    'see you',
    'see you later',
    'talk to you later',
    'good night',
    'have a good one',
  ].some(
    (phrase) =>
      normalized === phrase ||
      normalized.endsWith(` ${phrase}`) ||
      normalized.includes(`${phrase} `),
  );
}

function normalizeConversationText(value: string): string {
  return value
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}
