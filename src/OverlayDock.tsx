import { useEffect, useMemo, useRef, useState, type CSSProperties } from 'react';
import {
  LogicalPosition,
  LogicalSize,
  currentMonitor,
  getCurrentWindow,
  primaryMonitor,
} from '@tauri-apps/api/window';
import {
  getAssistantState,
  getChatWindowVisibility,
  getMainWindowVisibility,
  getSettings,
  onAssistantStateChange,
  onChatWindowVisibility,
  onMainWindowVisibility,
  onSettingsUpdated,
  toggleChatWindow,
  toggleMainWindow,
} from './lib/voiceOverlay';
import type { VoiceTimer } from './lib/voiceOverlay';
import {
  OVERLAY_ACTION_EVENT,
  OVERLAY_STATE_EVENT,
  type OverlayAction,
  type OverlayState,
} from './lib/overlayBridge';
import { useVoiceTimers } from './hooks/useVoiceTimers';
import { TimerEditorDialog } from './components/timers/TimerEditorDialog';
import { TimerListPanel } from './components/timers/TimerListPanel';
import i18n from './i18n';

const EDGE_INSET = 0;
const BOTTOM_INSET = 10;
const WINDOW_PADDING = { top: 8, right: 6, bottom: 8 };
const COLLAPSED_LAYOUT = { width: 22, height: 84 };
const EXPANDED_LAYOUTS = {
  'icons-only': { width: 260, height: 84 },
  'text-only': { width: 360, height: 84 },
  'icons-and-text': { width: 470, height: 84 },
} as const;
const TIMER_FLYOUT_HEIGHT = 286;
const TIMER_DIALOG_LAYOUT = { minWidth: 620, height: 760 };
const DEFAULT_ACTION_BAR_ACTIVE_GLOW_COLOR = '#f06525';

type ActionBarDisplayMode = keyof typeof EXPANDED_LAYOUTS;

const fallbackOverlayState: OverlayState = {
  assistantActive: false,
  isLiveTranscribing: false,
  voiceOrbPinned: false,
  composerVisible: false,
  settingsVisible: false,
  assistantStateDetail: 'Listening is stopped.',
  liveTranscriptionStatus: 'Live transcription is stopped.',
  assistantWakePhrase: 'Hey Ava',
  assistantClosePhrase: 'Bye Ava',
  statusMessage: 'Overlay ready.',
  uiState: 'idle',
};

async function syncOverlayWindowLayout(
  expanded: boolean,
  displayMode: ActionBarDisplayMode,
  timerFlyoutOpen: boolean,
  timerDialogOpen: boolean,
): Promise<void> {
  const overlayWindow = getCurrentWindow();
  const monitor = await currentMonitor() ?? await primaryMonitor();
  if (!monitor) {
    return;
  }

  const baseLayout = expanded ? EXPANDED_LAYOUTS[displayMode] : COLLAPSED_LAYOUT;
  const nextLayout = timerDialogOpen
    ? {
        width: Math.max(baseLayout.width, TIMER_DIALOG_LAYOUT.minWidth),
        height: TIMER_DIALOG_LAYOUT.height,
      }
    : {
        width: baseLayout.width,
        height: baseLayout.height + (timerFlyoutOpen ? TIMER_FLYOUT_HEIGHT : 0),
      };
  const workAreaPosition = monitor.workArea.position.toLogical(monitor.scaleFactor);
  const workAreaSize = monitor.workArea.size.toLogical(monitor.scaleFactor);

  await overlayWindow.setSize(new LogicalSize(nextLayout.width, nextLayout.height));
  await overlayWindow.setPosition(
    new LogicalPosition(
      workAreaPosition.x + EDGE_INSET,
      workAreaPosition.y +
        workAreaSize.height -
        nextLayout.height -
        BOTTOM_INSET +
        WINDOW_PADDING.bottom,
    ),
  );
}

function normalizeHexColor(value: string | null | undefined): string {
  const normalized = value?.trim().toLowerCase() ?? '';
  return /^#[0-9a-f]{6}$/.test(normalized)
    ? normalized
    : DEFAULT_ACTION_BAR_ACTIVE_GLOW_COLOR;
}

