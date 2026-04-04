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
};

type RealtimeResponseContext = {
  channel: string;
  messageId?: string | null;
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
    this.announcedFinalTasks.clear();
    this.responseContexts.clear();
    this.memoryTracker.reset();
    this.setStatus('idle', 'Realtime voice session is disconnected.');
  }

  observeExternalUserTranscript(transcript: string): void {
    this.memoryTracker.rememberExternalUserTranscript(transcript);
  }

  private async attachMicrophone(reason: string): Promise<void> {
    if (this.state === 'online_listening') {
      return;
    }
    if (!this.audioSender) {
      throw new Error('Realtime audio sender is not ready.');
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

    this.log('events', 'server', `server -> ${firstString(event.type, 'unknown')}`, event);
    this.memoryTracker.captureMemoryFromEvent(event);
    const responseContext = this.captureResponseContext(event);

    if (event.type === 'session.created' || event.type === 'session.updated') {
      this.captureSessionLifetime(event);
    }

    if (event.type === 'error') {
      const errorRecord = asRecord(event.error);
      const errorCode = typeof errorRecord?.code === 'string' ? errorRecord.code : '';
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
      const responseRecord = asRecord(event.response);
      const responseId = firstString(responseRecord?.id);
      const output = Array.isArray(responseRecord?.output) ? responseRecord.output : [];
      let executedToolCall = false;
      for (const item of output) {
        if (isToolCallItem(item)) {
          executedToolCall = true;
          await this.executeToolCall(item, responseContext);
        }
      }

      if (responseContext?.channel === 'chat') {
        const assistantText = output
          .flatMap((item) => {
            const record = asRecord(item);
            return record ? collectMessageTexts(record) : [];
          })
          .join('\n\n')
          .trim();

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
    }
  }

  private async executeToolCall(
    item: ToolCallItem,
    responseContext?: RealtimeResponseContext | null,
  ): Promise<void> {
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

    try {
      this.sendRealtimeEvent({
        type: 'conversation.item.create',
        item: {
          type: 'function_call_output',
          call_id: item.call_id,
          output: JSON.stringify(toolResult),
        },
      });
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
      this.callbacks.onAssistantControlRequest?.({
        action: 'deactivate',
        reason: normalizeMemoryText(firstString(toolResult.reason, toolResult.message, 'assistant-requested')) || 'assistant-requested',
      });
    }
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

  private announceSystemEvent(text: string, createResponse = true): void {
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
        this.sendRealtimeEvent({ type: 'response.create' });
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

    if (responseId && (channel || messageId)) {
      const context = {
        channel: channel || this.responseContexts.get(responseId)?.channel || '',
        messageId: messageId || this.responseContexts.get(responseId)?.messageId || null,
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
}
