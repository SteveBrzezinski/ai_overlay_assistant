export type SttProviderId = 'webview2';

type AssistantControlSource = 'wake-word' | 'close-word' | 'hotkey' | 'manual' | 'system';

export type ProviderSnapshot = {
  provider: SttProviderId;
  transcript: string;
  latencyMs: number;
  ok: boolean;
  detail?: string;
  updatedAtMs: number;
};

export type AssistantStateSnapshot = {
  active: boolean;
  reason: string;
  source: AssistantControlSource;
  aiName: string;
  wakePhrase: string;
  closePhrase: string;
};

export type LiveSttConfig = {
  language: string;
  assistantName: string;
  activateImmediately?: boolean;
  wakeSamples?: string[];
  closeSamples?: string[];
  nameSamples?: string[];
};

export type LiveSttCallbacks = {
  onStatus: (message: string) => void;
  onProviderSnapshot: (snapshot: ProviderSnapshot) => void;
  onAssistantStateChange: (snapshot: AssistantStateSnapshot) => void;
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
  private assistantActive = false;

  async start(config: LiveSttConfig, callbacks: LiveSttCallbacks): Promise<void> {
    if (this.running) {
      await this.stop();
    }

    this.config = {
      language: config.language,
      assistantName: sanitizeAssistantName(config.assistantName),
      activateImmediately: config.activateImmediately ?? false,
      wakeSamples: sanitizeSamples(config.wakeSamples, 4),
      closeSamples: sanitizeSamples(config.closeSamples, 4),
      nameSamples: sanitizeSamples(config.nameSamples, 2),
    };
    this.callbacks = callbacks;
    this.running = true;
    this.assistantActive = Boolean(this.config.activateImmediately);

    callbacks.onStatus(`Starting WebView2 speech recognition for ${this.currentWakePhrase()}...`);
    this.startWebSpeechRecognition();

    if (this.assistantActive) {
      this.reportAssistantState(true, `Assistant activated manually. Say "${this.currentClosePhrase()}" to deactivate.`, 'manual');
    } else {
      this.reportAssistantState(false, `Listening for wake phrase "${this.currentWakePhrase()}".`, 'system');
    }
  }

  async stop(): Promise<void> {
    this.running = false;
    this.assistantActive = false;

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

  manualActivate(source: AssistantControlSource = 'hotkey'): void {
    if (!this.running || this.assistantActive) {
      return;
    }

    this.assistantActive = true;
    this.reportAssistantState(true, `Assistant active. Say "${this.currentClosePhrase()}" to deactivate.`, source);
    this.restartRecognitionForCurrentMode();
  }

  manualDeactivate(source: AssistantControlSource = 'hotkey'): void {
    if (!this.running || !this.assistantActive) {
      return;
    }

    this.assistantActive = false;
    this.reportAssistantState(false, `Assistant inactive. Listening for "${this.currentWakePhrase()}".`, source);
    this.restartRecognitionForCurrentMode();
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
    recognition.lang = this.currentRecognitionLanguage();
    recognition.onresult = (event) => {
      this.handleRecognitionResult(event);
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
          recognition.lang = this.currentRecognitionLanguage();
          recognition.start();
        } catch {
          // ignore restart race
        }
      }
    };

    this.speechRecognition = recognition;
    recognition.start();
  }

  private handleRecognitionResult(event: SpeechRecognitionEventLike): void {
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

    if (!this.assistantActive) {
      if (matchesCuePhrase(trimmed, 'hey', this.currentAssistantName(), this.config?.wakeSamples ?? [], this.config?.nameSamples ?? [])) {
        this.assistantActive = true;
        this.reportAssistantState(true, `Wake phrase detected: ${this.currentWakePhrase()}.`, 'wake-word', trimmed);
        this.restartRecognitionForCurrentMode();
        return;
      }

      this.callbacks?.onProviderSnapshot({
        provider: 'webview2',
        transcript: '',
        latencyMs: 0,
        ok: true,
        detail: `inactive · waiting for ${this.currentWakePhrase()}${isFinal ? ' · final' : ' · interim'}`,
        updatedAtMs: Date.now(),
      });
      return;
    }

    if (matchesCuePhrase(trimmed, 'bye', this.currentAssistantName(), this.config?.closeSamples ?? [], this.config?.nameSamples ?? [])) {
      this.assistantActive = false;
      this.reportAssistantState(false, `Close phrase detected: ${this.currentClosePhrase()}.`, 'close-word', trimmed);
      this.restartRecognitionForCurrentMode();
      return;
    }

    this.callbacks?.onProviderSnapshot({
      provider: 'webview2',
      transcript: trimmed,
      latencyMs: 0,
      ok: true,
      detail: isFinal ? 'assistant-active · final' : 'assistant-active · interim',
      updatedAtMs: Date.now(),
    });
  }

  private reportAssistantState(
    active: boolean,
    reason: string,
    source: AssistantControlSource,
    transcript = '',
  ): void {
    this.callbacks?.onAssistantStateChange({
      active,
      reason,
      source,
      aiName: this.currentAssistantName(),
      wakePhrase: this.currentWakePhrase(),
      closePhrase: this.currentClosePhrase(),
    });
    this.callbacks?.onStatus(reason);
    this.callbacks?.onProviderSnapshot({
      provider: 'webview2',
      transcript,
      latencyMs: 0,
      ok: true,
      detail: active ? `assistant-active · ${source}` : `assistant-inactive · ${source}`,
      updatedAtMs: Date.now(),
    });
  }

  private restartRecognitionForCurrentMode(): void {
    if (!this.speechRecognition) {
      return;
    }

    try {
      this.speechRecognition.lang = this.currentRecognitionLanguage();
      this.speechRecognition.stop();
    } catch {
      // ignore stop/restart race
    }
  }

  private currentAssistantName(): string {
    return sanitizeAssistantName(this.config?.assistantName);
  }

  private currentWakePhrase(): string {
    return `Hey ${this.currentAssistantName()}`;
  }

  private currentClosePhrase(): string {
    return `Bye ${this.currentAssistantName()}`;
  }

  private currentRecognitionLanguage(): string {
    if (this.assistantActive) {
      return mapSpeechRecognitionLanguage(this.config?.language ?? 'de');
    }
    return 'en-US';
  }
}

