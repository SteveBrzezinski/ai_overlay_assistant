import { useEffect, useRef, useState } from 'react';
import { LogicalPosition, LogicalSize, currentMonitor, getCurrentWindow, primaryMonitor } from '@tauri-apps/api/window';
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
const EXPANDED_LAYOUT = { width: 432, height: 84 };

const fallbackOverlayState: OverlayState = {
  assistantActive: false,
  isLiveTranscribing: false,
  voiceOrbPinned: false,
  composerVisible: false,
  assistantStateDetail: 'Listening is stopped.',
  liveTranscriptionStatus: 'Live transcription is stopped.',
  assistantWakePhrase: 'Hey Ava',
  assistantClosePhrase: 'Bye Ava',
  statusMessage: 'Overlay ready.',
  uiState: 'idle',
};

async function syncOverlayWindowLayout(expanded: boolean): Promise<void> {
  const overlayWindow = getCurrentWindow();
  const monitor = await currentMonitor() ?? await primaryMonitor();
  if (!monitor) {
    return;
  }

  const nextLayout = expanded ? EXPANDED_LAYOUT : COLLAPSED_LAYOUT;
  const workAreaPosition = monitor.workArea.position.toLogical(monitor.scaleFactor);
  const workAreaSize = monitor.workArea.size.toLogical(monitor.scaleFactor);

  await overlayWindow.setSize(new LogicalSize(nextLayout.width, nextLayout.height));
  await overlayWindow.setPosition(
    new LogicalPosition(
      workAreaPosition.x + EDGE_INSET,
      workAreaPosition.y + workAreaSize.height - nextLayout.height - BOTTOM_INSET + WINDOW_PADDING.bottom,
    ),
  );
}

