import { useMemo, useState, type Dispatch, type SetStateAction } from 'react';
import { Trans, useTranslation } from 'react-i18next';
import { DESIGN_THEME_OPTIONS, getDesignThemeLabel, normalizeDesignThemeId } from './designThemes';
import type {
  AppSettings,
  HostedAccountStatus,
  HostedBillingPlan,
  LanguageOption,
} from './lib/voiceOverlay';
import {
  ASSISTANT_CUE_COOLDOWN_MS_MAX,
  ASSISTANT_MATCH_THRESHOLD_MAX,
  ASSISTANT_MATCH_THRESHOLD_MIN,
} from './lib/liveStt';

type SettingsSectionId = 'general' | 'assistant' | 'startup' | 'api' | 'design' | 'actionbar';

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
  hostedAccount: HostedAccountStatus | null;
  hostedAccountError: string | null;
  isHostedAccountBusy: boolean;
  hostedBillingPlans: HostedBillingPlan[];
  selectedHostedPlanKey: string;
  hostedBillingError: string | null;
  isHostedCheckoutBusy: boolean;
  onHostedLogin: (credentials: {
    baseUrl: string;
    email: string;
    password: string;
  }) => Promise<void>;
  onHostedRefresh: () => Promise<void>;
  onHostedLogout: () => Promise<void>;
  onHostedPlanChange: (planKey: string) => void;
  onHostedCheckout: () => Promise<void>;
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
  hostedAccount,
  hostedAccountError,
  isHostedAccountBusy,
  hostedBillingPlans,
  selectedHostedPlanKey,
  hostedBillingError,
  isHostedCheckoutBusy,
  onHostedLogin,
  onHostedRefresh,
  onHostedLogout,
  onHostedPlanChange,
  onHostedCheckout,
  normalizeLanguageCode,
}: SettingsViewProps) {
  const { t } = useTranslation();
  const [activeSection, setActiveSection] = useState<SettingsSectionId | null>(null);
  const [hostedEmailDraft, setHostedEmailDraft] = useState<string | null>(null);
  const [hostedPassword, setHostedPassword] = useState('');
  const hostedEmail = hostedEmailDraft ?? settings.hostedAccountEmail;

  const isHostedMode = settings.aiProviderMode === 'hosted';
  const hostedRealtimeEnabled = Boolean(
    hostedAccount?.entitlements.some((item) => item.feature === 'hosted_realtime' && item.enabled),
  );

  const translationTargetLabel = useMemo(
    () =>
      languageOptions.find((option) => option.code === settings.translationTargetLanguage)?.label ??
      settings.translationTargetLanguage.toUpperCase(),
    [languageOptions, settings.translationTargetLanguage],
  );
  const selectedThemeLabel = useMemo(
    () => getDesignThemeLabel(settings.designThemeId),
    [settings.designThemeId],
  );

  const settingsSections = useMemo<SettingsSection[]>(() => {
    const assistantLabel = settings.assistantName.trim() || 'Ava';
    const assistantLanguage = settings.sttLanguage.trim().toUpperCase() || 'DE';
    const assistantSummary =
      assistantCalibrationComplete && assistantTrainingReadyName === settings.assistantName
        ? t('settingsPage.assistantSummaryReady', {
            assistant: assistantLabel,
            language: assistantLanguage,
          })
        : assistantCalibrationRequired
          ? t('settingsPage.assistantSummaryRecommended', {
              assistant: assistantLabel,
              language: assistantLanguage,
            })
          : t('settingsPage.assistantSummaryDefault', {
              assistant: assistantLabel,
              language: assistantLanguage,
            });
    const actionBarSummary =
      settings.actionBarDisplayMode === 'icons-only'
        ? t('settings.actionBarDisplayIconsOnly')
        : settings.actionBarDisplayMode === 'text-only'
          ? t('settings.actionBarDisplayTextOnly')
          : t('settings.actionBarDisplayIconsAndText');

    return [
      {
        id: 'general',
        label: t('settingsPage.sections.general.label'),
        description: t('settingsPage.sections.general.description'),
        summary: t('settingsPage.generalSummary', {
          translationTarget: translationTargetLabel,
          uiLanguage: settings.uiLanguage.toUpperCase(),
          playbackSpeed: settings.playbackSpeed.toFixed(1),
        }),
      },
      {
        id: 'assistant',
        label: t('settingsPage.sections.assistant.label'),
        description: t('settingsPage.sections.assistant.description'),
        summary: assistantSummary,
      },
      {
        id: 'startup',
        label: t('settingsPage.sections.startup.label'),
        description: t('settingsPage.sections.startup.description'),
        summary: settings.launchAtLogin
          ? settings.startHiddenOnLaunch
            ? t('settingsPage.startupSummaryAutoHidden')
            : t('settingsPage.startupSummaryAutoVisible')
          : t('settingsPage.startupSummaryManual'),
      },
      {
        id: 'api',
        label: 'API',
        description: t('settingsPage.sections.api.description'),
        summary:
          settings.aiProviderMode === 'hosted'
            ? hostedAccount?.connected
              ? t('settingsPage.apiSummaryHostedConnected', {
                  workspace:
                    hostedAccount.currentTeam?.name ??
                    hostedAccount.user?.email ??
                    t('settings.hostedAccountConnected'),
                })
              : t('settingsPage.apiSummaryHostedRequired')
            : settings.openaiApiKey
              ? t('settingsPage.apiSummaryByoCustomKey')
              : t('settingsPage.apiSummaryByoEnvKey'),
      },
      {
        id: 'design',
        label: t('settingsPage.sections.design.label'),
        description: t('settingsPage.sections.design.description'),
        summary: selectedThemeLabel,
      },
      {
        id: 'actionbar',
        label: t('settingsPage.sections.actionbar.label'),
        description: t('settingsPage.sections.actionbar.description'),
        summary: actionBarSummary,
      },
    ];
  }, [
    assistantCalibrationComplete,
    assistantCalibrationRequired,
    assistantTrainingReadyName,
    selectedThemeLabel,
    settings.assistantName,
    settings.aiProviderMode,
    settings.launchAtLogin,
    settings.openaiApiKey,
    settings.playbackSpeed,
    settings.startHiddenOnLaunch,
    settings.sttLanguage,
    settings.translationTargetLanguage,
    settings.uiLanguage,
    settings.actionBarDisplayMode,
    translationTargetLabel,
    hostedAccount,
    t,
  ]);

  const saveDisabled = !hasUnsavedChanges || isSavingSettings || isWorking || !canSaveSettings;
  const settingsStatusTone = assistantNameError ? 'error' : hasUnsavedChanges ? 'pending' : 'saved';
  const settingsStatusText = assistantNameError
    ? assistantNameError
    : hasUnsavedChanges
      ? t('settingsPage.unsavedChangesReady')
      : t('settingsPage.allSettingsSaved');

  const renderDetail = () => {
    if (!activeSection) {
      return (
        <div className="settings-panel-empty">
          <span className="settings-panel-eyebrow">{t('settingsPage.overviewEyebrow')}</span>
          <h2>{t('settingsPage.overviewTitle')}</h2>
          <p className="settings-helper">{t('settingsPage.overviewDescription')}</p>
          <div className="settings-panel-meta">
            <span className={`settings-state-pill settings-state-pill--${settingsStatusTone}`}>{settingsStatusText}</span>
            <p className="field-note">{t('settings.helper')}</p>
          </div>
        </div>
      );
    }

    if (activeSection === 'general') {
      return (
        <div className="settings-detail-stack">
          <div className="settings-panel-header">
            <div>
              <span className="settings-panel-eyebrow">{t('settingsPage.sections.general.label')}</span>
              <h2>{t('settingsPage.sections.general.label')}</h2>
              <p className="settings-helper">{t('settingsPage.sections.general.helper')}</p>
            </div>
            <button type="button" className="settings-link-button" onClick={() => setActiveSection(null)}>
              {t('settingsPage.showCategories')}
            </button>
          </div>
          <div className="settings-grid">
            <label className="settings-field">
              <span className="info-label">{t('settings.translationTargetLanguage')}</span>
              <select
                value={settings.translationTargetLanguage}
                onChange={(event) =>
                  setSettings({
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
                    setSettings({ ...settings, playbackSpeed: Number(event.target.value) })
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
                  setSettings({
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
          </div>
        </div>
      );
    }

    if (activeSection === 'assistant') {
      return (
        <div className="settings-detail-stack">
          <div className="settings-panel-header">
            <div>
              <span className="settings-panel-eyebrow">{t('settingsPage.sections.assistant.label')}</span>
              <h2>{t('settingsPage.sections.assistant.label')}</h2>
              <p className="settings-helper">{t('settingsPage.sections.assistant.helper')}</p>
            </div>
            <button type="button" className="settings-link-button" onClick={() => setActiveSection(null)}>
              {t('settingsPage.showCategories')}
            </button>
          </div>
          <div className="settings-grid">
            <label className="settings-field settings-field--wide">
              <span className="info-label">{t('settings.assistantName')}</span>
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
                <button
                  type="button"
                  className="secondary-button secondary-button--icon"
                  disabled={Boolean(assistantNameError) || isSavingSettings}
                  onClick={() => void onOpenTraining()}
                >
                  {t('settings.trainWakePhrase')}
                </button>
              </div>
              {assistantNameError ? <span className="field-note field-note--error">{assistantNameError}</span> : null}
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
                  values={{ assistantName: settings.assistantName || 'Ava' }}
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
                onChange={(event) =>
                  setSettings({
                    ...settings,
                    sttLanguage: event.target.value,
                    assistantWakeSamples: [],
                    assistantNameSamples: [],
                    assistantSampleLanguage: normalizeLanguageCode(event.target.value),
                  })
                }
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
                    setSettings({
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
                  setSettings({
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
          </div>
        </div>
      );
    }

    if (activeSection === 'startup') {
      return (
        <div className="settings-detail-stack">
          <div className="settings-panel-header">
            <div>
              <span className="settings-panel-eyebrow">{t('settingsPage.sections.startup.label')}</span>
              <h2>{t('settingsPage.sections.startup.label')}</h2>
              <p className="settings-helper">{t('settingsPage.sections.startup.helper')}</p>
            </div>
            <button type="button" className="settings-link-button" onClick={() => setActiveSection(null)}>
              {t('settingsPage.showCategories')}
            </button>
          </div>
          <div className="settings-grid">
            <label className="settings-field settings-field--wide">
              <span className="info-label">{t('settings.backgroundStartup')}</span>
              <label className="checkbox-row">
                <input
                  type="checkbox"
                  checked={settings.launchAtLogin}
                  onChange={(event) =>
                    setSettings({ ...settings, launchAtLogin: event.target.checked })
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
                    setSettings({ ...settings, startHiddenOnLaunch: event.target.checked })
                  }
                />
                <span>{t('settings.startHiddenOnLaunch')}</span>
              </label>
              <span className="field-note">{t('settings.backgroundStartupNote')}</span>
            </label>
          </div>
        </div>
      );
    }

    if (activeSection === 'api') {
      return (
        <div className="settings-detail-stack">
          <div className="settings-panel-header">
            <div>
              <span className="settings-panel-eyebrow">API</span>
              <h2>API</h2>
              <p className="settings-helper">{t('settingsPage.sections.api.helper')}</p>
            </div>
            <button type="button" className="settings-link-button" onClick={() => setActiveSection(null)}>
              {t('settingsPage.showCategories')}
            </button>
          </div>
          <div className="settings-grid">
            <label className="settings-field settings-field--wide">
              <span className="info-label">{t('settings.aiProviderMode')}</span>
              <select
                value={settings.aiProviderMode}
                onChange={(event) =>
                  setSettings({
                    ...settings,
                    aiProviderMode: event.target.value as AppSettings['aiProviderMode'],
                  })
                }
              >
                <option value="byo">{t('settings.aiProviderModeByo')}</option>
                <option value="hosted">{t('settings.aiProviderModeHosted')}</option>
              </select>
              <span className="field-note">{t('settings.aiProviderModeNote')}</span>
              {isHostedMode ? (
                <span className="field-note field-note--warning">
                  {t('settings.hostedModeScopeNote')}
                </span>
              ) : null}
            </label>

            {isHostedMode ? (
              <>
                <label className="settings-field settings-field--wide">
                  <span className="info-label">{t('settings.hostedApiBaseUrl')}</span>
                  <input
                    type="url"
                    autoComplete="off"
                    placeholder="https://app.example.com"
                    value={settings.hostedApiBaseUrl}
                    onChange={(event) =>
                      setSettings({ ...settings, hostedApiBaseUrl: event.target.value })
                    }
                  />
                  <span className="field-note">
                    <Trans
                      i18nKey="settings.hostedApiBaseUrlNote"
                      components={{ code: <code /> }}
                    />
                  </span>
                </label>

                <div className="settings-field settings-field--wide">
                  <span className="info-label">{t('settings.hostedAccount')}</span>
                  <div className="settings-auth-panel">
                    <div className="settings-auth-summary">
                      <strong>
                        {hostedAccount?.connected
                          ? t('settings.hostedAccountConnected')
                          : t('settings.hostedAccountDisconnected')}
                      </strong>
                      <p>
                        {hostedAccountError
                          ? hostedAccountError
                          : hostedAccount?.connected
                            ? t('settings.hostedAccountSummary', {
                                email: hostedAccount.user?.email ?? hostedEmail.trim(),
                                workspace:
                                  hostedAccount.currentTeam?.name ??
                                  hostedAccount.currentTeam?.slug ??
                                  t('settings.hostedWorkspaceCurrentDefault'),
                              })
                            : t('settings.hostedAccountSummaryDisconnected')}
                      </p>
                      {hostedAccount?.subscription ? (
                        <p>
                          {t('settings.hostedSubscriptionSummary', {
                            plan: hostedAccount.subscription.planKey,
                            seats: hostedAccount.subscription.seats,
                            status: hostedAccount.subscription.status,
                          })}
                        </p>
                      ) : null}
                      {hostedAccount?.connected ? (
                        <p>
                          {hostedRealtimeEnabled
                            ? t('settings.hostedRealtimeReady')
                            : t('settings.hostedRealtimeUnavailable')}
                        </p>
                      ) : null}
                    </div>

                    <div className="settings-auth-grid">
                      <input
                        type="email"
                        autoComplete="username"
                        placeholder="name@example.com"
                        value={hostedEmail}
                        onChange={(event) => setHostedEmailDraft(event.target.value)}
                      />
                      <input
                        type="password"
                        autoComplete="current-password"
                        placeholder={t('settings.hostedPasswordPlaceholder')}
                        value={hostedPassword}
                        onChange={(event) => setHostedPassword(event.target.value)}
                      />
                    </div>

                    <div className="settings-actions">
                      <button
                        type="button"
                        className="secondary-button"
                        disabled={
                          isHostedAccountBusy ||
                          isSavingSettings ||
                          !settings.hostedApiBaseUrl.trim() ||
                          !hostedEmail.trim() ||
                          !hostedPassword.trim()
                        }
                        onClick={() => {
                          void (async () => {
                            await onHostedLogin({
                              baseUrl: settings.hostedApiBaseUrl,
                              email: hostedEmail,
                              password: hostedPassword,
                            });
                            setHostedEmailDraft(null);
                            setHostedPassword('');
                          })();
                        }}
                      >
                        {isHostedAccountBusy
                          ? t('settings.hostedSigningIn')
                          : t('settings.hostedSignIn')}
                      </button>
                      <button
                        type="button"
                        className="secondary-button"
                        disabled={
                          isHostedAccountBusy ||
                          isSavingSettings ||
                          !settings.hostedApiBaseUrl.trim() ||
                          !settings.hostedAccessToken.trim()
                        }
                        onClick={() => void onHostedRefresh()}
                      >
                        {t('settings.hostedRefresh')}
                      </button>
                      <button
                        type="button"
                        className="danger-button"
                        disabled={
                          isHostedAccountBusy ||
                          isSavingSettings ||
                          !settings.hostedAccessToken.trim()
                        }
                        onClick={() => {
                          void (async () => {
                            await onHostedLogout();
                            setHostedEmailDraft(null);
                            setHostedPassword('');
                          })();
                        }}
                      >
                        {t('settings.hostedSignOut')}
                      </button>
                    </div>
                  </div>
                </div>

                <div className="settings-field">
                  <span className="info-label">{t('settings.hostedWorkspace')}</span>
                  {hostedAccount?.teams.length ? (
                    <select
                      value={settings.hostedWorkspaceSlug}
                      onChange={(event) =>
                        setSettings({
                          ...settings,
                          hostedWorkspaceSlug: event.target.value,
                        })
                      }
                    >
                      <option value="">
                        {t('settings.hostedWorkspaceUseCurrent', {
                          workspace:
                            hostedAccount.currentTeam?.name ??
                            hostedAccount.currentTeam?.slug ??
                            t('settings.hostedWorkspaceCurrentDefault'),
                        })}
                      </option>
                      {hostedAccount.teams.map((team) => (
                        <option key={team.slug} value={team.slug}>
                          {team.name}
                        </option>
                      ))}
                    </select>
                  ) : (
                    <input
                      type="text"
                      autoComplete="off"
                      placeholder="my-workspace"
                      value={settings.hostedWorkspaceSlug}
                      onChange={(event) =>
                        setSettings({
                          ...settings,
                          hostedWorkspaceSlug: event.target.value,
                        })
                      }
                    />
                  )}
                  <span className="field-note">
                    {t('settings.hostedWorkspaceNote')}
                  </span>
                </div>

                <div className="settings-field settings-field--wide">
                  <span className="info-label">{t('settings.hostedBilling')}</span>
                  <div className="settings-auth-panel">
                    <div className="settings-auth-summary">
                      <strong>{t('settings.hostedBillingTitle')}</strong>
                      <p>{t('settings.hostedBillingNote')}</p>
                      {hostedBillingError ? (
                        <p className="field-note field-note--error">{hostedBillingError}</p>
                      ) : null}
                    </div>

                    <div className="settings-auth-grid">
                      <select
                        value={selectedHostedPlanKey}
                        disabled={!hostedBillingPlans.length || isHostedCheckoutBusy}
                        onChange={(event) => onHostedPlanChange(event.target.value)}
                      >
                        {hostedBillingPlans.length ? (
                          hostedBillingPlans.map((plan) => (
                            <option key={plan.key} value={plan.key}>
                              {t('settings.hostedBillingPlanOption', {
                                name: plan.name,
                                seats: plan.seatLimit,
                              })}
                            </option>
                          ))
                        ) : (
                          <option value="">{t('settings.hostedBillingNoPlans')}</option>
                        )}
                      </select>
                    </div>

                    <div className="settings-actions">
                      <button
                        type="button"
                        className="primary-button"
                        disabled={
                          isHostedCheckoutBusy ||
                          isHostedAccountBusy ||
                          !hostedAccount?.connected ||
                          !selectedHostedPlanKey
                        }
                        onClick={() => void onHostedCheckout()}
                      >
                        {isHostedCheckoutBusy
                          ? t('settings.hostedBillingOpening')
                          : t('settings.hostedBillingCheckout')}
                      </button>
                    </div>
                  </div>
                </div>
              </>
            ) : (
              <label className="settings-field settings-field--wide">
                <span className="info-label">{t('settings.openaiApiKey')}</span>
                <input
                  type="password"
                  autoComplete="off"
                  placeholder="sk-..."
                  value={settings.openaiApiKey}
                  onChange={(event) =>
                    setSettings({ ...settings, openaiApiKey: event.target.value })
                  }
                />
                <span className="field-note">
                  <Trans
                    i18nKey="settings.openaiApiKeyNote"
                    components={{ env: <code />, envFile: <code /> }}
                  />
                </span>
              </label>
            )}
          </div>
        </div>
      );
    }

    const selectedThemeId = normalizeDesignThemeId(settings.designThemeId);

    if (activeSection === 'actionbar') {
      return (
        <div className="settings-detail-stack">
          <div className="settings-panel-header">
            <div>
              <span className="settings-panel-eyebrow">{t('settingsPage.sections.actionbar.label')}</span>
              <h2>{t('settingsPage.sections.actionbar.title')}</h2>
              <p className="settings-helper">{t('settingsPage.sections.actionbar.helper')}</p>
            </div>
            <button type="button" className="settings-link-button" onClick={() => setActiveSection(null)}>
              {t('settingsPage.showCategories')}
            </button>
          </div>
          <div className="settings-actionbar-content">
            <fieldset className="settings-actionbar-fieldset">
              <legend className="info-label">{t('settingsPage.sections.actionbar.fieldsetLegend')}</legend>
              <div className="radio-group">
                <label className="radio-label">
                  <input
                    type="radio"
                    name="actionBarDisplayMode"
                    value="icons-only"
                    checked={settings.actionBarDisplayMode === 'icons-only'}
                    onChange={(e) =>
                      setSettings({
                        ...settings,
                        actionBarDisplayMode: e.target.value as 'icons-only' | 'text-only' | 'icons-and-text',
                      })
                    }
                  />
                  <span className="radio-label-text">{t('settings.actionBarDisplayIconsOnly')}</span>
                </label>
                <label className="radio-label">
                  <input
                    type="radio"
                    name="actionBarDisplayMode"
                    value="text-only"
                    checked={settings.actionBarDisplayMode === 'text-only'}
                    onChange={(e) =>
                      setSettings({
                        ...settings,
                        actionBarDisplayMode: e.target.value as 'icons-only' | 'text-only' | 'icons-and-text',
                      })
                    }
                  />
                  <span className="radio-label-text">{t('settings.actionBarDisplayTextOnly')}</span>
                </label>
                <label className="radio-label">
                  <input
                    type="radio"
                    name="actionBarDisplayMode"
                    value="icons-and-text"
                    checked={settings.actionBarDisplayMode === 'icons-and-text'}
                    onChange={(e) =>
                      setSettings({
                        ...settings,
                        actionBarDisplayMode: e.target.value as 'icons-only' | 'text-only' | 'icons-and-text',
                      })
                    }
                  />
                  <span className="radio-label-text">{t('settings.actionBarDisplayIconsAndText')}</span>
                </label>
              </div>
              <span className="field-note">{t('settings.actionBarDisplayNote')}</span>
            </fieldset>
            <label className="settings-field settings-field--wide">
              <span className="info-label">{t('settings.actionBarGlowColor')}</span>
              <div className="settings-color-row">
                <input
                  type="color"
                  className="settings-color-picker"
                  value={settings.actionBarActiveGlowColor}
                  onChange={(event) =>
                    setSettings({
                      ...settings,
                      actionBarActiveGlowColor: event.target.value,
                    })
                  }
                />
                <input
                  type="text"
                  inputMode="text"
                  autoComplete="off"
                  spellCheck={false}
                  className="settings-color-value"
                  placeholder="#b63131"
                  value={settings.actionBarActiveGlowColor}
                  onChange={(event) =>
                    setSettings({
                      ...settings,
                      actionBarActiveGlowColor: event.target.value,
                    })
                  }
                />
              </div>
              <span className="field-note">
                {t('settings.actionBarGlowColorNote')}
              </span>
            </label>
          </div>
        </div>
      );
    }

    return (
      <div className="settings-detail-stack">
        <div className="settings-panel-header">
          <div>
            <span className="settings-panel-eyebrow">{t('settingsPage.sections.design.label')}</span>
            <h2>{t('settingsPage.sections.design.label')}</h2>
            <p className="settings-helper">{t('settingsPage.sections.design.helper')}</p>
          </div>
          <button type="button" className="settings-link-button" onClick={() => setActiveSection(null)}>
            {t('settingsPage.showCategories')}
          </button>
        </div>
        <div className="design-grid">
          {DESIGN_THEME_OPTIONS.map((theme) => {
            const isActive = selectedThemeId === theme.id;
            const themeAccent = t(`settingsPage.themeCards.${theme.id}.accent`, {
              defaultValue: theme.accent,
            });
            const themeDescription = t(`settingsPage.themeCards.${theme.id}.description`, {
              defaultValue: theme.description,
            });
            const themeContrast = t(`settingsPage.themeCards.${theme.id}.contrast`, {
              defaultValue: theme.contrast,
            });
            return (
              <button
                type="button"
                key={theme.id}
                data-preview-theme={theme.id}
                className={`design-card ${isActive ? 'design-card--active' : ''}`}
                onClick={() => setSettings({ ...settings, designThemeId: theme.id })}
              >
                <div className="design-card__preview" aria-hidden="true">
                  <span className="design-card__preview-window" />
                  <span className="design-card__preview-rail" />
                  <span className="design-card__preview-panel" />
                  <span className="design-card__preview-orb">
                    <span className="design-card__preview-ring design-card__preview-ring--outer" />
                    <span className="design-card__preview-ring design-card__preview-ring--middle" />
                    <span className="design-card__preview-core" />
                  </span>
                </div>
                <span className="design-card__eyebrow">{themeAccent}</span>
                <strong className="design-card__title">{theme.label}</strong>
                <p className="design-card__description">{themeDescription}</p>
                <span className="design-card__meta">
                  {isActive ? t('settingsPage.designSelectedForPreview') : themeContrast}
                </span>
              </button>
            );
          })}
        </div>
        <p className="field-note">{t('settingsPage.designApplyNote')}</p>
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
            <span className="toolbar-button__label">{t('settingsPage.dashboard')}</span>
          </button>
          <div className="settings-actions">
            <button type="button" className="secondary-button" disabled={saveDisabled} onClick={() => void onSave()}>
              {isSavingSettings ? t('settings.saving') : t('settings.save')}
            </button>
            <button type="button" className="danger-button" disabled={isSavingSettings || isWorking} onClick={onReset}>
              {t('settings.reset')}
            </button>
          </div>
        </div>
        <h1>{t('settings.title')}</h1>
        <p className="hero-copy">{t('settingsPage.heroCopy')}</p>
        <div className="settings-panel-meta">
          <span className={`settings-state-pill settings-state-pill--${settingsStatusTone}`}>{settingsStatusText}</span>
          <p className="field-note">{t('settings.helper')}</p>
        </div>
      </section>

      <section className="settings-layout">
        <aside className="settings-sidebar">
          <span className="info-label">{t('settingsPage.categories')}</span>
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
