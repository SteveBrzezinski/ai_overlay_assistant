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
  resetSettings,
  updateSettings,
  type AppSettings,
  type HotkeyStatus,
  type LanguageOption,
  type SttDebugEntry,
} from './lib/voiceOverlay';
import { LiveSttController, type ProviderSnapshot, type SttProviderId } from './lib/liveStt';

type UiState = 'idle' | 'working' | 'success' | 'error';
type ProviderSnapshotMap = Partial<Record<SttProviderId, ProviderSnapshot>>;

const fallbackHotkeyStatus: HotkeyStatus = {
  registered: false,
  accelerator: 'Ctrl+Shift+Space',
  translateAccelerator: 'Ctrl+Shift+T',
  pauseResumeAccelerator: 'Ctrl+Shift+P',
  cancelAccelerator: 'Ctrl+Shift+X',
  platform: 'unsupported',
  state: 'registering',
  message: 'Checking global hotkeys...',
};

const fallbackSettings: AppSettings = {
  ttsMode: 'classic',
  realtimeAllowLiveFallback: false,
  ttsFormat: 'wav',
  firstChunkLeadingSilenceMs: 180,
  translationTargetLanguage: 'en',
  playbackSpeed: 1,
  openaiApiKey: '',
  sttLanguage: 'de',
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
  const [isLiveTranscribing, setIsLiveTranscribing] = useState(false);
  const [liveTranscriptionStatus, setLiveTranscriptionStatus] = useState('Live transcription is stopped.');
  const [liveTranscript, setLiveTranscript] = useState('');
  const [sttProviderSnapshots, setSttProviderSnapshots] = useState<ProviderSnapshotMap>({});
  const [liveTranscriptionSessionId, setLiveTranscriptionSessionId] = useState('');
  const liveSttControllerRef = useRef<LiveSttController | null>(null);
  const sttDebugWriteTimerRef = useRef<number | null>(null);

  useEffect(() => {
    void Promise.all([getAppStatus(), getHotkeyStatus(), getSettings(), getLanguageOptions()])
      .then(([status, hotkey, appSettings, languages]) => {
        setAppStatus(status);
        setHotkeyStatus(hotkey);
        setSettings(appSettings);
        setSavedSettings(appSettings);
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

    return () => {
      void unlisten?.();
    };
  }, []);

  useEffect(() => {
    return () => {
      if (sttDebugWriteTimerRef.current !== null) {
        window.clearTimeout(sttDebugWriteTimerRef.current);
      }
      if (liveSttControllerRef.current) {
        void liveSttControllerRef.current.stop();
        liveSttControllerRef.current = null;
      }
    };
  }, []);

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
  const showLiveSpeedWarning = ['live', 'realtime'].includes(settings.ttsMode) && Math.abs(settings.playbackSpeed - 1) >= 0.01;

  const persistSettings = async (
    next: AppSettings,
    successMessage = 'Settings saved. Future hotkey runs use the updated values.',
  ): Promise<AppSettings> => {
    setIsSavingSettings(true);
    try {
      const saved = await updateSettings(next);
      setSettings(saved);
      setSavedSettings(saved);
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

  const runReadSelectedText = async (): Promise<void> => {
    let activeSettings = savedSettings;

    try {
      activeSettings = await ensureSavedSettings();
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
          format: activeSettings.ttsFormat,
          mode: activeSettings.ttsMode,
          maxParallelRequests: 3,
          voice: 'alloy',
          firstChunkLeadingSilenceMs: activeSettings.firstChunkLeadingSilenceMs,
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
        `Audio ready: ${result.speech.mode} mode, ${result.speech.chunkCount} chunk(s), ${result.speech.format.toUpperCase()} output${result.speech.startLatencyMs ? `, first audible audio after ${result.speech.startLatencyMs} ms` : ''}.`,
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
        `Translation completed (${result.translation.targetLanguage}) in ${result.speech.mode} mode${result.speech.startLatencyMs ? `, first audible audio after ${result.speech.startLatencyMs} ms` : ''}.`,
      );
    } catch (error: unknown) {
      const text = error instanceof Error ? error.message : String(error);
      setUiState('error');
      setMessage(text);
    }
  };

  const startLiveTranscription = async (): Promise<void> => {
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
    setIsLiveTranscribing(true);

    try {
      await controller.start(
        {
          language: activeSettings.sttLanguage,
        },
        {
          onStatus: (status) => {
            setLiveTranscriptionStatus(status);
          },
          onProviderSnapshot: (snapshot) => {
            setSttProviderSnapshots((current) => ({ ...current, [snapshot.provider]: snapshot }));
            if (snapshot.transcript) {
              setLiveTranscript(snapshot.transcript);
              setLastSttProvider(snapshot.provider);
              setLastSttActiveTranscript(snapshot.transcript);
            }
          },
        },
      );
      setLiveTranscriptionStatus('Live transcription is running.');
    } catch (error: unknown) {
      const text = error instanceof Error ? error.message : String(error);
      setIsLiveTranscribing(false);
      setLiveTranscriptionStatus(`Failed to start live transcription: ${text}`);
    }
  };

  const stopLiveTranscription = async (): Promise<void> => {
    if (liveSttControllerRef.current) {
      await liveSttControllerRef.current.stop();
      liveSttControllerRef.current = null;
    }
    setIsLiveTranscribing(false);
    setLiveTranscriptionStatus('Live transcription is stopped.');
  };

  const resetAllSettings = async (): Promise<void> => {
    setShowResetDialog(false);
    setIsSavingSettings(true);
    try {
      const defaults = await resetSettings();
      setSettings(defaults);
      setSavedSettings(defaults);
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
      { label: 'Speech mode', value: settings.ttsMode },
      { label: 'Speech defaults', value: `${settings.ttsFormat.toUpperCase()} · ${settings.firstChunkLeadingSilenceMs} ms lead-in · ${settings.playbackSpeed.toFixed(1)}x` },
      { label: 'Translation target', value: settings.translationTargetLanguage },
      { label: 'STT provider', value: 'webview2' },
      { label: 'Live transcription', value: isLiveTranscribing ? 'running' : 'stopped' },
      { label: 'Current status', value: appStatus },
    ],
    [appStatus, hotkeyStatus.accelerator, hotkeyStatus.registered, hotkeyStatus.translateAccelerator, isLiveTranscribing, settings],
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
                disabled={!hasUnsavedChanges || isSavingSettings || uiState === 'working'}
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
              <span className="info-label">Speech mode</span>
              <select value={settings.ttsMode} onChange={(event) => setSettings({ ...settings, ttsMode: event.target.value as AppSettings['ttsMode'] })}>
                <option value="classic">Classic / stable</option>
                <option value="live">Live / session-ready streaming</option>
                <option value="realtime">Realtime / experimental</option>
              </select>
              <span className="field-note">Classic keeps the chunked file pipeline. Live uses the newer session-oriented streaming path. Realtime uses the OpenAI Realtime WebSocket audio path directly and now exposes its own startup errors by default.</span>
            </label>

            <label className="settings-field settings-field--wide">
              <span className="info-label">Realtime debug fallback</span>
              <label className="checkbox-row">
                <input
                  type="checkbox"
                  checked={settings.realtimeAllowLiveFallback}
                  onChange={(event) => setSettings({ ...settings, realtimeAllowLiveFallback: event.target.checked })}
                />
                <span>Allow temporary fallback from realtime to live on startup failure</span>
              </label>
              <span className="field-note">Default is off so real Realtime connect/session.update/response.create/audio errors stay visible. Turn this on only if you explicitly want the old rescue path while debugging.</span>
            </label>

            <label className="settings-field">
              <span className="info-label">Audio format</span>
              <select value={settings.ttsFormat} onChange={(event) => setSettings({ ...settings, ttsFormat: event.target.value as AppSettings['ttsFormat'] })}>
                <option value="wav">WAV (Default)</option>
                <option value="mp3">MP3</option>
              </select>
              <span className="field-note">This applies to the classic pipeline. Live and realtime stream PCM internally and store the finished file as WAV.</span>
            </label>

            <label className="settings-field">
              <span className="info-label">First chunk lead-in</span>
              <select value={String(settings.firstChunkLeadingSilenceMs)} onChange={(event) => setSettings({ ...settings, firstChunkLeadingSilenceMs: Number(event.target.value) })}>
                {[0, 120, 180, 250, 320].map((value) => <option key={value} value={value}>{value} ms</option>)}
              </select>
            </label>

            <label className="settings-field">
              <span className="info-label">Translation target language</span>
              <select value={settings.translationTargetLanguage} onChange={(event) => setSettings({ ...settings, translationTargetLanguage: event.target.value })}>
                {languageOptions.map((option) => <option key={option.code} value={option.code}>{option.label}</option>)}
              </select>
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
              <span className="field-note">0.5x is slower, 1.0x is default, 2.0x is faster. Classic uses the pitch-friendlier time-stretch path; live keeps the fastest direct stream at 1.0x and uses a more buffered naturalized path for non-default speed.</span>
            </label>

            {showLiveSpeedWarning ? (
              <div className="settings-warning settings-field--wide" role="status" aria-live="polite">
                <strong>Streaming speed adjustment adds buffering</strong>
                <p>Non-default playback speed in live or realtime mode may require additional buffering and processing to keep the voice more natural.</p>
                <p>This can increase startup latency and local processing overhead. The current implementation does not add extra API requests.</p>
              </div>
            ) : null}

            {settings.ttsMode === 'realtime' ? (
              <div className="settings-warning settings-field--wide" role="status" aria-live="polite">
                <strong>Realtime mode is experimental</strong>
                <p>The app tries OpenAI Realtime audio over WebSocket and starts playback as soon as audio deltas arrive.</p>
                <p>Fallback to live is disabled by default so connect/session.update/response.create/first-audio failures remain visible while debugging. You can re-enable it above if needed.</p>
              </div>
            ) : null}

            <label className="settings-field">
              <span className="info-label">STT provider</span>
              <input type="text" value="WebView2 / Windows speech" readOnly />
              <span className="field-note">The live transcription path is now simplified to WebView2 only to keep local overhead and lag as low as possible.</span>
            </label>

            <label className="settings-field">
              <span className="info-label">STT language hint</span>
              <input
                type="text"
                placeholder="de"
                value={settings.sttLanguage}
                onChange={(event) => setSettings({ ...settings, sttLanguage: event.target.value })}
              />
              <span className="field-note">Language hint for WebView2 speech recognition, e.g. `de` or `en`.</span>
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

        <section className={`result-card result-card--${isLiveTranscribing ? 'working' : 'success'}`}>
          <div>
            <span className="info-label">Live transcription</span>
            <strong>{liveTranscriptionStatus}</strong>
          </div>
          <div className="result-block">
            <span className="info-label">Active transcript</span>
            <p>{liveTranscript || 'No transcript yet.'}</p>
          </div>
          {Object.values(sttProviderSnapshots).length ? (
            <div className="result-block">
              <span className="info-label">Recognition status</span>
              <div className="stt-provider-grid">
                {Object.values(sttProviderSnapshots).filter((snapshot): snapshot is ProviderSnapshot => Boolean(snapshot)).map((snapshot) => (
                  <article className="stt-provider-card" key={snapshot.provider}>
                    <strong>{snapshot.provider}</strong>
                    <p>{snapshot.transcript || 'No transcript yet.'}</p>
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
            <li>Use <strong>Start live transcription</strong> to begin continuous microphone transcription with WebView2 speech recognition.</li>
            <li>Select text in another Windows app when you want to test the existing TTS flows.</li>
            <li><strong>{hotkeyStatus.accelerator}</strong> reads it aloud, while <strong>{hotkeyStatus.translateAccelerator}</strong> translates it and speaks the translation.</li>
            <li>The live transcription status card and STT debug log help you see what WebView2 recognized and whether the runtime stayed stable.</li>
          </ol>
        </section>
      </main>

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
