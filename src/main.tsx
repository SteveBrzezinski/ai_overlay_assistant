import React from 'react';
import ReactDOM from 'react-dom/client';
import ActionBarApp from './ActionBarApp';
import App from './App';
import ChatOverlayApp from './ChatOverlayApp';
import './i18n';
import './styles.css';

type TauriMetadataWindow = {
  __TAURI_INTERNALS__?: {
    metadata?: {
      currentWindow?: {
        label?: string;
      };
    };
  };
};

function currentWindowLabel(): string {
  return (
    (window as Window & TauriMetadataWindow).__TAURI_INTERNALS__?.metadata?.currentWindow?.label ??
    'main'
  );
}

ReactDOM.createRoot(document.getElementById('root') as HTMLElement).render(
  <React.StrictMode>
    {currentWindowLabel() === 'action-bar' ? (
      <ActionBarApp />
    ) : currentWindowLabel() === 'chat-overlay' ? (
      <ChatOverlayApp />
    ) : (
      <App />
    )}
  </React.StrictMode>,
);
