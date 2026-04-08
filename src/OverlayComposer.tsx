import { type FormEvent, useEffect, useRef, useState } from 'react';
import { LogicalPosition, LogicalSize, currentMonitor, getCurrentWindow, primaryMonitor } from '@tauri-apps/api/window';
import { DEFAULT_DESIGN_THEME_ID } from './designThemes';
import { OVERLAY_ACTION_EVENT, OVERLAY_STATE_EVENT, type OverlayAction, type OverlayState } from './lib/overlayBridge';
import { getSettings, speakText, type AppSettings } from './lib/voiceOverlay';

const SCREEN_EDGE_INSET = 12;
const COMPOSER_PADDING = 8;
const COMPOSER_PANEL_LAYOUT = { width: 304, height: 224 };
const COMPOSER_LAYOUT = {
  width: COMPOSER_PANEL_LAYOUT.width + (COMPOSER_PADDING * 2),
  height: COMPOSER_PANEL_LAYOUT.height + (COMPOSER_PADDING * 2),
};
const VOICE_ORB_WIDTH = 188;
const COMPOSER_GAP = 12;

const fallbackSettings: AppSettings = {
  ttsMode: 'classic',
  realtimeAllowLiveFallback: false,
  designThemeId: DEFAULT_DESIGN_THEME_ID,
  actionBarActiveGlowColor: '#b63131',
  uiLanguage: 'en',
  launchAtLogin: false,
  startHiddenOnLaunch: true,
  ttsFormat: 'wav',
  firstChunkLeadingSilenceMs: 180,
  translationTargetLanguage: 'en',
  playbackSpeed: 1,
  openaiApiKey: '',
  aiProviderMode: 'byo',
  hostedApiBaseUrl: '',
  hostedAccountEmail: '',
  hostedAccessToken: '',
  hostedWorkspaceSlug: '',
  sttLanguage: 'de',
  assistantName: 'Ava',
  voiceAgentModel: 'gpt-realtime',
  voiceAgentVoice: 'marin',
  voiceAgentPersonality: 'Composed, technically precise, friendly, and concise.',
  voiceAgentBehavior: 'If a PC task is unclear, ask immediately. If something takes longer, acknowledge it briefly and follow up with the result.',
  voiceAgentExtraInstructions: 'Keep using the stored assistant name unchanged and do not rename yourself.',
  voiceAgentPreferredLanguage: 'German',
  voiceAgentToneNotes: '',
  voiceAgentOnboardingComplete: true,
  assistantWakeSamples: [],
  assistantNameSamples: [],
  assistantSampleLanguage: 'de',
  assistantWakeThreshold: 74,
  assistantCueCooldownMs: 1000,
  actionBarDisplayMode: 'icons-and-text',
};

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

async function syncComposerWindowLayout(orbVisible: boolean): Promise<void> {
  const overlayWindow = getCurrentWindow();
  const monitor = await currentMonitor() ?? await primaryMonitor();
  if (!monitor) {
    return;
  }

  const workAreaPosition = monitor.workArea.position.toLogical(monitor.scaleFactor);
  const workAreaSize = monitor.workArea.size.toLogical(monitor.scaleFactor);

  await overlayWindow.setSize(new LogicalSize(COMPOSER_LAYOUT.width, COMPOSER_LAYOUT.height));
  await overlayWindow.setPosition(
    new LogicalPosition(
      workAreaPosition.x + workAreaSize.width - COMPOSER_PANEL_LAYOUT.width - (orbVisible ? (VOICE_ORB_WIDTH + COMPOSER_GAP) : 0) - SCREEN_EDGE_INSET - COMPOSER_PADDING,
      workAreaPosition.y + workAreaSize.height - COMPOSER_PANEL_LAYOUT.height - SCREEN_EDGE_INSET - COMPOSER_PADDING,
    ),
  );
}