export default function OverlayDock() {
  const overlayWindowRef = useRef(getCurrentWindow());
  const collapseTimerRef = useRef<number | null>(null);
  const hasShownWindowRef = useRef(false);
  const isExpandedRef = useRef(false);
  const isPointerInsideRef = useRef(false);
  const armedActionRef = useRef<string | null>(null);
  const [isExpanded, setIsExpanded] = useState(false);
  const [overlayState, setOverlayState] = useState<OverlayState>(fallbackOverlayState);
  const [statusNote, setStatusNote] = useState('Hover the edge glow to open the action bar.');

  useEffect(() => {
    document.documentElement.classList.add('overlay-html');
    document.body.classList.add('overlay-body');

    return () => {
      document.documentElement.classList.remove('overlay-html');
      document.body.classList.remove('overlay-body');
    };
  }, []);

  useEffect(() => {
    let unlistenOverlayState: (() => void | Promise<void>) | undefined;
    let unlistenScale: (() => void | Promise<void>) | undefined;

    void overlayWindowRef.current.listen<OverlayState>(OVERLAY_STATE_EVENT, (event) => {
      setOverlayState(event.payload);
    }).then((cleanup) => {
      unlistenOverlayState = cleanup;
    });

    void overlayWindowRef.current.onScaleChanged(() => {
      void syncOverlayWindowLayout(isExpandedRef.current);
    }).then((cleanup) => {
      unlistenScale = cleanup;
    });

    void overlayWindowRef.current.emitTo<OverlayAction>('main', OVERLAY_ACTION_EVENT, { type: 'request-state' });
    void syncOverlayWindowLayout(isExpandedRef.current);

    return () => {
      if (collapseTimerRef.current !== null) {
        window.clearTimeout(collapseTimerRef.current);
      }
      void unlistenOverlayState?.();
      void unlistenScale?.();
    };
  }, []);

  useEffect(() => {
    isExpandedRef.current = isExpanded;
  }, [isExpanded]);

  useEffect(() => {
    void syncOverlayWindowLayout(isExpanded)
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
  }, [isExpanded]);

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

  const requestOverlayAction = async (action: OverlayAction): Promise<void> => {
    await overlayWindowRef.current.emitTo<OverlayAction>('main', OVERLAY_ACTION_EVENT, action);
  };

  const armAction = (actionId: string): void => {
    armedActionRef.current = actionId;
  };

  const clearArmedAction = (): void => {
    armedActionRef.current = null;
  };

  const handleArmedAction = (actionId: string, run: () => Promise<void>): void => {
    if (armedActionRef.current !== actionId) {
      return;
    }

    armedActionRef.current = null;
    void run();
  };

  const handleSpeak = async (): Promise<void> => {
    setIsExpanded(true);
    try {
      if (overlayState.assistantActive || overlayState.voiceOrbPinned) {
        await requestOverlayAction({ type: 'deactivate' });
        await requestOverlayAction({ type: 'unpin-voice-orb' });
        setStatusNote('Voice overlay closed.');
        return;
      }

      await requestOverlayAction({ type: 'activate' });
      setStatusNote('Voice overlay opened.');
    } catch (error: unknown) {
      const text = error instanceof Error ? error.message : String(error);
      setStatusNote(`Speak trigger failed: ${text}`);
    }
  };

  const handleOpenSettings = async (): Promise<void> => {
    setIsExpanded(true);
    try {
      await requestOverlayAction({ type: 'open-settings' });
      setStatusNote('Settings page opened.');
    } catch (error: unknown) {
      const text = error instanceof Error ? error.message : String(error);
      setStatusNote(`Could not open the settings page: ${text}`);
    }
  };

  const handleOpenComposer = async (): Promise<void> => {
    setIsExpanded(true);
    try {
      await requestOverlayAction({ type: 'toggle-composer' });
      setStatusNote(overlayState.composerVisible ? 'Text composer closed.' : 'Text composer opened.');
    } catch (error: unknown) {
      const text = error instanceof Error ? error.message : String(error);
      setStatusNote(`Could not open the text composer: ${text}`);
    }
  };

  return (
    <div className="overlay-root overlay-root--dock">
      <div
        className={`edge-nav edge-nav--${overlayState.assistantActive ? 'active' : overlayState.isLiveTranscribing ? 'ready' : 'idle'} ${isExpanded ? 'edge-nav--open' : ''}`}
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

        <nav className="edge-nav-panel" aria-label="AI overlay quick actions" title={statusNote}>
          <button
            type="button"
            className="edge-nav-btn edge-nav-btn--primary"
            onPointerDown={() => armAction('speak')}
            onPointerLeave={clearArmedAction}
            onPointerUp={() => handleArmedAction('speak', handleSpeak)}
          >
            <span className="edge-nav-icon" aria-hidden="true">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
                <polygon points="7 5 19 12 7 19 7 5" />
              </svg>
            </span>
            <span className="edge-nav-label">Speak</span>
          </button>

          <button
            type="button"
            className={`edge-nav-btn ${overlayState.composerVisible ? 'edge-nav-btn--active' : ''}`}
            onPointerDown={() => armAction('composer')}
            onPointerLeave={clearArmedAction}
            onPointerUp={() => handleArmedAction('composer', handleOpenComposer)}
          >
            <span className="edge-nav-icon" aria-hidden="true">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M21 15a2 2 0 0 1-2 2H8l-5 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
              </svg>
            </span>
            <span className="edge-nav-label">Chat</span>
          </button>

          <button
            type="button"
            className="edge-nav-btn"
            onPointerDown={() => armAction('settings')}
            onPointerLeave={clearArmedAction}
            onPointerUp={() => handleArmedAction('settings', handleOpenSettings)}
          >
            <span className="edge-nav-icon" aria-hidden="true">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <circle cx="12" cy="12" r="3" />
                <path d="M19.4 15a1.7 1.7 0 0 0 .34 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.7 1.7 0 0 0-1.82-.34 1.7 1.7 0 0 0-1 1.52V21a2 2 0 1 1-4 0v-.09a1.7 1.7 0 0 0-1-1.52 1.7 1.7 0 0 0-1.82.34l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.7 1.7 0 0 0 .34-1.82 1.7 1.7 0 0 0-1.52-1H3a2 2 0 1 1 0-4h.09a1.7 1.7 0 0 0 1.52-1 1.7 1.7 0 0 0-.34-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.7 1.7 0 0 0 1.82.34h.01a1.7 1.7 0 0 0 .99-1.52V3a2 2 0 1 1 4 0v.09a1.7 1.7 0 0 0 .99 1.52h.01a1.7 1.7 0 0 0 1.82-.34l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.7 1.7 0 0 0-.34 1.82v.01a1.7 1.7 0 0 0 1.52.99H21a2 2 0 1 1 0 4h-.09a1.7 1.7 0 0 0-1.52.99z" />
              </svg>
            </span>
            <span className="edge-nav-label">Settings</span>
          </button>
        </nav>
      </div>
    </div>
  );
}
