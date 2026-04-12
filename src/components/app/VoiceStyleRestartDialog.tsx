import { useTranslation } from 'react-i18next';

type VoiceStyleRestartDialogProps = {
  open: boolean;
  changeKind: 'gender' | 'model' | 'model-and-gender';
  isBusy: boolean;
  onClose: () => void;
  onConfirm: () => void;
};

export function VoiceStyleRestartDialog(
  props: VoiceStyleRestartDialogProps,
): JSX.Element | null {
  const { t } = useTranslation();
  const { open, changeKind, isBusy, onClose, onConfirm } = props;

  if (!open) {
    return null;
  }

  const titleKey =
    changeKind === 'model'
      ? 'dialogs.voiceModelRestartTitle'
      : changeKind === 'model-and-gender'
        ? 'dialogs.voiceStyleModelRestartTitle'
        : 'dialogs.voiceStyleRestartTitle';
  const bodyKey =
    changeKind === 'model'
      ? 'dialogs.voiceModelRestartBody'
      : changeKind === 'model-and-gender'
        ? 'dialogs.voiceStyleModelRestartBody'
        : 'dialogs.voiceStyleRestartBody';
  const detailKey =
    changeKind === 'model'
      ? 'dialogs.voiceModelRestartDetail'
      : changeKind === 'model-and-gender'
        ? 'dialogs.voiceStyleModelRestartDetail'
        : 'dialogs.voiceStyleRestartDetail';
  const confirmKey =
    changeKind === 'model'
      ? 'dialogs.voiceModelRestartConfirm'
      : changeKind === 'model-and-gender'
        ? 'dialogs.voiceStyleModelRestartConfirm'
        : 'dialogs.voiceStyleRestartConfirm';
  const confirmingKey =
    changeKind === 'model'
      ? 'dialogs.voiceModelRestartConfirming'
      : changeKind === 'model-and-gender'
        ? 'dialogs.voiceStyleModelRestartConfirming'
        : 'dialogs.voiceStyleRestartConfirming';

  return (
    <div
      className="modal-backdrop"
      role="presentation"
      onClick={isBusy ? undefined : onClose}
    >
      <section
        className="modal-card"
        role="dialog"
        aria-modal="true"
        aria-labelledby="voice-style-restart-title"
        onClick={(event) => event.stopPropagation()}
      >
        <button
          type="button"
          className="modal-close"
          aria-label={t('dialogs.closeVoiceStyleRestart')}
          onClick={onClose}
          disabled={isBusy}
        >
          x
        </button>
        <h2 id="voice-style-restart-title">{t(titleKey)}</h2>
        <p>{t(bodyKey)}</p>
        <p>{t(detailKey)}</p>
        <div className="modal-actions">
          <button
            type="button"
            className="secondary-button"
            onClick={onClose}
            disabled={isBusy}
          >
            {t('dialogs.voiceStyleRestartNo')}
          </button>
          <button
            type="button"
            className="primary-button"
            onClick={onConfirm}
            disabled={isBusy}
          >
            {isBusy ? t(confirmingKey) : t(confirmKey)}
          </button>
        </div>
      </section>
    </div>
  );
}
