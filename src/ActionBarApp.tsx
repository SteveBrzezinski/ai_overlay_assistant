import { useEffect, useState } from 'react';
import {
  getChatWindowVisibility,
  getAssistantState,
  getMainWindowVisibility,
  onAssistantStateChange,
  onChatWindowVisibility,
  onMainWindowVisibility,
  requestAssistantControl,
  toggleChatWindow,
  toggleMainWindow,
  getSettings,
  onSettingsUpdated,
} from './lib/voiceOverlay';

function GearIcon() {
  return (
    <svg className="action-bar-icon" viewBox="0 0 24 24" aria-hidden="true">
      <path
        d="M10.4 2.8h3.2l.5 2.1c.5.2 1 .4 1.4.8l2-.7 1.6 2.8-1.6 1.4c.1.3.1.6.1.9s0 .6-.1.9l1.6 1.4-1.6 2.8-2-.7c-.4.3-.9.6-1.4.8l-.5 2.1h-3.2l-.5-2.1c-.5-.2-1-.4-1.4-.8l-2 .7-1.6-2.8 1.6-1.4a3.8 3.8 0 0 1 0-1.8L4.9 8.8l1.6-2.8 2 .7c.4-.3.9-.6 1.4-.8l.5-2.1Z"
        fill="none"
        stroke="currentColor"
        strokeLinecap="round"
        strokeLinejoin="round"
        strokeWidth="1.7"
      />
      <circle
        cx="12"
        cy="12"
        r="2.8"
        fill="none"
        stroke="currentColor"
        strokeLinecap="round"
        strokeLinejoin="round"
        strokeWidth="1.7"
      />
    </svg>
  );
}

function AssistantIcon() {
  return (
    <svg className="action-bar-icon" viewBox="0 0 24 24" aria-hidden="true">
      <path
        d="M12 15a3.2 3.2 0 0 0 3.2-3.2V7.7a3.2 3.2 0 1 0-6.4 0v4.1A3.2 3.2 0 0 0 12 15Z"
        fill="none"
        stroke="currentColor"
        strokeLinecap="round"
        strokeLinejoin="round"
        strokeWidth="1.8"
      />
      <path
        d="M17.5 11.5a5.5 5.5 0 0 1-11 0"
        fill="none"
        stroke="currentColor"
        strokeLinecap="round"
        strokeLinejoin="round"
        strokeWidth="1.8"
      />
      <path
        d="M12 17v3"
        fill="none"
        stroke="currentColor"
        strokeLinecap="round"
        strokeLinejoin="round"
        strokeWidth="1.8"
      />
      <path
        d="M9 20h6"
        fill="none"
        stroke="currentColor"
        strokeLinecap="round"
        strokeLinejoin="round"
        strokeWidth="1.8"
      />
    </svg>
  );
}

function ChatIcon() {
  return (
    <svg className="action-bar-icon" viewBox="0 0 24 24" aria-hidden="true">
      <path
        d="M6.8 6.4h10.4a2.8 2.8 0 0 1 2.8 2.8v5.3a2.8 2.8 0 0 1-2.8 2.8H10l-4.1 3v-3H6.8A2.8 2.8 0 0 1 4 14.5V9.2a2.8 2.8 0 0 1 2.8-2.8Z"
        fill="none"
        stroke="currentColor"
        strokeLinecap="round"
        strokeLinejoin="round"
        strokeWidth="1.8"
      />
      <path
        d="M8.5 11.8h7"
        fill="none"
        stroke="currentColor"
        strokeLinecap="round"
        strokeLinejoin="round"
        strokeWidth="1.8"
      />
      <path
        d="M8.5 14.5h4.5"
        fill="none"
        stroke="currentColor"
        strokeLinecap="round"
        strokeLinejoin="round"
        strokeWidth="1.8"
      />
    </svg>
  );
}

