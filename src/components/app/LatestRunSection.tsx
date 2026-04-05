import { useTranslation } from 'react-i18next';

import { formatTimestamp } from '../../lib/app/appModel';

type LatestRunSectionProps = {
  uiState: 'idle' | 'working' | 'success' | 'error';
  message: string;
  capturedPreview: string;
  translatedPreview: string;
  lastTtsMode: string;
  lastRequestedTtsMode: string;
  lastSessionStrategy: string;
  lastSessionId: string;
  lastSessionFallbackReason: string;
  lastSttProvider: string;
  lastSttActiveTranscript: string;
  lastSttDebugLogPath: string;
  startLatencyMs: number | null;
  hotkeyToFirstAudioMs: number | null;
  hotkeyToFirstPlaybackMs: number | null;
  captureDurationMs: number | null;
  captureToTtsStartMs: number | null;
  ttsToFirstAudioMs: number | null;
  firstAudioToPlaybackMs: number | null;
  hotkeyStartedAtMs: number | null;
  captureStartedAtMs: number | null;
  captureFinishedAtMs: number | null;
  ttsStartedAtMs: number | null;
  firstAudioReceivedAtMs: number | null;
  firstAudioPlaybackStartedAtMs: number | null;
  lastAudioPath: string;
  lastAudioOutputDirectory: string;
  lastAudioChunkCount: number;
};

