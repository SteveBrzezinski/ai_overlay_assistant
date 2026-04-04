import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import {
  appendSttDebugLog,
  emitVoiceChatState,
  onAssistantControlRequest,
  onLiveSttControl,
  onVoiceChatSubmitRequest,
  onVoiceChatSyncRequest,
  setAssistantState,
  type AppSettings,
  type CreateVoiceAgentSessionResult,
  type SttDebugEntry,
  type VoiceChatMessage,
} from '../lib/voiceOverlay';
import i18n from '../i18n';
import { LiveSttController, type AssistantStateSnapshot, type ProviderSnapshot } from '../lib/liveStt';
import {
  RealtimeVoiceAgentController,
  type RealtimeChatEvent,
  type VoiceConnectionState,
  type VoiceFeedItem,
} from '../lib/realtimeVoiceAgent';
import {
  normalizeAssistantSource,
  prependFeedItem,
  type AssistantActivationSource,
  type ProviderSnapshotMap,
} from '../lib/app/appModel';
type UseVoiceAssistantRuntimeOptions = {
  settings: AppSettings;
  savedSettings: AppSettings;
  initialStateLoaded: boolean;
  ensureSavedSettings: () => Promise<AppSettings>;
};

export type VoiceAssistantRuntime = {
  isLiveTranscribing: boolean;
  liveTranscriptionStatus: string;
  assistantActive: boolean;
  assistantStateDetail: string;
  assistantWakePhrase: string;
  liveTranscript: string;
  sttProviderSnapshots: ProviderSnapshotMap;
  providerSnapshots: ProviderSnapshot[];
  lastSttProvider: string;
  lastSttDebugLogPath: string;
  lastSttActiveTranscript: string;
  voiceAgentState: VoiceConnectionState;
  voiceAgentDetail: string;
  voiceAgentSession: CreateVoiceAgentSessionResult | null;
  voiceEventFeed: VoiceFeedItem[];
  voiceTaskFeed: VoiceFeedItem[];
  activateAssistantVoice: (source?: AssistantActivationSource) => Promise<void>;
  deactivateAssistantVoice: (source?: string) => Promise<void>;
  startLiveTranscription: (options?: { activateImmediately?: boolean }) => Promise<void>;
  restartVoiceAgentSession: (reason: string, shouldResumeListening: boolean) => Promise<void>;
  stopLiveTranscription: () => Promise<void>;
};

