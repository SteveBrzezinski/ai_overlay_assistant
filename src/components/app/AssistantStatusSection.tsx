import { useTranslation } from 'react-i18next';

import type { ProviderSnapshot } from '../../lib/liveStt';
import type { VoiceConnectionState } from '../../lib/realtimeVoiceAgent';
import type { CreateVoiceAgentSessionResult } from '../../lib/voiceOverlay';

type AssistantStatusSectionProps = {
  voiceAgentState: VoiceConnectionState;
  assistantActive: boolean;
  isLiveTranscribing: boolean;
  liveTranscriptionStatus: string;
  assistantStateDetail: string;
  voiceAgentDetail: string;
  voiceAgentSession: CreateVoiceAgentSessionResult | null;
  assistantWakePhrase: string;
  wakeThreshold: number;
  cueCooldownMs: number;
  liveTranscript: string;
  sttProviderSnapshots: ProviderSnapshot[];
  lastSttDebugLogPath: string;
};

export function AssistantStatusSection(
  props: AssistantStatusSectionProps,
): JSX.Element {
  const { t } = useTranslation();
  const {
    voiceAgentState,
    assistantActive,
    isLiveTranscribing,
    liveTranscriptionStatus,
    assistantStateDetail,
    voiceAgentDetail,
    voiceAgentSession,
    assistantWakePhrase,
    wakeThreshold,
    cueCooldownMs,
    liveTranscript,
    sttProviderSnapshots,
    lastSttDebugLogPath,
  } = props;

  return (
    <section
      className={`result-card result-card--${
        voiceAgentState === 'error' ? 'error' : assistantActive ? 'working' : 'success'
      }`}
    >
      <div>
        <span className="info-label">{t('assistantStatus.title')}</span>
        <strong>{liveTranscriptionStatus}</strong>
      </div>
      <div className="result-block">
        <span className="info-label">{t('assistantStatus.assistantState')}</span>
        <p>
          {assistantActive
            ? t('assistantStatus.assistantActive')
            : isLiveTranscribing
              ? t('assistantStatus.assistantInactiveListening')
              : t('assistantStatus.assistantInactiveMuted')}
        </p>
        <span className="field-note">{assistantStateDetail}</span>
      </div>
      <div className="result-block">
        <span className="info-label">{t('assistantStatus.realtimeVoiceSession')}</span>
        <p>{voiceAgentState}</p>
        <span className="field-note">{voiceAgentDetail}</span>
        {voiceAgentSession ? (
          <span className="field-note">
            {voiceAgentSession.profile.model} - {voiceAgentSession.profile.voice} -{' '}
            {voiceAgentSession.assistantState.sourceAssistantName}
          </span>
        ) : null}
      </div>
      <div className="result-block">
        <span className="info-label">{t('assistantStatus.wakePhrase')}</span>
        <p>
          <strong>{assistantWakePhrase}</strong>
        </p>
        <span className="field-note">{t('assistantStatus.wakePhraseNote')}</span>
      </div>
      <div className="result-block">
        <span className="info-label">{t('assistantStatus.cueMatching')}</span>
        <p>{t('assistantStatus.cueMatchingSummary', { threshold: wakeThreshold, cooldownMs: cueCooldownMs })}</p>
        <span className="field-note">{t('assistantStatus.cueMatchingNote')}</span>
      </div>
      <div className="result-block">
        <span className="info-label">{t('assistantStatus.activeTranscript')}</span>
        <p>
          {liveTranscript ||
            (assistantActive
              ? t('assistantStatus.activeTranscriptEmpty')
              : isLiveTranscribing
                ? t('assistantStatus.activeTranscriptWaiting')
                : t('assistantStatus.activeTranscriptUnavailable'))}
        </p>
      </div>
      {sttProviderSnapshots.length ? (
        <div className="result-block">
          <span className="info-label">{t('assistantStatus.recognitionStatus')}</span>
          <div className="stt-provider-grid">
            {sttProviderSnapshots.map((snapshot) => (
              <article className="stt-provider-card" key={snapshot.provider}>
                <strong>{snapshot.provider}</strong>
                <p>{snapshot.transcript || t('assistantStatus.noTranscriptPayload')}</p>
                <span className="field-note">
                  {snapshot.ok
                    ? t('assistantStatus.providerOk', { latencyMs: snapshot.latencyMs })
                    : t('assistantStatus.providerError')}
                  {snapshot.detail ? ` - ${snapshot.detail}` : ''}
                </span>
              </article>
            ))}
          </div>
        </div>
      ) : null}
      {lastSttDebugLogPath ? (
        <div className="result-block">
          <span className="info-label">{t('assistantStatus.liveSttDebugLog')}</span>
          <code>{lastSttDebugLogPath}</code>
        </div>
      ) : null}
    </section>
  );
}
