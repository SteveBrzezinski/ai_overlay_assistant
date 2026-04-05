import { useTranslation } from 'react-i18next';

import type { VoiceConnectionState, VoiceFeedItem } from '../../lib/realtimeVoiceAgent';

type VoiceFeedsSectionProps = {
  voiceAgentState: VoiceConnectionState;
  voiceEventFeed: VoiceFeedItem[];
  voiceTaskFeed: VoiceFeedItem[];
};

function FeedColumn(props: {
  title: string;
  counter: string | number;
  emptyState: string;
  items: VoiceFeedItem[];
}): JSX.Element {
  const { title, counter, emptyState, items } = props;

  return (
    <article className="feed-card">
      <div className="feed-header">
        <span className="info-label">{title}</span>
        <strong>{counter}</strong>
      </div>
      <div className="feed-list">
        {items.length ? (
          items.map((item) => (
            <article className={`feed-item feed-item--${item.kind}`} key={item.id}>
              <strong>{item.title}</strong>
              <pre>{item.body}</pre>
              <small>{new Date(item.timestampMs).toLocaleTimeString()}</small>
            </article>
          ))
        ) : (
          <p className="feed-empty">{emptyState}</p>
        )}
      </div>
    </article>
  );
}

export function VoiceFeedsSection(props: VoiceFeedsSectionProps): JSX.Element {
  const { t } = useTranslation();
  const { voiceAgentState, voiceEventFeed, voiceTaskFeed } = props;

  return (
    <section className="feed-grid">
      <FeedColumn
        title={t('feeds.realtimeEventFeed')}
        counter={voiceAgentState}
        emptyState={t('feeds.noRealtimeEvents')}
        items={voiceEventFeed}
      />
      <FeedColumn
        title={t('feeds.toolTaskFeed')}
        counter={voiceTaskFeed.length}
        emptyState={t('feeds.noToolCalls')}
        items={voiceTaskFeed}
      />
    </section>
  );
}
