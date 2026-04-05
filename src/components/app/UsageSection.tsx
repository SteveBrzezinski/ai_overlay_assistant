import { Trans, useTranslation } from 'react-i18next';

type UsageSectionProps = {
  assistantWakePhrase: string;
  activateHotkey: string;
  deactivateHotkey: string;
  speakHotkey: string;
  translateHotkey: string;
};

export function UsageSection(props: UsageSectionProps): JSX.Element {
  const { t } = useTranslation();
  const {
    assistantWakePhrase,
    activateHotkey,
    deactivateHotkey,
    speakHotkey,
    translateHotkey,
  } = props;

  return (
    <section className="instructions-card">
      <span className="info-label">{t('usage.title')}</span>
      <ol>
        <li>
          {t('usage.step1')}
        </li>
        <li>
          {t('usage.step2')}
        </li>
        <li>
          <Trans
            i18nKey="usage.step3"
            values={{ assistantWakePhrase }}
            components={{ wake: <strong />, action: <strong />, mode: <strong /> }}
          />
        </li>
        <li>
          <Trans
            i18nKey="usage.step4"
            values={{ activateHotkey, deactivateHotkey }}
            components={{ hotkey: <strong />, mode: <strong /> }}
          />
        </li>
        <li>{t('usage.step5')}</li>
        <li>
          <Trans
            i18nKey="usage.step6"
            values={{ speakHotkey, translateHotkey }}
            components={{ speak: <strong />, translate: <strong /> }}
          />
        </li>
      </ol>
    </section>
  );
}
