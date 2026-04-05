import { useCallback, useMemo, useRef, useState } from 'react';

import type { AppSettings } from '../lib/voiceOverlay';
import i18n from '../i18n';
import type {
  SpeechRecognitionErrorLike,
  SpeechRecognitionEventLike,
  SpeechRecognitionLike,
} from '../lib/speechRecognition';
import { getSpeechRecognitionConstructor } from '../lib/speechRecognition';
import {
  buildCalibrationSteps,
  isAssistantCalibrationComplete,
  mapRecognitionLanguage,
  normalizeLanguageCode,
  type CalibrationStep,
} from '../lib/app/appModel';

type UseAssistantTrainingOptions = {
  settings: AppSettings;
  assistantNameError: string | null;
  isLiveTranscribing: boolean;
  stopLiveTranscription: () => Promise<void>;
  resumeLiveTranscription: () => void;
  onSettingsChange: (settings: AppSettings) => void;
  onMessage: (message: string) => void;
  onValidationError: (message: string) => void;
};

export type AssistantTrainingController = {
  assistantTrainingReadyName: string | null;
  assistantCalibrationSteps: CalibrationStep[];
  currentAssistantTrainingStep: CalibrationStep | null;
  showAssistantTrainingDialog: boolean;
  assistantTrainingTranscript: string;
  assistantTrainingCapturedTranscript: string;
  assistantTrainingStatus: string;
  assistantTrainingError: string;
  isAssistantTrainingRecording: boolean;
  openAssistantTrainingDialog: () => Promise<void>;
  closeAssistantTrainingDialog: () => void;
  startAssistantTrainingRecording: () => void;
  stopAssistantTrainingRecording: () => void;
  confirmAssistantTrainingStep: () => void;
  retryAssistantTrainingStep: () => void;
};

