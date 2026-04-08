import i18n from '../../i18n.js';
import {
  ASSISTANT_MATCH_THRESHOLD_MAX,
  ASSISTANT_MATCH_THRESHOLD_MIN,
  DEFAULT_ASSISTANT_CUE_COOLDOWN_MS,
  DEFAULT_ASSISTANT_WAKE_THRESHOLD,
  type AssistantStateSnapshot,
  type ProviderSnapshot,
  type SttProviderId,
} from '../liveStt.js';
import type { VoiceFeedItem } from '../realtimeVoiceAgent.js';
import type { AppSettings, HotkeyStatus } from '../voiceOverlay.js';

export type UiState = 'idle' | 'working' | 'success' | 'error';
export type RunHistoryEntry = {
  id: string;
  recordedAtMs: number;
  state: string;
  message: string;
  mode: string;
  requestedMode: string;
  sessionStrategy: string;
  captureDurationMs: number | null;
  captureToTtsStartMs: number | null;
  ttsToFirstAudioMs: number | null;
  firstAudioToPlaybackMs: number | null;
  hotkeyToFirstAudioMs: number | null;
  hotkeyToFirstPlaybackMs: number | null;
};
export type ProviderSnapshotMap = Partial<Record<SttProviderId, ProviderSnapshot>>;
export type CalibrationTarget = 'wake' | 'name';
export type AssistantActivationSource = AssistantStateSnapshot['source'];
export type CalibrationStep = {
  id: string;
  target: CalibrationTarget;
  prompt: string;
  headline: string;
  progress: string;
  recognitionLanguage: string;
};

export const fallbackHotkeyStatus: HotkeyStatus = {
  registered: false,
  accelerator: 'Ctrl+Shift+Space',
  translateAccelerator: 'Ctrl+Shift+T',
  pauseResumeAccelerator: 'Ctrl+Shift+P',
  cancelAccelerator: 'Ctrl+Shift+X',
  activateAccelerator: 'Ctrl+Shift+A',
  deactivateAccelerator: 'Ctrl+Shift+D',
  platform: 'unsupported',
  state: 'registering',
  message: i18n.t('hero.statusChecking'),
};

export function defaultVoiceAgentPreferredLanguage(languageCode: string): string {
  switch (languageCode.trim().toLowerCase()) {
    case 'de':
      return 'German';
    case 'en':
      return 'English';
    case 'fr':
      return 'French';
    case 'es':
      return 'Spanish';
    case 'it':
      return 'Italian';
    case 'pt':
      return 'Portuguese';
    case 'pl':
      return 'Polish';
    case 'nl':
      return 'Dutch';
    case 'tr':
      return 'Turkish';
    case 'ja':
      return 'Japanese';
    default:
      return 'English';
  }
}

export function defaultVoiceAgentExtraInstructions(): string {
  return 'Keep using the stored assistant name unchanged and do not rename yourself.';
}

export const fallbackSettings: AppSettings = {
  ttsMode: 'classic',
  realtimeAllowLiveFallback: false,
  designThemeId: 'obsidian-halo',
  actionBarActiveGlowColor: '#b63131',
  ttsFormat: 'wav',
  firstChunkLeadingSilenceMs: 180,
  uiLanguage: 'en',
  translationTargetLanguage: 'en',
  playbackSpeed: 1,
  openaiApiKey: '',
  aiProviderMode: 'byo',
  hostedApiBaseUrl: '',
  hostedAccountEmail: '',
  hostedAccessToken: '',
  hostedWorkspaceSlug: '',
  sttLanguage: 'de',
  launchAtLogin: false,
  startHiddenOnLaunch: true,
  assistantName: 'Ava',
  voiceAgentModel: 'gpt-realtime',
  voiceAgentVoice: 'marin',
  voiceAgentPersonality: 'Composed, technically precise, friendly, and concise.',
  voiceAgentBehavior:
    'If a PC task is unclear, ask immediately. If something takes longer, acknowledge it briefly and follow up with the result.',
  voiceAgentExtraInstructions: defaultVoiceAgentExtraInstructions(),
  voiceAgentPreferredLanguage: defaultVoiceAgentPreferredLanguage('de'),
  voiceAgentToneNotes: '',
  voiceAgentOnboardingComplete: true,
  assistantWakeSamples: [],
  assistantNameSamples: [],
  assistantSampleLanguage: 'de',
  assistantWakeThreshold: DEFAULT_ASSISTANT_WAKE_THRESHOLD,
  assistantCueCooldownMs: DEFAULT_ASSISTANT_CUE_COOLDOWN_MS,
  actionBarDisplayMode: 'icons-and-text',
};