export default function OverlayComposer() {
  const overlayWindowRef = useRef(getCurrentWindow());
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  const [overlayState, setOverlayState] = useState<OverlayState>(fallbackOverlayState);
  const [settings, setSettings] = useState<AppSettings>(fallbackSettings);
  const [draftText, setDraftText] = useState('');
  const [statusNote, setStatusNote] = useState('Type a short text and send it to speech.');
  const [isSubmitting, setIsSubmitting] = useState(false);

  useEffect(() => {
    document.documentElement.classList.add('overlay-html');
    document.body.classList.add('overlay-body');

    return () => {
      document.documentElement.classList.remove('overlay-html');
      document.body.classList.remove('overlay-body');
    };
  }, []);

  useEffect(() => {
    void getSettings()
      .then((nextSettings) => {
        setSettings(nextSettings);
      })
      .catch((error: unknown) => {
        const text = error instanceof Error ? error.message : String(error);
        setStatusNote(`Could not load speech settings: ${text}`);
      });

    let unlistenOverlayState: (() => void | Promise<void>) | undefined;
    let unlistenFocus: (() => void | Promise<void>) | undefined;
    let unlistenScale: (() => void | Promise<void>) | undefined;

    void overlayWindowRef.current.listen<OverlayState>(OVERLAY_STATE_EVENT, (event) => {
      setOverlayState(event.payload);
    }).then((cleanup) => {
      unlistenOverlayState = cleanup;
    });

    void overlayWindowRef.current.onFocusChanged(({ payload }) => {
      if (payload) {
        textareaRef.current?.focus();
      }
    }).then((cleanup) => {
      unlistenFocus = cleanup;
    });

    void overlayWindowRef.current.onScaleChanged(() => {
      const orbVisible = overlayState.assistantActive || overlayState.voiceOrbPinned;
      void syncComposerWindowLayout(orbVisible);
    }).then((cleanup) => {
      unlistenScale = cleanup;
    });

    void overlayWindowRef.current.emitTo<OverlayAction>('main', OVERLAY_ACTION_EVENT, { type: 'request-state' });
    void syncComposerWindowLayout(false);

    const closeComposer = (): void => {
      void overlayWindowRef.current.emitTo<OverlayAction>('main', OVERLAY_ACTION_EVENT, { type: 'close-composer' });
    };

    const handleKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') {
        closeComposer();
      }
    };

    window.addEventListener('keydown', handleKeyDown);

    return () => {
      window.removeEventListener('keydown', handleKeyDown);
      void unlistenOverlayState?.();
      void unlistenFocus?.();
      void unlistenScale?.();
    };
  }, []);

  useEffect(() => {
    const orbVisible = overlayState.assistantActive || overlayState.voiceOrbPinned;
    void syncComposerWindowLayout(orbVisible);
  }, [overlayState.assistantActive, overlayState.voiceOrbPinned, overlayState.composerVisible]);

  const handleSubmitDraft = async (event: FormEvent<HTMLFormElement>): Promise<void> => {
    event.preventDefault();
    const trimmed = draftText.trim();
    if (!trimmed || isSubmitting) {
      return;
    }

    setIsSubmitting(true);
    setStatusNote('Speaking typed text...');
    try {
      await speakText(trimmed, {
        autoplay: true,
        format: settings.ttsFormat,
        mode: settings.ttsMode,
        voice: 'alloy',
        firstChunkLeadingSilenceMs: settings.firstChunkLeadingSilenceMs,
      });
      setDraftText('');
      setStatusNote('Typed text sent to speech.');
    } catch (error: unknown) {
      const text = error instanceof Error ? error.message : String(error);
      setStatusNote(text);
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <div className="overlay-root overlay-root--composer">
      <form className="overlay-composer-panel" onSubmit={(event) => void handleSubmitDraft(event)}>
        <div className="overlay-composer-panel__header">
          <div>
            <span className="overlay-composer-panel__eyebrow">Text</span>
            <strong>{overlayState.assistantActive ? 'Assistant active' : 'Speech composer'}</strong>
          </div>
        </div>

        <textarea
          ref={textareaRef}
          placeholder="Type a short prompt, note, or speech snippet..."
          value={draftText}
          onChange={(event) => setDraftText(event.target.value)}
        />

        <div className="overlay-composer-panel__footer">
          <button
            type="submit"
            className="overlay-composer-panel__send"
            disabled={!draftText.trim() || isSubmitting}
            title={statusNote}
          >
            {isSubmitting ? 'Sending...' : 'Send'}
          </button>
        </div>
      </form>
    </div>
  );
}
