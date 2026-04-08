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
import {
  OVERLAY_ACTION_EVENT,
  OVERLAY_STATE_EVENT,
  type OverlayAction,
  type OverlayState,
} from './lib/overlayBridge';

const EDGE_INSET = 0;
const BOTTOM_INSET = 10;
const WINDOW_PADDING = { top: 8, right: 6, bottom: 8 };
const COLLAPSED_LAYOUT = { width: 22, height: 84 };
const EXPANDED_LAYOUTS = {
  'icons-only': { width: 212, height: 84 },
  'text-only': { width: 280, height: 84 },
  'icons-and-text': { width: 360, height: 84 },
} as const;
const DEFAULT_ACTION_BAR_ACTIVE_GLOW_COLOR = '#b63131';

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
): Promise<void> {
  const overlayWindow = getCurrentWindow();
  const monitor = await currentMonitor() ?? await primaryMonitor();
  if (!monitor) {
    return;
  }

  const nextLayout = expanded ? EXPANDED_LAYOUTS[displayMode] : COLLAPSED_LAYOUT;
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
  const hasShownWindowRef = useRef(false);
  const isExpandedRef = useRef(false);
  const isPointerInsideRef = useRef(false);
  const armedActionRef = useRef<string | null>(null);
  const actionBarDisplayModeRef = useRef<ActionBarDisplayMode>('icons-and-text');
  const [isExpanded, setIsExpanded] = useState(false);
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
  const [statusNote, setStatusNote] = useState(
    'Hover the edge glow to open the action bar.',
  );

  const resolvedSpeakActive =
    assistantStateActive || overlayState.assistantActive || overlayState.voiceOrbPinned;
  const isSpeakActive = pendingSpeakActive ?? resolvedSpeakActive;
  const isSettingsActive = isMainWindowVisible && overlayState.settingsVisible;
  const showIcons = actionBarDisplayMode !== 'text-only';
  const showLabels = actionBarDisplayMode !== 'icons-only';

  const actionBarGlowStyle = useMemo<CSSProperties>(() => {
    const color = normalizeHexColor(actionBarActiveGlowColor);
    return {
      ['--edge-action-active-text' as string]: color,
      ['--edge-action-active-glow' as string]: withAlpha(color, 0.92),
      ['--edge-action-active-glow-soft' as string]: withAlpha(color, 0.34),
      ['--edge-action-active-border' as string]: withAlpha(color, 0.52),
      ['--edge-action-active-surface' as string]: withAlpha(color, 0.14),
    };
  }, [actionBarActiveGlowColor]);

  useEffect(() => {
    document.documentElement.classList.add('overlay-html');
    document.body.classList.add('overlay-body');

    return () => {
      if (pendingSpeakTimerRef.current !== null) {
        window.clearTimeout(pendingSpeakTimerRef.current);
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
    );

    return () => {
      if (collapseTimerRef.current !== null) {
        window.clearTimeout(collapseTimerRef.current);
      }
      if (pendingSpeakTimerRef.current !== null) {
        window.clearTimeout(pendingSpeakTimerRef.current);
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
    actionBarDisplayModeRef.current = actionBarDisplayMode;
  }, [actionBarDisplayMode]);

  useEffect(() => {
    void syncOverlayWindowLayout(isExpanded, actionBarDisplayMode)
      .then(async () => {
        if (!hasShownWindowRef.current) {
          hasShownWindowRef.current = true;
          await overlayWindowRef.current.show();
        }
      })
      .catch((error: unknown) => {
        const text = error instanceof Error ? error.message : String(error);
        setStatusNote(`Action bar layout failed: ${text}`);
      });
  }, [actionBarDisplayMode, isExpanded]);

  const clearCollapseTimer = (): void => {
    if (collapseTimerRef.current !== null) {
      window.clearTimeout(collapseTimerRef.current);
      collapseTimerRef.current = null;
    }
  };

  const scheduleCollapse = (): void => {
    clearCollapseTimer();
    collapseTimerRef.current = window.setTimeout(() => {
      if (!isPointerInsideRef.current) {
        setIsExpanded(false);
      }
    }, 260);
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
        setStatusNote('Voice overlay closed.');
        return;
      }

      armPendingSpeakState(true);
      await requestOverlayAction({ type: 'activate' });
      setStatusNote('Voice overlay opened.');
    } catch (error: unknown) {
      if (pendingSpeakTimerRef.current !== null) {
        window.clearTimeout(pendingSpeakTimerRef.current);
        pendingSpeakTimerRef.current = null;
      }
      setPendingSpeakActive(null);
      const text = error instanceof Error ? error.message : String(error);
      setStatusNote(`Speak trigger failed: ${text}`);
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
        setStatusNote(visible ? 'Settings page opened.' : 'Settings page closed.');
        return;
      }

      await requestOverlayAction({ type: 'open-settings' });
      setIsMainWindowVisible(true);
      setStatusNote('Settings page opened.');
    } catch (error: unknown) {
      const text = error instanceof Error ? error.message : String(error);
      setStatusNote(`Could not open the settings page: ${text}`);
    }
  };

  const handleToggleChatWindow = async (): Promise<void> => {
    setIsExpanded(true);
    try {
      const visible = await toggleChatWindow();
      setIsChatVisible(visible);
      setStatusNote(visible ? 'Chat window opened.' : 'Chat window closed.');
    } catch (error: unknown) {
      const text = error instanceof Error ? error.message : String(error);
      setStatusNote(`Could not toggle the chat window: ${text}`);
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
          aria-label="Open action bar"
          onClick={() => setIsExpanded((current) => !current)}
        >
          <span className="edge-nav-trigger-indicator" />
        </button>

        <nav
          className="edge-nav-panel"
          aria-label="AI overlay quick actions"
          data-display-mode={actionBarDisplayMode}
          title={statusNote}
        >
          <button
            type="button"
            className={`edge-nav-btn edge-nav-btn--primary ${
              isSpeakActive ? 'edge-nav-btn--active' : ''
            }`}
            data-display-mode={actionBarDisplayMode}
            aria-label="Speak"
            title="Speak"
            onPointerDown={() => armAction('speak')}
            onPointerLeave={clearArmedAction}
            onPointerUp={() => handleArmedAction('speak', handleSpeak)}
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
            {showLabels ? <span className="edge-nav-label">Speak</span> : null}
          </button>

          <button
            type="button"
            className={`edge-nav-btn ${isChatVisible ? 'edge-nav-btn--active' : ''}`}
            data-display-mode={actionBarDisplayMode}
            aria-label="Chat"
            title="Chat"
            onPointerDown={() => armAction('chat')}
            onPointerLeave={clearArmedAction}
            onPointerUp={() => handleArmedAction('chat', handleToggleChatWindow)}
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
            {showLabels ? <span className="edge-nav-label">Chat</span> : null}
          </button>

          <button
            type="button"
            className={`edge-nav-btn ${isSettingsActive ? 'edge-nav-btn--active' : ''}`}
            data-display-mode={actionBarDisplayMode}
            aria-label={isSettingsActive ? 'Close settings' : 'Open settings'}
            title={isSettingsActive ? 'Close settings' : 'Open settings'}
            onPointerDown={() => armAction('settings')}
            onPointerLeave={clearArmedAction}
            onPointerUp={() => handleArmedAction('settings', handleOpenSettings)}
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
            {showLabels ? <span className="edge-nav-label">Settings</span> : null}
          </button>
        </nav>
      </div>
    </div>
  );
}