export function useVoiceAssistantRuntime(
  options: UseVoiceAssistantRuntimeOptions,
): VoiceAssistantRuntime {
  const { settings, savedSettings, initialStateLoaded, ensureSavedSettings } = options;

  const [isLiveTranscribing, setIsLiveTranscribing] = useState(false);
  const [liveTranscriptionStatus, setLiveTranscriptionStatus] = useState(
    i18n.t('voiceRuntime.liveTranscriptionStartsAutomatically'),
  );
  const [assistantActive, setAssistantActive] = useState(false);
  const [assistantStateDetail, setAssistantStateDetail] = useState(
    i18n.t('voiceRuntime.initializingWakeListener'),
  );
  const [assistantWakePhraseState, setAssistantWakePhraseState] = useState('Hey AIVA');
  const [liveTranscript, setLiveTranscript] = useState('');
  const [sttProviderSnapshots, setSttProviderSnapshots] = useState<ProviderSnapshotMap>({});
  const [liveTranscriptionSessionId, setLiveTranscriptionSessionId] = useState('');
  const [voiceAgentState, setVoiceAgentState] = useState<VoiceConnectionState>('idle');
  const [voiceAgentDetail, setVoiceAgentDetail] = useState(
    i18n.t('voiceRuntime.persistentSessionStarting'),
  );
  const [voiceAgentSession, setVoiceAgentSession] = useState<CreateVoiceAgentSessionResult | null>(
    null,
  );
  const [voiceEventFeed, setVoiceEventFeed] = useState<VoiceFeedItem[]>([]);
  const [voiceTaskFeed, setVoiceTaskFeed] = useState<VoiceFeedItem[]>([]);
  const [lastSttProvider, setLastSttProvider] = useState('');
  const [lastSttDebugLogPath, setLastSttDebugLogPath] = useState('');
  const [lastSttActiveTranscript, setLastSttActiveTranscript] = useState('');
  const [chatMessages, setChatMessages] = useState<VoiceChatMessage[]>([]);
  const [chatStatusText, setChatStatusText] = useState('Chat bereit.');
  const [isChatAssistantResponding, setIsChatAssistantResponding] = useState(false);
  const liveSttControllerRef = useRef<LiveSttController | null>(null);
  const realtimeVoiceAgentRef = useRef<RealtimeVoiceAgentController | null>(null);
  const startLiveTranscriptionRef = useRef<(options?: { activateImmediately?: boolean }) => Promise<void>>(
    () => Promise.resolve(),
  );
  const activateAssistantVoiceRef = useRef<(source?: AssistantActivationSource) => Promise<void>>(
    () => Promise.resolve(),
  );
  const deactivateAssistantVoiceRef = useRef<(source?: string) => Promise<void>>(
    () => Promise.resolve(),
  );
  const autoStartLiveTranscriptionRef = useRef(false);
  const sttDebugWriteTimerRef = useRef<number | null>(null);
  const pendingChatMessageIdRef = useRef<string | null>(null);
  const ensureSavedSettingsRef = useRef(ensureSavedSettings);
  const publishChatStateRef = useRef<() => void>(() => {});

  const appendChatMessage = useCallback((message: VoiceChatMessage): void => {
    setChatMessages((current) => [...current, message].slice(-40));
  }, []);

  const handleChatEvent = useCallback((event: RealtimeChatEvent): void => {
    if (event.type === 'assistant-message') {
      if (
        pendingChatMessageIdRef.current &&
        pendingChatMessageIdRef.current === (event.replyToMessageId ?? null)
      ) {
        pendingChatMessageIdRef.current = null;
      }
      setIsChatAssistantResponding(false);
      setChatStatusText('Chat bereit.');
      appendChatMessage({
        id: `chat-assistant-${Date.now()}-${Math.random().toString(16).slice(2)}`,
        role: 'assistant',
        text: event.text,
        createdAtMs: Date.now(),
        status: 'complete',
        replyToMessageId: event.replyToMessageId ?? null,
      });
      return;
    }

    if (
      pendingChatMessageIdRef.current &&
      pendingChatMessageIdRef.current === (event.replyToMessageId ?? null)
    ) {
      pendingChatMessageIdRef.current = null;
    }
    setIsChatAssistantResponding(false);
    setChatStatusText(event.detail);
    appendChatMessage({
      id: `chat-system-${Date.now()}-${Math.random().toString(16).slice(2)}`,
      role: 'system',
      text: event.detail,
      createdAtMs: Date.now(),
      status: 'error',
      replyToMessageId: event.replyToMessageId ?? null,
    });
  }, [appendChatMessage]);

  const publishChatState = useCallback((): void => {
    void emitVoiceChatState({
      messages: chatMessages,
      isAssistantResponding: isChatAssistantResponding,
      statusText: chatStatusText,
      connectionState: voiceAgentState,
      assistantActive,
    }).catch(() => {
      // The chat overlay is optional. Ignore failed sync attempts when it is unavailable.
    });
  }, [assistantActive, chatMessages, chatStatusText, isChatAssistantResponding, voiceAgentState]);

  useEffect(() => {
    ensureSavedSettingsRef.current = ensureSavedSettings;
    publishChatStateRef.current = publishChatState;
  }, [ensureSavedSettings, publishChatState]);

  const applyAssistantState = useCallback((snapshot: AssistantStateSnapshot): void => {
    setAssistantActive(snapshot.active);
    setAssistantWakePhraseState(snapshot.wakePhrase);
    setAssistantStateDetail(snapshot.reason);
    setLiveTranscriptionStatus(snapshot.reason);
    if (!snapshot.active) {
      setLiveTranscript('');
      setLastSttActiveTranscript('');
    }
  }, []);

  const startVoiceAgent = useCallback(async (): Promise<void> => {
    if (realtimeVoiceAgentRef.current) {
      await realtimeVoiceAgentRef.current.connect();
      return;
    }

    const controller = new RealtimeVoiceAgentController({
      onFeedItem: (item) => {
        if (item.section === 'events') {
          setVoiceEventFeed((current) => prependFeedItem(current, item));
        } else {
          setVoiceTaskFeed((current) => prependFeedItem(current, item));
        }
      },
      onStatus: (status) => {
        setVoiceAgentState(status.state);
        setVoiceAgentDetail(status.detail);
        setVoiceAgentSession(status.session ?? null);
      },
      onAssistantControlRequest: ({ action, reason }) => {
        if (action === 'deactivate') {
          void deactivateAssistantVoiceRef.current(reason || 'assistant-requested');
        }
      },
      onChatEvent: (event) => {
        handleChatEvent(event);
      },
    });

    realtimeVoiceAgentRef.current = controller;
    try {
      await controller.connect();
    } catch {
      realtimeVoiceAgentRef.current = null;
    }
  }, [handleChatEvent]);

  const stopVoiceAgent = useCallback(async (reason = 'deactivate'): Promise<void> => {
    if (realtimeVoiceAgentRef.current) {
      await realtimeVoiceAgentRef.current.disconnect(reason);
      realtimeVoiceAgentRef.current = null;
    }
    setVoiceAgentState('idle');
    setVoiceAgentDetail(i18n.t('voiceRuntime.voiceSessionIdle'));
    setVoiceAgentSession(null);
  }, []);

  const activateAssistantVoice = useCallback(async (
    source: AssistantActivationSource = 'manual',
  ): Promise<void> => {
    if (liveSttControllerRef.current) {
      liveSttControllerRef.current.manualActivate(source);
      return;
    }

    await startVoiceAgent();
    await realtimeVoiceAgentRef.current?.startListening(source);
    setAssistantActive(true);
    setAssistantStateDetail(i18n.t('voiceRuntime.assistantActiveMicrophoneLive', { source }));
    setLiveTranscriptionStatus(i18n.t('voiceRuntime.assistantActiveMicrophoneLive', { source }));
  }, [startVoiceAgent]);

  const deactivateAssistantVoice = useCallback(async (source = 'manual'): Promise<void> => {
    if (liveSttControllerRef.current) {
      liveSttControllerRef.current.manualDeactivate(normalizeAssistantSource(source));
      return;
    }

    await realtimeVoiceAgentRef.current?.mute(source);
    setAssistantActive(false);
    setAssistantStateDetail(i18n.t('voiceRuntime.assistantInactiveMicrophoneMuted', { source }));
    setLiveTranscriptionStatus(
      i18n.t('voiceRuntime.assistantInactiveMicrophoneMuted', { source }),
    );
    setLiveTranscript('');
    setLastSttActiveTranscript('');
  }, []);

  const restartVoiceAgentSession = useCallback(async (
    reason: string,
    shouldResumeListening: boolean,
  ): Promise<void> => {
    if (realtimeVoiceAgentRef.current) {
      await stopVoiceAgent(reason);
    }

    await startVoiceAgent();
    if (shouldResumeListening) {
      await realtimeVoiceAgentRef.current?.startListening(reason);
    }
  }, [startVoiceAgent, stopVoiceAgent]);

  const startLiveTranscription = useCallback(async (startOptions?: {
    activateImmediately?: boolean;
  }): Promise<void> => {
    let activeSettings = savedSettings;

    try {
      activeSettings = await ensureSavedSettings();
    } catch {
      return;
    }

    if (liveSttControllerRef.current) {
      await liveSttControllerRef.current.stop();
    }

    await startVoiceAgent();

    const controller = new LiveSttController();
    liveSttControllerRef.current = controller;
    const sessionId = `stt-live-${Date.now()}`;
    setLiveTranscriptionSessionId(sessionId);
    setSttProviderSnapshots({});
    setLiveTranscript('');
    setLastSttDebugLogPath('');
    setLastSttProvider('webview2');
    setLastSttActiveTranscript('');
    setAssistantWakePhraseState(`Hey ${activeSettings.assistantName}`);
    setAssistantStateDetail(i18n.t('voiceRuntime.startingWakeListener'));
    setIsLiveTranscribing(true);

    try {
      await controller.start(
        {
          language: activeSettings.sttLanguage,
          assistantName: activeSettings.assistantName,
          activateImmediately: startOptions?.activateImmediately,
          wakeSamples: activeSettings.assistantWakeSamples,
          nameSamples: activeSettings.assistantNameSamples,
          assistantWakeThreshold: activeSettings.assistantWakeThreshold,
          assistantCueCooldownMs: activeSettings.assistantCueCooldownMs,
        },
        {
          onStatus: setLiveTranscriptionStatus,
          onAssistantStateChange: (snapshot) => {
            applyAssistantState(snapshot);
            if (snapshot.active) {
              void (async () => {
                await startVoiceAgent();
                await realtimeVoiceAgentRef.current?.startListening(snapshot.source);
              })();
            } else {
              void realtimeVoiceAgentRef.current?.mute(snapshot.source);
            }
          },
          onProviderSnapshot: (snapshot) => {
            setSttProviderSnapshots((current) => ({
              ...current,
              [snapshot.provider]: snapshot,
            }));
            setLastSttProvider(snapshot.provider);
            if (
              snapshot.transcript &&
              snapshot.detail?.startsWith('assistant-active') &&
              !snapshot.detail?.includes('wake-word')
            ) {
              setLiveTranscript(snapshot.transcript);
              setLastSttActiveTranscript(snapshot.transcript);
              realtimeVoiceAgentRef.current?.observeExternalUserTranscript(snapshot.transcript);
            }
          },
        },
      );
    } catch (error: unknown) {
      const detail = error instanceof Error ? error.message : String(error);
      setIsLiveTranscribing(false);
      setLiveTranscriptionStatus(
        i18n.t('voiceRuntime.failedToStartLiveTranscription', { detail }),
      );
    }
  }, [applyAssistantState, ensureSavedSettings, savedSettings, startVoiceAgent]);

  const stopLiveTranscription = useCallback(async (): Promise<void> => {
    await realtimeVoiceAgentRef.current?.mute('stop-live-transcription');
    if (liveSttControllerRef.current) {
      await liveSttControllerRef.current.stop();
      liveSttControllerRef.current = null;
    }
    setIsLiveTranscribing(false);
    setAssistantActive(false);
    setAssistantStateDetail(i18n.t('voiceRuntime.wakeListenerStopped'));
    setLiveTranscript('');
    setLiveTranscriptionStatus(i18n.t('voiceRuntime.liveTranscriptionStopped'));
  }, []);

  useEffect(() => {
    activateAssistantVoiceRef.current = activateAssistantVoice;
    deactivateAssistantVoiceRef.current = deactivateAssistantVoice;
    startLiveTranscriptionRef.current = startLiveTranscription;
  }, [activateAssistantVoice, deactivateAssistantVoice, startLiveTranscription]);

  useEffect(() => {
    void setAssistantState(assistantActive).catch(() => {
      // Keep the action bar state mirror best-effort; the runtime stays functional without it.
    });
  }, [assistantActive]);

  useEffect(() => {
    publishChatState();
  }, [publishChatState]);

  useEffect(() => {
    let unlistenAssistantControl: (() => void | Promise<void>) | undefined;

    void onAssistantControlRequest((event) => {
      if (event.action === 'activate') {
        if (liveSttControllerRef.current) {
          liveSttControllerRef.current.manualActivate('manual');
        } else {
          void activateAssistantVoiceRef.current('manual');
        }
        return;
      }

      void deactivateAssistantVoiceRef.current('manual');
    }).then((cleanup) => {
      unlistenAssistantControl = cleanup;
    });

    return () => {
      void unlistenAssistantControl?.();
    };
  }, []);

  useEffect(() => {
    let unlistenChatSync: (() => void | Promise<void>) | undefined;
    let unlistenChatSubmit: (() => void | Promise<void>) | undefined;

    void onVoiceChatSyncRequest(() => {
      publishChatStateRef.current();
    }).then((cleanup) => {
      unlistenChatSync = cleanup;
    });

    void onVoiceChatSubmitRequest((event) => {
      const text = event.text.trim();
      const messageId = event.messageId.trim();
      if (!text || !messageId || pendingChatMessageIdRef.current) {
        return;
      }

      appendChatMessage({
        id: messageId,
        role: 'user',
        text,
        createdAtMs: Date.now(),
        status: 'complete',
      });
      pendingChatMessageIdRef.current = messageId;
      setIsChatAssistantResponding(true);
      setChatStatusText('Assistent antwortet...');

      void (async () => {
        try {
          await ensureSavedSettingsRef.current();
          await startVoiceAgent();
          await realtimeVoiceAgentRef.current?.sendTextMessage(text, messageId);
        } catch (error: unknown) {
          const detail = error instanceof Error ? error.message : String(error);
          if (pendingChatMessageIdRef.current === messageId) {
            pendingChatMessageIdRef.current = null;
          }
          setIsChatAssistantResponding(false);
          setChatStatusText(detail);
          appendChatMessage({
            id: `chat-system-${Date.now()}-${Math.random().toString(16).slice(2)}`,
            role: 'system',
            text: detail,
            createdAtMs: Date.now(),
            status: 'error',
            replyToMessageId: messageId,
          });
        }
      })();
    }).then((cleanup) => {
      unlistenChatSubmit = cleanup;
    });

    return () => {
      void unlistenChatSync?.();
      void unlistenChatSubmit?.();
    };
  }, [appendChatMessage, startVoiceAgent]);

  useEffect(() => {
    let unlistenLiveSttControl: (() => void | Promise<void>) | undefined;

    void onLiveSttControl((event) => {
      if (event.action === 'activate') {
        if (liveSttControllerRef.current) {
          liveSttControllerRef.current.manualActivate('hotkey');
        } else {
          void activateAssistantVoiceRef.current('hotkey');
        }
        return;
      }

      void deactivateAssistantVoiceRef.current('hotkey');
    }).then((cleanup) => {
      unlistenLiveSttControl = cleanup;
    });

    return () => {
      void unlistenLiveSttControl?.();
    };
  }, []);

  useEffect(() => {
    return () => {
      if (sttDebugWriteTimerRef.current !== null) {
        window.clearTimeout(sttDebugWriteTimerRef.current);
      }
      if (realtimeVoiceAgentRef.current) {
        void realtimeVoiceAgentRef.current.disconnect('app-shutdown');
        realtimeVoiceAgentRef.current = null;
      }
      if (liveSttControllerRef.current) {
        void liveSttControllerRef.current.stop();
        liveSttControllerRef.current = null;
      }
    };
  }, []);

  useEffect(() => {
    if (voiceAgentState !== 'error' || !pendingChatMessageIdRef.current) {
      return;
    }

    const replyToMessageId = pendingChatMessageIdRef.current;
    pendingChatMessageIdRef.current = null;
    setIsChatAssistantResponding(false);
    setChatStatusText(voiceAgentDetail);
    appendChatMessage({
      id: `chat-system-${Date.now()}-${Math.random().toString(16).slice(2)}`,
      role: 'system',
      text: voiceAgentDetail,
      createdAtMs: Date.now(),
      status: 'error',
      replyToMessageId,
    });
  }, [appendChatMessage, voiceAgentDetail, voiceAgentState]);

  useEffect(() => {
    if (!isLiveTranscribing || !liveTranscriptionSessionId) {
      return;
    }

    const entries: SttDebugEntry[] = Object.values(sttProviderSnapshots)
      .filter((snapshot): snapshot is ProviderSnapshot => Boolean(snapshot))
      .map((snapshot) => ({
        provider: snapshot.provider,
        transcript: snapshot.transcript,
        latencyMs: snapshot.latencyMs,
        ok: snapshot.ok,
        detail: snapshot.detail ?? null,
      }));

    if (!entries.length) {
      return;
    }

    if (sttDebugWriteTimerRef.current !== null) {
      window.clearTimeout(sttDebugWriteTimerRef.current);
    }

    // Buffer filesystem writes from rapid interim STT events so the overlay stays responsive.
    sttDebugWriteTimerRef.current = window.setTimeout(() => {
      void appendSttDebugLog({
        sessionId: liveTranscriptionSessionId,
        selectedProvider: 'webview2',
        activeTranscript: liveTranscript,
        entries,
      })
        .then((result) => setLastSttDebugLogPath(result.debugLogPath))
        .catch((error: unknown) => {
          const detail = error instanceof Error ? error.message : String(error);
          setLiveTranscriptionStatus(i18n.t('voiceRuntime.failedToWriteSttLog', { detail }));
        });
    }, 600);

    return () => {
      if (sttDebugWriteTimerRef.current !== null) {
        window.clearTimeout(sttDebugWriteTimerRef.current);
      }
    };
  }, [isLiveTranscribing, liveTranscript, liveTranscriptionSessionId, sttProviderSnapshots]);

  useEffect(() => {
    if (!initialStateLoaded || autoStartLiveTranscriptionRef.current) {
      return;
    }

    autoStartLiveTranscriptionRef.current = true;
    void startLiveTranscriptionRef.current();
  }, [initialStateLoaded]);

  const providerSnapshots = useMemo(
    () =>
      Object.values(sttProviderSnapshots).filter(
        (snapshot): snapshot is ProviderSnapshot => Boolean(snapshot),
      ),
    [sttProviderSnapshots],
  );
  const assistantWakePhrase = useMemo(
    () =>
      isLiveTranscribing
        ? assistantWakePhraseState
        : `Hey ${settings.assistantName || 'AIVA'}`,
    [assistantWakePhraseState, isLiveTranscribing, settings.assistantName],
  );

  return {
    isLiveTranscribing,
    liveTranscriptionStatus,
    assistantActive,
    assistantStateDetail,
    assistantWakePhrase,
    liveTranscript,
    sttProviderSnapshots,
    providerSnapshots,
    lastSttProvider,
    lastSttDebugLogPath,
    lastSttActiveTranscript,
    voiceAgentState,
    voiceAgentDetail,
    voiceAgentSession,
    voiceEventFeed,
    voiceTaskFeed,
    activateAssistantVoice,
    deactivateAssistantVoice,
    startLiveTranscription,
    restartVoiceAgentSession,
    stopLiveTranscription,
  };
}
