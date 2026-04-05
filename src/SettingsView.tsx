import { useMemo, useState, type Dispatch, type SetStateAction } from 'react';
import type { AppSettings, LanguageOption } from './lib/voiceOverlay';
import {
  ASSISTANT_CUE_COOLDOWN_MS_MAX,
  ASSISTANT_MATCH_THRESHOLD_MAX,
  ASSISTANT_MATCH_THRESHOLD_MIN,
} from './lib/liveStt';

type SettingsSectionId = 'audio' | 'translation' | 'assistant' | 'startup' | 'advanced';

type SettingsViewProps = {
  settings: AppSettings;
  setSettings: Dispatch<SetStateAction<AppSettings>>;
  languageOptions: LanguageOption[];
  assistantNameError: string | null;
  assistantCalibrationRequired: boolean;
  assistantCalibrationComplete: boolean;
  assistantTrainingReadyName: string | null;
  isSavingSettings: boolean;
  isWorking: boolean;
  hasUnsavedChanges: boolean;
  canSaveSettings: boolean;
  onSave: () => Promise<unknown>;
  onReset: () => void;
  onBack: () => void;
  onOpenTraining: () => Promise<void>;
  normalizeLanguageCode: (language: string) => string;
};

type SettingsSection = {
  id: SettingsSectionId;
  label: string;
  description: string;
  summary: string;
};

function parseBoundedInteger(value: string, fallback: number, min: number, max: number): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) {
    return fallback;
  }

  return Math.min(max, Math.max(min, Math.round(parsed)));
}

