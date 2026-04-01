import {
  createVoiceAgentSession,
  onVoiceAgentTask,
  runVoiceAgentTool,
  type CreateVoiceAgentSessionResult,
  type VoiceTask,
} from './voiceOverlay';

export type VoiceFeedSection = 'events' | 'tasks';
export type VoiceFeedKind = 'client' | 'server' | 'lifecycle' | 'task' | 'error';
export type VoiceConnectionState = 'idle' | 'connecting' | 'connected' | 'disconnecting' | 'error';

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
  private mediaStream: MediaStream | null = null;
  private audioElement: HTMLAudioElement | null = null;
  private session: CreateVoiceAgentSessionResult | null = null;
  private state: VoiceConnectionState = 'idle';
  private unlistenTaskEvents: (() => void | Promise<void>) | null = null;
  private announcedFinalTasks = new Set<string>();

  constructor(callbacks: RealtimeVoiceAgentCallbacks) {
    this.callbacks = callbacks;
  }

  async connect(): Promise<void> {
    if (this.state === 'connecting' || this.state === 'connected') {
      return;
    }

    this.setStatus('connecting', 'Realtime WebRTC session is starting...');
    this.log('events', 'lifecycle', 'session', 'Session start is being prepared');

    try {
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
      };

      const mediaStream = await navigator.mediaDevices.getUserMedia({
        audio: {
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true,
        },
      });
      mediaStream.getTracks().forEach((track) => peerConnection.addTrack(track, mediaStream));

      const dataChannel = peerConnection.createDataChannel('oai-events');
      dataChannel.addEventListener('message', (event) => {
        void this.handleRealtimeMessage(event.data);
      });
      dataChannel.addEventListener('open', () => {
        this.setStatus(
          'connected',
          `Realtime voice session connected as ${this.session?.assistantState?.sourceAssistantName ?? 'assistant'}.`,
        );
        this.log('events', 'lifecycle', 'session', 'Realtime data channel opened');
      });
      dataChannel.addEventListener('close', () => {
        this.log('events', 'lifecycle', 'session', 'Realtime data channel closed');
      });

      this.peerConnection = peerConnection;
      this.dataChannel = dataChannel;
      this.mediaStream = mediaStream;
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
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      this.log('events', 'error', 'session error', detail);
      await this.disconnect();
      this.setStatus('error', detail);
      throw error;
    }
  }

  async disconnect(): Promise<void> {
    if (this.state === 'disconnecting' || this.state === 'idle') {
      return;
    }

    this.state = 'disconnecting';
    this.log('events', 'lifecycle', 'session', 'Closing realtime connection');

    if (this.unlistenTaskEvents) {
      await this.unlistenTaskEvents();
      this.unlistenTaskEvents = null;
    }

    if (this.dataChannel) {
      this.dataChannel.close();
    }
    if (this.peerConnection) {
      this.peerConnection.close();
    }
    if (this.mediaStream) {
      for (const track of this.mediaStream.getTracks()) {
        track.stop();
      }
    }
    if (this.audioElement) {
      this.audioElement.srcObject = null;
    }

    this.peerConnection = null;
    this.dataChannel = null;
    this.mediaStream = null;
    this.audioElement = null;
    this.session = null;
    this.announcedFinalTasks.clear();
    this.setStatus('idle', 'Realtime voice session is disconnected.');
  }

  private async handleRealtimeMessage(rawPayload: string): Promise<void> {
    const event = JSON.parse(rawPayload);
    this.log('events', 'server', `server -> ${event.type}`, event);

    if (event.type === 'response.done') {
      const output = Array.isArray(event.response?.output) ? event.response.output : [];
      for (const item of output) {
        if (item?.type === 'function_call') {
          await this.executeToolCall(item as ToolCallItem);
        }
      }
    }
  }

  private async executeToolCall(item: ToolCallItem): Promise<void> {
    let parsedArguments: Record<string, unknown> = {};
    try {
      parsedArguments = item.arguments ? JSON.parse(item.arguments) as Record<string, unknown> : {};
    } catch {
      parsedArguments = {};
    }

    this.log('tasks', 'task', `tool requested: ${item.name}`, parsedArguments);
    const response = await runVoiceAgentTool(item.name, parsedArguments);
    this.log('tasks', 'task', `tool result: ${item.name}`, response.result);

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

    this.sendRealtimeEvent({
      type: 'conversation.item.create',
      item: {
        type: 'function_call_output',
        call_id: item.call_id,
        output: JSON.stringify(response.result),
      },
    });
    this.sendRealtimeEvent({ type: 'response.create' });
  }

  private handleVoiceTask(task: VoiceTask): void {
    this.log('tasks', 'task', `background task ${task.status}`, task);

    if (this.announcedFinalTasks.has(task.id)) {
      return;
    }

    if (task.status === 'completed') {
      this.announcedFinalTasks.add(task.id);
      this.announceSystemEvent(
        `Der Hintergrundtask ${task.id} ist abgeschlossen. ${String((task.result as Record<string, unknown> | undefined)?.message ?? '')}`,
      );
      return;
    }

    if (task.status === 'needs_clarification') {
      this.announcedFinalTasks.add(task.id);
      const result = task.result as Record<string, unknown> | undefined;
      this.announceSystemEvent(
        `Der Hintergrundtask ${task.id} braucht eine Rueckfrage. ${String(result?.question ?? result?.message ?? '')}`,
      );
      return;
    }

    if (task.status === 'failed') {
      this.announcedFinalTasks.add(task.id);
      const result = task.result as Record<string, unknown> | undefined;
      this.announceSystemEvent(
        `Der Hintergrundtask ${task.id} ist fehlgeschlagen. ${String(result?.message ?? 'Keine weiteren Details.')}`,
      );
    }
  }

  private announceSystemEvent(text: string): void {
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
    this.sendRealtimeEvent({ type: 'response.create' });
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
}