export default function ActionBarApp() {
  const [isMainWindowVisible, setIsMainWindowVisible] = useState(false);
  const [isChatWindowVisible, setIsChatWindowVisible] = useState(false);
  const [isAssistantActive, setIsAssistantActive] = useState(false);
  const [isSettingsToggling, setIsSettingsToggling] = useState(false);
  const [isChatToggling, setIsChatToggling] = useState(false);
  const [actionBarDisplayMode, setActionBarDisplayMode] = useState<'icons-only' | 'text-only' | 'icons-and-text'>('icons-and-text');
  const [settingsWindowWasOpen, setSettingsWindowWasOpen] = useState(false);

  useEffect(() => {
    let isMounted = true;
    let unlistenMainWindow: (() => void | Promise<void>) | undefined;
    let unlistenChatWindow: (() => void | Promise<void>) | undefined;
    let unlistenAssistantState: (() => void | Promise<void>) | undefined;
    let unlistenSettings: (() => void | Promise<void>) | undefined;

    document.documentElement.classList.add('overlay-html');
    document.body.classList.add('overlay-body');

    void getMainWindowVisibility()
      .then((visible) => {
        if (isMounted) {
          setIsMainWindowVisible(visible);
        }
      })
      .catch(() => {
        if (isMounted) {
          setIsMainWindowVisible(false);
        }
      });

    void getChatWindowVisibility()
      .then((visible) => {
        if (isMounted) {
          setIsChatWindowVisible(visible);
        }
      })
      .catch(() => {
        if (isMounted) {
          setIsChatWindowVisible(false);
        }
      });

    void getAssistantState()
      .then((active) => {
        if (isMounted) {
          setIsAssistantActive(active);
        }
      })
      .catch(() => {
        if (isMounted) {
          setIsAssistantActive(false);
        }
      });

    void getSettings()
      .then((settings) => {
        if (isMounted) {
          setActionBarDisplayMode(settings.actionBarDisplayMode ?? 'icons-and-text');
        }
      })
      .catch(() => {
        if (isMounted) {
          setActionBarDisplayMode('icons-and-text');
        }
      });

    void onMainWindowVisibility(({ visible }) => {
      if (!isMounted) {
        return;
      }

      setIsMainWindowVisible(visible);
      setSettingsWindowWasOpen(visible);
      setIsSettingsToggling(false);
    }).then((cleanup) => {
      unlistenMainWindow = cleanup;
    });

    void onChatWindowVisibility(({ visible }) => {
      if (!isMounted) {
        return;
      }

      setIsChatWindowVisible(visible);
      setIsChatToggling(false);
    }).then((cleanup) => {
      unlistenChatWindow = cleanup;
    });

    void onAssistantStateChange(({ active }) => {
      if (isMounted) {
        setIsAssistantActive(active);
      }
    }).then((cleanup) => {
      unlistenAssistantState = cleanup;
    });

    void onSettingsUpdated((settings) => {
      if (isMounted) {
        setActionBarDisplayMode(settings.actionBarDisplayMode ?? 'icons-and-text');
      }
    }).then((cleanup) => {
      unlistenSettings = cleanup;
    });

    return () => {
      isMounted = false;
      document.documentElement.classList.remove('overlay-html');
      document.body.classList.remove('overlay-body');
      void unlistenMainWindow?.();
      void unlistenChatWindow?.();
      void unlistenAssistantState?.();
      void unlistenSettings?.();
    };
  }, []);

  const handleSettingsToggle = async (): Promise<void> => {
    if (isSettingsToggling) {
      return;
    }

    setIsSettingsToggling(true);
    try {
      const visible = await toggleMainWindow();
      setIsMainWindowVisible(visible);
      setIsSettingsToggling(false);
    } catch (error) {
      console.error('Settings toggle error:', error);
      setIsSettingsToggling(false);
    }
  };

  const handleChatToggle = async (): Promise<void> => {
    if (isChatToggling) {
      return;
    }

    setIsChatToggling(true);
    try {
      const visible = await toggleChatWindow();
      setIsChatWindowVisible(visible);
      // Force state sync after a delay to ensure UI matches backend
      setTimeout(() => {
        void getChatWindowVisibility().then((updated) => {
          setIsChatWindowVisible(updated);
          setIsChatToggling(false);
        });
      }, 150);
    } catch (error) {
      console.error('Chat toggle error:', error);
      setIsChatToggling(false);
    }
  };

  const handleAssistantToggle = async (): Promise<void> => {
    await requestAssistantControl(isAssistantActive ? 'deactivate' : 'activate');
  };

  return (
    <main className="action-bar-screen" aria-label="Voice Overlay Assistant quick actions">
      <div className="action-bar-rail">
        <div className="action-bar-handle" aria-hidden="true">
          <span />
          <span />
          <span />
        </div>

        <div className="action-bar-actions">
          <button
            type="button"
            className={`action-bar-button${isAssistantActive ? ' action-bar-button--active' : ''}`}
            data-display-mode={actionBarDisplayMode}
            aria-label={isAssistantActive ? 'Assistent deaktivieren' : 'Assistent aktivieren'}
            aria-pressed={isAssistantActive}
            title={isAssistantActive ? 'Assistent deaktivieren' : 'Assistent aktivieren'}
            onClick={() => void handleAssistantToggle()}
          >
            {actionBarDisplayMode !== 'text-only' && <AssistantIcon />}
            {actionBarDisplayMode !== 'icons-only' && <span className="action-bar-label">Speak</span>}
          </button>

          <button
            type="button"
            className={`action-bar-button${isChatWindowVisible ? ' action-bar-button--active' : ''}`}
            data-display-mode={actionBarDisplayMode}
            aria-label={isChatWindowVisible ? 'Chat schliessen' : 'Chat oeffnen'}
            aria-pressed={isChatWindowVisible}
            disabled={isChatToggling}
            title={isChatWindowVisible ? 'Chat schliessen' : 'Chat oeffnen'}
            onClick={() => void handleChatToggle()}
          >
            {actionBarDisplayMode !== 'text-only' && <ChatIcon />}
            {actionBarDisplayMode !== 'icons-only' && <span className="action-bar-label">Chat</span>}
          </button>

          <button
            type="button"
            className={`action-bar-button${isMainWindowVisible ? ' action-bar-button--active' : ''}`}
            data-display-mode={actionBarDisplayMode}
            aria-label={
              isMainWindowVisible
                ? 'Voice Overlay Assistant schliessen'
                : 'Voice Overlay Assistant oeffnen'
            }
            aria-pressed={isMainWindowVisible}
            disabled={isSettingsToggling}
            title={
              isMainWindowVisible
                ? 'Voice Overlay Assistant schliessen'
                : 'Voice Overlay Assistant oeffnen'
            }
            onClick={() => void handleSettingsToggle()}
          >
            {actionBarDisplayMode !== 'text-only' && <GearIcon />}
            {actionBarDisplayMode !== 'icons-only' && <span className="action-bar-label">Settings</span>}
          </button>
        </div>
      </div>
    </main>
  );
}
