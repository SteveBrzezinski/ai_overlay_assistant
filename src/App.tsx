import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  captureAndSpeak,
  captureAndTranslate,
  resetSettings,
  updateSettings,
  type AppSettings,
  type HotkeyStatus,
} from './lib/voiceOverlay';
import {
  buildRunHistoryEntry,
  createReadinessItems,
  getAssistantNameError,
  isAssistantCalibrationComplete,
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
import { SettingsSection } from './components/app/SettingsSection';
import { UsageSection } from './components/app/UsageSection';
import { VoiceFeedsSection } from './components/app/VoiceFeedsSection';

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

  useEffect(() => {
    const nextLanguage = normalizeUiLanguage(settings.uiLanguage);
    if (i18n.resolvedLanguage !== nextLanguage) {
      void i18n.changeLanguage(nextLanguage);
    }
    document.documentElement.lang = nextLanguage;
  }, [settings.uiLanguage]);

  const persistSettings = async (
    next: AppSettings,
    successMessage = i18n.t('app.settingsSavedFuture'),
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
      try {
        await voiceRuntime.restartVoiceAgentSession('settings-update', voiceRuntime.assistantActive);
      } catch (voiceError: unknown) {
        const detail = voiceError instanceof Error ? voiceError.message : String(voiceError);
        setMessage(i18n.t('app.settingsSavedRestartFailed', { detail }));
      }
      setMessage(successMessage);
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

  const voiceRuntime = useVoiceAssistantRuntime({
    settings,
    savedSettings,
    initialStateLoaded,
    ensureSavedSettings,
  });

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

  return (
    <>
      <main className="app-shell">
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
        />

        <ReadinessGrid items={readinessItems} />

        <SettingsSection
          settings={settings}
          languageOptions={languageOptions}
          hasUnsavedChanges={hasUnsavedChanges}
          isSavingSettings={isSavingSettings}
          isBusy={uiState === 'working'}
          canSaveSettings={canSaveSettings}
          assistantNameError={assistantNameError}
          assistantCalibrationRequired={assistantCalibrationRequired}
          assistantCalibrationComplete={assistantCalibrationComplete}
          assistantTrainingReadyName={assistantTrainingReadyName}
          onSettingsChange={setSettings}
          onSaveSettings={() => void persistSettings(settings)}
          onResetSettings={() => setShowResetDialog(true)}
          onOpenAssistantTraining={() => void openAssistantTrainingDialog()}
        />

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
      </main>

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
