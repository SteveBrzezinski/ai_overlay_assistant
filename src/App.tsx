import { useEffect, useMemo, useRef, useState } from 'react';
import { Window, getCurrentWindow } from '@tauri-apps/api/window';
import { applyDesignTheme, DEFAULT_DESIGN_THEME_ID } from './designThemes';
import SettingsView from './SettingsView';

 type RunHistoryEntry = {
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
import {
  appendSttDebugLog,
  captureAndSpeak,
  captureAndTranslate,
  getAppStatus,
  getHotkeyStatus,
  getLanguageOptions,
  getSettings,
  onHotkeyStatus,
  onLiveSttControl,
  resetSettings,
  updateSettings,
  type AppSettings,
  type CreateVoiceAgentSessionResult,
  type HotkeyStatus,
  type LanguageOption,
  type SttDebugEntry,
} from './lib/voiceOverlay';
import {
  ACTION_BAR_WINDOW_LABEL,
  OVERLAY_ACTION_EVENT,
  OVERLAY_COMPOSER_WINDOW_LABEL,
  OVERLAY_STATE_EVENT,
  VOICE_OVERLAY_WINDOW_LABEL,
  type OverlayAction,
  type OverlayState,
} from './lib/overlayBridge';
import {
  DEFAULT_ASSISTANT_CUE_COOLDOWN_MS,
  DEFAULT_ASSISTANT_WAKE_THRESHOLD,
  LiveSttController,
  type AssistantStateSnapshot,
  type ProviderSnapshot,
  type SttProviderId,
} from './lib/liveStt';
import {
  RealtimeVoiceAgentController,
  type VoiceConnectionState,
  type VoiceFeedItem,
} from './lib/realtimeVoiceAgent';

type UiState = 'idle' | 'working' | 'success' | 'error';
type ProviderSnapshotMap = Partial<Record<SttProviderId, ProviderSnapshot>>;
type CalibrationTarget = 'wake' | 'name';
type VoiceOverlayCommand = 'open-chat' | 'open-settings';
type AppView = 'dashboard' | 'settings';
type CalibrationStep = {
  id: string;
  target: CalibrationTarget;
  prompt: string;
  headline: string;
  progress: string;
  recognitionLanguage: string;
};

const fallbackHotkeyStatus: HotkeyStatus = {
  registered: false,
  accelerator: 'Ctrl+Shift+Space',
  translateAccelerator: 'Ctrl+Shift+T',
  pauseResumeAccelerator: 'Ctrl+Shift+P',
  cancelAccelerator: 'Ctrl+Shift+X',
  activateAccelerator: 'Ctrl+Shift+A',
  deactivateAccelerator: 'Ctrl+Shift+D',
  platform: 'unsupported',
  state: 'registering',
  message: 'Checking global hotkeys...',
};

function defaultVoiceAgentPreferredLanguage(languageCode: string): string {
  switch (languageCode.trim().toLowerCase()) {
    case 'de': return 'German';
    case 'en': return 'English';
    case 'fr': return 'French';
    case 'es': return 'Spanish';
    case 'it': return 'Italian';
    case 'pt': return 'Portuguese';
    case 'pl': return 'Polish';
    case 'nl': return 'Dutch';
    case 'tr': return 'Turkish';
    case 'ja': return 'Japanese';
    default: return 'English';
  }
}

function defaultVoiceAgentExtraInstructions(): string {
  return 'Keep using the stored assistant name unchanged and do not rename yourself.';
}

const fallbackSettings: AppSettings = {
  ttsMode: 'classic',
  realtimeAllowLiveFallback: false,
  designThemeId: DEFAULT_DESIGN_THEME_ID,
  launchAtLogin: false,
  startHiddenOnLaunch: true,
  ttsFormat: 'wav',
  firstChunkLeadingSilenceMs: 180,
  translationTargetLanguage: 'en',
  playbackSpeed: 1,
  openaiApiKey: '',
  sttLanguage: 'de',
  assistantName: 'Ava',
  voiceAgentModel: 'gpt-realtime',
  voiceAgentVoice: 'marin',
  voiceAgentPersonality: 'Composed, technically precise, friendly, and concise.',
  voiceAgentBehavior: 'If a PC task is unclear, ask immediately. If something takes longer, acknowledge it briefly and follow up with the result.',
  voiceAgentExtraInstructions: defaultVoiceAgentExtraInstructions(),
  voiceAgentPreferredLanguage: defaultVoiceAgentPreferredLanguage('de'),
  voiceAgentToneNotes: '',
  voiceAgentOnboardingComplete: true,
  assistantWakeSamples: [],
  assistantNameSamples: [],
  assistantSampleLanguage: 'de',
  assistantWakeThreshold: DEFAULT_ASSISTANT_WAKE_THRESHOLD,
  assistantCueCooldownMs: DEFAULT_ASSISTANT_CUE_COOLDOWN_MS,
};

function formatTimestamp(value?: number | null): string {
  if (!value) {
    return 'Not recorded';
  }

  return new Date(value).toLocaleTimeString();
}

function buildRunHistoryEntry(status: HotkeyStatus): RunHistoryEntry | null {
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

function getAssistantNameError(value: string): string | null {
  const trimmed = value.trim();
  if (!trimmed) {
    return 'Please enter an assistant name.';
  }
  if (trimmed.length < 3 || trimmed.length > 8) {
    return 'The assistant name must be 3 to 8 characters long.';
  }
  if (!/^[A-Za-z0-9]+$/.test(trimmed)) {
    return 'Use one single word without spaces or special characters.';
  }
  return null;
}

function normalizeLanguageCode(language: string): string {
  const trimmed = language.trim().toLowerCase();
  return trimmed || 'de';
}

function normalizeCommandText(value: string): string {
  return value
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function includesAny(value: string, candidates: string[]): boolean {
  return candidates.some((candidate) => value.includes(candidate));
}

function detectVoiceOverlayCommand(value: string): VoiceOverlayCommand | null {
  const normalized = normalizeCommandText(value);
  if (!normalized) {
    return null;
  }

  if (!includesAny(normalized, ['open', 'show', 'offne', 'oeffne', 'zeige'])) {
    return null;
  }

  if (includesAny(normalized, ['chat', 'chatfenster', 'chat window', 'textfenster', 'text window'])) {
    return 'open-chat';
  }

  if (includesAny(normalized, ['settings', 'einstellungen', 'preferences'])) {
    return 'open-settings';
  }

  return null;
}

function isAssistantCalibrationComplete(settings: AppSettings): boolean {
  return settings.assistantWakeSamples.length === 4 &&
    settings.assistantNameSamples.length === 2 &&
    normalizeLanguageCode(settings.assistantSampleLanguage) === normalizeLanguageCode(settings.sttLanguage);
}

function buildCalibrationSteps(name: string, language: string): CalibrationStep[] {
  const safeName = name.trim() || 'Ava';
  const recognitionLanguage = mapRecognitionLanguage(language);
  return [
    ...Array.from({ length: 4 }, (_, index) => ({
      id: `wake-${index + 1}`,
      target: 'wake' as const,
      prompt: `Hey ${safeName}`,
      headline: 'Please say:',
      progress: `${index + 1}/6`,
      recognitionLanguage,
    })),
    {
      id: 'name-1',
      target: 'name',
      prompt: safeName,
      headline: 'Please say only the name:',
      progress: '5/6',
      recognitionLanguage,
    },
    {
      id: 'name-2',
      target: 'name',
      prompt: safeName,
      headline: 'Please say only the name again:',
      progress: '6/6',
      recognitionLanguage,
    },
  ];
}

function mapRecognitionLanguage(language: string): string {
  switch (language.trim().toLowerCase()) {
    case 'de': return 'de-DE';
    case 'en': return 'en-US';
    case 'fr': return 'fr-FR';
    case 'es': return 'es-ES';
    case 'it': return 'it-IT';
    case 'pt': return 'pt-PT';
    case 'pl': return 'pl-PL';
    case 'nl': return 'nl-NL';
    case 'tr': return 'tr-TR';
    case 'ja': return 'ja-JP';
    default: return language || 'en-US';
  }
}

function prependFeedItem(current: VoiceFeedItem[], item: VoiceFeedItem): VoiceFeedItem[] {
  return [item, ...current].slice(0, 40);
}

export default function App() {
  const [appStatus, setAppStatus] = useState('Loading status...');
  const [hotkeyStatus, setHotkeyStatus] = useState<HotkeyStatus>(fallbackHotkeyStatus);
  const [settings, setSettings] = useState<AppSettings>(fallbackSettings);
  const [savedSettings, setSavedSettings] = useState<AppSettings>(fallbackSettings);
  const [languageOptions, setLanguageOptions] = useState<LanguageOption[]>([]);
  const [uiState, setUiState] = useState<UiState>('idle');
  const [message, setMessage] = useState('Ready.');
  const [capturedPreview, setCapturedPreview] = useState('');
  const [translatedPreview, setTranslatedPreview] = useState('');
  const [lastAudioPath, setLastAudioPath] = useState('');
  const [lastAudioOutputDirectory, setLastAudioOutputDirectory] = useState('');
  const [lastAudioChunkCount, setLastAudioChunkCount] = useState(0);
  const [lastTtsMode, setLastTtsMode] = useState('');
  const [lastRequestedTtsMode, setLastRequestedTtsMode] = useState('');
  const [lastSessionStrategy, setLastSessionStrategy] = useState('');
  const [lastSessionId, setLastSessionId] = useState('');
  const [lastSessionFallbackReason, setLastSessionFallbackReason] = useState('');
  const [lastSttProvider, setLastSttProvider] = useState('');
  const [lastSttDebugLogPath, setLastSttDebugLogPath] = useState('');
  const [lastSttActiveTranscript, setLastSttActiveTranscript] = useState('');
  const [hotkeyStartedAtMs, setHotkeyStartedAtMs] = useState<number | null>(null);
  const [captureStartedAtMs, setCaptureStartedAtMs] = useState<number | null>(null);
  const [captureFinishedAtMs, setCaptureFinishedAtMs] = useState<number | null>(null);
  const [ttsStartedAtMs, setTtsStartedAtMs] = useState<number | null>(null);
  const [firstAudioReceivedAtMs, setFirstAudioReceivedAtMs] = useState<number | null>(null);
  const [firstAudioPlaybackStartedAtMs, setFirstAudioPlaybackStartedAtMs] = useState<number | null>(null);
  const [startLatencyMs, setStartLatencyMs] = useState<number | null>(null);
  const [hotkeyToFirstAudioMs, setHotkeyToFirstAudioMs] = useState<number | null>(null);
  const [hotkeyToFirstPlaybackMs, setHotkeyToFirstPlaybackMs] = useState<number | null>(null);
  const [captureDurationMs, setCaptureDurationMs] = useState<number | null>(null);
  const [captureToTtsStartMs, setCaptureToTtsStartMs] = useState<number | null>(null);
  const [ttsToFirstAudioMs, setTtsToFirstAudioMs] = useState<number | null>(null);
  const [firstAudioToPlaybackMs, setFirstAudioToPlaybackMs] = useState<number | null>(null);
  const [runHistory, setRunHistory] = useState<RunHistoryEntry[]>([]);
  const [isSavingSettings, setIsSavingSettings] = useState(false);
  const [showResetDialog, setShowResetDialog] = useState(false);
  const [showAssistantTrainingDialog, setShowAssistantTrainingDialog] = useState(false);
  const [assistantTrainingStepIndex, setAssistantTrainingStepIndex] = useState(0);
  const [assistantTrainingTranscript, setAssistantTrainingTranscript] = useState('');
  const [assistantTrainingCapturedTranscript, setAssistantTrainingCapturedTranscript] = useState('');
  const [assistantTrainingStatus, setAssistantTrainingStatus] = useState('');
  const [assistantTrainingError, setAssistantTrainingError] = useState('');
  const [assistantTrainingWakeSamples, setAssistantTrainingWakeSamples] = useState<string[]>([]);
  const [assistantTrainingNameSamples, setAssistantTrainingNameSamples] = useState<string[]>([]);
  const [isAssistantTrainingRecording, setIsAssistantTrainingRecording] = useState(false);
  const [assistantTrainingReadyName, setAssistantTrainingReadyName] = useState<string | null>(null);
  const [isLiveTranscribing, setIsLiveTranscribing] = useState(false);
  const [liveTranscriptionStatus, setLiveTranscriptionStatus] = useState('Live transcription is stopped.');
  const [assistantActive, setAssistantActive] = useState(false);
  const [assistantStateDetail, setAssistantStateDetail] = useState('Listening is stopped.');
  const [assistantWakePhrase, setAssistantWakePhrase] = useState('Hey Ava');
  const [assistantClosePhrase, setAssistantClosePhrase] = useState('Bye Ava');
  const [liveTranscript, setLiveTranscript] = useState('');
  const [sttProviderSnapshots, setSttProviderSnapshots] = useState<ProviderSnapshotMap>({});
  const [liveTranscriptionSessionId, setLiveTranscriptionSessionId] = useState('');
  const [voiceOrbPinned, setVoiceOrbPinned] = useState(false);
  const [composerVisible, setComposerVisible] = useState(false);
  const [didLoadInitialData, setDidLoadInitialData] = useState(false);
  const [voiceAgentState, setVoiceAgentState] = useState<VoiceConnectionState>('idle');
  const [voiceAgentDetail, setVoiceAgentDetail] = useState('Persistent realtime voice session is starting.');
  const [voiceAgentSession, setVoiceAgentSession] = useState<CreateVoiceAgentSessionResult | null>(null);
  const [voiceEventFeed, setVoiceEventFeed] = useState<VoiceFeedItem[]>([]);
  const [voiceTaskFeed, setVoiceTaskFeed] = useState<VoiceFeedItem[]>([]);
  const [activeView, setActiveView] = useState<AppView>('dashboard');
  const [initialStateLoaded, setInitialStateLoaded] = useState(false);
  const [isMainWindowMaximized, setIsMainWindowMaximized] = useState(false);
  const appWindowRef = useRef(getCurrentWindow());
  const liveSttControllerRef = useRef<LiveSttController | null>(null);
  const assistantActiveRef = useRef(false);
  const composerVisibleRef = useRef(false);
  const settingsVisibleRef = useRef(false);
  const liveTranscribingRef = useRef(false);
  const listenerDesiredRunningRef = useRef(false);
  const listenerTransitionRef = useRef<Promise<void> | null>(null);
  const settingsTransitionRef = useRef<Promise<void> | null>(null);
  const composerTransitionRef = useRef<Promise<void> | null>(null);
  const startLiveTranscriptionRef = useRef<(options?: { activateImmediately?: boolean }) => Promise<void>>(async () => undefined);
  const assistantTrainingRecognitionRef = useRef<{ stop: () => void } | null>(null);
  const sttDebugWriteTimerRef = useRef<number | null>(null);
  const realtimeVoiceAgentRef = useRef<RealtimeVoiceAgentController | null>(null);
  const hasAutoStartedLiveRef = useRef(false);
  const lastHandledVoiceCommandRef = useRef<{ command: VoiceOverlayCommand; text: string; handledAtMs: number } | null>(null);

  async function syncMainWindowMaximized(): Promise<void> {
    try {
      setIsMainWindowMaximized(await appWindowRef.current.isMaximized());
    } catch {
      // Window state sync is best-effort for the custom titlebar.
    }
  }

  useEffect(() => {
    void applyDesignTheme(settings.designThemeId, appWindowRef.current);
  }, [settings.designThemeId]);

  useEffect(() => {
    let unlistenResize: (() => void | Promise<void>) | undefined;

    void syncMainWindowMaximized();
    void appWindowRef.current.onResized(() => {
      void syncMainWindowMaximized();
    }).then((cleanup) => {
      unlistenResize = cleanup;
    });

    return () => {
      void unlistenResize?.();
    };
  }, []);

  useEffect(() => {
    void Promise.all([getAppStatus(), getHotkeyStatus(), getSettings(), getLanguageOptions()])
      .then(([status, hotkey, appSettings, languages]) => {
        setAppStatus(status);
        setHotkeyStatus(hotkey);
        setSettings(appSettings);
        setSavedSettings(appSettings);
        setAssistantTrainingReadyName(isAssistantCalibrationComplete(appSettings) ? appSettings.assistantName : null);
        setAssistantWakePhrase(`Hey ${appSettings.assistantName}`);
        setLanguageOptions(languages);
        setMessage(hotkey.message);
        setCapturedPreview(hotkey.lastCapturedText ?? '');
        setTranslatedPreview(hotkey.lastTranslationText ?? '');
        setLastAudioPath(hotkey.lastAudioPath ?? '');
        setLastAudioOutputDirectory(hotkey.lastAudioOutputDirectory ?? '');
        setLastAudioChunkCount(hotkey.lastAudioChunkCount ?? 0);
        setLastTtsMode(hotkey.activeTtsMode ?? '');
        setLastRequestedTtsMode(hotkey.requestedTtsMode ?? '');
        setLastSessionStrategy(hotkey.sessionStrategy ?? '');
        setLastSessionId(hotkey.sessionId ?? '');
        setLastSessionFallbackReason(hotkey.sessionFallbackReason ?? '');
        setLastSttProvider(hotkey.lastSttProvider ?? '');
        setLastSttDebugLogPath(hotkey.lastSttDebugLogPath ?? '');
        setLastSttActiveTranscript(hotkey.lastSttActiveTranscript ?? '');
        setHotkeyStartedAtMs(hotkey.hotkeyStartedAtMs ?? null);
        setCaptureStartedAtMs(hotkey.captureStartedAtMs ?? null);
        setCaptureFinishedAtMs(hotkey.captureFinishedAtMs ?? null);
        setTtsStartedAtMs(hotkey.ttsStartedAtMs ?? null);
        setFirstAudioReceivedAtMs(hotkey.firstAudioReceivedAtMs ?? null);
        setFirstAudioPlaybackStartedAtMs(hotkey.firstAudioPlaybackStartedAtMs ?? null);
        setStartLatencyMs(hotkey.startLatencyMs ?? null);
        setHotkeyToFirstAudioMs(hotkey.hotkeyToFirstAudioMs ?? null);
        setHotkeyToFirstPlaybackMs(hotkey.hotkeyToFirstPlaybackMs ?? null);
        setCaptureDurationMs(hotkey.captureDurationMs ?? null);
        setCaptureToTtsStartMs(hotkey.captureToTtsStartMs ?? null);
        setTtsToFirstAudioMs(hotkey.ttsToFirstAudioMs ?? null);
        setFirstAudioToPlaybackMs(hotkey.firstAudioToPlaybackMs ?? null);
        setDidLoadInitialData(true);
      })
      .catch((error: unknown) => {
        const text = error instanceof Error ? error.message : String(error);
        setAppStatus(`Failed to load status: ${text}`);
        setDidLoadInitialData(true);
      })
      .finally(() => {
        setInitialStateLoaded(true);
      });

    let unlisten: (() => void | Promise<void>) | undefined;
    let unlistenLiveSttControl: (() => void | Promise<void>) | undefined;
    void onHotkeyStatus((status) => {
      setHotkeyStatus(status);
      setMessage(status.message);
      setCapturedPreview(status.lastCapturedText ?? '');
      setTranslatedPreview(status.lastTranslationText ?? '');
      setLastAudioPath(status.lastAudioPath ?? '');
      setLastAudioOutputDirectory(status.lastAudioOutputDirectory ?? '');
      setLastAudioChunkCount(status.lastAudioChunkCount ?? 0);
      setLastTtsMode(status.activeTtsMode ?? '');
      setLastRequestedTtsMode(status.requestedTtsMode ?? '');
      setLastSessionStrategy(status.sessionStrategy ?? '');
      setLastSessionId(status.sessionId ?? '');
      setLastSessionFallbackReason(status.sessionFallbackReason ?? '');
      setLastSttProvider(status.lastSttProvider ?? '');
      setLastSttDebugLogPath(status.lastSttDebugLogPath ?? '');
      setLastSttActiveTranscript(status.lastSttActiveTranscript ?? '');
      setHotkeyStartedAtMs(status.hotkeyStartedAtMs ?? null);
      setCaptureStartedAtMs(status.captureStartedAtMs ?? null);
      setCaptureFinishedAtMs(status.captureFinishedAtMs ?? null);
      setTtsStartedAtMs(status.ttsStartedAtMs ?? null);
      setFirstAudioReceivedAtMs(status.firstAudioReceivedAtMs ?? null);
      setFirstAudioPlaybackStartedAtMs(status.firstAudioPlaybackStartedAtMs ?? null);
      setStartLatencyMs(status.startLatencyMs ?? null);
      setHotkeyToFirstAudioMs(status.hotkeyToFirstAudioMs ?? null);
      setHotkeyToFirstPlaybackMs(status.hotkeyToFirstPlaybackMs ?? null);
      setCaptureDurationMs(status.captureDurationMs ?? null);
      setCaptureToTtsStartMs(status.captureToTtsStartMs ?? null);
      setTtsToFirstAudioMs(status.ttsToFirstAudioMs ?? null);
      setFirstAudioToPlaybackMs(status.firstAudioToPlaybackMs ?? null);
      setUiState(status.state === 'working' ? 'working' : status.state === 'error' ? 'error' : status.state === 'success' ? 'success' : 'idle');

      const historyEntry = buildRunHistoryEntry(status);
      if (historyEntry) {
        setRunHistory((current) => {
          if (current.some((entry) => entry.id === historyEntry.id)) {
            return current;
          }
          return [historyEntry, ...current].slice(0, 8);
        });
      }
    }).then((cleanup) => {
      unlisten = cleanup;
    });

    void onLiveSttControl((event) => {
      if (event.action === 'activate') {
        void activateAssistantVoice('hotkey');
        return;
      }

      void deactivateAssistantVoice('hotkey');
    }).then((cleanup) => {
      unlistenLiveSttControl = cleanup;
    });

    return () => {
      void unlisten?.();
      void unlistenLiveSttControl?.();
    };
  }, []);

  useEffect(() => {
    if (!initialStateLoaded) {
      return;
    }
    void startVoiceAgent();
  }, [initialStateLoaded]);

  useEffect(() => {
    return () => {
      if (sttDebugWriteTimerRef.current !== null) {
        window.clearTimeout(sttDebugWriteTimerRef.current);
      }
      if (realtimeVoiceAgentRef.current) {
        void realtimeVoiceAgentRef.current.disconnect('app-shutdown');
        realtimeVoiceAgentRef.current = null;
      }
      if (liveSttControllerRef.current) {
        void liveSttControllerRef.current.stop();
        liveSttControllerRef.current = null;
      }
      if (assistantTrainingRecognitionRef.current) {
        assistantTrainingRecognitionRef.current.stop();
        assistantTrainingRecognitionRef.current = null;
      }
    };
  }, []);

  useEffect(() => {
    if (!isLiveTranscribing) {
      setAssistantWakePhrase(`Hey ${settings.assistantName || 'Ava'}`);
      setAssistantClosePhrase(`Bye ${settings.assistantName || 'Ava'}`);
    }
  }, [isLiveTranscribing, settings.assistantName]);

  useEffect(() => {
    if (!isLiveTranscribing || !liveTranscriptionSessionId) {
      return;
    }

    const entries: SttDebugEntry[] = Object.values(sttProviderSnapshots)
      .filter((snapshot): snapshot is ProviderSnapshot => Boolean(snapshot))
      .map((snapshot) => ({
        provider: snapshot.provider,
        transcript: snapshot.transcript,
        latencyMs: snapshot.latencyMs,
        ok: snapshot.ok,
        detail: snapshot.detail ?? null,
      }));

    if (!entries.length) {
      return;
    }

    if (sttDebugWriteTimerRef.current !== null) {
      window.clearTimeout(sttDebugWriteTimerRef.current);
    }

    sttDebugWriteTimerRef.current = window.setTimeout(() => {
      void appendSttDebugLog({
        sessionId: liveTranscriptionSessionId,
        selectedProvider: 'webview2',
        activeTranscript: liveTranscript,
        entries,
      })
        .then((result) => setLastSttDebugLogPath(result.debugLogPath))
        .catch((error: unknown) => {
          const text = error instanceof Error ? error.message : String(error);
          setLiveTranscriptionStatus(`Failed to write STT debug log: ${text}`);
        });
    }, 600);

    return () => {
      if (sttDebugWriteTimerRef.current !== null) {
        window.clearTimeout(sttDebugWriteTimerRef.current);
      }
    };
  }, [isLiveTranscribing, liveTranscript, liveTranscriptionSessionId, sttProviderSnapshots]);

  const hasUnsavedChanges = useMemo(
    () => JSON.stringify(settings) !== JSON.stringify(savedSettings),
    [savedSettings, settings],
  );
  const assistantNameError = getAssistantNameError(settings.assistantName);
  const assistantCalibrationRequired = settings.assistantName !== savedSettings.assistantName ||
    normalizeLanguageCode(settings.sttLanguage) !== normalizeLanguageCode(savedSettings.assistantSampleLanguage);
  const assistantCalibrationComplete = isAssistantCalibrationComplete(settings);
  const canSaveSettings = !assistantNameError;
  const assistantCalibrationSteps = useMemo(
    () => buildCalibrationSteps(settings.assistantName, settings.sttLanguage),
    [settings.assistantName, settings.sttLanguage],
  );
  const currentAssistantTrainingStep = assistantCalibrationSteps[assistantTrainingStepIndex] ?? null;

  const persistSettings = async (
    next: AppSettings,
    successMessage = 'Settings saved. Future hotkey runs use the updated values.',
  ): Promise<AppSettings> => {
    const validationError = getAssistantNameError(next.assistantName);
    if (validationError) {
      setUiState('error');
      setMessage(validationError);
      throw new Error(validationError);
    }

    setIsSavingSettings(true);
    try {
      const saved = await updateSettings(next);
      setSettings(saved);
      setSavedSettings(saved);
      setAssistantTrainingReadyName(isAssistantCalibrationComplete(saved) ? saved.assistantName : null);
      try {
        await restartVoiceAgentSession('settings-update', assistantActive);
      } catch (voiceError: unknown) {
        const text = voiceError instanceof Error ? voiceError.message : String(voiceError);
        setVoiceAgentDetail(`Voice session restart failed after settings update: ${text}`);
      }
      setMessage(successMessage);
      return saved;
    } catch (error: unknown) {
      const text = error instanceof Error ? error.message : String(error);
      setUiState('error');
      setMessage(`Failed to save settings: ${text}`);
      throw error;
    } finally {
      setIsSavingSettings(false);
    }
  };

  const ensureSavedSettings = async (): Promise<AppSettings> => {
    if (hasUnsavedChanges) {
      return persistSettings(settings, 'Settings saved. Running with the updated values.');
    }

    return savedSettings;
  };

  const applyAssistantState = (snapshot: AssistantStateSnapshot): void => {
    setAssistantActive(snapshot.active);
    setAssistantWakePhrase(snapshot.wakePhrase);
    setAssistantStateDetail(snapshot.reason);
    setLiveTranscriptionStatus(snapshot.reason);
    if (!snapshot.active) {
      setLiveTranscript('');
      setLastSttActiveTranscript('');
    }
  };

  const processSettingsWindowTransition = async (): Promise<void> => {
    if (settingsTransitionRef.current) {
      await settingsTransitionRef.current;
      return;
    }

    settingsTransitionRef.current = (async () => {
      try {
        while (true) {
          const targetVisible = settingsVisibleRef.current;
          const mainWindow = await Window.getByLabel('main');
          if (!mainWindow) {
            throw new Error('The main dashboard window is not available right now.');
          }

          const isVisible = await mainWindow.isVisible();
          if (isVisible !== targetVisible) {
            if (targetVisible) {
              await mainWindow.show();
              await mainWindow.setFocus();
            } else {
              await mainWindow.hide();
            }
          }

          if (targetVisible === settingsVisibleRef.current) {
            break;
          }
        }
      } finally {
        settingsTransitionRef.current = null;
        if (settingsVisibleRef.current !== false && settingsVisibleRef.current !== true) {
          settingsVisibleRef.current = false;
        }
      }
    })();

    await settingsTransitionRef.current;
  };

  const openSettingsWindow = async (): Promise<void> => {
    const mainWindow = await Window.getByLabel('main');
    if (!mainWindow) {
      throw new Error('The main dashboard window is not available right now.');
    }

    setActiveView('settings');
    settingsVisibleRef.current = true;
    await processSettingsWindowTransition();
    await mainWindow.setFocus();
  };

  const processComposerWindowTransition = async (): Promise<void> => {
    if (composerTransitionRef.current) {
      await composerTransitionRef.current;
      return;
    }

    composerTransitionRef.current = (async () => {
      try {
        while (true) {
          const targetVisible = composerVisibleRef.current;
          const composerWindow = await Window.getByLabel(OVERLAY_COMPOSER_WINDOW_LABEL);

          setComposerVisible(targetVisible);

          if (composerWindow) {
            const isVisible = await composerWindow.isVisible();
            if (isVisible !== targetVisible) {
              if (targetVisible) {
                await composerWindow.show();
                await composerWindow.setFocus();
              } else {
                await composerWindow.hide();
              }
            }
          }

          if (targetVisible === composerVisibleRef.current) {
            break;
          }
        }
      } finally {
        composerTransitionRef.current = null;
      }
    })();

    await composerTransitionRef.current;
  };

  const openComposerWindow = async (): Promise<void> => {
    composerVisibleRef.current = true;
    await processComposerWindowTransition();
  };

  const closeComposerWindow = async (): Promise<void> => {
    composerVisibleRef.current = false;
    await processComposerWindowTransition();
  };

  const toggleComposerWindow = async (): Promise<void> => {
    composerVisibleRef.current = !composerVisibleRef.current;
    await processComposerWindowTransition();
  };

  const processListenerTransition = async (): Promise<void> => {
    if (listenerTransitionRef.current) {
      await listenerTransitionRef.current;
      return;
    }

    listenerTransitionRef.current = (async () => {
      try {
        while (true) {
          const shouldRun = listenerDesiredRunningRef.current;
          const isRunning = liveTranscribingRef.current;

          if (shouldRun !== isRunning) {
            if (shouldRun) {
              await startLiveTranscription();
            } else {
              await stopLiveTranscription();
            }
          }

          if (shouldRun === listenerDesiredRunningRef.current && liveTranscribingRef.current === shouldRun) {
            break;
          }
        }
      } finally {
        listenerTransitionRef.current = null;
        if (listenerDesiredRunningRef.current !== liveTranscribingRef.current) {
          void processListenerTransition();
        }
      }
    })();

    await listenerTransitionRef.current;
  };

  const toggleListenerRunning = async (): Promise<void> => {
    listenerDesiredRunningRef.current = !listenerDesiredRunningRef.current;
    await processListenerTransition();
  };

  const handleVoiceOverlayCommand = async (transcript: string): Promise<boolean> => {
    const command = detectVoiceOverlayCommand(transcript);
    if (!command) {
      return false;
    }

    const normalized = normalizeCommandText(transcript);
    const lastHandled = lastHandledVoiceCommandRef.current;
    if (
      lastHandled &&
      lastHandled.command === command &&
      lastHandled.text === normalized &&
      Date.now() - lastHandled.handledAtMs < 2000
    ) {
      return true;
    }

    lastHandledVoiceCommandRef.current = {
      command,
      text: normalized,
      handledAtMs: Date.now(),
    };

    if (command === 'open-chat') {
      await openComposerWindow();
      setMessage('Voice command recognised: opened the chat window.');
      return true;
    }

    if (command === 'open-settings') {
      await openSettingsWindow();
      setMessage('Voice command recognised: opened the settings page.');
      return true;
    }

    return false;
  };

  const startVoiceAgent = async (): Promise<void> => {
    if (realtimeVoiceAgentRef.current) {
      await realtimeVoiceAgentRef.current.connect();
      return;
    }

    const controller = new RealtimeVoiceAgentController({
      onFeedItem: (item) => {
        if (item.section === 'events') {
          setVoiceEventFeed((current) => prependFeedItem(current, item));
        } else {
          setVoiceTaskFeed((current) => prependFeedItem(current, item));
        }
      },
      onStatus: (status) => {
        setVoiceAgentState(status.state);
        setVoiceAgentDetail(status.detail);
        setVoiceAgentSession(status.session ?? null);
      },
      onAssistantControlRequest: ({ action, reason }) => {
        if (action === 'deactivate') {
          void deactivateAssistantVoice(reason || 'assistant-requested');
        }
      },
    });

    realtimeVoiceAgentRef.current = controller;
    try {
      await controller.connect();
    } catch {
      realtimeVoiceAgentRef.current = null;
    }
  };

  const stopVoiceAgent = async (reason = 'deactivate'): Promise<void> => {
    if (realtimeVoiceAgentRef.current) {
      await realtimeVoiceAgentRef.current.disconnect(reason);
      realtimeVoiceAgentRef.current = null;
    }
    setVoiceAgentState('idle');
    setVoiceAgentDetail('Realtime voice session is idle.');
    setVoiceAgentSession(null);
  };

  const activateAssistantVoice = async (source: 'manual' | 'hotkey' | 'wake-word' | 'system' = 'manual'): Promise<void> => {
    if (liveSttControllerRef.current) {
      liveSttControllerRef.current.manualActivate(source);
      return;
    }

    await startVoiceAgent();
    await realtimeVoiceAgentRef.current?.startListening(source);
    setAssistantActive(true);
    setAssistantStateDetail(`Assistant active. Microphone is live (${source}).`);
    setLiveTranscriptionStatus(`Assistant active. Microphone is live (${source}).`);
  };

  const deactivateAssistantVoice = async (source: 'manual' | 'hotkey' | 'system' | string = 'manual'): Promise<void> => {
    if (liveSttControllerRef.current) {
      liveSttControllerRef.current.manualDeactivate(
        source === 'manual' || source === 'hotkey' || source === 'system'
          ? source
          : 'system',
      );
      await realtimeVoiceAgentRef.current?.mute(source);
      return;
    }

    await realtimeVoiceAgentRef.current?.mute(source);
    setAssistantActive(false);
    setAssistantStateDetail(`Assistant inactive. Realtime session is still connected, but the microphone is muted (${source}).`);
    setLiveTranscriptionStatus(`Assistant inactive. Realtime session is still connected, but the microphone is muted (${source}).`);
    setLiveTranscript('');
    setLastSttActiveTranscript('');
  };

  const restartVoiceAgentSession = async (reason: string, shouldResumeListening: boolean): Promise<void> => {
    const hadController = Boolean(realtimeVoiceAgentRef.current);
    if (hadController) {
      await stopVoiceAgent(reason);
    }
    await startVoiceAgent();
    if (shouldResumeListening) {
      await realtimeVoiceAgentRef.current?.startListening(reason);
    }
  };

  const stopAssistantTrainingRecognition = (): void => {
    if (assistantTrainingRecognitionRef.current) {
      assistantTrainingRecognitionRef.current.stop();
      assistantTrainingRecognitionRef.current = null;
    }
    setIsAssistantTrainingRecording(false);
  };

  const openAssistantTrainingDialog = async (): Promise<void> => {
    if (assistantNameError) {
      setUiState('error');
      setMessage(assistantNameError);
      return;
    }

    if (isLiveTranscribing) {
      await stopLiveTranscription();
    }

    setAssistantTrainingStepIndex(0);
    setAssistantTrainingTranscript('');
    setAssistantTrainingCapturedTranscript('');
    setAssistantTrainingStatus('Click Start, speak the shown phrase, then click Stop.');
    setAssistantTrainingError('');
    setAssistantTrainingWakeSamples([]);
    setAssistantTrainingNameSamples([]);
    setShowAssistantTrainingDialog(true);
  };

  const closeAssistantTrainingDialog = (): void => {
    stopAssistantTrainingRecognition();
    setShowAssistantTrainingDialog(false);
    setAssistantTrainingTranscript('');
    setAssistantTrainingCapturedTranscript('');
    setAssistantTrainingStatus('');
    setAssistantTrainingError('');
  };

  const startAssistantTrainingRecording = (): void => {
    const ctor = (
      window as unknown as {
        SpeechRecognition?: new () => any;
        webkitSpeechRecognition?: new () => any;
      }
    ).SpeechRecognition ?? (
      window as unknown as {
        webkitSpeechRecognition?: new () => any;
      }
    ).webkitSpeechRecognition;

    if (!ctor || !currentAssistantTrainingStep) {
      setAssistantTrainingError('SpeechRecognition is not available in this runtime.');
      return;
    }

    stopAssistantTrainingRecognition();
    setAssistantTrainingTranscript('');
    setAssistantTrainingCapturedTranscript('');
    setAssistantTrainingError('');
    setAssistantTrainingStatus(`Recording ${currentAssistantTrainingStep.prompt}...`);

    const recognition = new ctor();
    recognition.continuous = true;
    recognition.interimResults = true;
    recognition.lang = currentAssistantTrainingStep.recognitionLanguage || mapRecognitionLanguage(settings.sttLanguage);
    recognition.onresult = (event: any) => {
      let transcript = '';
      const startIndex = event.resultIndex ?? 0;
      for (let index = startIndex; index < event.results.length; index += 1) {
        transcript += event.results[index]?.[0]?.transcript ?? '';
      }
      setAssistantTrainingTranscript(transcript.trim());
    };
    recognition.onerror = (event: any) => {
      setAssistantTrainingError(event.error ?? 'Unknown recognition error');
    };
    recognition.onend = () => {
      assistantTrainingRecognitionRef.current = null;
      setIsAssistantTrainingRecording(false);
    };

    assistantTrainingRecognitionRef.current = recognition as { stop: () => void };
    setIsAssistantTrainingRecording(true);
    recognition.start();
  };

  const stopAssistantTrainingRecording = (): void => {
    stopAssistantTrainingRecognition();
    setAssistantTrainingCapturedTranscript(assistantTrainingTranscript.trim());
    setAssistantTrainingStatus(assistantTrainingTranscript.trim() ? 'Recording captured. Confirm or retry.' : 'No transcript captured yet. Please retry.');
  };

  const confirmAssistantTrainingStep = (): void => {
    if (!currentAssistantTrainingStep || !assistantTrainingCapturedTranscript.trim()) {
      return;
    }

    if (currentAssistantTrainingStep.target === 'wake') {
      setAssistantTrainingWakeSamples((current) => [...current, assistantTrainingCapturedTranscript.trim()]);
    } else {
      setAssistantTrainingNameSamples((current) => [...current, assistantTrainingCapturedTranscript.trim()]);
    }

    if (assistantTrainingStepIndex + 1 >= assistantCalibrationSteps.length) {
      const nextSettings: AppSettings = {
        ...settings,
        assistantWakeSamples: [...assistantTrainingWakeSamples, ...(currentAssistantTrainingStep.target === 'wake' ? [assistantTrainingCapturedTranscript.trim()] : [])],
        assistantNameSamples: [...assistantTrainingNameSamples, ...(currentAssistantTrainingStep.target === 'name' ? [assistantTrainingCapturedTranscript.trim()] : [])],
        assistantSampleLanguage: normalizeLanguageCode(settings.sttLanguage),
      };
      setSettings(nextSettings);
      setAssistantTrainingReadyName(nextSettings.assistantName);
      setAssistantTrainingStatus('Wake-word calibration completed. Save settings to persist the recorded samples.');
      setMessage('Assistant calibration captured. Save settings to persist it.');
      closeAssistantTrainingDialog();
      return;
    }

    setAssistantTrainingStepIndex((current) => current + 1);
    setAssistantTrainingTranscript('');
    setAssistantTrainingCapturedTranscript('');
    setAssistantTrainingStatus('Sample saved. Continue with the next recording.');
  };

  const retryAssistantTrainingStep = (): void => {
    setAssistantTrainingTranscript('');
    setAssistantTrainingCapturedTranscript('');
    setAssistantTrainingError('');
    setAssistantTrainingStatus('Retry the same phrase.');
  };

  const runReadSelectedText = async (): Promise<void> => {
    try {
      await ensureSavedSettings();
    } catch {
      return;
    }

    setUiState('working');
    setMessage('Local test run: reading selected text...');
    try {
      const result = await captureAndSpeak(
        { copyDelayMs: 100, restoreClipboard: true },
        {
          autoplay: true,
          maxParallelRequests: 3,
          voice: 'alloy',
        },
      );
      setUiState('success');
      setCapturedPreview(result.capturedText);
      setTranslatedPreview('');
      setLastAudioPath(result.speech.filePath);
      setLastAudioOutputDirectory(result.speech.outputDirectory);
      setLastAudioChunkCount(result.speech.chunkCount);
      setLastTtsMode(result.speech.mode);
      setLastRequestedTtsMode(result.speech.requestedMode);
      setLastSessionStrategy(result.speech.sessionStrategy);
      setLastSessionId(result.speech.sessionId);
      setLastSessionFallbackReason(result.speech.fallbackReason ?? '');
      setFirstAudioReceivedAtMs(result.speech.firstAudioReceivedAtMs ?? null);
      setFirstAudioPlaybackStartedAtMs(result.speech.firstAudioPlaybackStartedAtMs ?? null);
      setStartLatencyMs(result.speech.startLatencyMs ?? null);
      setMessage(
        `Audio ready: fixed live mode, ${result.speech.chunkCount} chunk(s), ${result.speech.format.toUpperCase()} output${result.speech.startLatencyMs ? `, first audible audio after ${result.speech.startLatencyMs} ms` : ''}.`,
      );
    } catch (error: unknown) {
      const text = error instanceof Error ? error.message : String(error);
      setUiState('error');
      setMessage(text);
    }
  };

  const runTranslateSelectedText = async (): Promise<void> => {
    let activeSettings = savedSettings;

    try {
      activeSettings = await ensureSavedSettings();
    } catch {
      return;
    }

    setUiState('working');
    setMessage(`Local test run: translating selected text to ${activeSettings.translationTargetLanguage}...`);
    try {
      const result = await captureAndTranslate(
        { copyDelayMs: 100, restoreClipboard: true },
        { targetLanguage: activeSettings.translationTargetLanguage },
      );
      setUiState('success');
      setCapturedPreview(result.capturedText);
      setTranslatedPreview(result.translation.text);
      setLastAudioPath(result.speech.filePath);
      setLastAudioOutputDirectory(result.speech.outputDirectory);
      setLastAudioChunkCount(result.speech.chunkCount);
      setLastTtsMode(result.speech.mode);
      setLastRequestedTtsMode(result.speech.requestedMode);
      setLastSessionStrategy(result.speech.sessionStrategy);
      setLastSessionId(result.speech.sessionId);
      setLastSessionFallbackReason(result.speech.fallbackReason ?? '');
      setFirstAudioReceivedAtMs(result.speech.firstAudioReceivedAtMs ?? null);
      setFirstAudioPlaybackStartedAtMs(result.speech.firstAudioPlaybackStartedAtMs ?? null);
      setStartLatencyMs(result.speech.startLatencyMs ?? null);
      setMessage(
        `Translation completed (${result.translation.targetLanguage}) in fixed live mode${result.speech.startLatencyMs ? `, first audible audio after ${result.speech.startLatencyMs} ms` : ''}.`,
      );
    } catch (error: unknown) {
      const text = error instanceof Error ? error.message : String(error);
      setUiState('error');
      setMessage(text);
    }
  };

  const startLiveTranscription = async (options?: { activateImmediately?: boolean }): Promise<void> => {
    let activeSettings = savedSettings;

    try {
      activeSettings = await ensureSavedSettings();
    } catch {
      return;
    }

    if (liveSttControllerRef.current) {
      await liveSttControllerRef.current.stop();
    }

    await startVoiceAgent();

    const controller = new LiveSttController();
    liveSttControllerRef.current = controller;
    const sessionId = `stt-live-${Date.now()}`;
    setLiveTranscriptionSessionId(sessionId);
    setSttProviderSnapshots({});
    setLiveTranscript('');
    setLastSttDebugLogPath('');
    setLastSttProvider('webview2');
    setLastSttActiveTranscript('');
    setAssistantWakePhrase(`Hey ${activeSettings.assistantName}`);
    setAssistantStateDetail('Starting wake-word listener...');
    setIsLiveTranscribing(true);
    liveTranscribingRef.current = true;

    try {
      await controller.start(
        {
          language: activeSettings.sttLanguage,
          assistantName: activeSettings.assistantName,
          activateImmediately: options?.activateImmediately,
          wakeSamples: activeSettings.assistantWakeSamples,
          nameSamples: activeSettings.assistantNameSamples,
          assistantWakeThreshold: activeSettings.assistantWakeThreshold,
          assistantCueCooldownMs: activeSettings.assistantCueCooldownMs,
        },
        {
          onStatus: (status) => {
            setLiveTranscriptionStatus(status);
          },
          onAssistantStateChange: (snapshot) => {
            applyAssistantState(snapshot);
            if (snapshot.active) {
              void (async () => {
                await startVoiceAgent();
                await realtimeVoiceAgentRef.current?.startListening(snapshot.source);
              })();
            } else {
              void realtimeVoiceAgentRef.current?.mute(snapshot.source);
            }
          },
          onProviderSnapshot: (snapshot) => {
            setSttProviderSnapshots((current) => ({ ...current, [snapshot.provider]: snapshot }));
            setLastSttProvider(snapshot.provider);
            if (
              snapshot.transcript &&
              snapshot.detail?.startsWith('assistant-active') &&
              !snapshot.detail?.includes('wake-word')
            ) {
              void handleVoiceOverlayCommand(snapshot.transcript).catch((error: unknown) => {
                const text = error instanceof Error ? error.message : String(error);
                setMessage(text);
              });
              setLiveTranscript(snapshot.transcript);
              setLastSttActiveTranscript(snapshot.transcript);
              realtimeVoiceAgentRef.current?.observeExternalUserTranscript(snapshot.transcript);
            }
          },
        },
      );
    } catch (error: unknown) {
      const text = error instanceof Error ? error.message : String(error);
      setIsLiveTranscribing(false);
      liveTranscribingRef.current = false;
      setLiveTranscriptionStatus(`Failed to start live transcription: ${text}`);
    }
  };

  startLiveTranscriptionRef.current = startLiveTranscription;

  useEffect(() => {
    if (!didLoadInitialData || hasAutoStartedLiveRef.current || isLiveTranscribing) {
      return;
    }

    hasAutoStartedLiveRef.current = true;
    void startLiveTranscription().catch(() => {
      hasAutoStartedLiveRef.current = false;
    });
  }, [didLoadInitialData, isLiveTranscribing, savedSettings, startLiveTranscription]);

  const stopLiveTranscription = async (): Promise<void> => {
    await realtimeVoiceAgentRef.current?.mute('stop-live-transcription');
    if (liveSttControllerRef.current) {
      await liveSttControllerRef.current.stop();
      liveSttControllerRef.current = null;
    }
    setIsLiveTranscribing(false);
    liveTranscribingRef.current = false;
    setAssistantActive(false);
    setAssistantStateDetail('Wake-word listener stopped. Realtime session remains connected and muted.');
    setLiveTranscript('');
    setLiveTranscriptionStatus('Live transcription is stopped. Realtime session remains connected and muted.');
  };

  const resetAllSettings = async (): Promise<void> => {
    setShowResetDialog(false);
    setIsSavingSettings(true);
    try {
      const defaults = await resetSettings();
      setSettings(defaults);
      setSavedSettings(defaults);
      setAssistantTrainingReadyName(isAssistantCalibrationComplete(defaults) ? defaults.assistantName : null);
      setMessage('Settings reset to defaults.');
    } catch (error: unknown) {
      const text = error instanceof Error ? error.message : String(error);
      setUiState('error');
      setMessage(`Failed to reset settings: ${text}`);
    } finally {
      setIsSavingSettings(false);
    }
  };

  const readinessItems = useMemo(
    () => [
      { label: 'Global speak hotkey', value: `${hotkeyStatus.accelerator} · ${hotkeyStatus.registered ? 'active' : 'inactive'}` },
      { label: 'Global translate hotkey', value: `${hotkeyStatus.translateAccelerator} · ${hotkeyStatus.registered ? 'active' : 'inactive'}` },
      { label: 'Assistant activate hotkey', value: `${hotkeyStatus.activateAccelerator} · ${hotkeyStatus.registered ? 'active' : 'inactive'}` },
      { label: 'Assistant deactivate hotkey', value: `${hotkeyStatus.deactivateAccelerator} · ${hotkeyStatus.registered ? 'active' : 'inactive'}` },
      { label: 'Assistant name', value: settings.assistantName },
      { label: 'Assistant state', value: assistantActive ? 'active' : 'inactive' },
      { label: 'Read / translate engine', value: `live · ${settings.playbackSpeed.toFixed(1)}x` },
      { label: 'Voice assistant transport', value: 'WebRTC realtime' },
      { label: 'Voice session', value: voiceAgentState },
      { label: 'Translation target', value: settings.translationTargetLanguage },
      { label: 'STT provider', value: 'webview2' },
      { label: 'Live transcription', value: isLiveTranscribing ? 'running' : 'stopped' },
      { label: 'Current status', value: appStatus },
    ],
    [
      appStatus,
      assistantActive,
      hotkeyStatus.accelerator,
      hotkeyStatus.activateAccelerator,
      hotkeyStatus.deactivateAccelerator,
      hotkeyStatus.registered,
      hotkeyStatus.translateAccelerator,
      isLiveTranscribing,
      settings,
      voiceAgentState,
    ],
  );

  const overlayBridgeState: OverlayState = {
    assistantActive,
    isLiveTranscribing,
    voiceOrbPinned,
    composerVisible,
    assistantStateDetail,
    liveTranscriptionStatus,
    assistantWakePhrase,
    assistantClosePhrase,
    statusMessage: message,
    uiState,
  };

  useEffect(() => {
    assistantActiveRef.current = assistantActive;
  }, [assistantActive]);

  useEffect(() => {
    composerVisibleRef.current = composerVisible;
  }, [composerVisible]);

  useEffect(() => {
    liveTranscribingRef.current = isLiveTranscribing;
    if (!listenerTransitionRef.current) {
      listenerDesiredRunningRef.current = isLiveTranscribing;
    }
  }, [isLiveTranscribing]);

  useEffect(() => {
    const appWindow = getCurrentWindow();
    [ACTION_BAR_WINDOW_LABEL, VOICE_OVERLAY_WINDOW_LABEL, OVERLAY_COMPOSER_WINDOW_LABEL].forEach((label) => {
      void appWindow.emitTo<OverlayState>(label, OVERLAY_STATE_EVENT, overlayBridgeState).catch(() => undefined);
    });
  }, [
    assistantActive,
    assistantClosePhrase,
    assistantStateDetail,
    assistantWakePhrase,
    composerVisible,
    isLiveTranscribing,
    liveTranscriptionStatus,
    message,
    voiceOrbPinned,
    uiState,
  ]);

  useEffect(() => {
    void Window.getByLabel(ACTION_BAR_WINDOW_LABEL)
      .then((window) => window?.show())
      .catch(() => undefined);
  }, []);

  useEffect(() => {
    void Window.getByLabel(VOICE_OVERLAY_WINDOW_LABEL)
      .then(async (window) => {
        if (!window) {
          return;
        }

        if (assistantActive || voiceOrbPinned) {
          await window.show();
        } else {
          await window.hide();
        }
      })
      .catch(() => undefined);
  }, [assistantActive, voiceOrbPinned]);

  useEffect(() => {
    const appWindow = getCurrentWindow();
    let unlisten: (() => void | Promise<void>) | undefined;

    void appWindow.listen<OverlayAction>(OVERLAY_ACTION_EVENT, (event) => {
      switch (event.payload.type) {
        case 'request-state':
          [ACTION_BAR_WINDOW_LABEL, VOICE_OVERLAY_WINDOW_LABEL, OVERLAY_COMPOSER_WINDOW_LABEL].forEach((label) => {
            void appWindow.emitTo<OverlayState>(label, OVERLAY_STATE_EVENT, overlayBridgeState).catch(() => undefined);
          });
          break;
        case 'toggle-live':
          listenerDesiredRunningRef.current = !listenerDesiredRunningRef.current;
          void processListenerTransition();
          break;
        case 'toggle-listener':
          void toggleListenerRunning();
          break;
        case 'activate':
          void activateAssistantVoice('manual').catch((error: unknown) => {
            const text = error instanceof Error ? error.message : String(error);
            setMessage(text);
          });
          break;
        case 'deactivate':
          void deactivateAssistantVoice('manual').catch((error: unknown) => {
            const text = error instanceof Error ? error.message : String(error);
            setMessage(text);
          });
          break;
        case 'toggle-composer':
          void toggleComposerWindow().catch((error: unknown) => {
            const text = error instanceof Error ? error.message : String(error);
            setMessage(text);
          });
          break;
        case 'close-composer':
          void closeComposerWindow().catch((error: unknown) => {
            const text = error instanceof Error ? error.message : String(error);
            setMessage(text);
          });
          break;
        case 'open-settings':
          void openSettingsWindow().catch((error: unknown) => {
            const text = error instanceof Error ? error.message : String(error);
            setMessage(text);
          });
          break;
        case 'pin-voice-orb':
          setVoiceOrbPinned(true);
          break;
        case 'unpin-voice-orb':
          setVoiceOrbPinned(false);
          break;
      }
    }).then((cleanup) => {
      unlisten = cleanup;
    });

    return () => {
      void unlisten?.();
    };
  }, [
    assistantActive,
    assistantClosePhrase,
    assistantStateDetail,
    assistantWakePhrase,
    closeComposerWindow,
    composerVisible,
    isLiveTranscribing,
    liveTranscriptionStatus,
    message,
    openSettingsWindow,
    startLiveTranscription,
    stopLiveTranscription,
    toggleComposerWindow,
    voiceOrbPinned,
    uiState,
  ]);

  const handleWindowMinimize = async (): Promise<void> => {
    await appWindowRef.current.minimize();
  };

  const handleWindowMaximizeToggle = async (): Promise<void> => {
    await appWindowRef.current.toggleMaximize();
    await syncMainWindowMaximized();
  };

  const handleWindowClose = async (): Promise<void> => {
    try {
      await appWindowRef.current.close();
    } catch {
      await appWindowRef.current.hide();
    }
  };

  return (
    <>
      <div className={`app-frame ${isMainWindowMaximized ? 'app-frame--maximized' : ''}`}>
        <header className="window-titlebar">
          <div
            className="window-titlebar__drag"
            data-tauri-drag-region
            onDoubleClick={() => void handleWindowMaximizeToggle()}
          >
            <span className="window-titlebar__mark" aria-hidden="true" />
            <span className="window-titlebar__title">Voice Overlay Assistant</span>
          </div>
          <div className="window-titlebar__controls" aria-label="Window controls">
            <button
              type="button"
              className="window-titlebar__control"
              aria-label="Minimize window"
              onClick={() => void handleWindowMinimize()}
            >
              <svg viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round">
                <path d="M2 9.2h8" />
              </svg>
            </button>
            <button
              type="button"
              className="window-titlebar__control"
              aria-label={isMainWindowMaximized ? 'Restore window' : 'Maximize window'}
              onClick={() => void handleWindowMaximizeToggle()}
            >
              <svg viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinejoin="round">
                {isMainWindowMaximized ? (
                  <>
                    <path d="M3 4.2h5.2V9.4H3z" />
                    <path d="M4.8 2.6H10v5.2" />
                  </>
                ) : (
                  <path d="M2.6 2.6h6.8v6.8H2.6z" />
                )}
              </svg>
            </button>
            <button
              type="button"
              className="window-titlebar__control window-titlebar__control--close"
              aria-label="Hide window"
              onClick={() => void handleWindowClose()}
            >
              <svg viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round">
                <path d="M2.5 2.5l7 7" />
                <path d="M9.5 2.5l-7 7" />
              </svg>
            </button>
          </div>
        </header>

        <main className="app-shell">
        {activeView === 'dashboard' ? (
          <>
            <section className="hero-card">
              <div className="hero-toolbar">
                <div className="status-row">
                  <span className="status-dot" aria-hidden="true" />
                  <span className="status-text">{hotkeyStatus.registered ? 'Global hotkeys active' : 'Checking global hotkeys'}</span>
                </div>
                <button type="button" className="toolbar-button" onClick={() => void openSettingsWindow()}>
                  <span className="toolbar-button__icon" aria-hidden="true">
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                      <circle cx="12" cy="12" r="3" />
                      <path d="M19.4 15a1.7 1.7 0 0 0 .34 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.7 1.7 0 0 0-1.82-.34 1.7 1.7 0 0 0-1 1.52V21a2 2 0 1 1-4 0v-.09a1.7 1.7 0 0 0-1-1.52 1.7 1.7 0 0 0-1.82.34l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.7 1.7 0 0 0 .34-1.82 1.7 1.7 0 0 0-1.52-1H3a2 2 0 1 1 0-4h.09a1.7 1.7 0 0 0 1.52-1 1.7 1.7 0 0 0-.34-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.7 1.7 0 0 0 1.82.34h.01a1.7 1.7 0 0 0 .99-1.52V3a2 2 0 1 1 4 0v.09a1.7 1.7 0 0 0 .99 1.52h.01a1.7 1.7 0 0 0 1.82-.34l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.7 1.7 0 0 0-.34 1.82v.01a1.7 1.7 0 0 0 1.52.99H21a2 2 0 1 1 0 4h-.09a1.7 1.7 0 0 0-1.52.99z" />
                    </svg>
                  </span>
                  <span className="toolbar-button__label">Settings</span>
                </button>
              </div>
              <h1>Voice Overlay Assistant</h1>
              <p className="hero-copy">
                Two existing flows share one stable base: <strong>{hotkeyStatus.accelerator}</strong> reads selected text aloud,
                <strong> {hotkeyStatus.translateAccelerator}</strong> captures selected text, translates it, and keeps the result visible in the UI.
              </p>
              <div className="actions">
                <button
                  type="button"
                  className="primary-button"
                  disabled={uiState === 'working' || isSavingSettings}
                  onClick={() => void runReadSelectedText()}
                >
                  {uiState === 'working' ? 'Working...' : 'Local speech test'}
                </button>
                <button
                  type="button"
                  className="secondary-button"
                  disabled={uiState === 'working' || isSavingSettings}
                  onClick={() => void runTranslateSelectedText()}
                >
                  Local translation test
                </button>
                <button
                  type="button"
                  className="secondary-button"
                  disabled={isSavingSettings}
                  onClick={() => void (isLiveTranscribing ? stopLiveTranscription() : startLiveTranscription())}
                >
                  {isLiveTranscribing ? 'Stop live transcription' : 'Start live transcription'}
                </button>
                <button
                  type="button"
                  className="secondary-button"
                  disabled={isSavingSettings || assistantActive || voiceAgentState === 'connecting'}
                  onClick={() => void activateAssistantVoice('manual')}
                >
                  Activate assistant
                </button>
                <button
                  type="button"
                  className="secondary-button"
                  disabled={isSavingSettings || !assistantActive}
                  onClick={() => void deactivateAssistantVoice('manual')}
                >
                  Deactivate assistant
                </button>
              </div>
            </section>

            <section className="panel-grid" aria-label="Project status">
              {readinessItems.map((item) => (
                <article className="info-card" key={item.label}>
                  <span className="info-label">{item.label}</span>
                  <strong>{item.value}</strong>
                </article>
              ))}
            </section>
          </>
        ) : (
          <SettingsView
            settings={settings}
            setSettings={setSettings}
            languageOptions={languageOptions}
            assistantNameError={assistantNameError}
            assistantCalibrationRequired={assistantCalibrationRequired}
            assistantCalibrationComplete={assistantCalibrationComplete}
            assistantTrainingReadyName={assistantTrainingReadyName}
            isSavingSettings={isSavingSettings}
            isWorking={uiState === 'working'}
            hasUnsavedChanges={hasUnsavedChanges}
            canSaveSettings={canSaveSettings}
            onSave={() => persistSettings(settings)}
            onReset={() => setShowResetDialog(true)}
            onBack={() => setActiveView('dashboard')}
            onOpenTraining={openAssistantTrainingDialog}
            normalizeLanguageCode={normalizeLanguageCode}
          />
        )}

        {activeView === 'dashboard' ? (
          <>

        <section className={`result-card result-card--${voiceAgentState === 'error' ? 'error' : assistantActive ? 'working' : 'success'}`}>
          <div>
            <span className="info-label">Wake / voice assistant</span>
            <strong>{liveTranscriptionStatus}</strong>
          </div>
          <div className="result-block">
            <span className="info-label">Assistant state</span>
            <p>{assistantActive ? 'Assistant is active.' : isLiveTranscribing ? 'Assistant is inactive and listening for the wake phrase.' : 'Assistant is inactive. The Realtime session stays online, but the microphone is muted.'}</p>
            <span className="field-note">{assistantStateDetail}</span>
          </div>
          <div className="result-block">
            <span className="info-label">Realtime voice session</span>
            <p>{voiceAgentState}</p>
            <span className="field-note">{voiceAgentDetail}</span>
            {voiceAgentSession ? (
              <span className="field-note">
                {voiceAgentSession.profile.model} · {voiceAgentSession.profile.voice} · {voiceAgentSession.assistantState.sourceAssistantName}
              </span>
            ) : null}
          </div>
          <div className="result-block">
            <span className="info-label">Wake phrase</span>
            <p><strong>{assistantWakePhrase}</strong></p>
            <span className="field-note">WebView2 listens only for the wake phrase. The Realtime WebRTC session stays connected in the background, and only the microphone uplink is toggled on activation.</span>
          </div>
          <div className="result-block">
            <span className="info-label">Cue matching</span>
            <p>Wake {settings.assistantWakeThreshold}/100 · Cooldown {settings.assistantCueCooldownMs} ms</p>
            <span className="field-note">Recognition status shows the current fuzzy wake score, component hints, and best matching fragment for tuning.</span>
          </div>
          <div className="result-block">
            <span className="info-label">Active transcript</span>
            <p>{liveTranscript || (assistantActive ? 'No transcript yet.' : isLiveTranscribing ? 'Waiting for wake phrase...' : 'Microphone muted. Start live transcription for wake-word listening or activate the assistant manually.')}</p>
          </div>
          {Object.values(sttProviderSnapshots).length ? (
            <div className="result-block">
              <span className="info-label">Recognition status</span>
              <div className="stt-provider-grid">
                {Object.values(sttProviderSnapshots).filter((snapshot): snapshot is ProviderSnapshot => Boolean(snapshot)).map((snapshot) => (
                  <article className="stt-provider-card" key={snapshot.provider}>
                    <strong>{snapshot.provider}</strong>
                    <p>{snapshot.transcript || 'No transcript payload for this event.'}</p>
                    <span className="field-note">
                      {snapshot.ok ? `ok · ${snapshot.latencyMs} ms` : 'error'}
                      {snapshot.detail ? ` · ${snapshot.detail}` : ''}
                    </span>
                  </article>
                ))}
              </div>
            </div>
          ) : null}
          {lastSttDebugLogPath ? <div className="result-block"><span className="info-label">Live STT debug log</span><code>{lastSttDebugLogPath}</code></div> : null}
        </section>

        <section className="feed-grid">
          <article className="feed-card">
            <div className="feed-header">
              <span className="info-label">Realtime event feed</span>
              <strong>{voiceAgentState}</strong>
            </div>
            <div className="feed-list">
              {voiceEventFeed.length ? voiceEventFeed.map((item) => (
                <article className={`feed-item feed-item--${item.kind}`} key={item.id}>
                  <strong>{item.title}</strong>
                  <pre>{item.body}</pre>
                  <small>{new Date(item.timestampMs).toLocaleTimeString()}</small>
                </article>
              )) : (
                <p className="feed-empty">No realtime WebRTC events yet.</p>
              )}
            </div>
          </article>

          <article className="feed-card">
            <div className="feed-header">
              <span className="info-label">Tool / task feed</span>
              <strong>{voiceTaskFeed.length}</strong>
            </div>
            <div className="feed-list">
              {voiceTaskFeed.length ? voiceTaskFeed.map((item) => (
                <article className={`feed-item feed-item--${item.kind}`} key={item.id}>
                  <strong>{item.title}</strong>
                  <pre>{item.body}</pre>
                  <small>{new Date(item.timestampMs).toLocaleTimeString()}</small>
                </article>
              )) : (
                <p className="feed-empty">No tool calls or background tasks yet.</p>
              )}
            </div>
          </article>
        </section>

        <section className={`result-card result-card--${uiState}`}>
          <div>
            <span className="info-label">Latest run / hotkey status</span>
            <strong>{message}</strong>
          </div>
          {capturedPreview ? <div className="result-block"><span className="info-label">Captured text</span><p>{capturedPreview}</p></div> : null}
          {translatedPreview ? <div className="result-block"><span className="info-label">Translation</span><p>{translatedPreview}</p></div> : null}
          {lastTtsMode ? <div className="result-block"><span className="info-label">Resolved TTS mode</span><strong>{lastTtsMode}</strong></div> : null}
          {lastRequestedTtsMode ? <div className="result-block"><span className="info-label">Requested TTS mode</span><strong>{lastRequestedTtsMode}</strong></div> : null}
          {lastSessionStrategy ? <div className="result-block"><span className="info-label">Session strategy</span><p>{lastSessionStrategy}</p><code>{lastSessionId}</code></div> : null}
          {lastSessionFallbackReason ? <div className="result-block"><span className="info-label">Session fallback</span><p>{lastSessionFallbackReason}</p></div> : null}
          {lastSttProvider ? <div className="result-block"><span className="info-label">Last STT provider</span><strong>{lastSttProvider}</strong></div> : null}
          {lastSttActiveTranscript ? <div className="result-block"><span className="info-label">Last STT transcript</span><p>{lastSttActiveTranscript}</p></div> : null}
          {lastSttDebugLogPath ? <div className="result-block"><span className="info-label">STT debug log</span><code>{lastSttDebugLogPath}</code></div> : null}
          {startLatencyMs !== null ? <div className="result-block"><span className="info-label">Visible start latency</span><strong>{startLatencyMs} ms</strong></div> : null}
          {(hotkeyToFirstPlaybackMs !== null || hotkeyToFirstAudioMs !== null) ? (
            <div className="result-block">
              <span className="info-label">End-to-end latency</span>
              {hotkeyToFirstAudioMs !== null ? <p>Hotkey → first audio received: {hotkeyToFirstAudioMs} ms</p> : null}
              {hotkeyToFirstPlaybackMs !== null ? <p>Hotkey → first audible playback: {hotkeyToFirstPlaybackMs} ms</p> : null}
            </div>
          ) : null}
          {(captureDurationMs !== null || captureToTtsStartMs !== null || ttsToFirstAudioMs !== null || firstAudioToPlaybackMs !== null) ? (
            <div className="result-block">
              <span className="info-label">Latency breakdown</span>
              {captureDurationMs !== null ? <p>Capture duration: {captureDurationMs} ms</p> : null}
              {captureToTtsStartMs !== null ? <p>Capture → TTS start: {captureToTtsStartMs} ms</p> : null}
              {ttsToFirstAudioMs !== null ? <p>TTS start → first audio: {ttsToFirstAudioMs} ms</p> : null}
              {firstAudioToPlaybackMs !== null ? <p>First audio → audible playback: {firstAudioToPlaybackMs} ms</p> : null}
            </div>
          ) : null}
          {(hotkeyStartedAtMs || captureStartedAtMs || captureFinishedAtMs || ttsStartedAtMs || firstAudioReceivedAtMs || firstAudioPlaybackStartedAtMs) ? (
            <div className="result-block">
              <span className="info-label">Audio start timeline</span>
              {hotkeyStartedAtMs ? <p>Hotkey received: {formatTimestamp(hotkeyStartedAtMs)}</p> : null}
              {captureStartedAtMs ? <p>Capture started: {formatTimestamp(captureStartedAtMs)}</p> : null}
              {captureFinishedAtMs ? <p>Capture finished: {formatTimestamp(captureFinishedAtMs)}</p> : null}
              {ttsStartedAtMs ? <p>TTS pipeline started: {formatTimestamp(ttsStartedAtMs)}</p> : null}
              {firstAudioReceivedAtMs ? <p>First audio received: {formatTimestamp(firstAudioReceivedAtMs)}</p> : null}
              {firstAudioPlaybackStartedAtMs ? <p>First audible playback: {formatTimestamp(firstAudioPlaybackStartedAtMs)}</p> : null}
            </div>
          ) : null}
          {lastAudioPath ? <div className="result-block"><span className="info-label">Audio output</span><code>{lastAudioChunkCount > 1 ? lastAudioOutputDirectory : lastAudioPath}</code></div> : null}
        </section>

        {runHistory.length ? (
          <section className="instructions-card">
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: '1rem' }}>
              <span className="info-label">Recent run history</span>
              <button type="button" className="secondary-button" onClick={() => setRunHistory([])}>
                Clear history
              </button>
            </div>
            <div className="result-block">
              {runHistory.map((entry) => (
                <div key={entry.id} style={{ padding: '0.75rem 0', borderTop: '1px solid rgba(255,255,255,0.08)' }}>
                  <p><strong>{entry.mode || 'unknown'}</strong>{entry.requestedMode ? ` · requested ${entry.requestedMode}` : ''}{entry.sessionStrategy ? ` · ${entry.sessionStrategy}` : ''}</p>
                  <p>{new Date(entry.recordedAtMs).toLocaleTimeString()} · {entry.message}</p>
                  <p>
                    hotkey→audio {entry.hotkeyToFirstPlaybackMs ?? '—'} ms · capture {entry.captureDurationMs ?? '—'} ms · capture→tts {entry.captureToTtsStartMs ?? '—'} ms · tts→audio {entry.ttsToFirstAudioMs ?? '—'} ms · audio→playback {entry.firstAudioToPlaybackMs ?? '—'} ms
                  </p>
                </div>
              ))}
            </div>
          </section>
        ) : null}

        <section className="instructions-card">
          <span className="info-label">Usage</span>
          <ol>
            <li>Keep the app running in the background.</li>
            <li>Use <strong>Start live transcription</strong> when you want continuous local wake-word listening via WebView2.</li>
            <li>Say <strong>{assistantWakePhrase}</strong> or click <strong>Activate assistant</strong> to switch the Realtime session to <strong>online_listening</strong> and enable the microphone uplink.</li>
            <li>Let the assistant close itself naturally after the current turn, or use <strong>{hotkeyStatus.activateAccelerator}</strong> / <strong>{hotkeyStatus.deactivateAccelerator}</strong> or the buttons to return to <strong>online_muted</strong>.</li>
            <li>Select text in another Windows app when you want to test the separate read-aloud or translate+read flows.</li>
            <li><strong>{hotkeyStatus.accelerator}</strong> reads it aloud, while <strong>{hotkeyStatus.translateAccelerator}</strong> translates it and speaks the translation.</li>
          </ol>
        </section>
          </>
        ) : null}
        </main>
      </div>

      {showAssistantTrainingDialog && currentAssistantTrainingStep ? (
        <div className="modal-backdrop" role="presentation" onClick={closeAssistantTrainingDialog}>
          <section
            className="modal-card modal-card--wide"
            role="dialog"
            aria-modal="true"
            aria-labelledby="assistant-training-title"
            onClick={(event) => event.stopPropagation()}
          >
            <button type="button" className="modal-close" aria-label="Close assistant training dialog" onClick={closeAssistantTrainingDialog}>
              x
            </button>
            <h2 id="assistant-training-title">Assistant wake-word training</h2>
            <p>{currentAssistantTrainingStep.progress}) {currentAssistantTrainingStep.headline}</p>
            <div className="training-phrase-box">
              <strong>{currentAssistantTrainingStep.prompt}</strong>
            </div>
            <p className="field-note">Live transcription is paused while calibration is open. Click Start, say the phrase, click Stop, then confirm or retry. Training currently uses <code>{currentAssistantTrainingStep.recognitionLanguage}</code>.</p>
            <div className="modal-actions">
              <button type="button" className="primary-button" disabled={isAssistantTrainingRecording} onClick={startAssistantTrainingRecording}>
                Start
              </button>
              <button type="button" className="secondary-button" disabled={!isAssistantTrainingRecording} onClick={stopAssistantTrainingRecording}>
                Stop
              </button>
              <button type="button" className="secondary-button" disabled={!assistantTrainingCapturedTranscript.trim()} onClick={retryAssistantTrainingStep}>
                Retry
              </button>
              <button type="button" className="secondary-button" disabled={!assistantTrainingCapturedTranscript.trim()} onClick={confirmAssistantTrainingStep}>
                Confirm
              </button>
            </div>
            <div className="result-block">
              <span className="info-label">Live capture</span>
              <p>{assistantTrainingTranscript || 'No transcript yet.'}</p>
            </div>
            <div className="result-block">
              <span className="info-label">Captured sample</span>
              <p>{assistantTrainingCapturedTranscript || 'Stop the recording to review the captured phrase.'}</p>
            </div>
            {assistantTrainingStatus ? <p className="field-note">{assistantTrainingStatus}</p> : null}
            {assistantTrainingError ? <p className="field-note field-note--error">{assistantTrainingError}</p> : null}
          </section>
        </div>
      ) : null}

      {showResetDialog ? (
        <div className="modal-backdrop" role="presentation" onClick={() => setShowResetDialog(false)}>
          <section
            className="modal-card"
            role="dialog"
            aria-modal="true"
            aria-labelledby="reset-settings-title"
            onClick={(event) => event.stopPropagation()}
          >
            <button type="button" className="modal-close" aria-label="Close reset dialog" onClick={() => setShowResetDialog(false)}>
              x
            </button>
            <h2 id="reset-settings-title">Reset all settings?</h2>
            <p>This restores every setting to its default value, including playback speed, translation language, and the stored API key.</p>
            <div className="modal-actions">
              <button type="button" className="secondary-button" onClick={() => setShowResetDialog(false)}>
                No
              </button>
              <button type="button" className="danger-button" onClick={() => void resetAllSettings()}>
                Yes, reset everything
              </button>
            </div>
          </section>
        </div>
      ) : null}
    </>
  );
}
