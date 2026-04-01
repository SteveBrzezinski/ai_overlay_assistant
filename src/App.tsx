import { useEffect, useMemo, useRef, useState } from 'react';

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
  ASSISTANT_CUE_COOLDOWN_MS_MAX,
  ASSISTANT_MATCH_THRESHOLD_MAX,
  ASSISTANT_MATCH_THRESHOLD_MIN,
  DEFAULT_ASSISTANT_CLOSE_THRESHOLD,
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
type CalibrationTarget = 'wake' | 'close' | 'name';
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

const fallbackSettings: AppSettings = {
  translationTargetLanguage: 'en',
  playbackSpeed: 1,
  openaiApiKey: '',
  sttLanguage: 'de',
  assistantName: 'AIVA',
  voiceAgentModel: 'gpt-realtime',
  voiceAgentVoice: 'marin',
  voiceAgentPersonality: 'Souveraen, technisch praezise, freundlich und knapp.',
  voiceAgentBehavior: 'Wenn eine PC-Aufgabe unklar ist, frage sofort nach. Wenn etwas laenger dauert, kuendige es kurz an und melde dich spaeter mit dem Ergebnis.',
  voiceAgentExtraInstructions: 'Sprich standardmaessig Deutsch. Verwende den gespeicherten Assistant-Namen unveraendert und nenne dich nicht anders.',
  voiceAgentPreferredLanguage: 'Deutsch',
  voiceAgentToneNotes: '',
  voiceAgentOnboardingComplete: true,
  assistantWakeSamples: [],
  assistantCloseSamples: [],
  assistantNameSamples: [],
  assistantSampleLanguage: 'de',
  assistantWakeThreshold: DEFAULT_ASSISTANT_WAKE_THRESHOLD,
  assistantCloseThreshold: DEFAULT_ASSISTANT_CLOSE_THRESHOLD,
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
  if (trimmed.length < 4 || trimmed.length > 8) {
    return 'The assistant name must be 4 to 8 characters long.';
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

function isAssistantCalibrationComplete(settings: AppSettings): boolean {
  return settings.assistantWakeSamples.length === 4 &&
    settings.assistantCloseSamples.length === 4 &&
    settings.assistantNameSamples.length === 2 &&
    normalizeLanguageCode(settings.assistantSampleLanguage) === normalizeLanguageCode(settings.sttLanguage);
}

function buildCalibrationSteps(name: string, language: string): CalibrationStep[] {
  const safeName = name.trim() || 'AIVA';
  const recognitionLanguage = mapRecognitionLanguage(language);
  return [
    ...Array.from({ length: 4 }, (_, index) => ({
      id: `wake-${index + 1}`,
      target: 'wake' as const,
      prompt: `Hey ${safeName}`,
      headline: 'Bitte sagen sie:',
      progress: `${index + 1}/4`,
      recognitionLanguage,
    })),
    {
      id: 'name-1',
      target: 'name',
      prompt: safeName,
      headline: 'Bitte sagen sie nur den Namen:',
      progress: '1/2',
      recognitionLanguage,
    },
    ...Array.from({ length: 4 }, (_, index) => ({
      id: `close-${index + 1}`,
      target: 'close' as const,
      prompt: `Bye ${safeName}`,
      headline: 'Bitte sagen sie:',
      progress: `${index + 1}/4`,
      recognitionLanguage,
    })),
    {
      id: 'name-2',
      target: 'name',
      prompt: safeName,
      headline: 'Bitte sagen sie nur den Namen erneut:',
      progress: '2/2',
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

function parseBoundedInteger(value: string, fallback: number, min: number, max: number): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) {
    return fallback;
  }

  return Math.min(max, Math.max(min, Math.round(parsed)));
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
  const [assistantTrainingCloseSamples, setAssistantTrainingCloseSamples] = useState<string[]>([]);
  const [assistantTrainingNameSamples, setAssistantTrainingNameSamples] = useState<string[]>([]);
  const [isAssistantTrainingRecording, setIsAssistantTrainingRecording] = useState(false);
  const [assistantTrainingReadyName, setAssistantTrainingReadyName] = useState<string | null>(null);
  const [isLiveTranscribing, setIsLiveTranscribing] = useState(false);
  const [liveTranscriptionStatus, setLiveTranscriptionStatus] = useState('Live transcription is stopped.');
  const [assistantActive, setAssistantActive] = useState(false);
  const [assistantStateDetail, setAssistantStateDetail] = useState('Listening is stopped.');
  const [assistantWakePhrase, setAssistantWakePhrase] = useState('Hey AIVA');
  const [assistantClosePhrase, setAssistantClosePhrase] = useState('Bye AIVA');
  const [liveTranscript, setLiveTranscript] = useState('');
  const [sttProviderSnapshots, setSttProviderSnapshots] = useState<ProviderSnapshotMap>({});
  const [liveTranscriptionSessionId, setLiveTranscriptionSessionId] = useState('');
  const [voiceAgentState, setVoiceAgentState] = useState<VoiceConnectionState>('idle');
  const [voiceAgentDetail, setVoiceAgentDetail] = useState('Realtime voice session is idle.');
  const [voiceAgentSession, setVoiceAgentSession] = useState<CreateVoiceAgentSessionResult | null>(null);
  const [voiceEventFeed, setVoiceEventFeed] = useState<VoiceFeedItem[]>([]);
  const [voiceTaskFeed, setVoiceTaskFeed] = useState<VoiceFeedItem[]>([]);
  const liveSttControllerRef = useRef<LiveSttController | null>(null);
  const realtimeVoiceAgentRef = useRef<RealtimeVoiceAgentController | null>(null);
  const startLiveTranscriptionRef = useRef<(options?: { activateImmediately?: boolean }) => Promise<void>>(async () => undefined);
  const assistantTrainingRecognitionRef = useRef<{ stop: () => void } | null>(null);
  const sttDebugWriteTimerRef = useRef<number | null>(null);

  useEffect(() => {
    void Promise.all([getAppStatus(), getHotkeyStatus(), getSettings(), getLanguageOptions()])
      .then(([status, hotkey, appSettings, languages]) => {
        setAppStatus(status);
        setHotkeyStatus(hotkey);
        setSettings(appSettings);
        setSavedSettings(appSettings);
        setAssistantTrainingReadyName(isAssistantCalibrationComplete(appSettings) ? appSettings.assistantName : null);
        setAssistantWakePhrase(`Hey ${appSettings.assistantName}`);
        setAssistantClosePhrase(`Bye ${appSettings.assistantName}`);
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
      })
      .catch((error: unknown) => {
        const text = error instanceof Error ? error.message : String(error);
        setAppStatus(`Failed to load status: ${text}`);
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
        if (liveSttControllerRef.current) {
          liveSttControllerRef.current.manualActivate('hotkey');
        } else {
          void startLiveTranscriptionRef.current({ activateImmediately: true });
        }
        return;
      }

      if (liveSttControllerRef.current) {
        liveSttControllerRef.current.manualDeactivate('hotkey');
      } else {
        setLiveTranscriptionStatus('Deactivate hotkey received, but live transcription is not running yet.');
      }
    }).then((cleanup) => {
      unlistenLiveSttControl = cleanup;
    });

    return () => {
      void unlisten?.();
      void unlistenLiveSttControl?.();
    };
  }, []);

  useEffect(() => {
    return () => {
      if (sttDebugWriteTimerRef.current !== null) {
        window.clearTimeout(sttDebugWriteTimerRef.current);
      }
      if (realtimeVoiceAgentRef.current) {
        void realtimeVoiceAgentRef.current.disconnect();
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
      setAssistantWakePhrase(`Hey ${settings.assistantName || 'AIVA'}`);
      setAssistantClosePhrase(`Bye ${settings.assistantName || 'AIVA'}`);
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
  const canSaveSettings = !assistantNameError && (!assistantCalibrationRequired || assistantCalibrationComplete);
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
    if (
      (next.assistantName !== savedSettings.assistantName ||
        normalizeLanguageCode(next.sttLanguage) !== normalizeLanguageCode(savedSettings.assistantSampleLanguage)) &&
      !isAssistantCalibrationComplete(next)
    ) {
      const calibrationError = 'Please finish the assistant wake-word calibration for the current name and language before saving.';
      setUiState('error');
      setMessage(calibrationError);
      throw new Error(calibrationError);
    }

    setIsSavingSettings(true);
    try {
      const saved = await updateSettings(next);
      setSettings(saved);
      setSavedSettings(saved);
      setAssistantTrainingReadyName(isAssistantCalibrationComplete(saved) ? saved.assistantName : null);
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
    setAssistantClosePhrase(snapshot.closePhrase);
    setAssistantStateDetail(snapshot.reason);
    setLiveTranscriptionStatus(snapshot.reason);
    if (!snapshot.active) {
      setLiveTranscript('');
      setLastSttActiveTranscript('');
    }
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
    });

    realtimeVoiceAgentRef.current = controller;
    try {
      await controller.connect();
    } catch {
      realtimeVoiceAgentRef.current = null;
    }
  };

  const stopVoiceAgent = async (): Promise<void> => {
    if (realtimeVoiceAgentRef.current) {
      await realtimeVoiceAgentRef.current.disconnect();
      realtimeVoiceAgentRef.current = null;
    }
    setVoiceAgentState('idle');
    setVoiceAgentDetail('Realtime voice session is idle.');
    setVoiceAgentSession(null);
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
    setAssistantTrainingCloseSamples([]);
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
    } else if (currentAssistantTrainingStep.target === 'close') {
      setAssistantTrainingCloseSamples((current) => [...current, assistantTrainingCapturedTranscript.trim()]);
    } else {
      setAssistantTrainingNameSamples((current) => [...current, assistantTrainingCapturedTranscript.trim()]);
    }

    if (assistantTrainingStepIndex + 1 >= assistantCalibrationSteps.length) {
      const nextSettings: AppSettings = {
        ...settings,
        assistantWakeSamples: [...assistantTrainingWakeSamples, ...(currentAssistantTrainingStep.target === 'wake' ? [assistantTrainingCapturedTranscript.trim()] : [])],
        assistantCloseSamples: [...assistantTrainingCloseSamples, ...(currentAssistantTrainingStep.target === 'close' ? [assistantTrainingCapturedTranscript.trim()] : [])],
        assistantNameSamples: [...assistantTrainingNameSamples, ...(currentAssistantTrainingStep.target === 'name' ? [assistantTrainingCapturedTranscript.trim()] : [])],
        assistantSampleLanguage: normalizeLanguageCode(settings.sttLanguage),
      };
      setSettings(nextSettings);
      setAssistantTrainingReadyName(nextSettings.assistantName);
      setAssistantTrainingStatus('Calibration completed. Save settings to persist the trained wake phrases.');
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

    const controller = new LiveSttController();
    liveSttControllerRef.current = controller;
    const sessionId = `stt-live-${Date.now()}`;
    setLiveTranscriptionSessionId(sessionId);
    setSttProviderSnapshots({});
    setLiveTranscript('');
    setLastSttDebugLogPath('');
    setLastSttProvider('webview2');
    setLastSttActiveTranscript('');
    setVoiceEventFeed([]);
    setVoiceTaskFeed([]);
    setVoiceAgentState('idle');
    setVoiceAgentDetail('Realtime voice session is idle.');
    setVoiceAgentSession(null);
    setAssistantWakePhrase(`Hey ${activeSettings.assistantName}`);
    setAssistantClosePhrase(`Bye ${activeSettings.assistantName}`);
    setAssistantStateDetail('Starting wake-word listener...');
    setIsLiveTranscribing(true);

    try {
      await controller.start(
        {
          language: activeSettings.sttLanguage,
          assistantName: activeSettings.assistantName,
          activateImmediately: options?.activateImmediately,
          wakeSamples: activeSettings.assistantWakeSamples,
          closeSamples: activeSettings.assistantCloseSamples,
          nameSamples: activeSettings.assistantNameSamples,
          assistantWakeThreshold: activeSettings.assistantWakeThreshold,
          assistantCloseThreshold: activeSettings.assistantCloseThreshold,
          assistantCueCooldownMs: activeSettings.assistantCueCooldownMs,
        },
        {
          onStatus: (status) => {
            setLiveTranscriptionStatus(status);
          },
          onAssistantStateChange: (snapshot) => {
            applyAssistantState(snapshot);
            if (snapshot.active) {
              void startVoiceAgent();
            } else {
              void stopVoiceAgent();
            }
          },
          onProviderSnapshot: (snapshot) => {
            setSttProviderSnapshots((current) => ({ ...current, [snapshot.provider]: snapshot }));
            setLastSttProvider(snapshot.provider);
            if (
              snapshot.transcript &&
              snapshot.detail?.startsWith('assistant-active') &&
              !snapshot.detail?.includes('wake-word') &&
              !snapshot.detail?.includes('close-word')
            ) {
              setLiveTranscript(snapshot.transcript);
              setLastSttActiveTranscript(snapshot.transcript);
            }
          },
        },
      );
    } catch (error: unknown) {
      const text = error instanceof Error ? error.message : String(error);
      setIsLiveTranscribing(false);
      setLiveTranscriptionStatus(`Failed to start live transcription: ${text}`);
    }
  };

  startLiveTranscriptionRef.current = startLiveTranscription;

  const stopLiveTranscription = async (): Promise<void> => {
    await stopVoiceAgent();
    if (liveSttControllerRef.current) {
      await liveSttControllerRef.current.stop();
      liveSttControllerRef.current = null;
    }
    setIsLiveTranscribing(false);
    setAssistantActive(false);
    setAssistantStateDetail('Listening is stopped.');
    setLiveTranscript('');
    setLiveTranscriptionStatus('Live transcription is stopped.');
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

  return (
    <>
      <main className="app-shell">
        <section className="hero-card">
          <div className="status-row">
            <span className="status-dot" aria-hidden="true" />
            <span className="status-text">{hotkeyStatus.registered ? 'Global hotkeys active' : 'Checking global hotkeys'}</span>
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
              disabled={isSavingSettings || !isLiveTranscribing || assistantActive}
              onClick={() => liveSttControllerRef.current?.manualActivate('manual')}
            >
              Activate assistant
            </button>
            <button
              type="button"
              className="secondary-button"
              disabled={isSavingSettings || !isLiveTranscribing || !assistantActive}
              onClick={() => liveSttControllerRef.current?.manualDeactivate('manual')}
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

        <section className="settings-card">
          <div className="settings-header">
            <div>
              <h2>Settings</h2>
              <p className="settings-helper">
                Save applies changes to future hotkey runs and stores them in the local config file.
              </p>
            </div>
            <div className="settings-actions">
              <button
                type="button"
                className="secondary-button"
                disabled={!hasUnsavedChanges || isSavingSettings || uiState === 'working' || !canSaveSettings}
                onClick={() => void persistSettings(settings)}
              >
                {isSavingSettings ? 'Saving...' : 'Save settings'}
              </button>
              <button
                type="button"
                className="danger-button"
                disabled={isSavingSettings || uiState === 'working'}
                onClick={() => setShowResetDialog(true)}
              >
                Reset to defaults
              </button>
            </div>
          </div>

          <div className="settings-grid">
            <label className="settings-field">
              <span className="info-label">Translation target language</span>
              <select value={settings.translationTargetLanguage} onChange={(event) => setSettings({ ...settings, translationTargetLanguage: event.target.value })}>
                {languageOptions.map((option) => <option key={option.code} value={option.code}>{option.label}</option>)}
              </select>
            </label>

            <label className="settings-field">
              <span className="info-label">Read / translate engine</span>
              <input type="text" value="live / fixed" readOnly />
              <span className="field-note">Vorlesen und Uebersetzen+Vorlesen verwenden jetzt fest den live TTS-Pfad im Hintergrund. Es gibt dafuer keinen umschaltbaren Speech-Mode mehr.</span>
            </label>

            <label className="settings-field">
              <span className="info-label">Voice assistant transport</span>
              <input type="text" value="WebRTC realtime" readOnly />
              <span className="field-note">Der eigentliche Sprachdialog des Assistenten laeuft getrennt ueber OpenAI Realtime via WebRTC.</span>
            </label>

            <label className="settings-field settings-field--wide">
              <span className="info-label">Speech playback speed</span>
              <div className="slider-row">
                <input
                  type="range"
                  min="0.5"
                  max="2"
                  step="0.1"
                  value={settings.playbackSpeed}
                  onChange={(event) => setSettings({ ...settings, playbackSpeed: Number(event.target.value) })}
                />
                <output>{settings.playbackSpeed.toFixed(1)}x</output>
              </div>
              <span className="field-note">0.5x is slower, 1.0x is default, 2.0x is faster. This still applies to read-aloud and translate+read output.</span>
            </label>

            <label className="settings-field">
              <span className="info-label">STT provider</span>
              <input type="text" value="WebView2 / Windows speech" readOnly />
              <span className="field-note">The live transcription path stays on WebView2 only to keep local overhead and lag as low as possible.</span>
            </label>

            <label className="settings-field">
              <span className="info-label">Assistant name</span>
              <div className="inline-field-row">
                <input
                  type="text"
                  placeholder="AIVA"
                  value={settings.assistantName}
                  onChange={(event) => {
                    const nextName = event.target.value;
                    setSettings({
                      ...settings,
                      assistantName: nextName,
                      assistantWakeSamples: [],
                      assistantCloseSamples: [],
                      assistantNameSamples: [],
                      assistantSampleLanguage: normalizeLanguageCode(settings.sttLanguage),
                    });
                    setAssistantTrainingReadyName(null);
                  }}
                />
                <button
                  type="button"
                  className="secondary-button secondary-button--icon"
                  disabled={Boolean(assistantNameError) || isSavingSettings}
                  onClick={() => void openAssistantTrainingDialog()}
                  title="Train wake phrase"
                >
                  Activate
                </button>
              </div>
              {assistantNameError ? <span className="field-note field-note--error">{assistantNameError}</span> : null}
              {!assistantNameError && assistantCalibrationRequired && !assistantCalibrationComplete ? (
                <span className="field-note field-note--warning">Please train the current name and language before saving.</span>
              ) : null}
              {!assistantNameError && assistantCalibrationComplete && assistantTrainingReadyName === settings.assistantName ? (
                <span className="field-note field-note--success">Wake-/close-word calibration is ready for this name and language.</span>
              ) : null}
              <span className="field-note">Use 4-8 characters, one single word. Wake and close phrases stay in English: <code>Hey {settings.assistantName || 'AIVA'}</code> activates, <code>Bye {settings.assistantName || 'AIVA'}</code> deactivates.</span>
            </label>

            <label className="settings-field">
              <span className="info-label">Active transcription language</span>
              <input
                type="text"
                placeholder="de"
                value={settings.sttLanguage}
                onChange={(event) => {
                  setSettings({
                    ...settings,
                    sttLanguage: event.target.value,
                    assistantWakeSamples: [],
                    assistantCloseSamples: [],
                    assistantNameSamples: [],
                    assistantSampleLanguage: normalizeLanguageCode(event.target.value),
                  });
                  setAssistantTrainingReadyName(null);
                }}
              />
              <span className="field-note">This language is now also used while training and listening for wake/close phrases. If you change it, you need to record the training samples again, e.g. <code>de</code> or <code>en</code>.</span>
            </label>

            <label className="settings-field">
              <span className="info-label">Wake match threshold</span>
              <div className="slider-row">
                <input
                  type="range"
                  min={ASSISTANT_MATCH_THRESHOLD_MIN}
                  max={ASSISTANT_MATCH_THRESHOLD_MAX}
                  step="1"
                  value={settings.assistantWakeThreshold}
                  onChange={(event) => setSettings({
                    ...settings,
                    assistantWakeThreshold: parseBoundedInteger(
                      event.target.value,
                      settings.assistantWakeThreshold,
                      ASSISTANT_MATCH_THRESHOLD_MIN,
                      ASSISTANT_MATCH_THRESHOLD_MAX,
                    ),
                  })}
                />
                <output>{settings.assistantWakeThreshold}</output>
              </div>
              <span className="field-note">Higher is stricter. Recognition status shows the live wake score against this threshold.</span>
            </label>

            <label className="settings-field">
              <span className="info-label">Close match threshold</span>
              <div className="slider-row">
                <input
                  type="range"
                  min={ASSISTANT_MATCH_THRESHOLD_MIN}
                  max={ASSISTANT_MATCH_THRESHOLD_MAX}
                  step="1"
                  value={settings.assistantCloseThreshold}
                  onChange={(event) => setSettings({
                    ...settings,
                    assistantCloseThreshold: parseBoundedInteger(
                      event.target.value,
                      settings.assistantCloseThreshold,
                      ASSISTANT_MATCH_THRESHOLD_MIN,
                      ASSISTANT_MATCH_THRESHOLD_MAX,
                    ),
                  })}
                />
                <output>{settings.assistantCloseThreshold}</output>
              </div>
              <span className="field-note">Lower reacts easier, higher is stricter.</span>
            </label>

            <label className="settings-field">
              <span className="info-label">Cue cooldown</span>
              <input
                type="number"
                min="0"
                max={ASSISTANT_CUE_COOLDOWN_MS_MAX}
                step="100"
                value={settings.assistantCueCooldownMs}
                onChange={(event) => setSettings({
                  ...settings,
                  assistantCueCooldownMs: parseBoundedInteger(
                    event.target.value,
                    settings.assistantCueCooldownMs,
                    0,
                    ASSISTANT_CUE_COOLDOWN_MS_MAX,
                  ),
                })}
              />
              <span className="field-note">Milliseconds to ignore repeated cue hits right after a wake/close toggle so one utterance cannot bounce the state back.</span>
            </label>

            <label className="settings-field settings-field--wide">
              <span className="info-label">OpenAI API key</span>
              <input
                type="password"
                autoComplete="off"
                placeholder="sk-..."
                value={settings.openaiApiKey}
                onChange={(event) => setSettings({ ...settings, openaiApiKey: event.target.value })}
              />
              <span className="field-note">When set here, it overrides `OPENAI_API_KEY` from `.env`. Leave it empty to keep using `.env`.</span>
            </label>
          </div>
        </section>

        <section className={`result-card result-card--${voiceAgentState === 'error' ? 'error' : assistantActive ? 'working' : 'success'}`}>
          <div>
            <span className="info-label">Wake / voice assistant</span>
            <strong>{liveTranscriptionStatus}</strong>
          </div>
          <div className="result-block">
            <span className="info-label">Assistant state</span>
            <p>{assistantActive ? 'Assistant is active.' : 'Assistant is inactive and listening for the wake phrase.'}</p>
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
            <span className="info-label">Wake / close phrases</span>
            <p><strong>{assistantWakePhrase}</strong> · <strong>{assistantClosePhrase}</strong></p>
            <span className="field-note">WebView2 keeps listening for wake and close phrases. The actual conversation runs over WebRTC once the assistant is active.</span>
          </div>
          <div className="result-block">
            <span className="info-label">Cue matching</span>
            <p>Wake {settings.assistantWakeThreshold}/100 · Close {settings.assistantCloseThreshold}/100 · Cooldown {settings.assistantCueCooldownMs} ms</p>
            <span className="field-note">Recognition status shows the current fuzzy score, component hints, and best matching fragment for tuning.</span>
          </div>
          <div className="result-block">
            <span className="info-label">Active transcript</span>
            <p>{liveTranscript || (assistantActive ? 'No transcript yet.' : 'Waiting for wake phrase...')}</p>
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
            <li>Use <strong>Start live transcription</strong> to begin continuous WebView2 listening.</li>
            <li>Say <strong>{assistantWakePhrase}</strong> to activate the assistant. That keeps WebView2 listening for <strong>{assistantClosePhrase}</strong> and starts the actual assistant conversation over WebRTC.</li>
            <li>Say <strong>{assistantClosePhrase}</strong> to deactivate again, or use <strong>{hotkeyStatus.activateAccelerator}</strong> / <strong>{hotkeyStatus.deactivateAccelerator}</strong> to force activation or deactivation.</li>
            <li>Select text in another Windows app when you want to test the separate read-aloud or translate+read flows.</li>
            <li><strong>{hotkeyStatus.accelerator}</strong> reads it aloud, while <strong>{hotkeyStatus.translateAccelerator}</strong> translates it and speaks the translation.</li>
          </ol>
        </section>
      </main>

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
                Nochmal
              </button>
              <button type="button" className="secondary-button" disabled={!assistantTrainingCapturedTranscript.trim()} onClick={confirmAssistantTrainingStep}>
                Bestätigen
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
