import {
  getSpeechRecognitionConstructor,
  type SpeechRecognitionEventLike,
  type SpeechRecognitionLike,
} from './speechRecognition.js';
import i18n from '../i18n.js';
import {
  ASSISTANT_CUE_COOLDOWN_MS_MAX,
  ASSISTANT_MATCH_THRESHOLD_MAX,
  ASSISTANT_MATCH_THRESHOLD_MIN,
  DEFAULT_ASSISTANT_CUE_COOLDOWN_MS,
  DEFAULT_ASSISTANT_WAKE_THRESHOLD,
  buildCueSnapshotDetail,
  evaluateCuePhrase,
  formatCueEvaluationSummary,
  mapSpeechRecognitionLanguage,
  sanitizeAssistantName,
  sanitizeCooldownMs,
  sanitizeSamples,
  sanitizeThreshold,
} from './liveSttMatching.js';

export {
  ASSISTANT_CUE_COOLDOWN_MS_MAX,
  ASSISTANT_MATCH_THRESHOLD_MAX,
  ASSISTANT_MATCH_THRESHOLD_MIN,
  DEFAULT_ASSISTANT_CUE_COOLDOWN_MS,
  DEFAULT_ASSISTANT_WAKE_THRESHOLD,
};

export type SttProviderId = 'webview2';

type AssistantControlSource = 'wake-word' | 'hotkey' | 'manual' | 'system';

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
};

export type LiveSttConfig = {
  language: string;
  assistantName: string;
  activateImmediately?: boolean;
  wakeSamples?: string[];
  nameSamples?: string[];
  assistantWakeThreshold?: number;
  assistantCueCooldownMs?: number;
};

export type LiveSttCallbacks = {
  onStatus: (message: string) => void;
  onProviderSnapshot: (snapshot: ProviderSnapshot) => void;
  onAssistantStateChange: (snapshot: AssistantStateSnapshot) => void;
};

export class LiveSttController {
  private config: LiveSttConfig | null = null;
  private callbacks: LiveSttCallbacks | null = null;
  private speechRecognition: SpeechRecognitionLike | null = null;
  private running = false;
  private assistantActive = false;
  private cueCooldownUntilMs = 0;

  start(config: LiveSttConfig, callbacks: LiveSttCallbacks): Promise<void> {
    if (this.running) {
      void this.stop();
    }

    this.config = {
      language: config.language,
      assistantName: sanitizeAssistantName(config.assistantName),
      activateImmediately: config.activateImmediately ?? false,
      wakeSamples: sanitizeSamples(config.wakeSamples, 4),
      nameSamples: sanitizeSamples(config.nameSamples, 2),
      assistantWakeThreshold: sanitizeThreshold(
        config.assistantWakeThreshold,
        DEFAULT_ASSISTANT_WAKE_THRESHOLD,
      ),
      assistantCueCooldownMs: sanitizeCooldownMs(
        config.assistantCueCooldownMs,
        DEFAULT_ASSISTANT_CUE_COOLDOWN_MS,
      ),
    };
    this.callbacks = callbacks;
    this.running = true;
    this.assistantActive = Boolean(this.config.activateImmediately);

    if (this.assistantActive) {
      this.applyCueCooldown();
    }

    callbacks.onStatus(
      i18n.t('liveStt.startingWebSpeech', { wakePhrase: this.currentWakePhrase() }),
    );
    this.startWebSpeechRecognition();

    if (this.assistantActive) {
      this.reportAssistantState(true, i18n.t('liveStt.assistantActivatedManually'), 'manual');
    } else {
      this.reportAssistantState(
        false,
        i18n.t('liveStt.listeningForWakePhrase', { wakePhrase: this.currentWakePhrase() }),
        'system',
      );
    }

    return Promise.resolve();
  }

  stop(): Promise<void> {
    this.running = false;
    this.assistantActive = false;
    this.cueCooldownUntilMs = 0;

    if (this.speechRecognition) {
      try {
        this.speechRecognition.onend = null;
        this.speechRecognition.stop();
      } catch {
        // ignore stop race
      }
      this.speechRecognition = null;
    }

    return Promise.resolve();
  }

  manualActivate(source: AssistantControlSource = 'hotkey'): void {
    if (!this.running || this.assistantActive) {
      return;
    }

    this.assistantActive = true;
    this.applyCueCooldown();
    this.reportAssistantState(true, i18n.t('liveStt.assistantActive'), source);
    this.restartRecognitionForCurrentMode();
  }

