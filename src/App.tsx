import { useEffect, useMemo, useState } from 'react';
import {
  captureAndSpeak,
  captureAndTranslate,
  getAppStatus,
  getHotkeyStatus,
  getLanguageOptions,
  getSettings,
  onHotkeyStatus,
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
  message: 'Prüfe globale Hotkeys …',
};

const fallbackSettings: AppSettings = {
  ttsFormat: 'wav',
  firstChunkLeadingSilenceMs: 180,
  translationTargetLanguage: 'de',
};

export default function App() {
  const [appStatus, setAppStatus] = useState('Lade Status …');
  const [hotkeyStatus, setHotkeyStatus] = useState<HotkeyStatus>(fallbackHotkeyStatus);
  const [settings, setSettings] = useState<AppSettings>(fallbackSettings);
  const [languageOptions, setLanguageOptions] = useState<LanguageOption[]>([]);
  const [uiState, setUiState] = useState<UiState>('idle');
  const [message, setMessage] = useState('Bereit.');
  const [capturedPreview, setCapturedPreview] = useState('');
  const [translatedPreview, setTranslatedPreview] = useState('');
  const [lastAudioPath, setLastAudioPath] = useState('');
  const [lastAudioOutputDirectory, setLastAudioOutputDirectory] = useState('');
  const [lastAudioChunkCount, setLastAudioChunkCount] = useState(0);

  useEffect(() => {
    void Promise.all([getAppStatus(), getHotkeyStatus(), getSettings(), getLanguageOptions()])
      .then(([status, hotkey, appSettings, languages]) => {
        setAppStatus(status);
        setHotkeyStatus(hotkey);
        setSettings(appSettings);
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
        setAppStatus(`Status konnte nicht geladen werden: ${text}`);
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

  const saveSettings = async (next: AppSettings) => {
    setSettings(next);
    try {
      const saved = await updateSettings(next);
      setSettings(saved);
      setMessage('Settings gespeichert. Neue Hotkey-Läufe nutzen die aktualisierten Werte.');
    } catch (error: unknown) {
      const text = error instanceof Error ? error.message : String(error);
      setUiState('error');
      setMessage(`Settings konnten nicht gespeichert werden: ${text}`);
    }
  };

  const runReadSelectedText = async (): Promise<void> => {
    setUiState('working');
    setMessage('Lokaler Testlauf: markierten Text lesen …');
    try {
      const result = await captureAndSpeak(
        { copyDelayMs: 140, restoreClipboard: true },
        {
          autoplay: true,
          format: settings.ttsFormat,
          maxParallelRequests: 3,
          voice: 'alloy',
          firstChunkLeadingSilenceMs: settings.firstChunkLeadingSilenceMs,
        },
      );
      setUiState('success');
      setCapturedPreview(result.capturedText);
      setTranslatedPreview('');
      setLastAudioPath(result.speech.filePath);
      setLastAudioOutputDirectory(result.speech.outputDirectory);
      setLastAudioChunkCount(result.speech.chunkCount);
      setMessage(`Audio erzeugt: ${result.speech.chunkCount} Chunk(s), Format ${result.speech.format.toUpperCase()}, Startpuffer ${settings.firstChunkLeadingSilenceMs} ms.`);
    } catch (error: unknown) {
      const text = error instanceof Error ? error.message : String(error);
      setUiState('error');
      setMessage(text);
    }
  };

  const runTranslateSelectedText = async (): Promise<void> => {
    setUiState('working');
    setMessage(`Lokaler Testlauf: markierten Text nach ${settings.translationTargetLanguage} übersetzen …`);
    try {
      const result = await captureAndTranslate(
        { copyDelayMs: 140, restoreClipboard: true },
        { targetLanguage: settings.translationTargetLanguage },
      );
      setUiState('success');
      setCapturedPreview(result.capturedText);
      setTranslatedPreview(result.translation.text);
      setMessage(`Übersetzung fertig (${result.translation.targetLanguage}). Text-Ausgabe ist in der UI sichtbar.`);
    } catch (error: unknown) {
      const text = error instanceof Error ? error.message : String(error);
      setUiState('error');
      setMessage(text);
    }
  };

  const readinessItems = useMemo(
    () => [
      { label: 'Global speak hotkey', value: `${hotkeyStatus.accelerator} · ${hotkeyStatus.registered ? 'aktiv' : 'nicht aktiv'}` },
      { label: 'Global translate hotkey', value: `${hotkeyStatus.translateAccelerator} · ${hotkeyStatus.registered ? 'aktiv' : 'nicht aktiv'}` },
      { label: 'Speech defaults', value: `${settings.ttsFormat.toUpperCase()} · ${settings.firstChunkLeadingSilenceMs} ms Startpuffer` },
      { label: 'Translation target', value: settings.translationTargetLanguage },
      { label: 'Current status', value: appStatus },
    ],
    [appStatus, hotkeyStatus.accelerator, hotkeyStatus.registered, hotkeyStatus.translateAccelerator, settings],
  );

  return (
    <main className="app-shell">
      <section className="hero-card">
        <div className="status-row">
          <span className="status-dot" aria-hidden="true" />
          <span className="status-text">{hotkeyStatus.registered ? 'Globale Hotkeys aktiv' : 'Globale Hotkeys werden geprüft'}</span>
        </div>
        <h1>Voice Overlay Assistant</h1>
        <p className="hero-copy">
          Zwei Flows mit bestehender Struktur: <strong>{hotkeyStatus.accelerator}</strong> liest markierten Text vor,
          <strong> {hotkeyStatus.translateAccelerator}</strong> capturt markierten Text und zeigt die Übersetzung in der UI.
        </p>
        <div className="actions">
          <button type="button" className="primary-button" disabled={uiState === 'working'} onClick={() => void runReadSelectedText()}>
            {uiState === 'working' ? 'Working …' : 'Local speech test'}
          </button>
          <button type="button" className="secondary-button" disabled={uiState === 'working'} onClick={() => void runTranslateSelectedText()}>
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
        <h2>Settings</h2>
        <div className="settings-grid">
          <label>
            <span className="info-label">Audio format</span>
            <select value={settings.ttsFormat} onChange={(event) => void saveSettings({ ...settings, ttsFormat: event.target.value as AppSettings['ttsFormat'] })}>
              <option value="wav">WAV (Default)</option>
              <option value="mp3">MP3</option>
            </select>
          </label>
          <label>
            <span className="info-label">Erster Chunk: Startpuffer</span>
            <select value={String(settings.firstChunkLeadingSilenceMs)} onChange={(event) => void saveSettings({ ...settings, firstChunkLeadingSilenceMs: Number(event.target.value) })}>
              {[0, 120, 180, 250, 320].map((value) => <option key={value} value={value}>{value} ms</option>)}
            </select>
          </label>
          <label>
            <span className="info-label">Translation target language</span>
            <select value={settings.translationTargetLanguage} onChange={(event) => void saveSettings({ ...settings, translationTargetLanguage: event.target.value })}>
              {languageOptions.map((option) => <option key={option.code} value={option.code}>{option.label}</option>)}
            </select>
          </label>
        </div>
      </section>

      <section className={`result-card result-card--${uiState}`}>
        <div>
          <span className="info-label">Letzter Lauf / Hotkey-Status</span>
          <strong>{message}</strong>
        </div>
        {capturedPreview ? <div className="result-block"><span className="info-label">Erfasster Text</span><p>{capturedPreview}</p></div> : null}
        {translatedPreview ? <div className="result-block"><span className="info-label">Übersetzung</span><p>{translatedPreview}</p></div> : null}
        {lastAudioPath ? <div className="result-block"><span className="info-label">Audio output</span><code>{lastAudioChunkCount > 1 ? lastAudioOutputDirectory : lastAudioPath}</code></div> : null}
      </section>

      <section className="instructions-card">
        <span className="info-label">MVP-Nutzung</span>
        <ol>
          <li>App im Hintergrund offen lassen.</li>
          <li>Text in einer anderen Windows-App markieren.</li>
          <li><strong>{hotkeyStatus.accelerator}</strong> für Vorlesen oder <strong>{hotkeyStatus.translateAccelerator}</strong> für Übersetzung drücken.</li>
          <li>Die Übersetzung erscheint aktuell in der UI; das ist absichtlich die saubere MVP-Basis für späteres Vorlesen oder Einfügen.</li>
        </ol>
      </section>
    </main>
  );
}
