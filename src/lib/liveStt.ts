export type SttProviderId = 'webview2';

type AssistantControlSource = 'wake-word' | 'close-word' | 'hotkey' | 'manual' | 'system';
type CueKind = 'wake' | 'close';
type CueWord = 'hey' | 'bye';

export const DEFAULT_ASSISTANT_WAKE_THRESHOLD = 68;
export const DEFAULT_ASSISTANT_CLOSE_THRESHOLD = 64;
export const DEFAULT_ASSISTANT_CUE_COOLDOWN_MS = 1200;
export const ASSISTANT_MATCH_THRESHOLD_MIN = 45;
export const ASSISTANT_MATCH_THRESHOLD_MAX = 95;
export const ASSISTANT_CUE_COOLDOWN_MS_MAX = 5000;

const INTERIM_THRESHOLD_BONUS = 8;
const MAX_CUE_WINDOW_WORDS = 5;
const MAX_NAME_WINDOW_WORDS = 3;

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
  assistantWakeThreshold?: number;
  assistantCloseThreshold?: number;
  assistantCueCooldownMs?: number;
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

type CueEvaluation = {
  kind: CueKind;
  matched: boolean;
  score: number;
  threshold: number;
  cueScore: number;
  nameScore: number;
  phraseScore: number;
  sampleScore: number;
  compactScore: number;
  bestCandidate: string;
  hasCueEvidence: boolean;
  hasNameEvidence: boolean;
  cooldownRemainingMs: number;
};