export function LatestRunSection(props: LatestRunSectionProps): JSX.Element {
  const { t } = useTranslation();
  const {
    uiState,
    message,
    capturedPreview,
    translatedPreview,
    lastTtsMode,
    lastRequestedTtsMode,
    lastSessionStrategy,
    lastSessionId,
    lastSessionFallbackReason,
    lastSttProvider,
    lastSttActiveTranscript,
    lastSttDebugLogPath,
    startLatencyMs,
    hotkeyToFirstAudioMs,
    hotkeyToFirstPlaybackMs,
    captureDurationMs,
    captureToTtsStartMs,
    ttsToFirstAudioMs,
    firstAudioToPlaybackMs,
    hotkeyStartedAtMs,
    captureStartedAtMs,
    captureFinishedAtMs,
    ttsStartedAtMs,
    firstAudioReceivedAtMs,
    firstAudioPlaybackStartedAtMs,
    lastAudioPath,
    lastAudioOutputDirectory,
    lastAudioChunkCount,
  } = props;

  return (
    <section className={`result-card result-card--${uiState}`}>
      <div>
        <span className="info-label">{t('latestRun.title')}</span>
        <strong>{message}</strong>
      </div>
      {capturedPreview ? (
        <div className="result-block">
          <span className="info-label">{t('latestRun.capturedText')}</span>
          <p>{capturedPreview}</p>
        </div>
      ) : null}
      {translatedPreview ? (
        <div className="result-block">
          <span className="info-label">{t('latestRun.translation')}</span>
          <p>{translatedPreview}</p>
        </div>
      ) : null}
      {lastTtsMode ? (
        <div className="result-block">
          <span className="info-label">{t('latestRun.resolvedTtsMode')}</span>
          <strong>{lastTtsMode}</strong>
        </div>
      ) : null}
      {lastRequestedTtsMode ? (
        <div className="result-block">
          <span className="info-label">{t('latestRun.requestedTtsMode')}</span>
          <strong>{lastRequestedTtsMode}</strong>
        </div>
      ) : null}
      {lastSessionStrategy ? (
        <div className="result-block">
          <span className="info-label">{t('latestRun.sessionStrategy')}</span>
          <p>{lastSessionStrategy}</p>
          <code>{lastSessionId}</code>
        </div>
      ) : null}
      {lastSessionFallbackReason ? (
        <div className="result-block">
          <span className="info-label">{t('latestRun.sessionFallback')}</span>
          <p>{lastSessionFallbackReason}</p>
        </div>
      ) : null}
      {lastSttProvider ? (
        <div className="result-block">
          <span className="info-label">{t('latestRun.lastSttProvider')}</span>
          <strong>{lastSttProvider}</strong>
        </div>
      ) : null}
      {lastSttActiveTranscript ? (
        <div className="result-block">
          <span className="info-label">{t('latestRun.lastSttTranscript')}</span>
          <p>{lastSttActiveTranscript}</p>
        </div>
      ) : null}
      {lastSttDebugLogPath ? (
        <div className="result-block">
          <span className="info-label">{t('latestRun.sttDebugLog')}</span>
          <code>{lastSttDebugLogPath}</code>
        </div>
      ) : null}
      {startLatencyMs !== null ? (
        <div className="result-block">
          <span className="info-label">{t('latestRun.visibleStartLatency')}</span>
          <strong>{startLatencyMs} ms</strong>
        </div>
      ) : null}
      {hotkeyToFirstPlaybackMs !== null || hotkeyToFirstAudioMs !== null ? (
        <div className="result-block">
          <span className="info-label">{t('latestRun.endToEndLatency')}</span>
          {hotkeyToFirstAudioMs !== null ? (
            <p>{t('latestRun.hotkeyToFirstAudio', { value: hotkeyToFirstAudioMs })}</p>
          ) : null}
          {hotkeyToFirstPlaybackMs !== null ? (
            <p>{t('latestRun.hotkeyToFirstPlayback', { value: hotkeyToFirstPlaybackMs })}</p>
          ) : null}
        </div>
      ) : null}
      {captureDurationMs !== null ||
      captureToTtsStartMs !== null ||
      ttsToFirstAudioMs !== null ||
      firstAudioToPlaybackMs !== null ? (
        <div className="result-block">
          <span className="info-label">{t('latestRun.latencyBreakdown')}</span>
          {captureDurationMs !== null ? (
            <p>{t('latestRun.captureDuration', { value: captureDurationMs })}</p>
          ) : null}
          {captureToTtsStartMs !== null ? (
            <p>{t('latestRun.captureToTtsStart', { value: captureToTtsStartMs })}</p>
          ) : null}
          {ttsToFirstAudioMs !== null ? (
            <p>{t('latestRun.ttsToFirstAudio', { value: ttsToFirstAudioMs })}</p>
          ) : null}
          {firstAudioToPlaybackMs !== null ? (
            <p>{t('latestRun.firstAudioToPlayback', { value: firstAudioToPlaybackMs })}</p>
          ) : null}
        </div>
      ) : null}
      {hotkeyStartedAtMs ||
      captureStartedAtMs ||
      captureFinishedAtMs ||
      ttsStartedAtMs ||
      firstAudioReceivedAtMs ||
      firstAudioPlaybackStartedAtMs ? (
        <div className="result-block">
          <span className="info-label">{t('latestRun.audioStartTimeline')}</span>
          {hotkeyStartedAtMs ? (
            <p>{t('latestRun.hotkeyReceived', { value: formatTimestamp(hotkeyStartedAtMs) })}</p>
          ) : null}
          {captureStartedAtMs ? (
            <p>{t('latestRun.captureStarted', { value: formatTimestamp(captureStartedAtMs) })}</p>
          ) : null}
          {captureFinishedAtMs ? (
            <p>{t('latestRun.captureFinished', { value: formatTimestamp(captureFinishedAtMs) })}</p>
          ) : null}
          {ttsStartedAtMs ? (
            <p>{t('latestRun.ttsStarted', { value: formatTimestamp(ttsStartedAtMs) })}</p>
          ) : null}
          {firstAudioReceivedAtMs ? (
            <p>{t('latestRun.firstAudioReceived', { value: formatTimestamp(firstAudioReceivedAtMs) })}</p>
          ) : null}
          {firstAudioPlaybackStartedAtMs ? (
            <p>{t('latestRun.firstAudiblePlayback', { value: formatTimestamp(firstAudioPlaybackStartedAtMs) })}</p>
          ) : null}
        </div>
      ) : null}
      {lastAudioPath ? (
        <div className="result-block">
          <span className="info-label">{t('latestRun.audioOutput')}</span>
          <code>{lastAudioChunkCount > 1 ? lastAudioOutputDirectory : lastAudioPath}</code>
        </div>
      ) : null}
    </section>
  );
}
