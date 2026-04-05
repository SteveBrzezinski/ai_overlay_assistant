import { useEffect, useRef, useState } from 'react';
import {
  getSettings,
  onChatWindowVisibility,
  onVoiceChatState,
  requestVoiceChatSync,
  submitVoiceChatMessage,
  transcribeChatAudio,
  type VoiceChatState,
} from './lib/voiceOverlay';

const EMPTY_CHAT_STATE: VoiceChatState = {
  messages: [],
  isAssistantResponding: false,
  statusText: 'Chat bereit.',
  connectionState: 'idle',
  assistantActive: false,
};

function SendIcon() {
  return (
    <svg className="voice-chat-button-icon" viewBox="0 0 24 24" aria-hidden="true">
      <path
        d="M4 11.8 20 4l-4.8 16-3.4-5.1L4 11.8Z"
        fill="none"
        stroke="currentColor"
        strokeLinecap="round"
        strokeLinejoin="round"
        strokeWidth="1.8"
      />
      <path
        d="m11.8 14.9 3.7-3.7"
        fill="none"
        stroke="currentColor"
        strokeLinecap="round"
        strokeLinejoin="round"
        strokeWidth="1.8"
      />
    </svg>
  );
}

function MicIcon() {
  return (
    <svg className="voice-chat-button-icon" viewBox="0 0 24 24" aria-hidden="true">
      <path
        d="M12 15a3.2 3.2 0 0 0 3.2-3.2V7.7a3.2 3.2 0 1 0-6.4 0v4.1A3.2 3.2 0 0 0 12 15Z"
        fill="none"
        stroke="currentColor"
        strokeLinecap="round"
        strokeLinejoin="round"
        strokeWidth="1.8"
      />
      <path
        d="M17.5 11.5a5.5 5.5 0 0 1-11 0"
        fill="none"
        stroke="currentColor"
        strokeLinecap="round"
        strokeLinejoin="round"
        strokeWidth="1.8"
      />
      <path
        d="M12 17v3"
        fill="none"
        stroke="currentColor"
        strokeLinecap="round"
        strokeLinejoin="round"
        strokeWidth="1.8"
      />
      <path
        d="M9 20h6"
        fill="none"
        stroke="currentColor"
        strokeLinecap="round"
        strokeLinejoin="round"
        strokeWidth="1.8"
      />
    </svg>
  );
}

function StopIcon() {
  return (
    <svg className="voice-chat-button-icon" viewBox="0 0 24 24" aria-hidden="true">
      <rect
        x="7.2"
        y="7.2"
        width="9.6"
        height="9.6"
        rx="2"
        fill="none"
        stroke="currentColor"
        strokeLinecap="round"
        strokeLinejoin="round"
        strokeWidth="1.8"
      />
    </svg>
  );
}

function chooseRecordingMimeType(): string {
  const candidates = ['audio/webm;codecs=opus', 'audio/webm', 'audio/mp4'];
  for (const candidate of candidates) {
    if (typeof MediaRecorder !== 'undefined' && MediaRecorder.isTypeSupported(candidate)) {
      return candidate;
    }
  }

  return 'audio/webm';
}

function buildRecordingFileName(mimeType: string): string {
  if (mimeType.includes('mp4')) {
    return 'chat-recording.mp4';
  }

  return 'chat-recording.webm';
}

function blobToBase64(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => {
      reject(new Error('Die Aufnahme konnte nicht gelesen werden.'));
    };
    reader.onloadend = () => {
      if (typeof reader.result !== 'string') {
        reject(new Error('Die Aufnahme konnte nicht in Base64 umgewandelt werden.'));
        return;
      }

      const separatorIndex = reader.result.indexOf(',');
      resolve(separatorIndex >= 0 ? reader.result.slice(separatorIndex + 1) : reader.result);
    };
    reader.readAsDataURL(blob);
  });
}

function describeConnectionState(state: string, assistantActive: boolean): string {
  if (state === 'connecting') {
    return 'Verbinde Assistent...';
  }
  if (state === 'error') {
    return 'Verbindung gestört';
  }
  if (assistantActive || state === 'online_listening') {
    return 'Voice aktiv';
  }
  if (state === 'online_muted') {
    return 'Verbunden';
  }

  return 'Bereit';
}