export function mergeHostedSettings(target: AppSettings, source: AppSettings): AppSettings {
  return {
    ...target,
    aiProviderMode: source.aiProviderMode,
    hostedApiBaseUrl: source.hostedApiBaseUrl,
    hostedAccountEmail: source.hostedAccountEmail,
    hostedAccessToken: source.hostedAccessToken,
    hostedWorkspaceSlug: source.hostedWorkspaceSlug,
  };
}

export function formatTimestamp(value?: number | null): string {
  if (!value) {
    return i18n.t('latestRun.notRecorded', { defaultValue: 'Not recorded' });
  }

  return new Date(value).toLocaleTimeString();
}

export function buildRunHistoryEntry(status: HotkeyStatus): RunHistoryEntry | null {
  if (!['success', 'error', 'idle'].includes(status.state)) {
    return null;
  }

  if (!status.lastAction || status.lastAction !== 'speak') {
    return null;
  }

  if (
    !status.hotkeyToFirstPlaybackMs &&
    !status.hotkeyToFirstAudioMs &&
    !status.captureDurationMs &&
    !status.ttsToFirstAudioMs &&
    !status.message
  ) {
    return null;
  }

  return {
    id: `${status.sessionId ?? 'no-session'}-${status.message}`,
    recordedAtMs: Date.now(),
    state: status.state,
    message: status.message,
    mode: status.activeTtsMode ?? '',
    requestedMode: status.requestedTtsMode ?? '',
    sessionStrategy: status.sessionStrategy ?? '',
    captureDurationMs: status.captureDurationMs ?? null,
    captureToTtsStartMs: status.captureToTtsStartMs ?? null,
    ttsToFirstAudioMs: status.ttsToFirstAudioMs ?? null,
    firstAudioToPlaybackMs: status.firstAudioToPlaybackMs ?? null,
    hotkeyToFirstAudioMs: status.hotkeyToFirstAudioMs ?? null,
    hotkeyToFirstPlaybackMs: status.hotkeyToFirstPlaybackMs ?? null,
  };
}

export function getAssistantNameError(value: string): string | null {
  const trimmed = value.trim();
  if (!trimmed) {
    return i18n.t('validation.assistantNameRequired');
  }
  if (trimmed.length < 3 || trimmed.length > 8) {
    return i18n.t('validation.assistantNameLength');
  }
  if (!/^[A-Za-z0-9]+$/.test(trimmed)) {
    return i18n.t('validation.assistantNameFormat');
  }
  return null;
}

export function normalizeLanguageCode(language: string): string {
  const trimmed = language.trim().toLowerCase();
  return trimmed || 'de';
}

export function isAssistantCalibrationComplete(settings: AppSettings): boolean {
  return (
    settings.assistantWakeSamples.length === 4 &&
    settings.assistantNameSamples.length === 2 &&
    normalizeLanguageCode(settings.assistantSampleLanguage) ===
      normalizeLanguageCode(settings.sttLanguage)
  );
}