  manualDeactivate(source: AssistantControlSource = 'hotkey'): void {
    if (!this.running || !this.assistantActive) {
      return;
    }

    this.assistantActive = false;
    this.applyCueCooldown();
    this.reportAssistantState(
      false,
      i18n.t('liveStt.assistantInactive', { wakePhrase: this.currentWakePhrase() }),
      source,
    );
    this.restartRecognitionForCurrentMode();
  }

  private startWebSpeechRecognition(): void {
    const ctor = getSpeechRecognitionConstructor();

    if (!ctor) {
      this.callbacks?.onProviderSnapshot({
        provider: 'webview2',
        transcript: '',
        latencyMs: 0,
        ok: false,
        detail: i18n.t('liveStt.speechRecognitionUnavailable'),
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
        detail: event.error ?? i18n.t('liveStt.unknownSpeechRecognitionError'),
        updatedAtMs: Date.now(),
      });
    };
    recognition.onend = () => {
      if (!this.running) {
        return;
      }

      try {
        recognition.lang = this.currentRecognitionLanguage();
        recognition.start();
      } catch {
        // ignore restart race
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
      const wakeEvaluation = evaluateCuePhrase({
        transcript: trimmed,
        kind: 'wake',
        cueWord: 'hey',
        aiName: this.currentAssistantName(),
        trainedPhrases: this.config?.wakeSamples ?? [],
        trainedNameSamples: this.config?.nameSamples ?? [],
        baseThreshold: this.currentWakeThreshold(),
        isFinal,
        cooldownRemainingMs: this.cooldownRemainingMs(),
      });

      if (wakeEvaluation.matched) {
        this.assistantActive = true;
        this.applyCueCooldown();
        this.reportAssistantState(
          true,
          i18n.t('liveStt.wakePhraseDetected', {
            score: wakeEvaluation.score,
            threshold: wakeEvaluation.threshold,
            wakePhrase: this.currentWakePhrase(),
          }),
          'wake-word',
          trimmed,
          formatCueEvaluationSummary(wakeEvaluation),
        );
        this.restartRecognitionForCurrentMode();
        return;
      }

      this.callbacks?.onProviderSnapshot({
        provider: 'webview2',
        transcript: trimmed,
        latencyMs: 0,
        ok: true,
        detail: buildCueSnapshotDetail('assistant-inactive', wakeEvaluation, isFinal),
        updatedAtMs: Date.now(),
      });
      return;
    }

    this.callbacks?.onProviderSnapshot({
      provider: 'webview2',
      transcript: trimmed,
      latencyMs: 0,
      ok: true,
      detail: ['assistant-active', isFinal ? 'final' : 'interim'].join(' - '),
      updatedAtMs: Date.now(),
    });
  }

  private reportAssistantState(
    active: boolean,
    reason: string,
    source: AssistantControlSource,
    transcript = '',
    detailSuffix?: string,
  ): void {
    this.callbacks?.onAssistantStateChange({
      active,
      reason,
      source,
      aiName: this.currentAssistantName(),
      wakePhrase: this.currentWakePhrase(),
    });
    this.callbacks?.onStatus(reason);
    this.callbacks?.onProviderSnapshot({
      provider: 'webview2',
      transcript,
      latencyMs: 0,
      ok: true,
      detail: [active ? 'assistant-active' : 'assistant-inactive', source, detailSuffix]
        .filter(Boolean)
        .join(' - '),
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

  private applyCueCooldown(): void {
    this.cueCooldownUntilMs = Date.now() + this.currentCueCooldownMs();
  }

  private cooldownRemainingMs(): number {
    return Math.max(0, this.cueCooldownUntilMs - Date.now());
  }

  private currentAssistantName(): string {
    return sanitizeAssistantName(this.config?.assistantName);
  }

  private currentWakePhrase(): string {
    return `Hey ${this.currentAssistantName()}`;
  }

  private currentRecognitionLanguage(): string {
    return mapSpeechRecognitionLanguage(this.config?.language ?? 'de');
  }

  private currentWakeThreshold(): number {
    return sanitizeThreshold(
      this.config?.assistantWakeThreshold,
      DEFAULT_ASSISTANT_WAKE_THRESHOLD,
    );
  }

  private currentCueCooldownMs(): number {
    return sanitizeCooldownMs(
      this.config?.assistantCueCooldownMs,
      DEFAULT_ASSISTANT_CUE_COOLDOWN_MS,
    );
  }
}
