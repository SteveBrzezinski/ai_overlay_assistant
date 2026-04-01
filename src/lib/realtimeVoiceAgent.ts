import {
  createVoiceAgentSession,
  getRecentVoiceMemory,
  onVoiceAgentTask,
  runVoiceAgentTool,
  storeVoiceSessionMemory,
  type CreateVoiceAgentSessionResult,
  type RecentVoiceMemoryResult,
  type VoiceTask,
} from './voiceOverlay';

const MAX_MEMORY_ITEMS = 32;
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

export type RealtimeVoiceAgentCallbacks = {
  onFeedItem: (item: VoiceFeedItem) => void;
  onStatus: (status: VoiceAgentStatus) => void;
  onAssistantControlRequest?: (request: { action: 'deactivate'; reason: string }) => void;
};

type ToolCallItem = {
  name: string;
  arguments?: string;
  call_id: string;
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
  private userTranscripts: string[] = [];
  private assistantTranscripts: string[] = [];
  private toolEvents: string[] = [];
  private taskEvents: string[] = [];
  private connectPromise: Promise<void> | null = null;
  private reconnectPromise: Promise<void> | null = null;
  private sessionRotationTimer: number | null = null;
  private sessionExpiresAtMs: number | null = null;
  private rotateAfterMute = false;

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
      this.resetSessionMemory();
      this.setStatus('connecting', 'Realtime voice session is starting...');
      this.log('events', 'lifecycle', 'session', 'Session start is being prepared');

      try {
        this.recentMemory = await this.loadRecentMemory();
        this.session = await createVoiceAgentSession();
        this.log('events', 'lifecycle', 'session bootstrap', this.session);

        const peerConnection = new RTCPeerConnection();
        const audioElement = new Audio();
        audioElement.autoplay = true;
        peerConnection.ontrack = (event) => {
          audioElement.srcObject = event.streams[0];
        };
        peerConnection.onconnectionstatechange = () => {
          this.log('events', 'lifecycle', 'peer connection', peerConnection.connectionState);
          if (
            (peerConnection.connectionState === 'failed' || peerConnection.connectionState === 'closed') &&
            this.state !== 'disconnecting' &&
            this.state !== 'idle' &&
            !this.reconnectPromise
          ) {
            void this.recoverSession(`peer-${peerConnection.connectionState}`);
          }
        };

        const audioTransceiver = peerConnection.addTransceiver('audio', { direction: 'sendrecv' });
        const dataChannel = peerConnection.createDataChannel('oai-events');
        dataChannel.addEventListener('message', (event) => {
          const rawPayload = typeof event.data === 'string' ? event.data : String(event.data);
          void this.handleRealtimeMessage(rawPayload);
        });
        dataChannel.addEventListener('open', () => {
          this.setStatus('online_muted', 'Realtime voice session connected. Microphone is muted.');
          this.log('events', 'lifecycle', 'session', 'Realtime data channel opened');
          this.scheduleSessionRotation();
          void this.injectRecentMemoryContext();
        });
        dataChannel.addEventListener('close', () => {
          this.log('events', 'lifecycle', 'session', 'Realtime data channel closed');
          if (this.state !== 'disconnecting' && this.state !== 'idle' && !this.reconnectPromise) {
            void this.recoverSession('data-channel-closed');
          }
        });

        this.peerConnection = peerConnection;
        this.dataChannel = dataChannel;
        this.audioSender = audioTransceiver.sender;
        this.audioElement = audioElement;

        const unlistenTasks = await onVoiceAgentTask((event) => {
          this.handleVoiceTask(event.task);
        });
        this.unlistenTaskEvents = unlistenTasks;

        const offer = await peerConnection.createOffer();
        await peerConnection.setLocalDescription(offer);

        const sdpResponse = await fetch('https://api.openai.com/v1/realtime/calls', {
          method: 'POST',
          body: offer.sdp,
          headers: {
            Authorization: `Bearer ${this.session.clientSecret}`,
            'Content-Type': 'application/sdp',
          },
        });

        if (!sdpResponse.ok) {
          const errorText = await sdpResponse.text();
          throw new Error(errorText || 'Failed to connect to OpenAI Realtime');
        }

        await peerConnection.setRemoteDescription({
          type: 'answer',
          sdp: await sdpResponse.text(),
        });

        await this.waitForDataChannelOpen();
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
      this.log('events', 'lifecycle', 'session', `Realtime transport was not ready before microphone activation. Recovering session (${reason}).`);
      await this.recoverSession(`${reason}-recover`, true);
      return;
    }
    await this.attachMicrophone(reason);
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

  async mute(reason = 'deactivate'): Promise<void> {
    if (
      this.state === 'idle' ||
      this.state === 'disconnecting' ||
      this.state === 'error'
    ) {
      return;
    }

    this.log('events', 'lifecycle', 'microphone', `Muting microphone (${reason})`);
    await this.detachMicrophone();

    try {
      await this.persistSessionMemory(reason);
    } catch (error) {
      this.log('tasks', 'error', 'memory store failed', error instanceof Error ? error.message : String(error));
    }
    this.resetSessionMemory();
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
    this.resetSessionMemory();
    this.setStatus('idle', 'Realtime voice session is disconnected.');
  }

  observeExternalUserTranscript(transcript: string): void {
    this.rememberUserTranscript(transcript);
  }

  private async handleRealtimeMessage(rawPayload: string): Promise<void> {
    let event: Record<string, unknown>;
    try {
      event = JSON.parse(rawPayload) as Record<string, unknown>;
    } catch (error) {
      this.log('events', 'error', 'invalid realtime payload', error instanceof Error ? error.message : String(error));
      return;
    }

    this.log('events', 'server', `server -> ${String(event.type ?? 'unknown')}`, event);
    this.captureMemoryFromEvent(event);

    if (event.type === 'session.created' || event.type === 'session.updated') {
      this.captureSessionLifetime(event);
    }

    if (event.type === 'error') {
      const errorRecord = asRecord(event.error);
      const errorCode = typeof errorRecord?.code === 'string' ? errorRecord.code : '';
      if (errorCode === 'session_expired') {
        await this.recoverSession('session-expired');
        return;
      }
    }

    if (event.type === 'response.done') {
      const responseRecord = asRecord(event.response);
      const output = Array.isArray(responseRecord?.output) ? responseRecord.output : [];
      for (const item of output) {
        if (isToolCallItem(item)) {
          await this.executeToolCall(item);
        }
      }
    }
  }

  private async executeToolCall(item: ToolCallItem): Promise<void> {
    let parsedArguments: Record<string, unknown> = {};
    try {
      parsedArguments = item.arguments ? (JSON.parse(item.arguments) as Record<string, unknown>) : {};
    } catch {
      parsedArguments = {};
    }

    this.log('tasks', 'task', `tool requested: ${item.name}`, parsedArguments);
    this.rememberToolEvent(this.describeToolRequest(item.name, parsedArguments));

    let toolResult: Record<string, unknown>;
    try {
      const response = await runVoiceAgentTool(item.name, parsedArguments);
      toolResult = response.result;
      this.log('tasks', 'task', `tool result: ${item.name}`, response.result);
      this.rememberToolEvent(this.describeToolResult(item.name, response.result));

      if (item.name === 'update_assistant_state') {
        const sessionUpdate = response.result?.sessionUpdate as
          | { instructions?: string; voice?: string }
          | undefined;
        if (sessionUpdate?.instructions && sessionUpdate.voice) {
          this.sendRealtimeEvent({
            type: 'session.update',
            session: {
              instructions: sessionUpdate.instructions,
              audio: {
                output: {
                  voice: sessionUpdate.voice,
                },
              },
            },
          });
        }
      }
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      toolResult = {
        ok: false,
        toolName: item.name,
        message: detail,
      };
      this.log('tasks', 'error', `tool failed: ${item.name}`, detail);
      this.rememberToolEvent(`Tool ${item.name} failed: ${detail}`);
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
      this.sendRealtimeEvent({ type: 'response.create' });
    } catch (error) {
      this.log('events', 'error', 'tool response dispatch failed', error instanceof Error ? error.message : String(error));
    }

    if (item.name === 'deactivate_voice_assistant') {
      this.callbacks.onAssistantControlRequest?.({
        action: 'deactivate',
        reason: normalizeMemoryText(String(toolResult.reason ?? toolResult.message ?? 'assistant-requested')) || 'assistant-requested',
      });
    }
  }

  private handleVoiceTask(task: VoiceTask): void {
    this.log('tasks', 'task', `background task ${task.status}`, task);
    this.rememberTaskEvent(this.describeTask(task));

    if (this.announcedFinalTasks.has(task.id)) {
      return;
    }

    if (task.status === 'completed') {
      this.announcedFinalTasks.add(task.id);
      this.announceSystemEvent(
        `Background task ${task.id} completed. ${String((task.result as Record<string, unknown> | undefined)?.message ?? '')}`,
      );
      return;
    }

    if (task.status === 'needs_clarification') {
      this.announcedFinalTasks.add(task.id);
      const result = task.result as Record<string, unknown> | undefined;
      this.announceSystemEvent(
        `Background task ${task.id} needs clarification. ${String(result?.question ?? result?.message ?? '')}`,
      );
      return;
    }

    if (task.status === 'failed') {
      this.announcedFinalTasks.add(task.id);
      const result = task.result as Record<string, unknown> | undefined;
      this.announceSystemEvent(
        `Background task ${task.id} failed. ${String(result?.message ?? 'No further details.')}`,
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
          content: [
            {
              type: 'input_text',
              text: `SYSTEM_EVENT: ${text}`,
            },
          ],
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
    this.log('events', 'client', `client -> ${String(event.type ?? 'event')}`, event);
  }

  private setStatus(state: VoiceConnectionState, detail: string): void {
    this.state = state;
    this.callbacks.onStatus({
      state,
      detail,
      session: this.session,
    });
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
      typeof sessionRecord?.expires_at === 'number'
        ? sessionRecord.expires_at
        : null;
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

  private async recoverSession(reason: string, resumeListening = this.state === 'online_listening'): Promise<void> {
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

  private async waitForDataChannelOpen(timeoutMs = 20000): Promise<void> {
    if (this.dataChannel?.readyState === 'open') {
      return;
    }
    const dataChannel = this.dataChannel;
    const peerConnection = this.peerConnection;
    if (!dataChannel || !peerConnection) {
      throw new Error('Realtime transport is not ready.');
    }

    await new Promise<void>((resolve, reject) => {
      let settled = false;
      const timer = window.setTimeout(() => {
        cleanup();
        reject(new Error('Timed out while waiting for the Realtime data channel.'));
      }, timeoutMs);

      const cleanup = (): void => {
        if (settled) {
          return;
        }
        settled = true;
        window.clearTimeout(timer);
        dataChannel.removeEventListener('open', handleOpen);
        dataChannel.removeEventListener('close', handleClose);
        dataChannel.removeEventListener('error', handleError);
        peerConnection.removeEventListener('connectionstatechange', handleConnectionStateChange);
      };

      const handleOpen = (): void => {
        cleanup();
        resolve();
      };

      const handleClose = (): void => {
        cleanup();
        reject(new Error('Realtime data channel closed before it was ready.'));
      };

      const handleError = (): void => {
        cleanup();
        reject(new Error('Realtime data channel reported an error.'));
      };

      const handleConnectionStateChange = (): void => {
        if (peerConnection.connectionState === 'failed' || peerConnection.connectionState === 'closed') {
          cleanup();
          reject(new Error(`Realtime peer connection ${peerConnection.connectionState}.`));
        }
      };

      dataChannel.addEventListener('open', handleOpen);
      dataChannel.addEventListener('close', handleClose);
      dataChannel.addEventListener('error', handleError);
      peerConnection.addEventListener('connectionstatechange', handleConnectionStateChange);

      if (dataChannel.readyState === 'open') {
        handleOpen();
      } else {
        handleConnectionStateChange();
      }
    });
  }

  private resetSessionMemory(): void {
    this.userTranscripts = [];
    this.assistantTranscripts = [];
    this.toolEvents = [];
    this.taskEvents = [];
  }

  private async injectRecentMemoryContext(): Promise<void> {
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
    const hasMaterial =
      this.userTranscripts.length ||
      this.assistantTranscripts.length ||
      this.toolEvents.length ||
      this.taskEvents.length;
    if (!hasMaterial) {
      return;
    }

    const result = await storeVoiceSessionMemory({
      disconnectReason: reason,
      userTranscripts: this.userTranscripts,
      assistantTranscripts: this.assistantTranscripts,
      toolEvents: this.toolEvents,
      taskEvents: this.taskEvents,
    });
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

  private captureMemoryFromEvent(event: Record<string, unknown>): void {
    const eventType = typeof event.type === 'string' ? event.type : '';

    if (eventType === 'conversation.item.input_audio_transcription.completed') {
      this.rememberUserTranscript(
        firstString(event.transcript, asRecord(event.item)?.transcript, asRecord(event.item)?.text),
      );
      return;
    }

    if (eventType === 'response.audio_transcript.done' || eventType === 'response.audio_transcript.delta') {
      this.rememberAssistantTranscript(firstString(event.transcript, event.delta, event.text));
      return;
    }

    if (eventType === 'conversation.item.created' || eventType === 'response.output_item.done') {
      this.captureTextsFromItem(event.item);
      return;
    }

    if (eventType === 'response.done') {
      const responseRecord = asRecord(event.response);
      const output = Array.isArray(responseRecord?.output) ? responseRecord.output : [];
      for (const item of output) {
        this.captureTextsFromItem(item);
      }
    }
  }

  private captureTextsFromItem(item: unknown): void {
    const record = asRecord(item);
    if (!record) {
      return;
    }

    const role = typeof record.role === 'string' ? record.role : '';
    const texts = collectMessageTexts(record);
    if (!texts.length) {
      return;
    }

    if (role === 'assistant') {
      texts.forEach((text) => this.rememberAssistantTranscript(text));
      return;
    }

    if (role === 'user') {
      texts.forEach((text) => this.rememberUserTranscript(text));
    }
  }

  private rememberUserTranscript(text: string | null | undefined): void {
    this.rememberLine(this.userTranscripts, text);
  }

  private rememberAssistantTranscript(text: string | null | undefined): void {
    this.rememberLine(this.assistantTranscripts, text);
  }

  private rememberToolEvent(text: string | null | undefined): void {
    this.rememberLine(this.toolEvents, text);
  }

  private rememberTaskEvent(text: string | null | undefined): void {
    this.rememberLine(this.taskEvents, text);
  }

  private rememberLine(target: string[], text: string | null | undefined): void {
    const normalized = normalizeMemoryText(text);
    if (!normalized || normalized.startsWith('SYSTEM_EVENT:')) {
      return;
    }

    const existingIndex = target.indexOf(normalized);
    if (existingIndex >= 0) {
      target.splice(existingIndex, 1);
    }
    target.push(normalized);
    if (target.length > MAX_MEMORY_ITEMS) {
      target.splice(0, target.length - MAX_MEMORY_ITEMS);
    }
  }

  private describeToolRequest(toolName: string, args: Record<string, unknown>): string {
    return `Tool ${toolName} requested: ${safeJson(args)}`;
  }

  private describeToolResult(toolName: string, result: Record<string, unknown>): string {
    const parts = [
      typeof result.message === 'string' ? result.message : '',
      typeof result.question === 'string' ? result.question : '',
      typeof result.path === 'string' ? `Path: ${result.path}` : '',
      typeof result.taskId === 'string' ? `Task: ${result.taskId}` : '',
      typeof result.status === 'string' ? `Status: ${result.status}` : '',
    ].filter(Boolean);

    if (!parts.length) {
      parts.push(safeJson(result));
    }

    return `Tool ${toolName} result: ${parts.join(' | ')}`;
  }

  private describeTask(task: VoiceTask): string {
    const result = task.result ?? {};
    const parts = [
      `Task ${task.id}`,
      task.taskType,
      task.status,
      typeof result.message === 'string' ? result.message : '',
      typeof result.question === 'string' ? result.question : '',
      typeof result.path === 'string' ? `Path: ${result.path}` : '',
    ].filter(Boolean);
    return parts.join(' | ');
  }
}

function normalizeMemoryText(text: string | null | undefined): string {
  if (typeof text !== 'string') {
    return '';
  }

  const normalized = text.replace(/\s+/g, ' ').trim();
  if (!normalized) {
    return '';
  }
  return normalized.length > 500 ? `${normalized.slice(0, 497)}...` : normalized;
}

function safeJson(value: unknown): string {
  const raw = JSON.stringify(value);
  if (!raw) {
    return '';
  }
  return raw.length > 500 ? `${raw.slice(0, 497)}...` : raw;
}

function firstString(...values: unknown[]): string {
  for (const value of values) {
    if (typeof value === 'string' && value.trim()) {
      return value;
    }
  }
  return '';
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return null;
  }
  return value as Record<string, unknown>;
}

function collectMessageTexts(item: Record<string, unknown>): string[] {
  const texts: string[] = [];
  const content = Array.isArray(item.content) ? item.content : [];
  for (const contentItem of content) {
    const contentRecord = asRecord(contentItem);
    if (!contentRecord) {
      continue;
    }

    const contentType = typeof contentRecord.type === 'string' ? contentRecord.type : '';
    if (
      contentType === 'input_text' ||
      contentType === 'text' ||
      contentType === 'output_text' ||
      contentType === 'audio'
    ) {
      const text = firstString(contentRecord.transcript, contentRecord.text);
      if (text) {
        texts.push(text);
      }
    }
  }

  if (!texts.length) {
    const direct = firstString(item.transcript, item.text);
    if (direct) {
      texts.push(direct);
    }
  }

  return texts.map((text) => normalizeMemoryText(text)).filter(Boolean);
}

function isToolCallItem(value: unknown): value is ToolCallItem {
  const record = asRecord(value);
  return Boolean(
    record &&
      record.type === 'function_call' &&
      typeof record.name === 'string' &&
      typeof record.call_id === 'string',
  );
}