export function buildCalibrationSteps(name: string, language: string): CalibrationStep[] {
  const safeName = name.trim() || 'AIVA';
  const recognitionLanguage = mapRecognitionLanguage(language);

  return [
    ...Array.from({ length: 4 }, (_, index) => ({
      id: `wake-${index + 1}`,
      target: 'wake' as const,
      prompt: `Hey ${safeName}`,
      headline: i18n.t('training.stepSay', { defaultValue: 'Please say:' }),
      progress: `${index + 1}/6`,
      recognitionLanguage,
    })),
    {
      id: 'name-1',
      target: 'name',
      prompt: safeName,
      headline: i18n.t('training.stepSayName', {
        defaultValue: 'Please say only the name:',
      }),
      progress: '5/6',
      recognitionLanguage,
    },
    {
      id: 'name-2',
      target: 'name',
      prompt: safeName,
      headline: i18n.t('training.stepSayNameAgain', {
        defaultValue: 'Please say only the name again:',
      }),
      progress: '6/6',
      recognitionLanguage,
    },
  ];
}

export function mapRecognitionLanguage(language: string): string {
  switch (language.trim().toLowerCase()) {
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
      return language || 'en-US';
  }
}

export function parseBoundedInteger(
  value: string,
  fallback: number,
  min: number,
  max: number,
): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) {
    return fallback;
  }

  return Math.min(max, Math.max(min, Math.round(parsed)));
}

export function prependFeedItem(current: VoiceFeedItem[], item: VoiceFeedItem): VoiceFeedItem[] {
  return [item, ...current].slice(0, 40);
}

export function normalizeAssistantSource(value: string): AssistantActivationSource {
  if (value === 'manual' || value === 'hotkey' || value === 'system' || value === 'wake-word') {
    return value;
  }

  return 'system';
}

export function createReadinessItems(options: {
  appStatus: string;
  assistantActive: boolean;
  hotkeyStatus: HotkeyStatus;
  isLiveTranscribing: boolean;
  settings: AppSettings;
  voiceAgentState: string;
}): Array<{ label: string; value: string }> {
  const {
    appStatus,
    assistantActive,
    hotkeyStatus,
    isLiveTranscribing,
    settings,
    voiceAgentState,
  } = options;
  const hotkeyRegistrationState = hotkeyStatus.registered
    ? i18n.t('readiness.active')
    : i18n.t('readiness.inactive');

  return [
    {
      label: i18n.t('readiness.globalSpeakHotkey'),
      value: `${hotkeyStatus.accelerator} - ${hotkeyRegistrationState}`,
    },
    {
      label: i18n.t('readiness.globalTranslateHotkey'),
      value: `${hotkeyStatus.translateAccelerator} - ${hotkeyRegistrationState}`,
    },
    {
      label: i18n.t('readiness.assistantActivateHotkey'),
      value: `${hotkeyStatus.activateAccelerator} - ${hotkeyRegistrationState}`,
    },
    {
      label: i18n.t('readiness.assistantDeactivateHotkey'),
      value: `${hotkeyStatus.deactivateAccelerator} - ${hotkeyRegistrationState}`,
    },
    { label: i18n.t('readiness.assistantName'), value: settings.assistantName },
    {
      label: i18n.t('readiness.assistantState'),
      value: assistantActive ? i18n.t('readiness.active') : i18n.t('readiness.inactive'),
    },
    {
      label: i18n.t('readiness.readTranslateEngine'),
      value: `live - ${settings.playbackSpeed.toFixed(1)}x`,
    },
    { label: i18n.t('readiness.voiceAssistantTransport'), value: 'WebRTC realtime' },
    { label: i18n.t('readiness.voiceSession'), value: voiceAgentState },
    { label: i18n.t('readiness.translationTarget'), value: settings.translationTargetLanguage },
    { label: i18n.t('readiness.sttProvider'), value: 'webview2' },
    {
      label: i18n.t('readiness.liveTranscription'),
      value: isLiveTranscribing ? i18n.t('readiness.running') : i18n.t('readiness.stopped'),
    },
    { label: i18n.t('readiness.currentStatus'), value: appStatus },
  ];
}

export function clampWakeThreshold(value: string, fallback: number): number {
  return parseBoundedInteger(
    value,
    fallback,
    ASSISTANT_MATCH_THRESHOLD_MIN,
    ASSISTANT_MATCH_THRESHOLD_MAX,
  );
}