export function useAssistantTraining(
  options: UseAssistantTrainingOptions,
): AssistantTrainingController {
  const {
    settings,
    assistantNameError,
    isLiveTranscribing,
    stopLiveTranscription,
    resumeLiveTranscription,
    onSettingsChange,
    onMessage,
    onValidationError,
  } = options;

  const [showAssistantTrainingDialog, setShowAssistantTrainingDialog] = useState(false);
  const [assistantTrainingStepIndex, setAssistantTrainingStepIndex] = useState(0);
  const [assistantTrainingTranscript, setAssistantTrainingTranscript] = useState('');
  const [assistantTrainingCapturedTranscript, setAssistantTrainingCapturedTranscript] = useState('');
  const [assistantTrainingStatus, setAssistantTrainingStatus] = useState('');
  const [assistantTrainingError, setAssistantTrainingError] = useState('');
  const [assistantTrainingWakeSamples, setAssistantTrainingWakeSamples] = useState<string[]>([]);
  const [assistantTrainingNameSamples, setAssistantTrainingNameSamples] = useState<string[]>([]);
  const [isAssistantTrainingRecording, setIsAssistantTrainingRecording] = useState(false);
  const assistantTrainingReadyName = useMemo(
    () => (isAssistantCalibrationComplete(settings) ? settings.assistantName : null),
    [settings],
  );
  const assistantTrainingRecognitionRef = useRef<SpeechRecognitionLike | null>(null);
  const resumeLiveTranscriptionAfterTrainingRef = useRef(false);

  const assistantCalibrationSteps = useMemo(
    () => buildCalibrationSteps(settings.assistantName, settings.sttLanguage),
    [settings.assistantName, settings.sttLanguage],
  );
  const currentAssistantTrainingStep =
    assistantCalibrationSteps[assistantTrainingStepIndex] ?? null;

  const stopAssistantTrainingRecognition = useCallback((): void => {
    if (assistantTrainingRecognitionRef.current) {
      assistantTrainingRecognitionRef.current.stop();
      assistantTrainingRecognitionRef.current = null;
    }
    setIsAssistantTrainingRecording(false);
  }, []);

  const closeAssistantTrainingDialog = useCallback((): void => {
    const shouldResumeLiveTranscription = resumeLiveTranscriptionAfterTrainingRef.current;
    resumeLiveTranscriptionAfterTrainingRef.current = false;

    stopAssistantTrainingRecognition();
    setShowAssistantTrainingDialog(false);
    setAssistantTrainingTranscript('');
    setAssistantTrainingCapturedTranscript('');
    setAssistantTrainingStatus('');
    setAssistantTrainingError('');

    if (shouldResumeLiveTranscription) {
      window.setTimeout(() => {
        resumeLiveTranscription();
      }, 0);
    }
  }, [resumeLiveTranscription, stopAssistantTrainingRecognition]);

  const openAssistantTrainingDialog = useCallback(async (): Promise<void> => {
    if (assistantNameError) {
      onValidationError(assistantNameError);
      return;
    }

    resumeLiveTranscriptionAfterTrainingRef.current = isLiveTranscribing;
    if (isLiveTranscribing) {
      await stopLiveTranscription();
    }

    setAssistantTrainingStepIndex(0);
    setAssistantTrainingTranscript('');
    setAssistantTrainingCapturedTranscript('');
    setAssistantTrainingStatus(i18n.t('training.startHint'));
    setAssistantTrainingError('');
    setAssistantTrainingWakeSamples([]);
    setAssistantTrainingNameSamples([]);
    setShowAssistantTrainingDialog(true);
  }, [
    assistantNameError,
    isLiveTranscribing,
    onValidationError,
    stopLiveTranscription,
  ]);

  const startAssistantTrainingRecording = useCallback((): void => {
    const ctor = getSpeechRecognitionConstructor();

    if (!ctor || !currentAssistantTrainingStep) {
      setAssistantTrainingError(i18n.t('training.runtimeUnavailable'));
      return;
    }

    stopAssistantTrainingRecognition();
    setAssistantTrainingTranscript('');
    setAssistantTrainingCapturedTranscript('');
    setAssistantTrainingError('');
    setAssistantTrainingStatus(
      i18n.t('training.recording', { prompt: currentAssistantTrainingStep.prompt }),
    );

    const recognition = new ctor();
    recognition.continuous = true;
    recognition.interimResults = true;
    recognition.lang =
      currentAssistantTrainingStep.recognitionLanguage ||
      mapRecognitionLanguage(settings.sttLanguage);
    recognition.onresult = (event: SpeechRecognitionEventLike) => {
      let transcript = '';
      const startIndex = event.resultIndex ?? 0;
      for (let index = startIndex; index < event.results.length; index += 1) {
        transcript += event.results[index]?.[0]?.transcript ?? '';
      }
      setAssistantTrainingTranscript(transcript.trim());
    };
    recognition.onerror = (event: SpeechRecognitionErrorLike) => {
      setAssistantTrainingError(event.error ?? i18n.t('training.unknownRecognitionError'));
    };
    recognition.onend = () => {
      assistantTrainingRecognitionRef.current = null;
      setIsAssistantTrainingRecording(false);
    };

    assistantTrainingRecognitionRef.current = recognition;
    setIsAssistantTrainingRecording(true);
    recognition.start();
  }, [currentAssistantTrainingStep, settings.sttLanguage, stopAssistantTrainingRecognition]);

  const stopAssistantTrainingRecording = useCallback((): void => {
    stopAssistantTrainingRecognition();
    setAssistantTrainingCapturedTranscript(assistantTrainingTranscript.trim());
    setAssistantTrainingStatus(
      assistantTrainingTranscript.trim()
        ? i18n.t('training.recordingCaptured')
        : i18n.t('training.noTranscriptCaptured'),
    );
  }, [assistantTrainingTranscript, stopAssistantTrainingRecognition]);

  const confirmAssistantTrainingStep = useCallback((): void => {
    if (!currentAssistantTrainingStep || !assistantTrainingCapturedTranscript.trim()) {
      return;
    }

    const captured = assistantTrainingCapturedTranscript.trim();
    if (currentAssistantTrainingStep.target === 'wake') {
      setAssistantTrainingWakeSamples((current) => [...current, captured]);
    } else {
      setAssistantTrainingNameSamples((current) => [...current, captured]);
    }

    if (assistantTrainingStepIndex + 1 >= assistantCalibrationSteps.length) {
      const nextSettings: AppSettings = {
        ...settings,
        assistantWakeSamples: [
          ...assistantTrainingWakeSamples,
          ...(currentAssistantTrainingStep.target === 'wake' ? [captured] : []),
        ],
        assistantNameSamples: [
          ...assistantTrainingNameSamples,
          ...(currentAssistantTrainingStep.target === 'name' ? [captured] : []),
        ],
        assistantSampleLanguage: normalizeLanguageCode(settings.sttLanguage),
      };

      onSettingsChange(nextSettings);
      setAssistantTrainingStatus(
        i18n.t('training.completed'),
      );
      onMessage(i18n.t('training.capturedSaved'));
      closeAssistantTrainingDialog();
      return;
    }

    setAssistantTrainingStepIndex((current) => current + 1);
    setAssistantTrainingTranscript('');
    setAssistantTrainingCapturedTranscript('');
    setAssistantTrainingStatus(i18n.t('training.nextSample'));
  }, [
    assistantCalibrationSteps.length,
    assistantTrainingCapturedTranscript,
    assistantTrainingNameSamples,
    assistantTrainingStepIndex,
    assistantTrainingWakeSamples,
    closeAssistantTrainingDialog,
    currentAssistantTrainingStep,
    onMessage,
    onSettingsChange,
    settings,
  ]);

  const retryAssistantTrainingStep = useCallback((): void => {
    setAssistantTrainingTranscript('');
    setAssistantTrainingCapturedTranscript('');
    setAssistantTrainingError('');
    setAssistantTrainingStatus(i18n.t('training.retrySamePhrase'));
  }, []);

  return {
    assistantTrainingReadyName,
    assistantCalibrationSteps,
    currentAssistantTrainingStep,
    showAssistantTrainingDialog,
    assistantTrainingTranscript,
    assistantTrainingCapturedTranscript,
    assistantTrainingStatus,
    assistantTrainingError,
    isAssistantTrainingRecording,
    openAssistantTrainingDialog,
    closeAssistantTrainingDialog,
    startAssistantTrainingRecording,
    stopAssistantTrainingRecording,
    confirmAssistantTrainingStep,
    retryAssistantTrainingStep,
  };
}
