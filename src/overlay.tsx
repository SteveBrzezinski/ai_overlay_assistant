import { useEffect, useMemo, useRef, useState } from 'react';
import { AIOrb } from './components/AIOrb';
import { executeVoiceCommand, onHotkeyStatus, showMainWindow, toggleMainWindow } from './lib/voiceOverlay';

type SpeechRecognitionResultShape = {
  0: { transcript: string };
  isFinal: boolean;
  length: number;
};

type SpeechRecognitionEventShape = Event & {
  resultIndex: number;
  results: ArrayLike<SpeechRecognitionResultShape>;
};

type SpeechRecognitionErrorEventShape = Event & {
  error?: string;
};

type SpeechRecognitionInstance = EventTarget & {
  continuous: boolean;
  interimResults: boolean;
  lang: string;
  onstart: (() => void) | null;
  onresult: ((event: SpeechRecognitionEventShape) => void) | null;
  onerror: ((event: SpeechRecognitionErrorEventShape) => void) | null;
  onend: (() => void) | null;
  start: () => void;
  stop: () => void;
};

type SpeechRecognitionConstructor = new () => SpeechRecognitionInstance;

declare global {
  interface Window {
    SpeechRecognition?: SpeechRecognitionConstructor;
    webkitSpeechRecognition?: SpeechRecognitionConstructor;
  }
}

const WAKE_PATTERNS = ['hey astra', 'hi astra', 'astra'];
const SLEEP_PATTERNS = [
  'astra zieh dich zuruck',
  'hey astra zieh dich zuruck',
  'astra verschwinde',
  'astra hide',
  'astra go away',
];

function matchesAnyPattern(input: string, patterns: string[]): boolean {
  return patterns.some((pattern) => input.includes(pattern));
}

function soundsLikeAstra(input: string): boolean {
  return (
    input.includes('astra') ||
    input.includes('astrah') ||
    input.includes('astraa') ||
    input.includes('hey asra') ||
    input.includes('hey astra') ||
    input.includes('hi astra') ||
    input.includes('hallo astra')
  );
}

function isAddressedToAstra(input: string): boolean {
  return matchesAnyPattern(input, WAKE_PATTERNS) || soundsLikeAstra(input);
}

