import { useTranslation } from 'react-i18next';

type ResetSettingsDialogProps = {
  open: boolean;
  onClose: () => void;
  onConfirm: () => void;
};

export function ResetSettingsDialog(props: ResetSettingsDialogProps): JSX.Element | null {
  const { t } = useTranslation();
  const { open, onClose, onConfirm } = props;

  if (!open) {
    return null;
  }

  return (
    <div className="modal-backdrop" role="presentation" onClick={onClose}>
      <section
        className="modal-card"
        role="dialog"
        aria-modal="true"
        aria-labelledby="reset-settings-title"
        onClick={(event) => event.stopPropagation()}
      >
        <button
          type="button"
          className="modal-close"
          aria-label={t('dialogs.closeReset')}
          onClick={onClose}
        >
          x
        </button>
        <h2 id="reset-settings-title">{t('dialogs.resetTitle')}</h2>
        <p>{t('dialogs.resetBody')}</p>
        <div className="modal-actions">
          <button type="button" className="secondary-button" onClick={onClose}>
            {t('dialogs.resetNo')}
          </button>
          <button type="button" className="danger-button" onClick={onConfirm}>
            {t('dialogs.resetConfirm')}
          </button>
        </div>
      </section>
    </div>
  );
}