function sanitizeAssistantName(value?: string | null): string {
  const trimmed = value?.trim();
  return trimmed ? trimmed : 'AIVA';
}

function sanitizeSamples(samples?: string[] | null, max: number = Number.MAX_SAFE_INTEGER): string[] {
  return (samples ?? [])
    .map((value) => value.trim())
    .filter(Boolean)
    .slice(0, max);
}

function matchesCuePhrase(
  transcript: string,
  cue: 'hey' | 'bye',
  aiName: string,
  trainedPhrases: string[],
  trainedNameSamples: string[],
): boolean {
  const normalized = normalizeForMatch(transcript);
  if (!normalized) {
    return false;
  }

  const words = normalized.split(' ');
  const compactName = normalizeForMatch(aiName).replace(/\s+/g, '');
  const compactText = normalized.replace(/\s+/g, '');
  const compactCueName = `${cue}${compactName}`;
  const nameThreshold = Math.max(1, Math.floor(compactName.length / 4));
  const normalizedSamples = sanitizeSamples(trainedPhrases).map((value) => normalizeForMatch(value).replace(/\s+/g, ''));
  const normalizedNameSamples = sanitizeSamples(trainedNameSamples).map((value) => normalizeForMatch(value).replace(/\s+/g, ''));

  if (normalizedSamples.some((sample) => sample && (compactText.includes(sample) || levenshtein(compactText, sample) <= Math.max(1, Math.floor(sample.length / 5))))) {
    return true;
  }

  if (compactText.includes(compactCueName)) {
    return true;
  }

  const suffix = compactText.slice(-compactCueName.length);
  if (suffix && levenshtein(suffix, compactCueName) <= nameThreshold) {
    return true;
  }

  for (let index = 0; index < words.length; index += 1) {
    if (levenshtein(words[index] ?? '', cue) > 1) {
      continue;
    }

    for (let take = 1; take <= 3; take += 1) {
      const candidate = words.slice(index + 1, index + 1 + take).join('');
      if (!candidate) {
        continue;
      }
      if (levenshtein(candidate, compactName) <= nameThreshold) {
        return true;
      }
      if (normalizedNameSamples.some((sample) => sample && levenshtein(candidate, sample) <= nameThreshold)) {
        return true;
      }
    }
  }

  return false;
}

function normalizeForMatch(value: string): string {
  return value
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function levenshtein(a: string, b: string): number {
  if (a === b) {
    return 0;
  }
  if (!a.length) {
    return b.length;
  }
  if (!b.length) {
    return a.length;
  }

  const dp = Array.from({ length: b.length + 1 }, (_, index) => index);
  for (let indexA = 1; indexA <= a.length; indexA += 1) {
    let previous = dp[0] ?? 0;
    dp[0] = indexA;
    for (let indexB = 1; indexB <= b.length; indexB += 1) {
      const current = dp[indexB] ?? 0;
      const cost = a[indexA - 1] === b[indexB - 1] ? 0 : 1;
      dp[indexB] = Math.min(
        (dp[indexB] ?? 0) + 1,
        (dp[indexB - 1] ?? 0) + 1,
        previous + cost,
      );
      previous = current;
    }
  }
  return dp[b.length] ?? 0;
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
    case 'it':
      return 'it-IT';
    case 'pt':
      return 'pt-PT';
    case 'pl':
      return 'pl-PL';
    case 'nl':
      return 'nl-NL';
    case 'tr':
      return 'tr-TR';
    case 'ja':
      return 'ja-JP';
    default:
      return normalized || 'de-DE';
  }
}
