type CueKind = 'wake';
type CueWord = 'hey';

export const DEFAULT_ASSISTANT_WAKE_THRESHOLD = 68;
export const DEFAULT_ASSISTANT_CUE_COOLDOWN_MS = 1200;
export const ASSISTANT_MATCH_THRESHOLD_MIN = 45;
export const ASSISTANT_MATCH_THRESHOLD_MAX = 95;
export const ASSISTANT_CUE_COOLDOWN_MS_MAX = 5000;

const INTERIM_THRESHOLD_BONUS = 8;
const MAX_CUE_WINDOW_WORDS = 5;
const MAX_NAME_WINDOW_WORDS = 3;

export type CueEvaluation = {
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

export function sanitizeAssistantName(value?: string | null): string {
  const trimmed = value?.trim();
  return trimmed ? trimmed : 'AIVA';
}

export function sanitizeSamples(
  samples?: string[] | null,
  max: number = Number.MAX_SAFE_INTEGER,
): string[] {
  return (samples ?? [])
    .map((value) => value.trim())
    .filter(Boolean)
    .slice(0, max);
}

export function sanitizeThreshold(value: number | undefined, fallback: number): number {
  if (!Number.isFinite(value)) {
    return fallback;
  }

  const safeValue = value ?? fallback;
  return Math.round(clamp(safeValue, ASSISTANT_MATCH_THRESHOLD_MIN, ASSISTANT_MATCH_THRESHOLD_MAX));
}

export function sanitizeCooldownMs(value: number | undefined, fallback: number): number {
  if (!Number.isFinite(value)) {
    return fallback;
  }

  const safeValue = value ?? fallback;
  return Math.round(clamp(safeValue, 0, ASSISTANT_CUE_COOLDOWN_MS_MAX));
}

export function evaluateCuePhrase(options: {
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
    sanitizeThreshold(options.baseThreshold, DEFAULT_ASSISTANT_WAKE_THRESHOLD) +
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
  const normalizedPhraseSamples = sanitizeSamples(options.trainedPhrases)
    .map((value) => normalizeForMatch(value))
    .filter(Boolean);
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

    // The wake score mixes explicit cue-word evidence, name similarity, whole-phrase matches,
    // and trained sample matches. This makes the detector tolerant to accent and spacing drift
    // without accepting arbitrary speech as a wake phrase.
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
      ((cueScore * 0.3 +
        nameScore * 0.25 +
        phraseScore * 0.2 +
        sampleScore * 0.15 +
        compactScore * 0.1) *
        100),
    );
    const hasCueEvidence =
      cueScore >= 0.6 || phraseScore >= 0.78 || sampleScore >= 0.82 || compactScore >= 0.82;
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
      (evaluation.score === bestEvaluation.score &&
        evaluation.phraseScore > bestEvaluation.phraseScore)
    ) {
      bestEvaluation = evaluation;
    }
  }

  return {
    ...bestEvaluation,
    matched:
      bestEvaluation.score >= threshold &&
      bestEvaluation.hasCueEvidence &&
      bestEvaluation.hasNameEvidence &&
      bestEvaluation.cooldownRemainingMs <= 0,
  };
}

export function buildCueSnapshotDetail(
  stateLabel: string,
  evaluation: CueEvaluation,
  isFinal: boolean,
): string {
  const parts = [stateLabel, formatCueEvaluationSummary(evaluation)];

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

export function formatCueEvaluationSummary(evaluation: CueEvaluation): string {
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

export function mapSpeechRecognitionLanguage(language: string): string {
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

function maxNameSimilarity(
  candidates: string[],
  normalizedTargets: string[],
  compactTargets: string[],
): number {
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

  return 1 - levenshtein(a, b) / Math.max(a.length, b.length, 1);
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
