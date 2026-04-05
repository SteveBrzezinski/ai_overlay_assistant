import { Trans, useTranslation } from 'react-i18next';

type HeroSectionProps = {
  hotkeyRegistered: boolean;
  speakHotkey: string;
  translateHotkey: string;
  isBusy: boolean;
  isSavingSettings: boolean;
  assistantActive: boolean;
  voiceAgentState: string;
  onReadSelectedText: () => void;
  onTranslateSelectedText: () => void;
  onActivateAssistant: () => void;
  onDeactivateAssistant: () => void;
};

export function HeroSection(props: HeroSectionProps): JSX.Element {
  const { t } = useTranslation();
  const {
    hotkeyRegistered,
    speakHotkey,
    translateHotkey,
    isBusy,
    isSavingSettings,
    assistantActive,
    voiceAgentState,
    onReadSelectedText,
    onTranslateSelectedText,
    onActivateAssistant,
    onDeactivateAssistant,
  } = props;

  return (
    <section className="hero-card">
      <div className="status-row">
        <span className="status-dot" aria-hidden="true" />
        <span className="status-text">
          {hotkeyRegistered ? t('hero.statusActive') : t('hero.statusChecking')}
        </span>
      </div>
      <h1>{t('hero.title')}</h1>
      <p className="hero-copy">
        <Trans
          i18nKey="hero.copy"
          values={{ speakHotkey, translateHotkey }}
          components={{ speak: <strong />, translate: <strong /> }}
        />
      </p>
      <div className="actions">
        <button
          type="button"
          className="primary-button"
          disabled={isBusy || isSavingSettings}
          onClick={onReadSelectedText}
        >
          {isBusy ? t('hero.actions.working') : t('hero.actions.localSpeechTest')}
        </button>
        <button
          type="button"
          className="secondary-button"
          disabled={isBusy || isSavingSettings}
          onClick={onTranslateSelectedText}
        >
          {t('hero.actions.localTranslationTest')}
        </button>
        <button
          type="button"
          className="secondary-button"
          disabled={isSavingSettings || assistantActive || voiceAgentState === 'connecting'}
          onClick={onActivateAssistant}
        >
          {t('hero.actions.activateAssistant')}
        </button>
        <button
          type="button"
          className="secondary-button"
          disabled={isSavingSettings || !assistantActive}
          onClick={onDeactivateAssistant}
        >
          {t('hero.actions.deactivateAssistant')}
        </button>
      </div>
    </section>
  );
}