function hexToRgb(hexColor: string): [number, number, number] {
  const normalized = normalizeHexColor(hexColor);
  return [
    Number.parseInt(normalized.slice(1, 3), 16),
    Number.parseInt(normalized.slice(3, 5), 16),
    Number.parseInt(normalized.slice(5, 7), 16),
  ];
}

function withAlpha(hexColor: string, alpha: number): string {
  const [red, green, blue] = hexToRgb(hexColor);
  return `rgba(${red}, ${green}, ${blue}, ${alpha})`;
}

export default function OverlayDock() {
  const overlayWindowRef = useRef(getCurrentWindow());
  const collapseTimerRef = useRef<number | null>(null);
  const pendingSpeakTimerRef = useRef<number | null>(null);
  const timerFlyoutTimerRef = useRef<number | null>(null);
  const timerFlyoutHoldUntilRef = useRef(0);
  const hasShownWindowRef = useRef(false);
  const isExpandedRef = useRef(false);
  const isPointerInsideRef = useRef(false);
  const armedActionRef = useRef<string | null>(null);
  const actionBarDisplayModeRef = useRef<ActionBarDisplayMode>('icons-and-text');
  const timerFlyoutOpenRef = useRef(false);
  const timerDialogOpenRef = useRef(false);
  const isTimerButtonHoveredRef = useRef(false);
  const isTimerFlyoutHoveredRef = useRef(false);
  const [isExpanded, setIsExpanded] = useState(false);
  const [isTimerFlyoutOpen, setIsTimerFlyoutOpen] = useState(false);
  const [isTimerFlyoutVisible, setIsTimerFlyoutVisible] = useState(false);
  const [timerEditorMode, setTimerEditorMode] = useState<'create' | 'edit' | null>(null);
  const [timerEditorTimer, setTimerEditorTimer] = useState<VoiceTimer | null>(null);
  const [isTimerEditorBusy, setIsTimerEditorBusy] = useState(false);
  const [overlayState, setOverlayState] = useState<OverlayState>(fallbackOverlayState);
  const [assistantStateActive, setAssistantStateActive] = useState(false);
  const [isChatVisible, setIsChatVisible] = useState(false);
  const [isMainWindowVisible, setIsMainWindowVisible] = useState(false);
  const [actionBarDisplayMode, setActionBarDisplayMode] =
    useState<ActionBarDisplayMode>('icons-and-text');
  const [actionBarActiveGlowColor, setActionBarActiveGlowColor] = useState(
    DEFAULT_ACTION_BAR_ACTIVE_GLOW_COLOR,
  );
  const [pendingSpeakActive, setPendingSpeakActive] = useState<boolean | null>(null);
  const [statusNote, setStatusNote] = useState(() => i18n.t('overlayDock.status.default'));
  const voiceTimers = useVoiceTimers();

  const resolvedSpeakActive =
    assistantStateActive || overlayState.assistantActive || overlayState.voiceOrbPinned;
  const isSpeakActive = pendingSpeakActive ?? resolvedSpeakActive;
  const isSettingsActive = isMainWindowVisible && overlayState.settingsVisible;
  const hasFinishedTimers = voiceTimers.timers.some((timer) => timer.status === 'completed');
  const isTimerButtonActive = Boolean(voiceTimers.timers.length) || hasFinishedTimers || isTimerFlyoutOpen;
  const showIcons = actionBarDisplayMode !== 'text-only';
  const showLabels = actionBarDisplayMode !== 'icons-only';

  const actionBarGlowStyle = useMemo<CSSProperties>(() => {
    const color = normalizeHexColor(actionBarActiveGlowColor);
    return {
      ['--edge-action-active-text' as string]: color,
      ['--edge-action-active-glow' as string]: withAlpha(color, 0.24),
      ['--edge-action-active-glow-soft' as string]: withAlpha(color, 0.1),
      ['--edge-action-active-border' as string]: withAlpha(color, 0.22),
      ['--edge-action-active-surface' as string]: withAlpha(color, 0.08),
    };
  }, [actionBarActiveGlowColor]);

  useEffect(() => {
    document.documentElement.classList.add('overlay-html');
    document.body.classList.add('overlay-body');

    return () => {
      if (pendingSpeakTimerRef.current !== null) {
        window.clearTimeout(pendingSpeakTimerRef.current);
      }
      if (timerFlyoutTimerRef.current !== null) {
        window.clearTimeout(timerFlyoutTimerRef.current);
      }
      document.documentElement.classList.remove('overlay-html');
      document.body.classList.remove('overlay-body');
    };
  }, []);

  useEffect(() => {
    let unlistenOverlayState: (() => void | Promise<void>) | undefined;
    let unlistenAssistantState: (() => void | Promise<void>) | undefined;
    let unlistenChatWindowVisibility: (() => void | Promise<void>) | undefined;
    let unlistenMainWindowVisibility: (() => void | Promise<void>) | undefined;
    let unlistenSettings: (() => void | Promise<void>) | undefined;
    let unlistenScale: (() => void | Promise<void>) | undefined;

    void overlayWindowRef.current
      .listen<OverlayState>(OVERLAY_STATE_EVENT, (event) => {
        setOverlayState(event.payload);
      })
      .then((cleanup) => {
        unlistenOverlayState = cleanup;
      });

    void getAssistantState()
      .then((active) => {
        setAssistantStateActive(active);
      })
      .catch(() => {
        setAssistantStateActive(false);
      });

    void getChatWindowVisibility()
      .then((visible) => {
        setIsChatVisible(visible);
      })
      .catch(() => {
        setIsChatVisible(false);
      });

    void getMainWindowVisibility()
      .then((visible) => {
        setIsMainWindowVisible(visible);
      })
      .catch(() => {
        setIsMainWindowVisible(false);
      });

    void getSettings()
      .then((settings) => {
        setActionBarDisplayMode(settings.actionBarDisplayMode ?? 'icons-and-text');
        setActionBarActiveGlowColor(
          normalizeHexColor(settings.actionBarActiveGlowColor),
        );
      })
      .catch(() => {
        setActionBarDisplayMode('icons-and-text');
        setActionBarActiveGlowColor(DEFAULT_ACTION_BAR_ACTIVE_GLOW_COLOR);
      });

    void onAssistantStateChange(({ active }) => {
      if (pendingSpeakTimerRef.current !== null) {
        window.clearTimeout(pendingSpeakTimerRef.current);
        pendingSpeakTimerRef.current = null;
      }
      setAssistantStateActive(active);
      setPendingSpeakActive(null);
    }).then((cleanup) => {
      unlistenAssistantState = cleanup;
    });

    void onChatWindowVisibility(({ visible }) => {
      setIsChatVisible(visible);
    }).then((cleanup) => {
      unlistenChatWindowVisibility = cleanup;
    });

    void onMainWindowVisibility(({ visible }) => {
      setIsMainWindowVisible(visible);
    }).then((cleanup) => {
      unlistenMainWindowVisibility = cleanup;
    });

    void onSettingsUpdated((settings) => {
      setActionBarDisplayMode(settings.actionBarDisplayMode ?? 'icons-and-text');
      setActionBarActiveGlowColor(
        normalizeHexColor(settings.actionBarActiveGlowColor),
      );
    }).then((cleanup) => {
      unlistenSettings = cleanup;
    });

    void overlayWindowRef.current
      .onScaleChanged(() => {
        void syncOverlayWindowLayout(
          isExpandedRef.current,
          actionBarDisplayModeRef.current,
          timerFlyoutOpenRef.current,
          timerDialogOpenRef.current,
        );
      })
      .then((cleanup) => {
        unlistenScale = cleanup;
      });

    void overlayWindowRef.current.emitTo<OverlayAction>(
      'main',
      OVERLAY_ACTION_EVENT,
      { type: 'request-state' },
    );
    void syncOverlayWindowLayout(
      isExpandedRef.current,
      actionBarDisplayModeRef.current,
      timerFlyoutOpenRef.current,
      timerDialogOpenRef.current,
    );

    return () => {
      if (collapseTimerRef.current !== null) {
        window.clearTimeout(collapseTimerRef.current);
      }
      if (pendingSpeakTimerRef.current !== null) {
        window.clearTimeout(pendingSpeakTimerRef.current);
      }
      if (timerFlyoutTimerRef.current !== null) {
        window.clearTimeout(timerFlyoutTimerRef.current);
      }
      void unlistenOverlayState?.();
      void unlistenAssistantState?.();
      void unlistenChatWindowVisibility?.();
      void unlistenMainWindowVisibility?.();
      void unlistenSettings?.();
      void unlistenScale?.();
    };
  }, []);

  useEffect(() => {
    isExpandedRef.current = isExpanded;
  }, [isExpanded]);

  useEffect(() => {
    timerFlyoutOpenRef.current = isTimerFlyoutOpen;
  }, [isTimerFlyoutOpen]);

  useEffect(() => {
    timerDialogOpenRef.current = timerEditorMode !== null;
  }, [timerEditorMode]);

  useEffect(() => {
    actionBarDisplayModeRef.current = actionBarDisplayMode;
  }, [actionBarDisplayMode]);

  useEffect(() => {
    let cancelled = false;
    const waitForPaint = async (): Promise<void> =>
      new Promise((resolve) => {
        window.requestAnimationFrame(() => {
          window.requestAnimationFrame(() => resolve());
        });
      });

    if (!isTimerFlyoutOpen || timerEditorMode !== null) {
      setIsTimerFlyoutVisible(false);
    }

    void syncOverlayWindowLayout(
      isExpanded,
      actionBarDisplayMode,
      isTimerFlyoutOpen,
      timerEditorMode !== null,
    )
      .then(async () => {
        if (cancelled) {
          return;
        }
        if (!hasShownWindowRef.current) {
          hasShownWindowRef.current = true;
          await overlayWindowRef.current.show();
        }
        if (isTimerFlyoutOpen && timerEditorMode === null) {
          await waitForPaint();
          if (!cancelled && timerFlyoutOpenRef.current && !timerDialogOpenRef.current) {
            setIsTimerFlyoutVisible(true);
          }
        }
      })
      .catch((error: unknown) => {
        if (cancelled) {
          return;
        }
        const text = error instanceof Error ? error.message : String(error);
        setStatusNote(i18n.t('overlayDock.status.layoutFailed', { detail: text }));
      });

    return () => {
      cancelled = true;
    };
  }, [actionBarDisplayMode, isExpanded, isTimerFlyoutOpen, timerEditorMode]);

  const clearCollapseTimer = (): void => {
    if (collapseTimerRef.current !== null) {
      window.clearTimeout(collapseTimerRef.current);
      collapseTimerRef.current = null;
    }
  };

  const scheduleCollapse = (): void => {
    clearCollapseTimer();
    collapseTimerRef.current = window.setTimeout(() => {
      if (!isPointerInsideRef.current && !timerDialogOpenRef.current) {
        setIsExpanded(false);
        setIsTimerFlyoutOpen(false);
      }
    }, 260);
  };

  const clearTimerFlyoutTimer = (): void => {
    if (timerFlyoutTimerRef.current !== null) {
      window.clearTimeout(timerFlyoutTimerRef.current);
      timerFlyoutTimerRef.current = null;
    }
  };

  const closeTimerFlyout = (): void => {
    clearTimerFlyoutTimer();
    timerFlyoutHoldUntilRef.current = 0;
    isTimerButtonHoveredRef.current = false;
    isTimerFlyoutHoveredRef.current = false;
    setIsTimerFlyoutVisible(false);
    setIsTimerFlyoutOpen(false);
  };

  const openTimerFlyout = (): void => {
    clearTimerFlyoutTimer();
    clearCollapseTimer();
    timerFlyoutHoldUntilRef.current = Date.now() + 320;
    if (!timerFlyoutOpenRef.current) {
      setIsTimerFlyoutVisible(false);
    }
    setIsExpanded(true);
    setIsTimerFlyoutOpen(true);
  };

  const scheduleTimerFlyoutClose = (): void => {
    clearTimerFlyoutTimer();
    const runCloseCheck = (): void => {
      timerFlyoutTimerRef.current = null;
      const holdRemainingMs = timerFlyoutHoldUntilRef.current - Date.now();
      if (holdRemainingMs > 0) {
        timerFlyoutTimerRef.current = window.setTimeout(
          runCloseCheck,
          Math.max(40, holdRemainingMs + 16),
        );
        return;
      }
      if (
        !timerDialogOpenRef.current
        && !isTimerButtonHoveredRef.current
        && !isTimerFlyoutHoveredRef.current
      ) {
        setIsTimerFlyoutVisible(false);
        setIsTimerFlyoutOpen(false);
      }
    };
    timerFlyoutTimerRef.current = window.setTimeout(runCloseCheck, 220);
  };

  const handleNonTimerActionHover = (): void => {
    if (timerFlyoutOpenRef.current) {
      closeTimerFlyout();
    }
  };

  const armPendingSpeakState = (active: boolean): void => {
    if (pendingSpeakTimerRef.current !== null) {
      window.clearTimeout(pendingSpeakTimerRef.current);
    }
    setPendingSpeakActive(active);
    pendingSpeakTimerRef.current = window.setTimeout(() => {
      pendingSpeakTimerRef.current = null;
      setPendingSpeakActive(null);
    }, 1400);
  };

  const requestOverlayAction = async (action: OverlayAction): Promise<void> => {
    await overlayWindowRef.current.emitTo<OverlayAction>(
      'main',
      OVERLAY_ACTION_EVENT,
      action,
    );
  };

  const armAction = (actionId: string): void => {
    armedActionRef.current = actionId;
  };

  const clearArmedAction = (): void => {
    armedActionRef.current = null;
  };

  const handleArmedAction = (
    actionId: string,
    run: () => Promise<void>,
  ): void => {
    if (armedActionRef.current !== actionId) {
      return;
    }

    armedActionRef.current = null;
    void run();
  };

  const handleSpeak = async (): Promise<void> => {
    setIsExpanded(true);
    try {
      if (resolvedSpeakActive) {
        armPendingSpeakState(false);
        await requestOverlayAction({ type: 'deactivate' });
        await requestOverlayAction({ type: 'unpin-voice-orb' });
        setStatusNote(i18n.t('overlayDock.status.voiceOverlayClosed'));
        return;
      }

      armPendingSpeakState(true);
      await requestOverlayAction({ type: 'activate' });
      setStatusNote(i18n.t('overlayDock.status.voiceOverlayOpened'));
    } catch (error: unknown) {
      if (pendingSpeakTimerRef.current !== null) {
        window.clearTimeout(pendingSpeakTimerRef.current);
        pendingSpeakTimerRef.current = null;
      }
      setPendingSpeakActive(null);
      const text = error instanceof Error ? error.message : String(error);
      setStatusNote(i18n.t('overlayDock.status.speakTriggerFailed', { detail: text }));
    }
  };

  const handleOpenSettings = async (): Promise<void> => {
    setIsExpanded(true);
    try {
      const mainWindowVisible = await getMainWindowVisibility();
      setIsMainWindowVisible(mainWindowVisible);

      if (mainWindowVisible && overlayState.settingsVisible) {
        const visible = await toggleMainWindow();
        setIsMainWindowVisible(visible);
        setStatusNote(
          visible
            ? i18n.t('overlayDock.status.settingsOpened')
            : i18n.t('overlayDock.status.settingsClosed'),
        );
        return;
      }

      await requestOverlayAction({ type: 'open-settings' });
      setIsMainWindowVisible(true);
      setStatusNote(i18n.t('overlayDock.status.settingsOpened'));
    } catch (error: unknown) {
      const text = error instanceof Error ? error.message : String(error);
      setStatusNote(i18n.t('overlayDock.status.settingsFailed', { detail: text }));
    }
  };

  const handleToggleChatWindow = async (): Promise<void> => {
    setIsExpanded(true);
    try {
      const visible = await toggleChatWindow();
      setIsChatVisible(visible);
      setStatusNote(
        visible
          ? i18n.t('overlayDock.status.chatOpened')
          : i18n.t('overlayDock.status.chatClosed'),
      );
    } catch (error: unknown) {
      const text = error instanceof Error ? error.message : String(error);
      setStatusNote(i18n.t('overlayDock.status.chatFailed', { detail: text }));
    }
  };

  const handlePauseTimer = async (timer: VoiceTimer): Promise<void> => {
    try {
      await voiceTimers.pauseTimer(timer.id);
      setStatusNote(i18n.t('timers.messages.paused', { title: timer.title }));
    } catch (error: unknown) {
      const text = error instanceof Error ? error.message : String(error);
      setStatusNote(i18n.t('timers.errors.pause', { detail: text }));
    }
  };

  const handleResumeTimer = async (timer: VoiceTimer): Promise<void> => {
    try {
      await voiceTimers.resumeTimer(timer.id);
      setStatusNote(i18n.t('timers.messages.resumed', { title: timer.title }));
    } catch (error: unknown) {
      const text = error instanceof Error ? error.message : String(error);
      setStatusNote(i18n.t('timers.errors.resume', { detail: text }));
    }
  };

  const handleDeleteTimer = async (timer: VoiceTimer): Promise<void> => {
    try {
      await voiceTimers.deleteTimer(timer.id);
      setStatusNote(i18n.t('timers.messages.deleted', { title: timer.title }));
    } catch (error: unknown) {
      const text = error instanceof Error ? error.message : String(error);
      setStatusNote(i18n.t('timers.errors.delete', { detail: text }));
    }
  };

  const handleSubmitTimerEditor = async (payload: {
    title: string;
    durationMinutes: number;
    durationSeconds: number;
  }): Promise<void> => {
    setIsTimerEditorBusy(true);
    try {
      if (timerEditorMode === 'edit' && timerEditorTimer) {
        await voiceTimers.updateTimer({
          timerId: timerEditorTimer.id,
          title: payload.title || undefined,
          durationMinutes: payload.durationMinutes,
          durationSeconds: payload.durationSeconds,
        });
        setStatusNote(
          i18n.t('timers.messages.updated', {
            title: payload.title || timerEditorTimer.title,
          }),
        );
      } else {
        const timer = await voiceTimers.createTimer({
          title: payload.title || undefined,
          durationMinutes: payload.durationMinutes,
          durationSeconds: payload.durationSeconds,
        });
        setStatusNote(i18n.t('timers.messages.created', { title: timer.title }));
      }
      setTimerEditorMode(null);
      setTimerEditorTimer(null);
      openTimerFlyout();
    } catch (error: unknown) {
      const text = error instanceof Error ? error.message : String(error);
      setStatusNote(i18n.t('timers.errors.save', { detail: text }));
    } finally {
      setIsTimerEditorBusy(false);
    }
  };

  return (
    <div className="overlay-root overlay-root--dock">
      <div
        className={`edge-nav edge-nav--${
          overlayState.assistantActive
            ? 'active'
            : overlayState.isLiveTranscribing
              ? 'ready'
              : 'idle'
        } ${isExpanded ? 'edge-nav--open' : ''}`}
        style={actionBarGlowStyle}
        onMouseEnter={() => {
          isPointerInsideRef.current = true;
          clearCollapseTimer();
          setIsExpanded(true);
        }}
        onMouseLeave={() => {
          isPointerInsideRef.current = false;
          scheduleCollapse();
        }}
      >
        <button
          type="button"
          className="edge-nav-trigger"
          aria-label={i18n.t('overlayDock.openActionBar')}
          onMouseEnter={() => {
            isPointerInsideRef.current = true;
            clearCollapseTimer();
            setIsExpanded(true);
          }}
          onFocus={() => {
            isPointerInsideRef.current = true;
            clearCollapseTimer();
            setIsExpanded(true);
          }}
          onClick={() => setIsExpanded((current) => !current)}
        >
          <span className="edge-nav-trigger-indicator" />
        </button>

        <nav
          className="edge-nav-panel"
          aria-label={i18n.t('overlayDock.quickActions')}
          data-display-mode={actionBarDisplayMode}
          title={statusNote}
        >
          <button
            type="button"
            className={`edge-nav-btn ${isSpeakActive ? 'edge-nav-btn--active' : ''}`}
            data-display-mode={actionBarDisplayMode}
            aria-label={i18n.t('overlayDock.speak')}
            title={i18n.t('overlayDock.speak')}
            onPointerDown={() => armAction('speak')}
            onMouseEnter={handleNonTimerActionHover}
            onFocus={handleNonTimerActionHover}
            onPointerLeave={clearArmedAction}
            onPointerUp={() => handleArmedAction('speak', handleSpeak)}
            onClick={(event) => {
              if (event.detail === 0) {
                void handleSpeak();
              }
            }}
          >
            {showIcons ? (
              <span className="edge-nav-icon" aria-hidden="true">
                <svg
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2.2"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                >
                  <polygon points="7 5 19 12 7 19 7 5" />
                </svg>
              </span>
            ) : null}
            {showLabels ? (
              <span className="edge-nav-label">{i18n.t('overlayDock.speak')}</span>
            ) : null}
          </button>

          <button
            type="button"
            className={`edge-nav-btn ${isChatVisible ? 'edge-nav-btn--active' : ''}`}
            data-display-mode={actionBarDisplayMode}
            aria-label={i18n.t('overlayDock.chat')}
            title={i18n.t('overlayDock.chat')}
            onPointerDown={() => armAction('chat')}
            onMouseEnter={handleNonTimerActionHover}
            onFocus={handleNonTimerActionHover}
            onPointerLeave={clearArmedAction}
            onPointerUp={() => handleArmedAction('chat', handleToggleChatWindow)}
            onClick={(event) => {
              if (event.detail === 0) {
                void handleToggleChatWindow();
              }
            }}
          >
            {showIcons ? (
              <span className="edge-nav-icon" aria-hidden="true">
                <svg
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                >
                  <path d="M21 15a2 2 0 0 1-2 2H8l-5 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
                </svg>
              </span>
            ) : null}
            {showLabels ? (
              <span className="edge-nav-label">{i18n.t('overlayDock.chat')}</span>
            ) : null}
          </button>

          <button
            type="button"
            className={`edge-nav-btn ${isTimerButtonActive ? 'edge-nav-btn--active' : ''}`}
            data-display-mode={actionBarDisplayMode}
            aria-label={i18n.t('timers.dockTitle')}
            title={i18n.t('timers.dockTitle')}
            onMouseEnter={() => {
              isTimerButtonHoveredRef.current = true;
              openTimerFlyout();
            }}
            onMouseLeave={() => {
              isTimerButtonHoveredRef.current = false;
            }}
            onFocus={() => {
              isTimerButtonHoveredRef.current = true;
              openTimerFlyout();
            }}
            onBlur={() => {
              isTimerButtonHoveredRef.current = false;
              scheduleTimerFlyoutClose();
            }}
            onClick={() => {
              setIsExpanded(true);
              setIsTimerFlyoutVisible(false);
              setIsTimerFlyoutOpen((current) => !current);
            }}
          >
            {showIcons ? (
              <span className="edge-nav-icon" aria-hidden="true">
                <svg
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                >
                  <circle cx="12" cy="13" r="8" />
                  <path d="M12 13V9" />
                  <path d="M15 5H9" />
                  <path d="M12 13l3 2" />
                </svg>
              </span>
            ) : null}
            {showLabels ? (
              <span className="edge-nav-label">{i18n.t('overlayDock.timer')}</span>
            ) : null}
          </button>

          <button
            type="button"
            className={`edge-nav-btn ${isSettingsActive ? 'edge-nav-btn--active' : ''}`}
            data-display-mode={actionBarDisplayMode}
            aria-label={
              isSettingsActive
                ? i18n.t('overlayDock.closeSettings')
                : i18n.t('overlayDock.openSettings')
            }
            title={
              isSettingsActive
                ? i18n.t('overlayDock.closeSettings')
                : i18n.t('overlayDock.openSettings')
            }
            onPointerDown={() => armAction('settings')}
            onMouseEnter={handleNonTimerActionHover}
            onFocus={handleNonTimerActionHover}
            onPointerLeave={clearArmedAction}
            onPointerUp={() => handleArmedAction('settings', handleOpenSettings)}
            onClick={(event) => {
              if (event.detail === 0) {
                void handleOpenSettings();
              }
            }}
          >
            {showIcons ? (
              <span className="edge-nav-icon" aria-hidden="true">
                <svg
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                >
                  <circle cx="12" cy="12" r="3" />
                  <path d="M19.4 15a1.7 1.7 0 0 0 .34 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.7 1.7 0 0 0-1.82-.34 1.7 1.7 0 0 0-1 1.52V21a2 2 0 1 1-4 0v-.09a1.7 1.7 0 0 0-1-1.52 1.7 1.7 0 0 0-1.82.34l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.7 1.7 0 0 0 .34-1.82 1.7 1.7 0 0 0-1.52-1H3a2 2 0 1 1 0-4h.09a1.7 1.7 0 0 0 1.52-1 1.7 1.7 0 0 0-.34-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.7 1.7 0 0 0 1.82.34h.01a1.7 1.7 0 0 0 .99-1.52V3a2 2 0 1 1 4 0v.09a1.7 1.7 0 0 0 .99 1.52h.01a1.7 1.7 0 0 0 1.82-.34l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.7 1.7 0 0 0-.34 1.82v.01a1.7 1.7 0 0 0 1.52.99H21a2 2 0 1 1 0 4h-.09a1.7 1.7 0 0 0-1.52.99z" />
                </svg>
              </span>
            ) : null}
            {showLabels ? (
              <span className="edge-nav-label">{i18n.t('overlayDock.settings')}</span>
            ) : null}
          </button>
        </nav>

        <div
          className={`edge-nav-timer-flyout ${isTimerFlyoutVisible ? 'edge-nav-timer-flyout--open' : ''}`}
          onMouseEnter={() => {
            isTimerFlyoutHoveredRef.current = true;
            openTimerFlyout();
          }}
          onMouseLeave={() => {
            isTimerFlyoutHoveredRef.current = false;
          }}
        >
          <TimerListPanel
            title={i18n.t('timers.dockTitle')}
            subtitle={i18n.t('timers.dockSubtitle')}
            variant="dock"
            timers={voiceTimers.timers}
            nowMs={voiceTimers.nowMs}
            isLoaded={voiceTimers.isLoaded}
            error={voiceTimers.error}
            onAdd={() => {
              setTimerEditorMode('create');
              setTimerEditorTimer(null);
              setIsTimerFlyoutVisible(false);
              setIsTimerFlyoutOpen(false);
              setIsExpanded(true);
            }}
            onEdit={(timer) => {
              setTimerEditorMode('edit');
              setTimerEditorTimer(timer);
              setIsTimerFlyoutVisible(false);
              setIsTimerFlyoutOpen(false);
              setIsExpanded(true);
            }}
            onPause={(timer) => void handlePauseTimer(timer)}
            onResume={(timer) => void handleResumeTimer(timer)}
            onDelete={(timer) => void handleDeleteTimer(timer)}
          />
        </div>
      </div>

      {timerEditorMode !== null ? (
        <div className="edge-nav-timer-dialog">
          <TimerEditorDialog
            open={timerEditorMode !== null}
            timer={timerEditorMode === 'edit' ? timerEditorTimer : null}
            variant="dock"
            isBusy={isTimerEditorBusy}
            onClose={() => {
              setTimerEditorMode(null);
              setTimerEditorTimer(null);
              openTimerFlyout();
            }}
            onSubmit={(payload) => void handleSubmitTimerEditor(payload)}
          />
        </div>
      ) : null}
    </div>
  );
}