function normalizeTranscript(text: string): string {
  return text
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/\u00df/g, 'ss')
    .replace(/[!?.,;:]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function looksLikeVoiceActionRequest(input: string): boolean {
  const mentionsAction = containsAny(input, [
    'offne',
    'oeffne',
    'schliesse',
    'schlies',
    'verstecke',
    'zeige',
    'starte',
    'geh auf',
    'gehe auf',
  ]);
  const mentionsTarget = containsAny(input, [
    'browser',
    'youtube',
    'google',
    'fenster',
    'tool',
    'app',
    'anwendung',
    'einstellung',
    'settings',
    'ordner',
    'folder',
    'desktop',
    'downloads',
    'dokument',
    'bilder',
    'musik',
    'videos',
    'projekt',
    'website',
    'webseite',
  ]);
  const addressedToAstra = isAddressedToAstra(input);

  return (mentionsAction && mentionsTarget) || (addressedToAstra && mentionsTarget);
}

function containsAny(input: string, patterns: string[]): boolean {
  return patterns.some((pattern) => input.includes(pattern));
}

export default function Overlay() {
  const [isMuted, setIsMuted] = useState(false);
  const [isWakePulseActive, setIsWakePulseActive] = useState(false);
  const [isSpeaking, setIsSpeaking] = useState(false);
  const [isOrbVisible, setIsOrbVisible] = useState(true);
  const [, setMicPermissionState] = useState<'checking' | 'granted' | 'denied' | 'unsupported'>('checking');
  const [, setWakeListenerState] = useState<'starting' | 'active' | 'paused' | 'error' | 'unsupported'>('starting');
  const recognitionRef = useRef<SpeechRecognitionInstance | null>(null);
  const shouldKeepRecognitionAliveRef = useRef(true);
  const restartTimerRef = useRef<number | null>(null);
  const wakePulseTimerRef = useRef<number | null>(null);
  const startRecognitionRef = useRef<() => void>(() => {});
  const stopRecognitionRef = useRef<(pauseListener: boolean) => void>(() => {});
  const lastExecutedCommandRef = useRef<{ text: string; atMs: number } | null>(null);
  const ignoreRecognitionUntilRef = useRef(0);

  const speechRecognitionSupported = useMemo(
    () => Boolean(window.SpeechRecognition || window.webkitSpeechRecognition),
    [],
  );

  useEffect(() => {
    let unlisten: (() => void | Promise<void>) | undefined;

    void onHotkeyStatus((status) => {
      setIsSpeaking(status.state === 'working');
      if (status.state === 'working') {
        setIsOrbVisible(true);
      }
    }).then((cleanup) => {
      unlisten = cleanup;
    });

    return () => {
      void unlisten?.();
    };
  }, []);

  useEffect(() => {
    if (!speechRecognitionSupported) {
      setMicPermissionState('unsupported');
      setWakeListenerState('unsupported');
      return;
    }

    const SpeechRecognitionCtor = window.SpeechRecognition ?? window.webkitSpeechRecognition;
    if (!SpeechRecognitionCtor) {
      setMicPermissionState('unsupported');
      setWakeListenerState('unsupported');
      return;
    }

    let isDisposed = false;

    const clearWakePulseTimer = () => {
      if (wakePulseTimerRef.current !== null) {
        window.clearTimeout(wakePulseTimerRef.current);
        wakePulseTimerRef.current = null;
      }
    };

    const clearRestartTimer = () => {
      if (restartTimerRef.current !== null) {
        window.clearTimeout(restartTimerRef.current);
        restartTimerRef.current = null;
      }
    };

    const detachRecognitionHandlers = (recognition: SpeechRecognitionInstance | null) => {
      if (!recognition) {
        return;
      }

      recognition.onstart = null;
      recognition.onresult = null;
      recognition.onerror = null;
      recognition.onend = null;
    };

    const pulseWakeVisual = () => {
      clearWakePulseTimer();
      setIsWakePulseActive(true);
      wakePulseTimerRef.current = window.setTimeout(() => {
        setIsWakePulseActive(false);
        wakePulseTimerRef.current = null;
      }, 2400);
    };

    const tryExecuteVoiceCommand = (normalized: string) => {
      const isJustWakePhrase = WAKE_PATTERNS.some((pattern) => normalized === pattern);
      const shouldHandle = looksLikeVoiceActionRequest(normalized) || isAddressedToAstra(normalized);

      if (!shouldHandle || isJustWakePhrase) {
        return;
      }

      const now = Date.now();
      if (now < ignoreRecognitionUntilRef.current) {
        return;
      }

      const lastExecuted = lastExecutedCommandRef.current;
      if (lastExecuted && lastExecuted.text === normalized && now - lastExecuted.atMs < 2600) {
        return;
      }

      lastExecutedCommandRef.current = { text: normalized, atMs: now };

      void executeVoiceCommand(normalized)
        .then((result) => {
          if (!result.handled) {
            return;
          }

          setIsOrbVisible(true);
          pulseWakeVisual();
          if (result.spokeFeedback) {
            ignoreRecognitionUntilRef.current = Date.now() + 4000;
          }
        })
        .catch(() => {
          // Keep voice listening alive even if command execution fails.
        });
    };

    const stopRecognitionSession = (pauseListener: boolean) => {
      clearRestartTimer();
      shouldKeepRecognitionAliveRef.current = !pauseListener;

      const activeRecognition = recognitionRef.current;
      recognitionRef.current = null;
      detachRecognitionHandlers(activeRecognition);

      if (activeRecognition) {
        try {
          activeRecognition.stop();
        } catch {
          // Ignore stop failures from a session that is already closing.
        }
      }

      if (pauseListener) {
        clearWakePulseTimer();
        setIsWakePulseActive(false);
        setWakeListenerState('paused');
      }
    };

    const scheduleRecognitionRestart = (delayMs: number) => {
      if (isDisposed || !shouldKeepRecognitionAliveRef.current) {
        return;
      }

      clearRestartTimer();
      setWakeListenerState('starting');
      restartTimerRef.current = window.setTimeout(() => {
        restartTimerRef.current = null;
        if (!isDisposed && shouldKeepRecognitionAliveRef.current) {
          startRecognitionRef.current();
        }
      }, delayMs);
    };

    const startRecognitionSession = () => {
      if (isDisposed || !shouldKeepRecognitionAliveRef.current) {
        return;
      }

      clearRestartTimer();
      stopRecognitionSession(false);
      setWakeListenerState('starting');

      let recognition: SpeechRecognitionInstance;
      try {
        recognition = new SpeechRecognitionCtor();
      } catch {
        setWakeListenerState('error');
        scheduleRecognitionRestart(1200);
        return;
      }

      recognition.continuous = true;
      recognition.interimResults = true;
      recognition.lang = 'de-DE';

      recognition.onstart = () => {
        if (isDisposed || !shouldKeepRecognitionAliveRef.current) {
          return;
        }

        setMicPermissionState('granted');
        setWakeListenerState('active');
      };

      recognition.onresult = (event) => {
        let transcript = '';
        let hasFinalResult = false;

        for (let index = event.resultIndex; index < event.results.length; index += 1) {
          transcript += `${event.results[index][0].transcript} `;
          if (event.results[index].isFinal) {
            hasFinalResult = true;
          }
        }

        const normalized = normalizeTranscript(transcript);
        if (!normalized) {
          return;
        }

        if (Date.now() < ignoreRecognitionUntilRef.current) {
          return;
        }

        if (matchesAnyPattern(normalized, SLEEP_PATTERNS)) {
          setIsOrbVisible(false);
          setIsSpeaking(false);
          setIsWakePulseActive(false);
          return;
        }

        if (isAddressedToAstra(normalized)) {
          setIsOrbVisible(true);
          pulseWakeVisual();
          setWakeListenerState('active');
        }

        if (hasFinalResult) {
          tryExecuteVoiceCommand(normalized);
        }
      };

      recognition.onerror = (event) => {
        if (recognitionRef.current === recognition) {
          recognitionRef.current = null;
        }

        if (isDisposed) {
          return;
        }

        const errorCode = typeof event.error === 'string' ? event.error : '';
        if (errorCode === 'not-allowed' || errorCode === 'service-not-allowed') {
          setMicPermissionState('denied');
        }

        if (!shouldKeepRecognitionAliveRef.current) {
          setWakeListenerState('paused');
          return;
        }

        setWakeListenerState('error');
        scheduleRecognitionRestart(errorCode === 'audio-capture' ? 1400 : 900);
      };

      recognition.onend = () => {
        if (recognitionRef.current === recognition) {
          recognitionRef.current = null;
        }

        if (isDisposed) {
          return;
        }

        if (!shouldKeepRecognitionAliveRef.current) {
          setWakeListenerState('paused');
          return;
        }

        scheduleRecognitionRestart(650);
      };

      recognitionRef.current = recognition;

      try {
        recognition.start();
      } catch {
        recognitionRef.current = null;
        detachRecognitionHandlers(recognition);
        setWakeListenerState('error');
        scheduleRecognitionRestart(1200);
      }
    };

    startRecognitionRef.current = startRecognitionSession;
    stopRecognitionRef.current = stopRecognitionSession;
    shouldKeepRecognitionAliveRef.current = true;
    startRecognitionSession();

    return () => {
      isDisposed = true;
      shouldKeepRecognitionAliveRef.current = false;
      clearRestartTimer();
      clearWakePulseTimer();
      stopRecognitionRef.current = () => {};
      startRecognitionRef.current = () => {};
      detachRecognitionHandlers(recognitionRef.current);
      recognitionRef.current?.stop();
      recognitionRef.current = null;
    };
  }, [speechRecognitionSupported]);

  const handleMuteToggle = () => {
    setIsMuted((current) => !current);
  };

  const handleVoiceToggle = () => {
    if (!speechRecognitionSupported) {
      setWakeListenerState('unsupported');
      return;
    }

    if (shouldKeepRecognitionAliveRef.current) {
      stopRecognitionRef.current(true);
      return;
    }

    shouldKeepRecognitionAliveRef.current = true;
    setWakeListenerState('starting');
    startRecognitionRef.current();
  };

  const handleChatOpen = async () => {
    setIsOrbVisible(true);
    await showMainWindow();
  };

  const handleSettingsOpen = async () => {
    setIsOrbVisible(true);
    await toggleMainWindow({ focusSettings: true });
  };

  return (
    <div className="overlay-root">
      <AIOrb
        isVisible={isOrbVisible || isSpeaking}
        isSpeaking={isSpeaking}
        isListening={isWakePulseActive}
        isMuted={isMuted}
        onMuteToggle={handleMuteToggle}
        onChatOpen={handleChatOpen}
        onVoiceToggle={handleVoiceToggle}
        onSettingsOpen={handleSettingsOpen}
      />
    </div>
  );
}
