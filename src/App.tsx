import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Window, getCurrentWindow } from '@tauri-apps/api/window';
import { applyDesignTheme } from './designThemes';
import SettingsView from './SettingsView';
import {
  captureAndSpeak,
  captureAndTranslate,
  createHostedCheckoutSession,
  getHostedBillingPlans,
  getHostedAccountStatus,
  loginHostedAccount,
  logoutHostedAccount,
  openExternalUrl,
  resetSettings,
  updateSettings,
  type AppSettings,
  type HostedBillingPlan,
  type HotkeyStatus,
  type HostedAccountStatus,
} from './lib/voiceOverlay';
import {
  buildRunHistoryEntry,
  createReadinessItems,
  getAssistantNameError,
  isAssistantCalibrationComplete,
  mergeHostedSettings,
  normalizeLanguageCode,
  type RunHistoryEntry,
  type UiState,
} from './lib/app/appModel';
import { useAppBootstrap } from './hooks/useAppBootstrap';
import { useAssistantTraining } from './hooks/useAssistantTraining';
import { useVoiceAssistantRuntime } from './hooks/useVoiceAssistantRuntime';
import i18n, { normalizeUiLanguage } from './i18n';
import { AssistantStatusSection } from './components/app/AssistantStatusSection';
import { AssistantTrainingDialog } from './components/app/AssistantTrainingDialog';
import { HeroSection } from './components/app/HeroSection';
import { LatestRunSection } from './components/app/LatestRunSection';
import { ReadinessGrid } from './components/app/ReadinessGrid';
import { ResetSettingsDialog } from './components/app/ResetSettingsDialog';
import { RunHistorySection } from './components/app/RunHistorySection';
import { TimerSection } from './components/app/TimerSection';
import { UsageSection } from './components/app/UsageSection';
import { VoiceFeedsSection } from './components/app/VoiceFeedsSection';
import { VoiceStyleRestartDialog } from './components/app/VoiceStyleRestartDialog';
import { TimerEditorDialog } from './components/timers/TimerEditorDialog';
import {
  ACTION_BAR_WINDOW_LABEL,
  OVERLAY_ACTION_EVENT,
  OVERLAY_COMPOSER_WINDOW_LABEL,
  OVERLAY_STATE_EVENT,
  VOICE_OVERLAY_WINDOW_LABEL,
  type OverlayAction,
  type OverlayState,
} from './lib/overlayBridge';
import { useVoiceTimers } from './hooks/useVoiceTimers';
import type { VoiceTimer } from './lib/voiceOverlay';

type AppView = 'dashboard' | 'settings';

type PendingVoiceSessionChange = {
  settings: AppSettings;
  kind: 'gender' | 'model' | 'model-and-gender';
};

