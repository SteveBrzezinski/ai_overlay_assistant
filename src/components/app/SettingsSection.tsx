import { Trans, useTranslation } from 'react-i18next';

import {
  ASSISTANT_CUE_COOLDOWN_MS_MAX,
  ASSISTANT_MATCH_THRESHOLD_MAX,
  ASSISTANT_MATCH_THRESHOLD_MIN,
} from '../../lib/liveStt';
import type { AppSettings, LanguageOption } from '../../lib/voiceOverlay';
import { normalizeLanguageCode, parseBoundedInteger } from '../../lib/app/appModel';

type SettingsSectionProps = {
  settings: AppSettings;
  languageOptions: LanguageOption[];
  hasUnsavedChanges: boolean;
  isSavingSettings: boolean;
  isBusy: boolean;
  canSaveSettings: boolean;
  assistantNameError: string | null;
  assistantCalibrationRequired: boolean;
  assistantCalibrationComplete: boolean;
  assistantTrainingReadyName: string | null;
  onSettingsChange: (settings: AppSettings) => void;
  onSaveSettings: () => void;
  onResetSettings: () => void;
  onOpenAssistantTraining: () => void;
};

export function SettingsSection(props: SettingsSectionProps): JSX.Element {
  const { t } = useTranslation();
  const {
    settings,
    languageOptions,
    hasUnsavedChanges,
    isSavingSettings,
    isBusy,
    canSaveSettings,
    assistantNameError,
    assistantCalibrationRequired,
    assistantCalibrationComplete,
    assistantTrainingReadyName,
    onSettingsChange,
    onSaveSettings,
    onResetSettings,
    onOpenAssistantTraining,
  } = props;

  return (
    <section className="settings-card">
      <div className="settings-header">
        <div>
          <h2>{t('settings.title')}</h2>
          <p className="settings-helper">{t('settings.helper')}</p>
        </div>
        <div className="settings-actions">
          <button
            type="button"
            className="secondary-button"
            disabled={!hasUnsavedChanges || isSavingSettings || isBusy || !canSaveSettings}
            onClick={onSaveSettings}
          >
            {isSavingSettings ? t('settings.saving') : t('settings.save')}
          </button>
          <button
            type="button"
            className="danger-button"
            disabled={isSavingSettings || isBusy}
            onClick={onResetSettings}
          >
            {t('settings.reset')}
          </button>
        </div>
      </div>

      <div className="settings-grid">
        <label className="settings-field">
          <span className="info-label">{t('settings.translationTargetLanguage')}</span>
          <select
            value={settings.translationTargetLanguage}
            onChange={(event) =>
              onSettingsChange({
                ...settings,
                translationTargetLanguage: event.target.value,
              })
            }
          >
            {languageOptions.map((option) => (
              <option key={option.code} value={option.code}>
                {option.label}
              </option>
            ))}
          </select>
        </label>

        <label className="settings-field settings-field--wide">
          <span className="info-label">{t('settings.speechPlaybackSpeed')}</span>
          <div className="slider-row">
            <input
              type="range"
              min="0.5"
              max="2"
              step="0.1"
              value={settings.playbackSpeed}
              onChange={(event) =>
                onSettingsChange({ ...settings, playbackSpeed: Number(event.target.value) })
              }
            />
            <output>{settings.playbackSpeed.toFixed(1)}x</output>
          </div>
          <span className="field-note">{t('settings.speechPlaybackSpeedNote')}</span>
        </label>

        <label className="settings-field">
          <span className="info-label">{t('settings.uiLanguage')}</span>
          <select
            value={settings.uiLanguage}
            onChange={(event) =>
              onSettingsChange({
                ...settings,
                uiLanguage: event.target.value,
              })
            }
          >
            <option value="en">{t('settings.uiLanguageOptionEn')}</option>
            <option value="de">{t('settings.uiLanguageOptionDe')}</option>
          </select>
          <span className="field-note">{t('settings.uiLanguageNote')}</span>
        </label>

        <label className="settings-field settings-field--wide">
          <span className="info-label">{t('settings.assistantName')}</span>
          <div className="inline-field-row">
            <input
              type="text"
              placeholder="AIVA"
              value={settings.assistantName}
              onChange={(event) => {
                const nextName = event.target.value;

                // Renaming the assistant invalidates the previous wake-word samples by design.
                onSettingsChange({
                  ...settings,
                  assistantName: nextName,
                  assistantWakeSamples: [],
                  assistantNameSamples: [],
                  assistantSampleLanguage: normalizeLanguageCode(settings.sttLanguage),
                });
              }}
            />
            <button
              type="button"
              className="secondary-button secondary-button--icon"
              disabled={Boolean(assistantNameError) || isSavingSettings}
              onClick={onOpenAssistantTraining}
              title={t('settings.trainWakePhrase')}
            >
              {t('settings.trainWakePhrase')}
            </button>
          </div>
          {assistantNameError ? (
            <span className="field-note field-note--error">{assistantNameError}</span>
          ) : null}
          {!assistantNameError && assistantCalibrationRequired && !assistantCalibrationComplete ? (
            <span className="field-note field-note--warning">
              {t('settings.assistantCalibrationWarning')}
            </span>
          ) : null}
          {!assistantNameError &&
          assistantCalibrationComplete &&
          assistantTrainingReadyName === settings.assistantName ? (
            <span className="field-note field-note--success">
              {t('settings.assistantCalibrationReady')}
            </span>
          ) : null}
          <span className="field-note">
            <Trans
              i18nKey="settings.assistantNameNote"
              values={{ assistantName: settings.assistantName || 'AIVA' }}
              components={{ wake: <code /> }}
            />
          </span>
        </label>

        <label className="settings-field">
          <span className="info-label">{t('settings.activeTranscriptionLanguage')}</span>
          <input
            type="text"
            placeholder="de"
            value={settings.sttLanguage}
            onChange={(event) => {
              // Training samples are language-dependent and must be rebuilt after a locale change.
              onSettingsChange({
                ...settings,
                sttLanguage: event.target.value,
                assistantWakeSamples: [],
                assistantNameSamples: [],
                assistantSampleLanguage: normalizeLanguageCode(event.target.value),
              });
            }}
          />
          <span className="field-note">
            <Trans
              i18nKey="settings.activeTranscriptionLanguageNote"
              components={{ code: <code /> }}
            />
          </span>
        </label>

        <label className="settings-field">
          <span className="info-label">{t('settings.wakeMatchThreshold')}</span>
          <div className="slider-row">
            <input
              type="range"
              min={ASSISTANT_MATCH_THRESHOLD_MIN}
              max={ASSISTANT_MATCH_THRESHOLD_MAX}
              step="1"
              value={settings.assistantWakeThreshold}
              onChange={(event) =>
                onSettingsChange({
                  ...settings,
                  assistantWakeThreshold: parseBoundedInteger(
                    event.target.value,
                    settings.assistantWakeThreshold,
                    ASSISTANT_MATCH_THRESHOLD_MIN,
                    ASSISTANT_MATCH_THRESHOLD_MAX,
                  ),
                })
              }
            />
            <output>{settings.assistantWakeThreshold}</output>
          </div>
          <span className="field-note">{t('settings.wakeMatchThresholdNote')}</span>
        </label>

        <label className="settings-field">
          <span className="info-label">{t('settings.cueCooldown')}</span>
          <input
            type="number"
            min="0"
            max={ASSISTANT_CUE_COOLDOWN_MS_MAX}
            step="100"
            value={settings.assistantCueCooldownMs}
            onChange={(event) =>
              onSettingsChange({
                ...settings,
                assistantCueCooldownMs: parseBoundedInteger(
                  event.target.value,
                  settings.assistantCueCooldownMs,
                  0,
                  ASSISTANT_CUE_COOLDOWN_MS_MAX,
                ),
              })
            }
          />
          <span className="field-note">{t('settings.cueCooldownNote')}</span>
        </label>

        <label className="settings-field settings-field--wide">
          <span className="info-label">{t('settings.backgroundStartup')}</span>
          <label className="checkbox-row">
            <input
              type="checkbox"
              checked={settings.launchAtLogin}
              onChange={(event) =>
                onSettingsChange({ ...settings, launchAtLogin: event.target.checked })
              }
            />
            <span>{t('settings.launchAtLogin')}</span>
          </label>
          <label className="checkbox-row">
            <input
              type="checkbox"
              checked={settings.startHiddenOnLaunch}
              disabled={!settings.launchAtLogin}
              onChange={(event) =>
                onSettingsChange({ ...settings, startHiddenOnLaunch: event.target.checked })
              }
            />
            <span>{t('settings.startHiddenOnLaunch')}</span>
          </label>
          <span className="field-note">{t('settings.backgroundStartupNote')}</span>
        </label>

        <label className="settings-field settings-field--wide">
          <span className="info-label">{t('settings.openaiApiKey')}</span>
          <input
            type="password"
            autoComplete="off"
            placeholder="sk-..."
            value={settings.openaiApiKey}
            onChange={(event) =>
              onSettingsChange({ ...settings, openaiApiKey: event.target.value })
            }
          />
          <span className="field-note">
            <Trans
              i18nKey="settings.openaiApiKeyNote"
              components={{ env: <code />, envFile: <code /> }}
            />
          </span>
        </label>
      </div>
    </section>
  );
}