export default function ChatOverlayApp() {
  const [chatState, setChatState] = useState<VoiceChatState>(EMPTY_CHAT_STATE);
  const [inputValue, setInputValue] = useState('');
  const [recordingPhase, setRecordingPhase] = useState<'idle' | 'recording' | 'transcribing'>(
    'idle',
  );
  const [recordingElapsedMs, setRecordingElapsedMs] = useState(0);
  const [recordingStartedAtMs, setRecordingStartedAtMs] = useState<number | null>(null);
  const [sttLanguage, setSttLanguage] = useState('de');
  const [localError, setLocalError] = useState('');
  const inputRef = useRef<HTMLTextAreaElement | null>(null);
  const messagesRef = useRef<HTMLDivElement | null>(null);
  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const mediaStreamRef = useRef<MediaStream | null>(null);
  const recordedChunksRef = useRef<Blob[]>([]);
  const recordingMimeTypeRef = useRef('audio/webm');

  function stopRecordingResources(): void {
    const recorder = mediaRecorderRef.current;
    if (recorder && recorder.state !== 'inactive') {
      recorder.ondataavailable = null;
      recorder.onerror = null;
      recorder.onstop = null;
      recorder.stop();
    }

    if (mediaStreamRef.current) {
      for (const track of mediaStreamRef.current.getTracks()) {
        track.stop();
      }
    }

    mediaRecorderRef.current = null;
    mediaStreamRef.current = null;
    recordedChunksRef.current = [];
  }

  useEffect(() => {
    let isMounted = true;
    let unlistenChatState: (() => void | Promise<void>) | undefined;
    let unlistenChatVisibility: (() => void | Promise<void>) | undefined;

    document.documentElement.classList.add('overlay-html');
    document.body.classList.add('overlay-body');

    void getSettings()
      .then((settings) => {
        if (isMounted) {
          setSttLanguage(settings.sttLanguage || 'de');
        }
      })
      .catch(() => {
        if (isMounted) {
          setSttLanguage('de');
        }
      });

    void onVoiceChatState((state) => {
      if (isMounted) {
        setChatState(state);
      }
    }).then((cleanup) => {
      unlistenChatState = cleanup;
    });

    void onChatWindowVisibility(({ visible }) => {
      if (!isMounted || !visible) {
        return;
      }

      void requestVoiceChatSync();
      window.setTimeout(() => {
        inputRef.current?.focus();
      }, 80);
    }).then((cleanup) => {
      unlistenChatVisibility = cleanup;
    });

    void requestVoiceChatSync();

    return () => {
      isMounted = false;
      stopRecordingResources();
      document.documentElement.classList.remove('overlay-html');
      document.body.classList.remove('overlay-body');
      void unlistenChatState?.();
      void unlistenChatVisibility?.();
    };
  }, []);

  useEffect(() => {
    if (recordingPhase !== 'recording' || !recordingStartedAtMs) {
      return;
    }

    const timer = window.setInterval(() => {
      setRecordingElapsedMs(Date.now() - recordingStartedAtMs);
    }, 250);

    return () => {
      window.clearInterval(timer);
    };
  }, [recordingPhase, recordingStartedAtMs]);

  useEffect(() => {
    messagesRef.current?.scrollTo({
      top: messagesRef.current.scrollHeight,
      behavior: 'smooth',
    });
  }, [chatState.isAssistantResponding, chatState.messages]);

  const composerStatus =
    localError ||
    (recordingPhase === 'recording'
      ? `Sprich jetzt... ${Math.max(1, Math.round(recordingElapsedMs / 1000))}s`
      : recordingPhase === 'transcribing'
        ? 'Transkribiere Aufnahme...'
        : chatState.statusText);
  const canSend =
    inputValue.trim().length > 0 &&
    recordingPhase === 'idle' &&
    !chatState.isAssistantResponding;

  async function handleSubmit(): Promise<void> {
    const text = inputValue.trim();
    if (!text || recordingPhase !== 'idle' || chatState.isAssistantResponding) {
      return;
    }

    const nextMessageId = `chat-user-${Date.now()}-${Math.random().toString(16).slice(2)}`;
    setLocalError('');
    setInputValue('');

    try {
      await submitVoiceChatMessage({
        messageId: nextMessageId,
        text,
      });
    } catch (error: unknown) {
      const detail = error instanceof Error ? error.message : String(error);
      setInputValue(text);
      setLocalError(detail);
    }
  }

  async function handleStartRecording(): Promise<void> {
    if (recordingPhase !== 'idle') {
      return;
    }
    if (typeof MediaRecorder === 'undefined') {
      setLocalError('MediaRecorder wird in diesem Webview nicht unterstuetzt.');
      return;
    }

    try {
      setLocalError('');
      setRecordingElapsedMs(0);
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true,
        },
      });
      const mimeType = chooseRecordingMimeType();
      const recorder = new MediaRecorder(stream, mimeType ? { mimeType } : undefined);
      recordedChunksRef.current = [];
      recordingMimeTypeRef.current = mimeType;
      mediaStreamRef.current = stream;
      mediaRecorderRef.current = recorder;
      recorder.ondataavailable = (event: BlobEvent) => {
        if (event.data.size > 0) {
          recordedChunksRef.current.push(event.data);
        }
      };
      recorder.start(200);
      setRecordingStartedAtMs(Date.now());
      setRecordingPhase('recording');
    } catch (error: unknown) {
      stopRecordingResources();
      setRecordingPhase('idle');
      setRecordingElapsedMs(0);
      setRecordingStartedAtMs(null);
      setLocalError(error instanceof Error ? error.message : String(error));
    }
  }

  async function handleFinishRecording(): Promise<void> {
    if (recordingPhase !== 'recording' || !mediaRecorderRef.current) {
      return;
    }

    setLocalError('');
    setRecordingPhase('transcribing');

    try {
      const recorder = mediaRecorderRef.current;
      const blob = await new Promise<Blob>((resolve, reject) => {
        recorder.onerror = () => {
          reject(new Error('Die Aufnahme konnte nicht gestoppt werden.'));
        };
        recorder.onstop = () => {
          resolve(
            new Blob(recordedChunksRef.current, {
              type: recordingMimeTypeRef.current,
            }),
          );
        };
        recorder.stop();
      });

      stopRecordingResources();
      setRecordingElapsedMs(0);
      setRecordingStartedAtMs(null);
      const transcriptionMimeType =
        (blob.type || recordingMimeTypeRef.current).split(';')[0] || 'audio/webm';

      const transcript = await transcribeChatAudio({
        audioBase64: await blobToBase64(blob),
        mimeType: transcriptionMimeType,
        fileName: buildRecordingFileName(transcriptionMimeType),
        language: sttLanguage,
      });

      setInputValue((current) =>
        current.trim() ? `${current.trim()} ${transcript.text}` : transcript.text,
      );
      setRecordingPhase('idle');
      window.setTimeout(() => {
        inputRef.current?.focus();
      }, 50);
    } catch (error: unknown) {
      stopRecordingResources();
      setRecordingPhase('idle');
      setRecordingElapsedMs(0);
      setRecordingStartedAtMs(null);
      setLocalError(error instanceof Error ? error.message : String(error));
    }
  }

  return (
    <main className="voice-chat-screen">
      <section className="voice-chat-shell" aria-label="Voice Overlay Assistant Chat">
        <header className="voice-chat-header">
          <div>
            <strong>Voice Chat</strong>
            <p>{describeConnectionState(chatState.connectionState, chatState.assistantActive)}</p>
          </div>
          <span
            className={`voice-chat-connection${
              chatState.connectionState === 'error' ? ' voice-chat-connection--error' : ''
            }`}
          >
            {chatState.isAssistantResponding
              ? 'Antwortet'
              : describeConnectionState(chatState.connectionState, chatState.assistantActive)}
          </span>
        </header>

        <div ref={messagesRef} className="voice-chat-messages">
          {chatState.messages.length ? (
            chatState.messages.map((message) => (
              <article
                key={message.id}
                className={`voice-chat-message voice-chat-message--${message.role}`}
              >
                <span className="voice-chat-message-role">
                  {message.role === 'user'
                    ? 'Du'
                    : message.role === 'assistant'
                      ? 'AIVA'
                      : 'System'}
                </span>
                <p>{message.text}</p>
              </article>
            ))
          ) : (
            <div className="voice-chat-empty">
              <strong>Chat ist bereit.</strong>
              <p>Schreib eine Nachricht oder nutze das Mikrofon, um Text einsprechen zu lassen.</p>
            </div>
          )}

          {chatState.isAssistantResponding ? (
            <div className="voice-chat-message voice-chat-message--assistant voice-chat-message--typing">
              <span className="voice-chat-message-role">AIVA</span>
              <div className="voice-chat-typing-dots" aria-hidden="true">
                <span />
                <span />
                <span />
              </div>
            </div>
          ) : null}
        </div>

        <footer className="voice-chat-composer">
          <label className="voice-chat-composer-label" htmlFor="voice-chat-input">
            Nachricht
          </label>
          <div className="voice-chat-composer-row">
            <textarea
              id="voice-chat-input"
              ref={inputRef}
              className="voice-chat-input"
              rows={2}
              placeholder="Nachricht eingeben..."
              value={inputValue}
              disabled={recordingPhase === 'transcribing'}
              onChange={(event) => setInputValue(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Enter' && !event.shiftKey) {
                  event.preventDefault();
                  void handleSubmit();
                }
              }}
            />

            <div className="voice-chat-composer-actions">
              <button
                type="button"
                className={`voice-chat-tool-button${
                  recordingPhase === 'recording' ? ' voice-chat-tool-button--recording' : ''
                }`}
                aria-label={
                  recordingPhase === 'recording' ? 'Aufnahme beenden' : 'Spracheingabe starten'
                }
                title={recordingPhase === 'recording' ? 'Fertig' : 'Spracheingabe starten'}
                disabled={recordingPhase === 'transcribing' || chatState.isAssistantResponding}
                onClick={() =>
                  void (recordingPhase === 'recording'
                    ? handleFinishRecording()
                    : handleStartRecording())
                }
              >
                {recordingPhase === 'recording' ? <StopIcon /> : <MicIcon />}
              </button>

              <button
                type="button"
                className="voice-chat-send-button"
                aria-label="Nachricht senden"
                title="Nachricht senden"
                disabled={!canSend}
                onClick={() => void handleSubmit()}
              >
                <SendIcon />
              </button>
            </div>
          </div>

          <p className={`voice-chat-status${localError ? ' voice-chat-status--error' : ''}`}>
            {composerStatus}
          </p>
        </footer>
      </section>
    </main>
  );
}