export default function App() {
  const [uiState, setUiState] = useState<UiState>('idle');
  const [message, setMessage] = useState(i18n.t('app.ready'));
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
  const [hotkeyStartedAtMs, setHotkeyStartedAtMs] = useState<number | null>(null);
  const [captureStartedAtMs, setCaptureStartedAtMs] = useState<number | null>(null);
  const [captureFinishedAtMs, setCaptureFinishedAtMs] = useState<number | null>(null);
  const [ttsStartedAtMs, setTtsStartedAtMs] = useState<number | null>(null);
  const [firstAudioReceivedAtMs, setFirstAudioReceivedAtMs] = useState<number | null>(null);
  const [firstAudioPlaybackStartedAtMs, setFirstAudioPlaybackStartedAtMs] = useState<number | null>(
    null,
  );
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
  const [activeView, setActiveView] = useState<AppView>('dashboard');
  const [composerVisible, setComposerVisible] = useState(false);
  const [voiceOrbPinned, setVoiceOrbPinned] = useState(false);
  const [isMainWindowMaximized, setIsMainWindowMaximized] = useState(false);
  const [hostedAccount, setHostedAccount] = useState<HostedAccountStatus | null>(null);
  const [hostedAccountError, setHostedAccountError] = useState<string | null>(null);
  const [isHostedAccountBusy, setIsHostedAccountBusy] = useState(false);
  const [hostedBillingPlans, setHostedBillingPlans] = useState<HostedBillingPlan[]>([]);
  const [selectedHostedPlanKey, setSelectedHostedPlanKey] = useState('');
  const [hostedBillingError, setHostedBillingError] = useState<string | null>(null);
  const [isHostedCheckoutBusy, setIsHostedCheckoutBusy] = useState(false);
  const [pendingVoiceSessionRestartReason, setPendingVoiceSessionRestartReason] = useState<string | null>(null);
  const [pendingVoiceSessionChange, setPendingVoiceSessionChange] =
    useState<PendingVoiceSessionChange | null>(null);
  const [timerEditorMode, setTimerEditorMode] = useState<'create' | 'edit' | null>(null);
  const [timerEditorTimer, setTimerEditorTimer] = useState<VoiceTimer | null>(null);
  const [isTimerEditorBusy, setIsTimerEditorBusy] = useState(false);
  const appWindowRef = useRef(getCurrentWindow());
  const composerVisibleRef = useRef(false);
  const composerTransitionRef = useRef<Promise<void> | null>(null);
  const listenerDesiredRunningRef = useRef(false);
  const listenerTransitionRef = useRef<Promise<void> | null>(null);
  const liveTranscribingRef = useRef(false);
  const overlayBridgeStateRef = useRef<OverlayState | null>(null);
  const applyHotkeyStatus = useCallback((status: HotkeyStatus, appendHistory = false): void => {
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
    setUiState(
      status.state === 'working'
        ? 'working'
        : status.state === 'error'
          ? 'error'
          : status.state === 'success'
            ? 'success'
            : 'idle',
    );

    if (!appendHistory) {
      return;
    }

    const historyEntry = buildRunHistoryEntry(status);
    if (!historyEntry) {
      return;
    }

    setRunHistory((current) => {
      if (current.some((entry) => entry.id === historyEntry.id)) {
        return current;
      }
      return [historyEntry, ...current].slice(0, 8);
    });
  }, []);
  const {
    appStatus, hotkeyStatus, settings, savedSettings, languageOptions, initialStateLoaded, setSettings, setSavedSettings,
  } = useAppBootstrap({
    onHotkeyStatusUpdate: applyHotkeyStatus,
  });

  const assistantNameError = getAssistantNameError(settings.assistantName);
  const hasUnsavedChanges = useMemo(
    () => JSON.stringify(settings) !== JSON.stringify(savedSettings),
    [savedSettings, settings],
  );
  const assistantCalibrationRequired =
    settings.assistantName !== savedSettings.assistantName ||
    normalizeLanguageCode(settings.sttLanguage) !==
      normalizeLanguageCode(savedSettings.assistantSampleLanguage);
  const assistantCalibrationComplete = isAssistantCalibrationComplete(settings);
  const canSaveSettings =
    !assistantNameError && (!assistantCalibrationRequired || assistantCalibrationComplete);

  const syncHostedSettings = useCallback((nextHostedSettings: AppSettings): void => {
    setSettings((current) => mergeHostedSettings(current, nextHostedSettings));
    setSavedSettings((current) => mergeHostedSettings(current, nextHostedSettings));
  }, [setSavedSettings, setSettings]);

  useEffect(() => {
    const nextLanguage = normalizeUiLanguage(settings.uiLanguage);
    if (i18n.resolvedLanguage !== nextLanguage) {
      void i18n.changeLanguage(nextLanguage);
    }
    document.documentElement.lang = nextLanguage;
  }, [settings.uiLanguage]);

  useEffect(() => {
    void applyDesignTheme(settings.designThemeId, appWindowRef.current);
  }, [settings.designThemeId]);

  const syncMainWindowMaximized = useCallback(async (): Promise<void> => {
    try {
      setIsMainWindowMaximized(await appWindowRef.current.isMaximized());
    } catch {
      // Window chrome state is best-effort for the custom titlebar.
    }
  }, []);

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
  }, [syncMainWindowMaximized]);

  const persistSettings = async (
    next: AppSettings,
    successMessage = i18n.t('app.settingsSavedFuture'),
    options?: { restartReason?: string; sessionAction?: 'restart' | 'disconnect' },
  ): Promise<AppSettings> => {
    const validationError = getAssistantNameError(next.assistantName);
    if (validationError) {
      setUiState('error');
      setMessage(validationError);
      throw new Error(validationError);
    }

    const recalibrationRequired =
      next.assistantName !== savedSettings.assistantName ||
      normalizeLanguageCode(next.sttLanguage) !==
        normalizeLanguageCode(savedSettings.assistantSampleLanguage);
    if (recalibrationRequired && !isAssistantCalibrationComplete(next)) {
      const calibrationError = i18n.t('validation.assistantCalibrationRequired');
      setUiState('error');
      setMessage(calibrationError);
      throw new Error(calibrationError);
    }

    setIsSavingSettings(true);
    try {
      const saved = await updateSettings(next);
      setSettings(saved);
      setSavedSettings(saved);
      let restartFailed = false;
      try {
        if (options?.sessionAction === 'disconnect') {
          await voiceRuntime.closeVoiceAgentSession(options.restartReason ?? 'settings-update');
        } else {
          await voiceRuntime.restartVoiceAgentSession(
            options?.restartReason ?? 'settings-update',
            voiceRuntime.assistantActive,
          );
        }
      } catch (voiceError: unknown) {
        const detail = voiceError instanceof Error ? voiceError.message : String(voiceError);
        restartFailed = true;
        setUiState('error');
        setMessage(i18n.t('app.settingsSavedRestartFailed', { detail }));
      }
      if (!restartFailed) {
        setMessage(successMessage);
      }
      return saved;
    } catch (error: unknown) {
      const detail = error instanceof Error ? error.message : String(error);
      setUiState('error');
      setMessage(i18n.t('app.failedToSaveSettings', { detail }));
      throw error;
    } finally {
      setIsSavingSettings(false);
    }
  };

  const ensureSavedSettings = async (): Promise<AppSettings> => {
    if (hasUnsavedChanges) {
      return persistSettings(settings, i18n.t('app.settingsSavedRun'));
    }

    return savedSettings;
  };

  useEffect(() => {
    if (!initialStateLoaded || settings.aiProviderMode !== 'hosted') {
      setHostedAccount(null);
      setHostedAccountError(null);
      setHostedBillingPlans([]);
      setHostedBillingError(null);
      return;
    }

    if (!savedSettings.hostedApiBaseUrl.trim() || !savedSettings.hostedAccessToken.trim()) {
      setHostedAccount(null);
      setHostedAccountError(null);
      setHostedBillingPlans([]);
      setHostedBillingError(null);
      return;
    }

    let active = true;
    setIsHostedAccountBusy(true);
    setHostedAccountError(null);

    void getHostedAccountStatus()
      .then((account) => {
        if (!active) {
          return;
        }
        setHostedAccount(account);
      })
      .catch((error: unknown) => {
        if (!active) {
          return;
        }
        const detail = error instanceof Error ? error.message : String(error);
        setHostedAccount(null);
        setHostedAccountError(detail);
      })
      .finally(() => {
        if (active) {
          setIsHostedAccountBusy(false);
        }
      });

    return () => {
      active = false;
    };
  }, [
    initialStateLoaded,
    savedSettings.hostedAccessToken,
    savedSettings.hostedApiBaseUrl,
    settings.aiProviderMode,
  ]);

  useEffect(() => {
    if (!initialStateLoaded || settings.aiProviderMode !== 'hosted') {
      setHostedBillingPlans([]);
      setHostedBillingError(null);
      return;
    }

    if (!savedSettings.hostedApiBaseUrl.trim() || !savedSettings.hostedAccessToken.trim()) {
      setHostedBillingPlans([]);
      setHostedBillingError(null);
      return;
    }

    let active = true;
    setHostedBillingError(null);

    void getHostedBillingPlans()
      .then((plans) => {
        if (!active) {
          return;
        }
        setHostedBillingPlans(plans);
      })
      .catch((error: unknown) => {
        if (!active) {
          return;
        }
        const detail = error instanceof Error ? error.message : String(error);
        setHostedBillingPlans([]);
        setHostedBillingError(detail);
      });

    return () => {
      active = false;
    };
  }, [
    initialStateLoaded,
    savedSettings.hostedAccessToken,
    savedSettings.hostedApiBaseUrl,
    settings.aiProviderMode,
  ]);

  useEffect(() => {
    if (!hostedBillingPlans.length) {
      setSelectedHostedPlanKey('');
      return;
    }

    if (!hostedBillingPlans.some((plan) => plan.key === selectedHostedPlanKey)) {
      setSelectedHostedPlanKey(hostedBillingPlans[0]?.key ?? '');
    }
  }, [hostedBillingPlans, selectedHostedPlanKey]);

  const refreshHostedAccount = async (): Promise<void> => {
    setIsHostedAccountBusy(true);
    try {
      const [account, plans] = await Promise.all([
        getHostedAccountStatus(),
        getHostedBillingPlans(),
      ]);
      setHostedAccount(account);
      setHostedAccountError(null);
      setHostedBillingPlans(plans);
      setHostedBillingError(null);
      setUiState('success');
      setMessage(i18n.t('app.hostedStatusRefreshed'));
    } catch (error: unknown) {
      const detail = error instanceof Error ? error.message : String(error);
      setHostedAccount(null);
      setHostedAccountError(detail);
      setUiState('error');
      setMessage(i18n.t('app.hostedStatusFailed', { detail }));
    } finally {
      setIsHostedAccountBusy(false);
    }
  };

  const handleHostedLogin = async (credentials: {
    baseUrl: string;
    email: string;
    password: string;
  }): Promise<void> => {
    setIsHostedAccountBusy(true);
    try {
      const result = await loginHostedAccount(
        credentials.baseUrl,
        credentials.email,
        credentials.password,
      );
      syncHostedSettings(result.settings);
      setPendingVoiceSessionRestartReason('hosted-login');
      setHostedAccount(result.account);
      setHostedAccountError(null);
      setHostedBillingError(null);
      setUiState('success');
      setMessage(
        i18n.t('app.hostedLoginSuccess', {
          workspace:
            result.account.currentTeam?.name ??
            result.account.currentTeam?.slug ??
            i18n.t('settings.hostedWorkspaceCurrentDefault'),
        }),
      );
    } catch (error: unknown) {
      const detail = error instanceof Error ? error.message : String(error);
      setHostedAccountError(detail);
      setUiState('error');
      setMessage(i18n.t('app.hostedLoginFailed', { detail }));
    } finally {
      setIsHostedAccountBusy(false);
    }
  };

  const handleHostedLogout = async (): Promise<void> => {
    setIsHostedAccountBusy(true);
    try {
      const nextSettings = await logoutHostedAccount();
      syncHostedSettings(nextSettings);
      setPendingVoiceSessionRestartReason('hosted-logout');
      setHostedAccount(null);
      setHostedAccountError(null);
      setHostedBillingPlans([]);
      setHostedBillingError(null);
      setUiState('success');
      setMessage(i18n.t('app.hostedLogoutSuccess'));
    } catch (error: unknown) {
      const detail = error instanceof Error ? error.message : String(error);
      setUiState('error');
      setMessage(i18n.t('app.hostedLogoutFailed', { detail }));
    } finally {
      setIsHostedAccountBusy(false);
    }
  };

  const handleHostedCheckout = async (): Promise<void> => {
    setIsHostedCheckoutBusy(true);
    try {
      const session = await createHostedCheckoutSession(selectedHostedPlanKey);
      await openExternalUrl(session.url);
      setUiState('success');
      setMessage(
        i18n.t('app.hostedCheckoutOpened', {
          plan: session.planKey,
          workspace: session.team.name,
        }),
      );
    } catch (error: unknown) {
      const detail = error instanceof Error ? error.message : String(error);
      setUiState('error');
      setMessage(i18n.t('app.hostedCheckoutFailed', { detail }));
    } finally {
      setIsHostedCheckoutBusy(false);
    }
  };

  const voiceRuntime = useVoiceAssistantRuntime({
    settings,
    savedSettings,
    initialStateLoaded,
    ensureSavedSettings,
  });
  const voiceTimers = useVoiceTimers();
  const restartVoiceAgentSession = voiceRuntime.restartVoiceAgentSession;
  const assistantVoiceActive = voiceRuntime.assistantActive;

  useEffect(() => {
    if (!pendingVoiceSessionRestartReason) {
      return;
    }

    let active = true;
    const reason = pendingVoiceSessionRestartReason;
    setPendingVoiceSessionRestartReason(null);

    void restartVoiceAgentSession(reason, assistantVoiceActive).catch((error: unknown) => {
      if (!active) {
        return;
      }
      const detail = error instanceof Error ? error.message : String(error);
      setUiState('error');
      setMessage(i18n.t('app.settingsSavedRestartFailed', { detail }));
    });

    return () => {
      active = false;
    };
  }, [
    pendingVoiceSessionRestartReason,
    assistantVoiceActive,
    restartVoiceAgentSession,
  ]);

  const handleSaveSettingsRequest = useCallback(async (): Promise<AppSettings | undefined> => {
    const genderChanged = settings.voiceAgentGender !== savedSettings.voiceAgentGender;
    const modelChanged = settings.voiceAgentModel !== savedSettings.voiceAgentModel;

    if (genderChanged || modelChanged) {
      setPendingVoiceSessionChange({
        settings,
        kind:
          genderChanged && modelChanged
            ? 'model-and-gender'
            : modelChanged
              ? 'model'
              : 'gender',
      });
      return undefined;
    }

    return persistSettings(settings);
  }, [persistSettings, savedSettings.voiceAgentGender, savedSettings.voiceAgentModel, settings]);

  const handleConfirmVoiceStyleRestart = useCallback(async (): Promise<void> => {
    const pendingChange = pendingVoiceSessionChange;
    if (!pendingChange) {
      return;
    }

    try {
      await persistSettings(pendingChange.settings, i18n.t('app.settingsSavedFuture'), {
        restartReason:
          pendingChange.kind === 'gender'
            ? 'settings-gender-change'
            : pendingChange.kind === 'model'
              ? 'settings-model-change'
              : 'settings-model-and-gender-change',
        sessionAction: pendingChange.kind === 'gender' ? 'restart' : 'disconnect',
      });
    } finally {
      setPendingVoiceSessionChange(null);
    }
  }, [pendingVoiceSessionChange, persistSettings]);

  const {
    assistantTrainingReadyName,
    currentAssistantTrainingStep,
    showAssistantTrainingDialog,
    assistantTrainingTranscript,
    assistantTrainingCapturedTranscript,
    assistantTrainingStatus,
    assistantTrainingError,
    isAssistantTrainingRecording,
    openAssistantTrainingDialog,
    closeAssistantTrainingDialog,
    startAssistantTrainingRecording,
    stopAssistantTrainingRecording,
    confirmAssistantTrainingStep,
    retryAssistantTrainingStep,
  } = useAssistantTraining({
    settings,
    assistantNameError,
    isLiveTranscribing: voiceRuntime.isLiveTranscribing,
    stopLiveTranscription: voiceRuntime.stopLiveTranscription,
    resumeLiveTranscription: () => {
      void voiceRuntime.startLiveTranscription();
    },
    onSettingsChange: setSettings,
    onMessage: setMessage,
    onValidationError: (errorMessage) => {
      setUiState('error');
      setMessage(errorMessage);
    },
  });

  const handlePauseTimer = useCallback(async (timer: VoiceTimer): Promise<void> => {
    try {
      await voiceTimers.pauseTimer(timer.id);
      setUiState('success');
      setMessage(i18n.t('timers.messages.paused', { title: timer.title }));
    } catch (error: unknown) {
      const detail = error instanceof Error ? error.message : String(error);
      setUiState('error');
      setMessage(detail);
    }
  }, [voiceTimers]);

  const handleResumeTimer = useCallback(async (timer: VoiceTimer): Promise<void> => {
    try {
      await voiceTimers.resumeTimer(timer.id);
      setUiState('success');
      setMessage(i18n.t('timers.messages.resumed', { title: timer.title }));
    } catch (error: unknown) {
      const detail = error instanceof Error ? error.message : String(error);
      setUiState('error');
      setMessage(detail);
    }
  }, [voiceTimers]);

  const handleDeleteTimer = useCallback(async (timer: VoiceTimer): Promise<void> => {
    try {
      await voiceTimers.deleteTimer(timer.id);
      setUiState('success');
      setMessage(i18n.t('timers.messages.deleted', { title: timer.title }));
    } catch (error: unknown) {
      const detail = error instanceof Error ? error.message : String(error);
      setUiState('error');
      setMessage(detail);
    }
  }, [voiceTimers]);

  const handleSubmitTimerEditor = useCallback(async (payload: {
    title: string;
    durationMinutes: number;
    durationSeconds: number;
  }): Promise<void> => {
    setIsTimerEditorBusy(true);
    try {
      if (timerEditorMode === 'edit' && timerEditorTimer) {
        await voiceTimers.updateTimer({
          timerId: timerEditorTimer.id,
          title: payload.title || undefined,
          durationMinutes: payload.durationMinutes,
          durationSeconds: payload.durationSeconds,
        });
        setMessage(i18n.t('timers.messages.updated', {
          title: payload.title || timerEditorTimer.title,
        }));
      } else {
        const created = await voiceTimers.createTimer({
          title: payload.title || undefined,
          durationMinutes: payload.durationMinutes,
          durationSeconds: payload.durationSeconds,
        });
        setMessage(i18n.t('timers.messages.created', { title: created.title }));
      }
      setUiState('success');
      setTimerEditorMode(null);
      setTimerEditorTimer(null);
    } catch (error: unknown) {
      const detail = error instanceof Error ? error.message : String(error);
      setUiState('error');
      setMessage(detail);
    } finally {
      setIsTimerEditorBusy(false);
    }
  }, [timerEditorMode, timerEditorTimer, voiceTimers]);

  const runReadSelectedText = async (): Promise<void> => {
    try {
      await ensureSavedSettings();
    } catch {
      return;
    }

    setUiState('working');
    setMessage(i18n.t('app.localReadStart'));
    try {
      const result = await captureAndSpeak(
        { copyDelayMs: 100, restoreClipboard: true },
        { autoplay: true, maxParallelRequests: 3, voice: 'alloy' },
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
        i18n.t('app.audioReady', {
          chunkCount: result.speech.chunkCount,
          format: result.speech.format.toUpperCase(),
          latencySuffix: result.speech.startLatencyMs
            ? i18n.t('app.audioReadyLatency', { latencyMs: result.speech.startLatencyMs })
            : '',
        }),
      );
    } catch (error: unknown) {
      const detail = error instanceof Error ? error.message : String(error);
      setUiState('error');
      setMessage(detail);
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
    setMessage(
      i18n.t('app.localTranslateStart', {
        language: activeSettings.translationTargetLanguage,
      }),
    );
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
        i18n.t('app.translationCompleted', {
          language: result.translation.targetLanguage,
          latencySuffix: result.speech.startLatencyMs
            ? i18n.t('app.translationCompletedLatency', {
                latencyMs: result.speech.startLatencyMs,
              })
            : '',
        }),
      );
    } catch (error: unknown) {
      const detail = error instanceof Error ? error.message : String(error);
      setUiState('error');
      setMessage(detail);
    }
  };

  const readinessItems = useMemo(
    () =>
      createReadinessItems({
        appStatus,
        assistantActive: voiceRuntime.assistantActive,
        hotkeyStatus,
        isLiveTranscribing: voiceRuntime.isLiveTranscribing,
        settings,
        voiceAgentState: voiceRuntime.voiceAgentState,
      }),
    [
      appStatus,
      hotkeyStatus,
      settings,
      voiceRuntime.assistantActive,
      voiceRuntime.isLiveTranscribing,
      voiceRuntime.voiceAgentState,
    ],
  );

  const assistantClosePhrase = useMemo(
    () => `Bye ${settings.assistantName || 'Ava'}`,
    [settings.assistantName],
  );

  const overlayBridgeState = useMemo<OverlayState>(
    () => ({
      assistantActive: voiceRuntime.assistantActive,
      isLiveTranscribing: voiceRuntime.isLiveTranscribing,
      voiceOrbPinned,
      composerVisible,
      settingsVisible: activeView === 'settings',
      assistantStateDetail: voiceRuntime.assistantStateDetail,
      liveTranscriptionStatus: voiceRuntime.liveTranscriptionStatus,
      assistantWakePhrase: voiceRuntime.assistantWakePhrase,
      assistantClosePhrase,
      statusMessage: message,
      uiState,
    }),
    [
      activeView,
      assistantClosePhrase,
      composerVisible,
      message,
      uiState,
      voiceOrbPinned,
      voiceRuntime.assistantActive,
      voiceRuntime.assistantStateDetail,
      voiceRuntime.assistantWakePhrase,
      voiceRuntime.isLiveTranscribing,
      voiceRuntime.liveTranscriptionStatus,
    ],
  );

  const broadcastOverlayState = useCallback((state: OverlayState): void => {
    [ACTION_BAR_WINDOW_LABEL, VOICE_OVERLAY_WINDOW_LABEL, OVERLAY_COMPOSER_WINDOW_LABEL].forEach(
      (label) => {
        void appWindowRef.current
          .emitTo<OverlayState>(label, OVERLAY_STATE_EVENT, state)
          .catch(() => undefined);
      },
    );
  }, []);

  useEffect(() => {
    overlayBridgeStateRef.current = overlayBridgeState;
    broadcastOverlayState(overlayBridgeState);
  }, [broadcastOverlayState, overlayBridgeState]);

  useEffect(() => {
    composerVisibleRef.current = composerVisible;
  }, [composerVisible]);

  useEffect(() => {
    liveTranscribingRef.current = voiceRuntime.isLiveTranscribing;
    if (!listenerTransitionRef.current) {
      listenerDesiredRunningRef.current = voiceRuntime.isLiveTranscribing;
    }
  }, [voiceRuntime.isLiveTranscribing]);

  const handleOverlayActionError = useCallback((error: unknown): void => {
    const detail = error instanceof Error ? error.message : String(error);
    setMessage(detail);
  }, []);

  const processComposerWindowTransition = useCallback(async (): Promise<void> => {
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
  }, []);

  const closeComposerWindow = useCallback(async (): Promise<void> => {
    composerVisibleRef.current = false;
    await processComposerWindowTransition();
  }, [processComposerWindowTransition]);

  const toggleComposerWindow = useCallback(async (): Promise<void> => {
    composerVisibleRef.current = !composerVisibleRef.current;
    await processComposerWindowTransition();
  }, [processComposerWindowTransition]);

  const processListenerTransition = useCallback(async (): Promise<void> => {
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
              await voiceRuntime.startLiveTranscription();
            } else {
              await voiceRuntime.stopLiveTranscription();
            }
          }

          if (
            shouldRun === listenerDesiredRunningRef.current &&
            liveTranscribingRef.current === shouldRun
          ) {
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
  }, [voiceRuntime.startLiveTranscription, voiceRuntime.stopLiveTranscription]);

  const toggleListenerRunning = useCallback(async (): Promise<void> => {
    listenerDesiredRunningRef.current = !listenerDesiredRunningRef.current;
    await processListenerTransition();
  }, [processListenerTransition]);

  const openSettingsWindow = useCallback(async (): Promise<void> => {
    setActiveView('settings');

    try {
      await appWindowRef.current.unminimize();
    } catch {
      // Some platforms may not expose a minimized state.
    }

    try {
      await appWindowRef.current.show();
      await appWindowRef.current.setFocus();
    } catch {
      // Focusing the main window is best-effort when called from overlay windows.
    }
  }, []);

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

        if (voiceRuntime.assistantActive || voiceOrbPinned) {
          await window.show();
        } else {
          await window.hide();
        }
      })
      .catch(() => undefined);
  }, [voiceOrbPinned, voiceRuntime.assistantActive]);

  useEffect(() => {
    let unlistenOverlayAction: (() => void | Promise<void>) | undefined;

    void appWindowRef.current
      .listen<OverlayAction>(OVERLAY_ACTION_EVENT, (event) => {
        switch (event.payload.type) {
          case 'request-state': {
            const currentState = overlayBridgeStateRef.current;
            if (currentState) {
              broadcastOverlayState(currentState);
            }
            break;
          }
          case 'toggle-live':
          case 'toggle-listener':
            void toggleListenerRunning().catch(handleOverlayActionError);
            break;
          case 'activate':
            void voiceRuntime.activateAssistantVoice('manual').catch(handleOverlayActionError);
            break;
          case 'deactivate':
            void voiceRuntime.deactivateAssistantVoice('manual').catch(handleOverlayActionError);
            break;
          case 'toggle-composer':
            void toggleComposerWindow().catch(handleOverlayActionError);
            break;
          case 'close-composer':
            void closeComposerWindow().catch(handleOverlayActionError);
            break;
          case 'open-settings':
            void openSettingsWindow().catch(handleOverlayActionError);
            break;
          case 'pin-voice-orb':
            setVoiceOrbPinned(true);
            break;
          case 'unpin-voice-orb':
            setVoiceOrbPinned(false);
            break;
        }
      })
      .then((cleanup) => {
        unlistenOverlayAction = cleanup;
      });

    return () => {
      void unlistenOverlayAction?.();
    };
  }, [
    broadcastOverlayState,
    closeComposerWindow,
    handleOverlayActionError,
    openSettingsWindow,
    toggleComposerWindow,
    toggleListenerRunning,
    voiceRuntime.activateAssistantVoice,
    voiceRuntime.deactivateAssistantVoice,
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
              <svg
                viewBox="0 0 12 12"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.6"
                strokeLinecap="round"
              >
                <path d="M2 9.2h8" />
              </svg>
            </button>
            <button
              type="button"
              className="window-titlebar__control"
              aria-label={isMainWindowMaximized ? 'Restore window' : 'Maximize window'}
              onClick={() => void handleWindowMaximizeToggle()}
            >
              <svg
                viewBox="0 0 12 12"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.3"
                strokeLinejoin="round"
              >
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
              <svg
                viewBox="0 0 12 12"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.6"
                strokeLinecap="round"
              >
                <path d="M2.5 2.5l7 7" />
                <path d="M9.5 2.5l-7 7" />
              </svg>
            </button>
          </div>
        </header>

        <main className="app-shell">
          {activeView === 'dashboard' ? (
            <>
              <HeroSection
                hotkeyRegistered={hotkeyStatus.registered}
                speakHotkey={hotkeyStatus.accelerator}
                translateHotkey={hotkeyStatus.translateAccelerator}
                isBusy={uiState === 'working'}
                isSavingSettings={isSavingSettings}
                assistantActive={voiceRuntime.assistantActive}
                voiceAgentState={voiceRuntime.voiceAgentState}
                onReadSelectedText={() => void runReadSelectedText()}
                onTranslateSelectedText={() => void runTranslateSelectedText()}
                onActivateAssistant={() => void voiceRuntime.activateAssistantVoice('manual')}
                onDeactivateAssistant={() => void voiceRuntime.deactivateAssistantVoice('manual')}
                onOpenSettings={() => void openSettingsWindow()}
              />

              <ReadinessGrid items={readinessItems} />

              <AssistantStatusSection
                voiceAgentState={voiceRuntime.voiceAgentState}
                assistantActive={voiceRuntime.assistantActive}
                isLiveTranscribing={voiceRuntime.isLiveTranscribing}
                liveTranscriptionStatus={voiceRuntime.liveTranscriptionStatus}
                assistantStateDetail={voiceRuntime.assistantStateDetail}
                voiceAgentDetail={voiceRuntime.voiceAgentDetail}
                voiceAgentSession={voiceRuntime.voiceAgentSession}
                assistantWakePhrase={voiceRuntime.assistantWakePhrase}
                wakeThreshold={settings.assistantWakeThreshold}
                cueCooldownMs={settings.assistantCueCooldownMs}
                liveTranscript={voiceRuntime.liveTranscript}
                sttProviderSnapshots={voiceRuntime.providerSnapshots}
                lastSttDebugLogPath={voiceRuntime.lastSttDebugLogPath}
              />

              <TimerSection
                timers={voiceTimers.timers}
                nowMs={voiceTimers.nowMs}
                isLoaded={voiceTimers.isLoaded}
                error={voiceTimers.error}
                onAdd={() => {
                  setTimerEditorMode('create');
                  setTimerEditorTimer(null);
                }}
                onEdit={(timer) => {
                  setTimerEditorMode('edit');
                  setTimerEditorTimer(timer);
                }}
                onPause={(timer) => void handlePauseTimer(timer)}
                onResume={(timer) => void handleResumeTimer(timer)}
                onDelete={(timer) => void handleDeleteTimer(timer)}
              />

              <VoiceFeedsSection
                voiceAgentState={voiceRuntime.voiceAgentState}
                voiceEventFeed={voiceRuntime.voiceEventFeed}
                voiceTaskFeed={voiceRuntime.voiceTaskFeed}
              />

              <LatestRunSection
                uiState={uiState}
                message={message}
                capturedPreview={capturedPreview}
                translatedPreview={translatedPreview}
                lastTtsMode={lastTtsMode}
                lastRequestedTtsMode={lastRequestedTtsMode}
                lastSessionStrategy={lastSessionStrategy}
                lastSessionId={lastSessionId}
                lastSessionFallbackReason={lastSessionFallbackReason}
                lastSttProvider={voiceRuntime.lastSttProvider}
                lastSttActiveTranscript={voiceRuntime.lastSttActiveTranscript}
                lastSttDebugLogPath={voiceRuntime.lastSttDebugLogPath}
                startLatencyMs={startLatencyMs}
                hotkeyToFirstAudioMs={hotkeyToFirstAudioMs}
                hotkeyToFirstPlaybackMs={hotkeyToFirstPlaybackMs}
                captureDurationMs={captureDurationMs}
                captureToTtsStartMs={captureToTtsStartMs}
                ttsToFirstAudioMs={ttsToFirstAudioMs}
                firstAudioToPlaybackMs={firstAudioToPlaybackMs}
                hotkeyStartedAtMs={hotkeyStartedAtMs}
                captureStartedAtMs={captureStartedAtMs}
                captureFinishedAtMs={captureFinishedAtMs}
                ttsStartedAtMs={ttsStartedAtMs}
                firstAudioReceivedAtMs={firstAudioReceivedAtMs}
                firstAudioPlaybackStartedAtMs={firstAudioPlaybackStartedAtMs}
                lastAudioPath={lastAudioPath}
                lastAudioOutputDirectory={lastAudioOutputDirectory}
                lastAudioChunkCount={lastAudioChunkCount}
              />

              <RunHistorySection entries={runHistory} onClear={() => setRunHistory([])} />

              <UsageSection
                assistantWakePhrase={voiceRuntime.assistantWakePhrase}
                activateHotkey={hotkeyStatus.activateAccelerator}
                deactivateHotkey={hotkeyStatus.deactivateAccelerator}
                speakHotkey={hotkeyStatus.accelerator}
                translateHotkey={hotkeyStatus.translateAccelerator}
              />
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
              onSave={handleSaveSettingsRequest}
              onReset={() => setShowResetDialog(true)}
              onBack={() => setActiveView('dashboard')}
              onOpenTraining={openAssistantTrainingDialog}
              hostedAccount={hostedAccount}
              hostedAccountError={hostedAccountError}
              isHostedAccountBusy={isHostedAccountBusy}
              hostedBillingPlans={hostedBillingPlans}
              selectedHostedPlanKey={selectedHostedPlanKey}
              hostedBillingError={hostedBillingError}
              isHostedCheckoutBusy={isHostedCheckoutBusy}
              onHostedLogin={handleHostedLogin}
              onHostedRefresh={refreshHostedAccount}
              onHostedLogout={handleHostedLogout}
              onHostedPlanChange={setSelectedHostedPlanKey}
              onHostedCheckout={handleHostedCheckout}
              normalizeLanguageCode={normalizeLanguageCode}
            />
          )}
        </main>
      </div>

      {showAssistantTrainingDialog ? (
        <AssistantTrainingDialog
          step={currentAssistantTrainingStep}
          isRecording={isAssistantTrainingRecording}
          liveTranscript={assistantTrainingTranscript}
          capturedTranscript={assistantTrainingCapturedTranscript}
          status={assistantTrainingStatus}
          error={assistantTrainingError}
          onClose={closeAssistantTrainingDialog}
          onStartRecording={startAssistantTrainingRecording}
          onStopRecording={stopAssistantTrainingRecording}
          onRetry={retryAssistantTrainingStep}
          onConfirm={confirmAssistantTrainingStep}
        />
      ) : null}

      <ResetSettingsDialog
        open={showResetDialog}
        onClose={() => setShowResetDialog(false)}
        onConfirm={() => void resetAllSettings()}
      />

      <VoiceStyleRestartDialog
        open={pendingVoiceSessionChange !== null}
        changeKind={pendingVoiceSessionChange?.kind ?? 'gender'}
        isBusy={isSavingSettings}
        onClose={() => setPendingVoiceSessionChange(null)}
        onConfirm={() => void handleConfirmVoiceStyleRestart()}
      />

      <TimerEditorDialog
        open={timerEditorMode !== null}
        timer={timerEditorMode === 'edit' ? timerEditorTimer : null}
        isBusy={isTimerEditorBusy}
        onClose={() => {
          setTimerEditorMode(null);
          setTimerEditorTimer(null);
        }}
        onSubmit={(payload) => void handleSubmitTimerEditor(payload)}
      />
    </>
  );

  async function resetAllSettings(): Promise<void> {
    setShowResetDialog(false);
    setIsSavingSettings(true);
    try {
      const defaults = await resetSettings();
      setSettings(defaults);
      setSavedSettings(defaults);
      setMessage(i18n.t('app.resetSuccess'));
    } catch (error: unknown) {
      const detail = error instanceof Error ? error.message : String(error);
      setUiState('error');
      setMessage(i18n.t('app.failedToResetSettings', { detail }));
    } finally {
      setIsSavingSettings(false);
    }
  }
}
