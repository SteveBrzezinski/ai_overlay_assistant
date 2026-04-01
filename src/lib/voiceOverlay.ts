import { invoke } from '@tauri-apps/api/core';
import { listen, type UnlistenFn } from '@tauri-apps/api/event';

export type CaptureOptions = {
  copyDelayMs?: number;
  restoreClipboard?: boolean;
};

export type SpeakOptions = {
  autoplay?: boolean;
  maxChunkChars?: number;
  maxParallelRequests?: number;
  model?: string;
  voice?: string;
};

export type TranslateOptions = {
  model?: string;
  sourceLanguage?: string;
  targetLanguage?: string;
};

export type AppSettings = {
  translationTargetLanguage: string;
  playbackSpeed: number;
  openaiApiKey: string;
  sttLanguage: string;
  assistantName: string;
  voiceAgentModel: string;
  voiceAgentVoice: string;
  voiceAgentPersonality: string;
  voiceAgentBehavior: string;
  voiceAgentExtraInstructions: string;
  voiceAgentPreferredLanguage: string;
  voiceAgentToneNotes: string;
  voiceAgentOnboardingComplete: boolean;
  assistantWakeSamples: string[];
  assistantCloseSamples: string[];
  assistantNameSamples: string[];
  assistantSampleLanguage: string;
  assistantWakeThreshold: number;
  assistantCloseThreshold: number;
  assistantCueCooldownMs: number;
};

export type LanguageOption = {
  code: string;
  label: string;
};

export type SttDebugEntry = {
  provider: string;
  transcript: string;
  latencyMs: number;
  ok: boolean;
  detail?: string | null;
};

export type AppendSttDebugLogResult = {
  debugLogPath: string;
};

export type VoiceAgentProfile = {
  name: string;
  voice: string;
  model: string;
  personality: string;
  behavior: string;
  extraInstructions: string;
};

export type VoiceAgentIdentity = {
  preferredLanguage: string;
  toneNotes: string;
};

export type VoiceAgentState = {
  profile: VoiceAgentProfile;
  identity: VoiceAgentIdentity;
  onboardingComplete: boolean;
  sourceAssistantName: string;
};

export type CreateVoiceAgentSessionResult = {
  clientSecret: string;
  profile: VoiceAgentProfile;
  assistantState: VoiceAgentState;
  bootstrapAction: string;
};

export type RunVoiceAgentToolResult = {
  ok: boolean;
  toolName: string;
  result: Record<string, unknown>;
};

export type VoiceTask = {
  id: string;
  taskType: string;
  payload: Record<string, unknown>;
  status: string;
  createdAtMs: number;
  updatedAtMs: number;
  result?: Record<string, unknown> | null;
};

export type VoiceTaskEvent = {
  task: VoiceTask;
};

export type CaptureAndSpeakResult = {
  capturedText: string;
  restoredClipboard: boolean;
  note?: string | null;
  speech: {
    autoplay: boolean;
    bytesWritten: number;
    chunkCount: number;
    filePath: string;
    format: string;
    model: string;
    mode: string;
    requestedMode: string;
    sessionId: string;
    sessionStrategy: string;
    fallbackReason?: string | null;
    supportsPersistentSession: boolean;
    outputDirectory: string;
    transportFormat: string;
    voice: string;
    firstAudioReceivedAtMs?: number | null;
    firstAudioPlaybackStartedAtMs?: number | null;
    startLatencyMs?: number | null;
  };
};

export type CaptureAndTranslateResult = {
  capturedText: string;
  restoredClipboard: boolean;
  note?: string | null;
  translation: {
    text: string;
    targetLanguage: string;
    sourceLanguage?: string | null;
    model: string;
  };
  speech: {
    autoplay: boolean;
    bytesWritten: number;
    chunkCount: number;
    filePath: string;
    format: string;
    model: string;
    mode: string;
    requestedMode: string;
    sessionId: string;
    sessionStrategy: string;
    fallbackReason?: string | null;
    supportsPersistentSession: boolean;
    outputDirectory: string;
    transportFormat: string;
    voice: string;
    firstAudioReceivedAtMs?: number | null;
    firstAudioPlaybackStartedAtMs?: number | null;
    startLatencyMs?: number | null;
  };
};

export type HotkeyStatus = {
  registered: boolean;
  accelerator: string;
  translateAccelerator: string;
  pauseResumeAccelerator: string;
  cancelAccelerator: string;
  activateAccelerator: string;
  deactivateAccelerator: string;
  platform: 'windows' | 'unsupported';
  state: 'idle' | 'registering' | 'working' | 'success' | 'error' | 'unsupported';
  message: string;
  lastAction?: string | null;
  lastCapturedText?: string | null;
  lastAudioPath?: string | null;
  lastAudioOutputDirectory?: string | null;
  lastAudioChunkCount?: number | null;
  activeTtsMode?: string | null;
  requestedTtsMode?: string | null;
  sessionStrategy?: string | null;
  sessionId?: string | null;
  sessionFallbackReason?: string | null;
  hotkeyStartedAtMs?: number | null;
  captureStartedAtMs?: number | null;
  captureFinishedAtMs?: number | null;
  ttsStartedAtMs?: number | null;
  firstAudioReceivedAtMs?: number | null;
  firstAudioPlaybackStartedAtMs?: number | null;
  startLatencyMs?: number | null;
  hotkeyToFirstAudioMs?: number | null;
  hotkeyToFirstPlaybackMs?: number | null;
  captureDurationMs?: number | null;
  captureToTtsStartMs?: number | null;
  ttsToFirstAudioMs?: number | null;
  firstAudioToPlaybackMs?: number | null;
  lastTranslationText?: string | null;
  lastTranslationTargetLanguage?: string | null;
  lastSttProvider?: string | null;
  lastSttDebugLogPath?: string | null;
  lastSttActiveTranscript?: string | null;
};

