export type SttProviderId = 'webview2';

export type ProviderSnapshot = {
  provider: SttProviderId;
  transcript: string;
  latencyMs: number;
  ok: boolean;
  detail?: string;
  updatedAtMs: number;
};

export type LiveSttConfig = {
  language: string;
};

export type LiveSttCallbacks = {
  onStatus: (message: string) => void;
  onProviderSnapshot: (snapshot: ProviderSnapshot) => void;
};

type SpeechRecognitionCtor = new () => {
  continuous: boolean;
  interimResults: boolean;
  lang: string;
  onresult: ((event: SpeechRecognitionEventLike) => void) | null;
  onerror: ((event: { error?: string }) => void) | null;
  onend: (() => void) | null;
  start: () => void;
  stop: () => void;
};

type SpeechRecognitionAlternativeLike = {
  transcript: string;
};

type SpeechRecognitionResultLike = {
  isFinal: boolean;
  0: SpeechRecognitionAlternativeLike;
  length: number;
};

type SpeechRecognitionEventLike = {
  resultIndex: number;
  results: ArrayLike<SpeechRecognitionResultLike>;
};

export class LiveSttController {
  private config: LiveSttConfig | null = null;
  private callbacks: LiveSttCallbacks | null = null;
  private speechRecognition: InstanceType<SpeechRecognitionCtor> | null = null;
  private running = false;

  async start(config: LiveSttConfig, callbacks: LiveSttCallbacks): Promise<void> {
    if (this.running) {
      await this.stop();
    }

    this.config = config;
    this.callbacks = callbacks;
    this.running = true;

    callbacks.onStatus('Starting WebView2 speech recognition...');
    this.startWebSpeechRecognition();
    callbacks.onStatus('Live transcription is running with WebView2 speech recognition.');
  }

  async stop(): Promise<void> {
    this.running = false;

    if (this.speechRecognition) {
      try {
        this.speechRecognition.onend = null;
        this.speechRecognition.stop();
      } catch {
        // ignore stop race
      }
      this.speechRecognition = null;
    }
  }

  private startWebSpeechRecognition(): void {
    const ctor = (
      window as unknown as {
        SpeechRecognition?: SpeechRecognitionCtor;
        webkitSpeechRecognition?: SpeechRecognitionCtor;
      }
    ).SpeechRecognition ?? (
      window as unknown as {
        webkitSpeechRecognition?: SpeechRecognitionCtor;
      }
    ).webkitSpeechRecognition;

    if (!ctor) {
      this.callbacks?.onProviderSnapshot({
        provider: 'webview2',
        transcript: '',
        latencyMs: 0,
        ok: false,
        detail: 'SpeechRecognition is not available in this WebView2 runtime.',
        updatedAtMs: Date.now(),
      });
      return;
    }

    const recognition = new ctor();
    recognition.continuous = true;
    recognition.interimResults = true;
    recognition.lang = mapSpeechRecognitionLanguage(this.config?.language ?? 'de');
    recognition.onresult = (event) => {
      let transcript = '';
      let isFinal = false;
      const startIndex = event.resultIndex ?? 0;
      for (let index = startIndex; index < event.results.length; index += 1) {
        const result = event.results[index];
        transcript += result[0]?.transcript ?? '';
        if (result.isFinal) {
          isFinal = true;
        }
      }

      const trimmed = transcript.trim();
      if (!trimmed) {
        return;
      }

      this.callbacks?.onProviderSnapshot({
        provider: 'webview2',
        transcript: trimmed,
        latencyMs: 0,
        ok: true,
        detail: isFinal ? 'final' : 'interim',
        updatedAtMs: Date.now(),
      });
    };
    recognition.onerror = (event) => {
      this.callbacks?.onProviderSnapshot({
        provider: 'webview2',
        transcript: '',
        latencyMs: 0,
        ok: false,
        detail: event.error ?? 'Unknown WebView2 speech recognition error',
        updatedAtMs: Date.now(),
      });
    };
    recognition.onend = () => {
      if (this.running) {
        try {
          recognition.start();
        } catch {
          // ignore restart race
        }
      }
    };

    this.speechRecognition = recognition;
    recognition.start();
  }
}

function mapSpeechRecognitionLanguage(language: string): string {
  const normalized = language.trim().toLowerCase();
  switch (normalized) {
    case 'de':
      return 'de-DE';
    case 'en':
      return 'en-US';
    case 'fr':
      return 'fr-FR';
    case 'es':
      return 'es-ES';
    default:
      return normalized || 'de-DE';
  }
}
