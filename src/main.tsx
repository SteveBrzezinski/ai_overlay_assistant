import React, { useEffect, useState } from 'react';
import ReactDOM from 'react-dom/client';
import { getCurrentWindow } from '@tauri-apps/api/window';
import App from './App';
import ChatOverlayApp from './ChatOverlayApp';
import { applyDesignTheme, DEFAULT_DESIGN_THEME_ID } from './designThemes';
import './i18n';
import OverlayDock from './OverlayDock';
import OverlayComposer from './OverlayComposer';
import VoiceOrbOverlay from './VoiceOrbOverlay';
import { getSettings, onSettingsUpdated } from './lib/voiceOverlay';
import './styles.css';

function WindowRoot() {
  const [windowLabel, setWindowLabel] = useState<string | null>(null);

  useEffect(() => {
    let isMounted = true;
    let retryTimer: number | null = null;

    const resolveWindowLabel = (): void => {
      try {
        const nextLabel = getCurrentWindow().label;
        if (isMounted) {
          setWindowLabel(nextLabel);
        }
        return;
      } catch {
        if (!isMounted) {
          return;
        }
      }

      retryTimer = window.setTimeout(resolveWindowLabel, 60);
    };

    resolveWindowLabel();

    return () => {
      isMounted = false;
      if (retryTimer !== null) {
        window.clearTimeout(retryTimer);
      }
    };
  }, []);

  useEffect(() => {
    let unlistenSettings: (() => void | Promise<void>) | undefined;

    void getSettings()
      .then((settings) => applyDesignTheme(settings.designThemeId))
      .catch(() => applyDesignTheme(DEFAULT_DESIGN_THEME_ID));

    void onSettingsUpdated((settings) => {
      void applyDesignTheme(settings.designThemeId);
    }).then((cleanup) => {
      unlistenSettings = cleanup;
    });

    return () => {
      void unlistenSettings?.();
    };
  }, []);

  if (windowLabel === null) {
    return null;
  }

  switch (windowLabel) {
    case 'action-bar':
      return <OverlayDock />;
    case 'chat-overlay':
      return <ChatOverlayApp />;
    case 'voice-overlay':
      return <VoiceOrbOverlay />;
    case 'overlay-composer':
      return <OverlayComposer />;
    default:
      return <App />;
  }
}

ReactDOM.createRoot(document.getElementById('root') as HTMLElement).render(
  <React.StrictMode>
    <WindowRoot />
  </React.StrictMode>,
);
