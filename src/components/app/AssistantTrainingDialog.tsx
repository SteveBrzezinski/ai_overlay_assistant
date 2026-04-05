import { Trans, useTranslation } from 'react-i18next';

import type { CalibrationStep } from '../../lib/app/appModel';

type AssistantTrainingDialogProps = {
  step: CalibrationStep | null;
  isRecording: boolean;
  liveTranscript: string;
  capturedTranscript: string;
  status: string;
  error: string;
  onClose: () => void;
  onStartRecording: () => void;
  onStopRecording: () => void;
  onRetry: () => void;
  onConfirm: () => void;
};

export function AssistantTrainingDialog(
  props: AssistantTrainingDialogProps,
): JSX.Element | null {
  const { t } = useTranslation();
  const {
    step,
    isRecording,
    liveTranscript,
    capturedTranscript,
    status,
    error,
    onClose,
    onStartRecording,
    onStopRecording,
    onRetry,
    onConfirm,
  } = props;

  if (!step) {
    return null;
  }

  return (
    <div className="modal-backdrop" role="presentation" onClick={onClose}>
      <section
        className="modal-card modal-card--wide"
        role="dialog"
        aria-modal="true"
        aria-labelledby="assistant-training-title"
        onClick={(event) => event.stopPropagation()}
      >
        <button
          type="button"
          className="modal-close"
          aria-label={t('dialogs.closeTraining')}
          onClick={onClose}
        >
          x
        </button>
        <h2 id="assistant-training-title">{t('dialogs.trainingTitle')}</h2>
        <p>
          {step.progress}) {step.headline}
        </p>
        <div className="training-phrase-box">
          <strong>{step.prompt}</strong>
        </div>
        <p className="field-note">
          <Trans
            i18nKey="dialogs.trainingNote"
            values={{ language: step.recognitionLanguage }}
            components={{ code: <code /> }}
          />
        </p>
        <div className="modal-actions">
          <button
            type="button"
            className="primary-button"
            disabled={isRecording}
            onClick={onStartRecording}
          >
            {t('dialogs.start')}
          </button>
          <button
            type="button"
            className="secondary-button"
            disabled={!isRecording}
            onClick={onStopRecording}
          >
            {t('dialogs.stop')}
          </button>
          <button
            type="button"
            className="secondary-button"
            disabled={!capturedTranscript.trim()}
            onClick={onRetry}
          >
            {t('dialogs.retry')}
          </button>
          <button
            type="button"
            className="secondary-button"
            disabled={!capturedTranscript.trim()}
            onClick={onConfirm}
          >
            {t('dialogs.confirm')}
          </button>
        </div>
        <div className="result-block">
          <span className="info-label">{t('dialogs.liveCapture')}</span>
          <p>{liveTranscript || t('dialogs.noTranscriptYet')}</p>
        </div>
        <div className="result-block">
          <span className="info-label">{t('dialogs.capturedSample')}</span>
          <p>{capturedTranscript || t('dialogs.reviewAfterStop')}</p>
        </div>
        {status ? <p className="field-note">{status}</p> : null}
        {error ? <p className="field-note field-note--error">{error}</p> : null}
      </section>
    </div>
  );
}