export class LiveSttController {
  private config: LiveSttConfig | null = null;
  private callbacks: LiveSttCallbacks | null = null;
  private speechRecognition: InstanceType<SpeechRecognitionCtor> | null = null;
  private running = false;
  private assistantActive = false;
  private cueCooldownUntilMs = 0;

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
      assistantWakeThreshold: sanitizeThreshold(config.assistantWakeThreshold, DEFAULT_ASSISTANT_WAKE_THRESHOLD),
      assistantCloseThreshold: sanitizeThreshold(config.assistantCloseThreshold, DEFAULT_ASSISTANT_CLOSE_THRESHOLD),
      assistantCueCooldownMs: sanitizeCooldownMs(config.assistantCueCooldownMs, DEFAULT_ASSISTANT_CUE_COOLDOWN_MS),
    };
    this.callbacks = callbacks;
    this.running = true;
    this.assistantActive = Boolean(this.config.activateImmediately);

    if (this.assistantActive) {
      this.applyCueCooldown();
    }

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
  }

  manualActivate(source: AssistantControlSource = 'hotkey'): void {
    if (!this.running || this.assistantActive) {
      return;
    }

    this.assistantActive = true;
    this.applyCueCooldown();
    this.reportAssistantState(true, `Assistant active. Say "${this.currentClosePhrase()}" to deactivate.`, source);
    this.restartRecognitionForCurrentMode();
  }

  manualDeactivate(source: AssistantControlSource = 'hotkey'): void {
    if (!this.running || !this.assistantActive) {
      return;
    }

    this.assistantActive = false;
    this.applyCueCooldown();
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
          `Wake phrase detected (${wakeEvaluation.score}/${wakeEvaluation.threshold}): ${this.currentWakePhrase()}.`,
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

    const closeEvaluation = evaluateCuePhrase({
      transcript: trimmed,
      kind: 'close',
      cueWord: 'bye',
      aiName: this.currentAssistantName(),
      trainedPhrases: this.config?.closeSamples ?? [],
      trainedNameSamples: this.config?.nameSamples ?? [],
      baseThreshold: this.currentCloseThreshold(),
      isFinal,
      cooldownRemainingMs: this.cooldownRemainingMs(),
    });

    if (closeEvaluation.matched) {
      this.assistantActive = false;
      this.applyCueCooldown();
      this.reportAssistantState(
        false,
        `Close phrase detected (${closeEvaluation.score}/${closeEvaluation.threshold}): ${this.currentClosePhrase()}.`,
        'close-word',
        trimmed,
        formatCueEvaluationSummary(closeEvaluation),
      );
      this.restartRecognitionForCurrentMode();
      return;
    }

    this.callbacks?.onProviderSnapshot({
      provider: 'webview2',
      transcript: trimmed,
      latencyMs: 0,
      ok: true,
      detail: buildCueSnapshotDetail('assistant-active', closeEvaluation, isFinal),
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
      closePhrase: this.currentClosePhrase(),
    });
    this.callbacks?.onStatus(reason);
    this.callbacks?.onProviderSnapshot({
      provider: 'webview2',
      transcript,
      latencyMs: 0,
      ok: true,
      detail: [active ? 'assistant-active' : 'assistant-inactive', source, detailSuffix].filter(Boolean).join(' · '),
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

  private currentClosePhrase(): string {
    return `Bye ${this.currentAssistantName()}`;
  }

  private currentRecognitionLanguage(): string {
    if (this.assistantActive) {
      return mapSpeechRecognitionLanguage(this.config?.language ?? 'de');
    }
    return 'en-US';
  }

  private currentWakeThreshold(): number {
    return sanitizeThreshold(this.config?.assistantWakeThreshold, DEFAULT_ASSISTANT_WAKE_THRESHOLD);
  }

  private currentCloseThreshold(): number {
    return sanitizeThreshold(this.config?.assistantCloseThreshold, DEFAULT_ASSISTANT_CLOSE_THRESHOLD);
  }

  private currentCueCooldownMs(): number {
    return sanitizeCooldownMs(this.config?.assistantCueCooldownMs, DEFAULT_ASSISTANT_CUE_COOLDOWN_MS);
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

function sanitizeThreshold(value: number | undefined, fallback: number): number {
  if (!Number.isFinite(value)) {
    return fallback;
  }

  const safeValue = value ?? fallback;
  return Math.round(clamp(safeValue, ASSISTANT_MATCH_THRESHOLD_MIN, ASSISTANT_MATCH_THRESHOLD_MAX));
}

function sanitizeCooldownMs(value: number | undefined, fallback: number): number {
  if (!Number.isFinite(value)) {
    return fallback;
  }

  const safeValue = value ?? fallback;
  return Math.round(clamp(safeValue, 0, ASSISTANT_CUE_COOLDOWN_MS_MAX));
}

function evaluateCuePhrase(options: {
  transcript: string;
  kind: CueKind;
  cueWord: CueWord;
  aiName: string;
  trainedPhrases: string[];
  trainedNameSamples: string[];
  baseThreshold: number;
  isFinal: boolean;
  cooldownRemainingMs: number;
}): CueEvaluation {
  const normalized = normalizeForMatch(options.transcript);
  const threshold = Math.min(
    ASSISTANT_MATCH_THRESHOLD_MAX,
    sanitizeThreshold(options.baseThreshold, options.kind === 'wake' ? DEFAULT_ASSISTANT_WAKE_THRESHOLD : DEFAULT_ASSISTANT_CLOSE_THRESHOLD) +
      (options.isFinal ? 0 : INTERIM_THRESHOLD_BONUS),
  );

  const fallbackEvaluation: CueEvaluation = {
    kind: options.kind,
    matched: false,
    score: 0,
    threshold,
    cueScore: 0,
    nameScore: 0,
    phraseScore: 0,
    sampleScore: 0,
    compactScore: 0,
    bestCandidate: '',
    hasCueEvidence: false,
    hasNameEvidence: false,
    cooldownRemainingMs: options.cooldownRemainingMs,
  };

  if (!normalized) {
    return fallbackEvaluation;
  }

  const expectedPhrase = normalizeForMatch(`${options.cueWord} ${options.aiName}`);
  const compactExpectedPhrase = normalizeCompact(`${options.cueWord} ${options.aiName}`);
  const normalizedPhraseSamples = sanitizeSamples(options.trainedPhrases).map((value) => normalizeForMatch(value)).filter(Boolean);
  const compactPhraseSamples = normalizedPhraseSamples.map((value) => value.replace(/\s+/g, ''));
  const normalizedNameTargets = [
    normalizeForMatch(options.aiName),
    ...sanitizeSamples(options.trainedNameSamples).map((value) => normalizeForMatch(value)),
  ].filter(Boolean);
  const compactNameTargets = normalizedNameTargets.map((value) => value.replace(/\s+/g, ''));

  let bestEvaluation = fallbackEvaluation;
  for (const candidate of buildCandidateWindows(normalized, MAX_CUE_WINDOW_WORDS)) {
    const words = candidate.split(' ');
    const compactCandidate = candidate.replace(/\s+/g, '');
    let cueScore = 0;
    let cueWordIndex = -1;

    for (let index = 0; index < words.length; index += 1) {
      const score = similarity(words[index] ?? '', options.cueWord);
      if (score > cueScore) {
        cueScore = score;
        cueWordIndex = index;
      }
    }

    const nameScore = maxNameSimilarity(
      buildNameCandidates(words, compactCandidate, cueWordIndex, options.cueWord),
      normalizedNameTargets,
      compactNameTargets,
    );
    const phraseScore = similarity(candidate, expectedPhrase);
    const sampleScore = Math.max(
      maxSimilarity(candidate, normalizedPhraseSamples),
      maxSimilarity(compactCandidate, compactPhraseSamples),
    );
    const compactScore = similarity(compactCandidate, compactExpectedPhrase);
    const score = Math.round(
      (
        (cueScore * 0.3) +
        (nameScore * 0.25) +
        (phraseScore * 0.2) +
        (sampleScore * 0.15) +
        (compactScore * 0.1)
      ) * 100,
    );
    const hasCueEvidence = cueScore >= 0.6 || phraseScore >= 0.78 || sampleScore >= 0.82 || compactScore >= 0.82;
    const hasNameEvidence = nameScore >= 0.55 || phraseScore >= 0.78 || compactScore >= 0.82;
    const evaluation: CueEvaluation = {
      kind: options.kind,
      matched: false,
      score,
      threshold,
      cueScore,
      nameScore,
      phraseScore,
      sampleScore,
      compactScore,
      bestCandidate: candidate,
      hasCueEvidence,
      hasNameEvidence,
      cooldownRemainingMs: options.cooldownRemainingMs,
    };

    if (
      evaluation.score > bestEvaluation.score ||
      (evaluation.score === bestEvaluation.score && evaluation.phraseScore > bestEvaluation.phraseScore)
    ) {
      bestEvaluation = evaluation;
    }
  }

  return {
    ...bestEvaluation,
    matched: bestEvaluation.score >= threshold &&
      bestEvaluation.hasCueEvidence &&
      bestEvaluation.hasNameEvidence &&
      bestEvaluation.cooldownRemainingMs <= 0,
  };
}

function buildCandidateWindows(normalized: string, maxWords: number): string[] {
  const words = normalized.split(' ').filter(Boolean);
  const candidates = new Set<string>();

  for (let start = 0; start < words.length; start += 1) {
    for (let take = 1; take <= maxWords && start + take <= words.length; take += 1) {
      candidates.add(words.slice(start, start + take).join(' '));
    }
  }

  candidates.add(normalized);
  return [...candidates];
}

function buildNameCandidates(
  words: string[],
  compactCandidate: string,
  cueWordIndex: number,
  cueWord: CueWord,
): string[] {
  const candidates = new Set<string>();

  if (cueWordIndex >= 0) {
    for (let take = 1; take <= MAX_NAME_WINDOW_WORDS; take += 1) {
      const value = words.slice(cueWordIndex + 1, cueWordIndex + 1 + take).join(' ');
      if (value) {
        candidates.add(value);
      }
    }
  }

  if (compactCandidate.length > cueWord.length) {
    candidates.add(compactCandidate.slice(cueWord.length));
  }

  return [...candidates];
}

function maxNameSimilarity(candidates: string[], normalizedTargets: string[], compactTargets: string[]): number {
  let best = 0;

  for (const candidate of candidates) {
    const normalizedCandidate = normalizeForMatch(candidate);
    const compactCandidate = normalizeCompact(candidate);
    best = Math.max(best, maxSimilarity(normalizedCandidate, normalizedTargets));
    best = Math.max(best, maxSimilarity(compactCandidate, compactTargets));
  }

  return best;
}

function maxSimilarity(value: string, candidates: string[]): number {
  if (!value) {
    return 0;
  }

  let best = 0;
  for (const candidate of candidates) {
    best = Math.max(best, similarity(value, candidate));
  }
  return best;
}

function buildCueSnapshotDetail(stateLabel: string, evaluation: CueEvaluation, isFinal: boolean): string {
  const parts = [
    stateLabel,
    formatCueEvaluationSummary(evaluation),
  ];

  if (!evaluation.hasCueEvidence) {
    parts.push('cue weak');
  }
  if (!evaluation.hasNameEvidence) {
    parts.push('name weak');
  }
  if (evaluation.cooldownRemainingMs > 0) {
    parts.push(`cooldown ${evaluation.cooldownRemainingMs} ms`);
  }

  parts.push(isFinal ? 'final' : 'interim');
  return parts.join(' · ');
}

function formatCueEvaluationSummary(evaluation: CueEvaluation): string {
  const parts = [
    `${evaluation.kind} ${evaluation.score}/${evaluation.threshold}`,
    `cue ${Math.round(evaluation.cueScore * 100)}`,
    `name ${Math.round(evaluation.nameScore * 100)}`,
    `phrase ${Math.round(evaluation.phraseScore * 100)}`,
  ];

  if (evaluation.sampleScore > 0) {
    parts.push(`sample ${Math.round(evaluation.sampleScore * 100)}`);
  }
  if (evaluation.compactScore > 0) {
    parts.push(`compact ${Math.round(evaluation.compactScore * 100)}`);
  }
  if (evaluation.bestCandidate) {
    parts.push(`best "${evaluation.bestCandidate}"`);
  }

  return parts.join(' · ');
}

function normalizeCompact(value: string): string {
  return normalizeForMatch(value).replace(/\s+/g, '');
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

function similarity(a: string, b: string): number {
  if (!a || !b) {
    return 0;
  }

  if (a === b) {
    return 1;
  }

  return 1 - (levenshtein(a, b) / Math.max(a.length, b.length, 1));
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

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
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