export default function SettingsView({
  settings,
  setSettings,
  languageOptions,
  assistantNameError,
  assistantCalibrationRequired,
  assistantCalibrationComplete,
  assistantTrainingReadyName,
  isSavingSettings,
  isWorking,
  hasUnsavedChanges,
  canSaveSettings,
  onSave,
  onReset,
  onBack,
  onOpenTraining,
  normalizeLanguageCode,
}: SettingsViewProps) {
  const [activeSection, setActiveSection] = useState<SettingsSectionId | null>(null);

  const translationTargetLabel = useMemo(
    () => languageOptions.find((option) => option.code === settings.translationTargetLanguage)?.label
      ?? settings.translationTargetLanguage.toUpperCase(),
    [languageOptions, settings.translationTargetLanguage],
  );

  const settingsSections = useMemo<SettingsSection[]>(() => {
    const assistantLabel = settings.assistantName.trim() || 'Ava';
    const assistantLanguage = settings.sttLanguage.trim().toUpperCase() || 'DE';
    const assistantSummary = assistantCalibrationComplete && assistantTrainingReadyName === settings.assistantName
      ? `${assistantLabel} / ${assistantLanguage} / training ready`
      : assistantCalibrationRequired
        ? `${assistantLabel} / ${assistantLanguage} / training recommended`
        : `${assistantLabel} / ${assistantLanguage}`;

    return [
      {
        id: 'audio',
        label: 'Audio & playback',
        description: 'Speech mode, output format, lead-in, and playback speed.',
        summary: `${settings.ttsMode} / ${settings.ttsFormat.toUpperCase()} / ${settings.playbackSpeed.toFixed(1)}x`,
      },
      {
        id: 'translation',
        label: 'Translation',
        description: 'Target language and the translation pipeline.',
        summary: translationTargetLabel,
      },
      {
        id: 'assistant',
        label: 'Assistant & listening',
        description: 'Wake word, STT language, activation, and voice assistant settings.',
        summary: assistantSummary,
      },
      {
        id: 'startup',
        label: 'Startup & background',
        description: 'How the app behaves when Windows starts.',
        summary: settings.launchAtLogin
          ? settings.startHiddenOnLaunch ? 'Auto-start hidden' : 'Auto-start visible'
          : 'Manual start',
      },
      {
        id: 'advanced',
        label: 'API & debug',
        description: 'OpenAI key handling and fallback behavior for troubleshooting.',
        summary: `${settings.openaiApiKey ? 'Custom API key' : 'Using .env key'} / ${settings.realtimeAllowLiveFallback ? 'Fallback on' : 'Fallback off'}`,
      },
    ];
  }, [
    assistantCalibrationComplete,
    assistantCalibrationRequired,
    assistantTrainingReadyName,
    languageOptions,
    settings.assistantName,
    settings.launchAtLogin,
    settings.openaiApiKey,
    settings.playbackSpeed,
    settings.realtimeAllowLiveFallback,
    settings.startHiddenOnLaunch,
    settings.sttLanguage,
    settings.translationTargetLanguage,
    settings.ttsFormat,
    settings.ttsMode,
    translationTargetLabel,
  ]);

  const saveDisabled = !hasUnsavedChanges || isSavingSettings || isWorking || !canSaveSettings;
  const settingsStatusTone = assistantNameError ? 'error' : hasUnsavedChanges ? 'pending' : 'saved';
  const settingsStatusText = assistantNameError
    ? assistantNameError
    : hasUnsavedChanges
      ? 'Unsaved changes are ready to save.'
      : 'All settings are saved.';

  const renderDetail = () => {
    if (!activeSection) {
      return (
        <div className="settings-panel-empty">
          <span className="settings-panel-eyebrow">Settings overview</span>
          <h2>Select a category</h2>
          <p className="settings-helper">
            Choose one of the categories on the left. The right side then shows only the settings that belong together.
          </p>
          <div className="settings-panel-meta">
            <span className={`settings-state-pill settings-state-pill--${settingsStatusTone}`}>{settingsStatusText}</span>
            <p className="field-note">Save applies changes to future hotkey runs and stores them in the local config file.</p>
          </div>
        </div>
      );
    }

    if (activeSection === 'audio') {
      return (
        <div className="settings-detail-stack">
          <div className="settings-panel-header">
            <div>
              <span className="settings-panel-eyebrow">Audio & playback</span>
              <h2>Audio & playback</h2>
              <p className="settings-helper">Everything for how speech is generated, starts, and plays back.</p>
            </div>
            <button type="button" className="settings-link-button" onClick={() => setActiveSection(null)}>Show categories</button>
          </div>
          <div className="settings-grid">
            <label className="settings-field">
              <span className="info-label">Speech mode</span>
              <select value={settings.ttsMode} onChange={(event) => setSettings({ ...settings, ttsMode: event.target.value as AppSettings['ttsMode'] })}>
                <option value="classic">Classic / stable</option>
                <option value="live">Live / session-ready streaming</option>
                <option value="realtime">Realtime / experimental</option>
              </select>
              <span className="field-note">Classic keeps the chunked file pipeline. Live uses the newer session-oriented streaming path. Realtime uses the OpenAI Realtime WebSocket audio path directly and exposes startup errors more clearly.</span>
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
            <label className="settings-field settings-field--wide">
              <span className="info-label">Speech playback speed</span>
              <div className="slider-row">
                <input type="range" min="0.5" max="2" step="0.1" value={settings.playbackSpeed} onChange={(event) => setSettings({ ...settings, playbackSpeed: Number(event.target.value) })} />
                <output>{settings.playbackSpeed.toFixed(1)}x</output>
              </div>
              <span className="field-note">0.5x is slower, 1.0x is default, 2.0x is faster. This still applies to read-aloud and translate+read output.</span>
            </label>
          </div>
        </div>
      );
    }

    if (activeSection === 'translation') {
      return (
        <div className="settings-detail-stack">
          <div className="settings-panel-header">
            <div>
              <span className="settings-panel-eyebrow">Translation</span>
              <h2>Translation</h2>
              <p className="settings-helper">Everything that affects translated output and the translate-plus-read flow.</p>
            </div>
            <button type="button" className="settings-link-button" onClick={() => setActiveSection(null)}>Show categories</button>
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
              <span className="field-note">Read aloud and translate-plus-read use the live TTS path in the background.</span>
            </label>
          </div>
        </div>
      );
    }

    if (activeSection === 'assistant') {
      return (
        <div className="settings-detail-stack">
          <div className="settings-panel-header">
            <div>
              <span className="settings-panel-eyebrow">Assistant & listening</span>
              <h2>Assistant & listening</h2>
              <p className="settings-helper">Wake word, STT language, recognition tuning, and assistant runtime details.</p>
            </div>
            <button type="button" className="settings-link-button" onClick={() => setActiveSection(null)}>Show categories</button>
          </div>
          <div className="settings-grid">
            <label className="settings-field">
              <span className="info-label">Voice assistant transport</span>
              <input type="text" value="WebRTC realtime" readOnly />
              <span className="field-note">The assistant&apos;s spoken conversation runs separately through OpenAI Realtime over WebRTC.</span>
            </label>
            <label className="settings-field">
              <span className="info-label">STT provider</span>
              <input type="text" value="WebView2 / Windows speech" readOnly />
              <span className="field-note">The live transcription path stays on WebView2 only to keep local overhead and lag as low as possible.</span>
            </label>
            <label className="settings-field settings-field--wide">
              <span className="info-label">Assistant name</span>
              <div className="inline-field-row">
                <input
                  type="text"
                  placeholder="Ava"
                  value={settings.assistantName}
                  onChange={(event) => {
                    const nextName = event.target.value;
                    setSettings({
                      ...settings,
                      assistantName: nextName,
                      assistantWakeSamples: [],
                      assistantNameSamples: [],
                      assistantSampleLanguage: normalizeLanguageCode(settings.sttLanguage),
                    });
                  }}
                />
                <button type="button" className="secondary-button secondary-button--icon" disabled={Boolean(assistantNameError) || isSavingSettings} onClick={() => void onOpenTraining()}>
                  Activate
                </button>
              </div>
              {assistantNameError ? <span className="field-note field-note--error">{assistantNameError}</span> : null}
              {!assistantNameError && assistantCalibrationRequired && !assistantCalibrationComplete ? <span className="field-note field-note--warning">Wake-word training is optional right now. You can save immediately, but training still improves matching.</span> : null}
              {!assistantNameError && assistantCalibrationComplete && assistantTrainingReadyName === settings.assistantName ? <span className="field-note field-note--success">Wake-word calibration is ready for this name and language.</span> : null}
              <span className="field-note">Use 3-8 characters, one single word. The wake phrase stays in English: <code>Hey {settings.assistantName || 'Ava'}</code>.</span>
            </label>
            <label className="settings-field">
              <span className="info-label">Active transcription language</span>
              <input
                type="text"
                placeholder="de"
                value={settings.sttLanguage}
                onChange={(event) => setSettings({
                  ...settings,
                  sttLanguage: event.target.value,
                  assistantWakeSamples: [],
                  assistantNameSamples: [],
                  assistantSampleLanguage: normalizeLanguageCode(event.target.value),
                })}
              />
              <span className="field-note">If you change it, record the training samples again, for example <code>de</code> or <code>en</code>.</span>
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
              <span className="field-note">Milliseconds to ignore repeated wake hits right after activation.</span>
            </label>
          </div>
        </div>
      );
    }

    if (activeSection === 'startup') {
      return (
        <div className="settings-detail-stack">
          <div className="settings-panel-header">
            <div>
              <span className="settings-panel-eyebrow">Startup & background</span>
              <h2>Startup & background</h2>
              <p className="settings-helper">Control whether the app starts with Windows and hides into the background.</p>
            </div>
            <button type="button" className="settings-link-button" onClick={() => setActiveSection(null)}>Show categories</button>
          </div>
          <div className="settings-grid">
            <label className="settings-field settings-field--wide">
              <span className="info-label">Background startup</span>
              <label className="checkbox-row">
                <input type="checkbox" checked={settings.launchAtLogin} onChange={(event) => setSettings({ ...settings, launchAtLogin: event.target.checked })} />
                <span>Launch the app automatically when I sign in to Windows</span>
              </label>
              <label className="checkbox-row">
                <input type="checkbox" checked={settings.startHiddenOnLaunch} disabled={!settings.launchAtLogin} onChange={(event) => setSettings({ ...settings, startHiddenOnLaunch: event.target.checked })} />
                <span>When started automatically, keep the window hidden and run in the background</span>
              </label>
              <span className="field-note">Saving this writes or removes a Windows Startup launcher for the current executable.</span>
            </label>
          </div>
        </div>
      );
    }

    return (
      <div className="settings-detail-stack">
        <div className="settings-panel-header">
          <div>
            <span className="settings-panel-eyebrow">API & debug</span>
            <h2>API & debug</h2>
            <p className="settings-helper">Keep sensitive and debugging-related options grouped in one place.</p>
          </div>
          <button type="button" className="settings-link-button" onClick={() => setActiveSection(null)}>Show categories</button>
        </div>
        <div className="settings-grid">
          <label className="settings-field settings-field--wide">
            <span className="info-label">Realtime debug fallback</span>
            <label className="checkbox-row">
              <input type="checkbox" checked={settings.realtimeAllowLiveFallback} onChange={(event) => setSettings({ ...settings, realtimeAllowLiveFallback: event.target.checked })} />
              <span>Allow temporary fallback from realtime to live on startup failure</span>
            </label>
            <span className="field-note">Leave this off if you want realtime startup errors to stay visible while debugging.</span>
          </label>
          <label className="settings-field settings-field--wide">
            <span className="info-label">OpenAI API key</span>
            <input type="password" autoComplete="off" placeholder="sk-..." value={settings.openaiApiKey} onChange={(event) => setSettings({ ...settings, openaiApiKey: event.target.value })} />
            <span className="field-note">When set here, it overrides <code>OPENAI_API_KEY</code> from <code>.env</code>.</span>
          </label>
        </div>
      </div>
    );
  };

  return (
    <>
      <section className="hero-card settings-page-hero">
        <div className="settings-page-toolbar">
          <button type="button" className="toolbar-button toolbar-button--ghost" onClick={onBack}>
            <span className="toolbar-button__icon" aria-hidden="true">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M15 18l-6-6 6-6" />
              </svg>
            </span>
            <span className="toolbar-button__label">Dashboard</span>
          </button>
          <div className="settings-actions">
            <button type="button" className="secondary-button" disabled={saveDisabled} onClick={() => void onSave()}>
              {isSavingSettings ? 'Saving...' : 'Save settings'}
            </button>
            <button type="button" className="danger-button" disabled={isSavingSettings || isWorking} onClick={onReset}>
              Reset to defaults
            </button>
          </div>
        </div>
        <h1>Settings</h1>
        <p className="hero-copy">Choose a category on the left. On the right, you only see the settings that logically belong together.</p>
        <div className="settings-panel-meta">
          <span className={`settings-state-pill settings-state-pill--${settingsStatusTone}`}>{settingsStatusText}</span>
          <p className="field-note">Save applies changes to future hotkey runs and stores them in the local config file.</p>
        </div>
      </section>

      <section className="settings-layout">
        <aside className="settings-sidebar">
          <span className="info-label">Categories</span>
          <div className="settings-nav">
            {settingsSections.map((section) => (
              <button
                type="button"
                key={section.id}
                className={`settings-nav-button ${activeSection === section.id ? 'settings-nav-button--active' : ''}`}
                onClick={() => setActiveSection(section.id)}
              >
                <span className="settings-nav-copy">
                  <span className="settings-nav-title">{section.label}</span>
                  <span className="settings-nav-description">{section.description}</span>
                </span>
                <span className="settings-nav-summary">{section.summary}</span>
              </button>
            ))}
          </div>
        </aside>

        <section className={`settings-detail-panel ${activeSection ? '' : 'settings-detail-panel--empty'}`}>
          {renderDetail()}
        </section>
      </section>
    </>
  );
}
