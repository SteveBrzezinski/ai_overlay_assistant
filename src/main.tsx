import ReactDOM from 'react-dom/client';
import { getCurrentWebviewWindow } from '@tauri-apps/api/webviewWindow';

async function bootstrap(): Promise<void> {
  const root = ReactDOM.createRoot(document.getElementById('root') as HTMLElement);
  const isOverlay = getCurrentWebviewWindow().label === 'overlay';

  if (isOverlay) {
    await import('./styles/overlay.css');
    const { default: Overlay } = await import('./overlay');

    root.render(<Overlay />);
    return;
  }

  await import('./styles.css');
  const { default: App } = await import('./App');

  root.render(<App />);
}

void bootstrap();
