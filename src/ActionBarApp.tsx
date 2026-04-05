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

  useEffect(() => {
    let isMounted = true;
    let unlistenMainWindow: (() => void | Promise<void>) | undefined;
    let unlistenChatWindow: (() => void | Promise<void>) | undefined;
    let unlistenAssistantState: (() => void | Promise<void>) | undefined;

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

    void onMainWindowVisibility(({ visible }) => {
      if (!isMounted) {
        return;
      }

      setIsMainWindowVisible(visible);
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

    return () => {
      isMounted = false;
      document.documentElement.classList.remove('overlay-html');
      document.body.classList.remove('overlay-body');
      void unlistenMainWindow?.();
      void unlistenChatWindow?.();
      void unlistenAssistantState?.();
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
    } finally {
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
    } finally {
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
            aria-label={isAssistantActive ? 'Assistent deaktivieren' : 'Assistent aktivieren'}
            aria-pressed={isAssistantActive}
            title={isAssistantActive ? 'Assistent deaktivieren' : 'Assistent aktivieren'}
            onClick={() => void handleAssistantToggle()}
          >
            <AssistantIcon />
          </button>

          <button
            type="button"
            className={`action-bar-button${isChatWindowVisible ? ' action-bar-button--active' : ''}`}
            aria-label={isChatWindowVisible ? 'Chat schliessen' : 'Chat oeffnen'}
            aria-pressed={isChatWindowVisible}
            disabled={isChatToggling}
            title={isChatWindowVisible ? 'Chat schliessen' : 'Chat oeffnen'}
            onClick={() => void handleChatToggle()}
          >
            <ChatIcon />
          </button>

          <button
            type="button"
            className={`action-bar-button${isMainWindowVisible ? ' action-bar-button--active' : ''}`}
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
            <GearIcon />
          </button>
        </div>
      </div>
    </main>
  );
}