export type LiveSttControlEvent = {
  action: 'activate' | 'deactivate';
  source: string;
};

const HOTKEY_STATUS_EVENT = 'hotkey-status';
const LIVE_STT_CONTROL_EVENT = 'live-stt-control';
const VOICE_AGENT_TASK_EVENT = 'voice-agent-task';

export async function getAppStatus(): Promise<string> {
  return invoke<string>('app_status');
}

export async function getHotkeyStatus(): Promise<HotkeyStatus> {
  return invoke<HotkeyStatus>('get_hotkey_status');
}

export async function getSettings(): Promise<AppSettings> {
  return invoke<AppSettings>('get_settings');
}

export async function updateSettings(next: AppSettings): Promise<AppSettings> {
  return invoke<AppSettings>('update_settings', { next });
}

export async function resetSettings(): Promise<AppSettings> {
  return invoke<AppSettings>('reset_settings');
}

export async function getLanguageOptions(): Promise<LanguageOption[]> {
  return invoke<LanguageOption[]>('get_language_options');
}

export async function onHotkeyStatus(callback: (status: HotkeyStatus) => void): Promise<UnlistenFn> {
  return listen<HotkeyStatus>(HOTKEY_STATUS_EVENT, (event) => callback(event.payload));
}

export async function onLiveSttControl(callback: (event: LiveSttControlEvent) => void): Promise<UnlistenFn> {
  return listen<LiveSttControlEvent>(LIVE_STT_CONTROL_EVENT, (event) => callback(event.payload));
}

export async function onVoiceAgentTask(callback: (event: VoiceTaskEvent) => void): Promise<UnlistenFn> {
  return listen<VoiceTaskEvent>(VOICE_AGENT_TASK_EVENT, (event) => callback(event.payload));
}

export async function captureAndSpeak(
  captureOptions: CaptureOptions = {},
  speakOptions: SpeakOptions = {},
): Promise<CaptureAndSpeakResult> {
  return invoke<CaptureAndSpeakResult>('capture_and_speak_command', {
    captureOptions: {
      copyDelayMs: captureOptions.copyDelayMs,
      restoreClipboard: captureOptions.restoreClipboard,
    },
    speakOptions: {
      autoplay: speakOptions.autoplay ?? true,
      maxChunkChars: speakOptions.maxChunkChars,
      maxParallelRequests: speakOptions.maxParallelRequests,
      model: speakOptions.model,
      voice: speakOptions.voice ?? 'alloy',
    },
  });
}

export async function captureAndTranslate(
  captureOptions: CaptureOptions = {},
  translateOptions: TranslateOptions = {},
): Promise<CaptureAndTranslateResult> {
  return invoke<CaptureAndTranslateResult>('capture_and_translate_command', {
    captureOptions: {
      copyDelayMs: captureOptions.copyDelayMs,
      restoreClipboard: captureOptions.restoreClipboard,
    },
    translateOptions: {
      model: translateOptions.model,
      sourceLanguage: translateOptions.sourceLanguage,
      targetLanguage: translateOptions.targetLanguage,
    },
  });
}

export async function appendSttDebugLog(options: {
  sessionId: string;
  selectedProvider: string;
  activeTranscript: string;
  entries: SttDebugEntry[];
}): Promise<AppendSttDebugLogResult> {
  return invoke<AppendSttDebugLogResult>('append_stt_debug_log_command', {
    options: {
      sessionId: options.sessionId,
      selectedProvider: options.selectedProvider,
      activeTranscript: options.activeTranscript,
      entries: options.entries,
    },
  });
}

export async function createVoiceAgentSession(): Promise<CreateVoiceAgentSessionResult> {
  return invoke<CreateVoiceAgentSessionResult>('create_voice_agent_session_command');
}

export async function runVoiceAgentTool(
  toolName: string,
  args: Record<string, unknown>,
): Promise<RunVoiceAgentToolResult> {
  return invoke<RunVoiceAgentToolResult>('run_voice_agent_tool_command', {
    toolName,
    args,
  });
}

export async function getVoiceAgentTask(taskId: string): Promise<VoiceTask> {
  return invoke<VoiceTask>('get_voice_agent_task_command', { taskId });
}

export async function pauseResumeCurrentRun(): Promise<string> {
  return invoke<string>('pause_resume_current_run');
}

export async function cancelCurrentRun(): Promise<string> {
  return invoke<string>('cancel_current_run');
}
