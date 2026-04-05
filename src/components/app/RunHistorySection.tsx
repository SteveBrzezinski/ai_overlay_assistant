import { useTranslation } from 'react-i18next';

import type { RunHistoryEntry } from '../../lib/app/appModel';

type RunHistorySectionProps = {
  entries: RunHistoryEntry[];
  onClear: () => void;
};

export function RunHistorySection(props: RunHistorySectionProps): JSX.Element | null {
  const { t } = useTranslation();
  const { entries, onClear } = props;

  if (!entries.length) {
    return null;
  }

  return (
    <section className="instructions-card">
      <div
        style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: '1rem' }}
      >
        <span className="info-label">{t('runHistory.title')}</span>
        <button type="button" className="secondary-button" onClick={onClear}>
          {t('runHistory.clear')}
        </button>
      </div>
      <div className="result-block">
        {entries.map((entry) => (
          <div
            key={entry.id}
            style={{ padding: '0.75rem 0', borderTop: '1px solid rgba(255,255,255,0.08)' }}
          >
            <p>
              <strong>{entry.mode || t('runHistory.unknownMode')}</strong>
              {entry.requestedMode
                ? ` - ${t('runHistory.requestedMode', { mode: entry.requestedMode })}`
                : ''}
              {entry.sessionStrategy ? ` - ${entry.sessionStrategy}` : ''}
            </p>
            <p>
              {new Date(entry.recordedAtMs).toLocaleTimeString()} - {entry.message}
            </p>
            <p>
              {t('runHistory.metrics', {
                hotkeyToAudio: entry.hotkeyToFirstPlaybackMs ?? '-',
                capture: entry.captureDurationMs ?? '-',
                captureToTts: entry.captureToTtsStartMs ?? '-',
                ttsToAudio: entry.ttsToFirstAudioMs ?? '-',
                audioToPlayback: entry.firstAudioToPlaybackMs ?? '-',
              })}
            </p>
          </div>
        ))}
      </div>
    </section>
  );
}
