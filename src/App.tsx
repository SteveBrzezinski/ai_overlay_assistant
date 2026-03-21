import { useEffect, useMemo, useState } from 'react';
import {
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
} from './lib/voiceOverlay';

type UiState = 'idle' | 'working' | 'success' | 'error';

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
  ttsFormat: 'wav',
  firstChunkLeadingSilenceMs: 180,
  translationTargetLanguage: 'en',
  playbackSpeed: 1,
  openaiApiKey: '',
};

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
  const [isSavingSettings, setIsSavingSettings] = useState(false);
  const [showResetDialog, setShowResetDialog] = useState(false);

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
      setUiState(status.state === 'working' ? 'working' : status.state === 'error' ? 'error' : status.state === 'success' ? 'success' : 'idle');
    }).then((cleanup) => {
      unlisten = cleanup;
    });

    return () => {
      void unlisten?.();
    };
  }, []);

  const hasUnsavedChanges = useMemo(
    () => JSON.stringify(settings) !== JSON.stringify(savedSettings),
    [savedSettings, settings],
  );

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
        { copyDelayMs: 140, restoreClipboard: true },
        {
          autoplay: true,
          format: activeSettings.ttsFormat,
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
      setMessage(
        `Audio ready: ${result.speech.chunkCount} chunk(s), ${result.speech.format.toUpperCase()}, ${activeSettings.firstChunkLeadingSilenceMs} ms lead-in, ${activeSettings.playbackSpeed.toFixed(1)}x playback.`,
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
        { copyDelayMs: 140, restoreClipboard: true },
        { targetLanguage: activeSettings.translationTargetLanguage },
      );
      setUiState('success');
      setCapturedPreview(result.capturedText);
      setTranslatedPreview(result.translation.text);
      setMessage(`Translation completed (${result.translation.targetLanguage}). The translated text is shown in the UI.`);
    } catch (error: unknown) {
      const text = error instanceof Error ? error.message : String(error);
      setUiState('error');
      setMessage(text);
    }
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
      { label: 'Speech defaults', value: `${settings.ttsFormat.toUpperCase()} · ${settings.firstChunkLeadingSilenceMs} ms lead-in · ${settings.playbackSpeed.toFixed(1)}x` },
      { label: 'Translation target', value: settings.translationTargetLanguage },
      { label: 'Current status', value: appStatus },
    ],
    [appStatus, hotkeyStatus.accelerator, hotkeyStatus.registered, hotkeyStatus.translateAccelerator, settings],
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
              <span className="info-label">Audio format</span>
              <select value={settings.ttsFormat} onChange={(event) => setSettings({ ...settings, ttsFormat: event.target.value as AppSettings['ttsFormat'] })}>
                <option value="wav">WAV (Default)</option>
                <option value="mp3">MP3</option>
              </select>
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
              <span className="field-note">0.5x is slower, 1.0x is default, 2.0x is faster. Playback now uses a pitch-preserving time-stretch path where practical, but extreme values can still introduce some artifacts.</span>
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

        <section className={`result-card result-card--${uiState}`}>
          <div>
            <span className="info-label">Latest run / hotkey status</span>
            <strong>{message}</strong>
          </div>
          {capturedPreview ? <div className="result-block"><span className="info-label">Captured text</span><p>{capturedPreview}</p></div> : null}
          {translatedPreview ? <div className="result-block"><span className="info-label">Translation</span><p>{translatedPreview}</p></div> : null}
          {lastAudioPath ? <div className="result-block"><span className="info-label">Audio output</span><code>{lastAudioChunkCount > 1 ? lastAudioOutputDirectory : lastAudioPath}</code></div> : null}
        </section>

        <section className="instructions-card">
          <span className="info-label">Usage</span>
          <ol>
            <li>Keep the app running in the background.</li>
            <li>Select text in another Windows app.</li>
            <li><strong>{hotkeyStatus.accelerator}</strong> reads it aloud, while <strong>{hotkeyStatus.translateAccelerator}</strong> translates it and speaks the translation.</li>
            <li>The translated text stays visible in the UI for the current MVP.</li>
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
