import { config as loadEnv } from 'dotenv';
import { resolve } from 'node:path';
import { NoopAudioPlayer, ShellAudioPlayer, type AudioPlayer } from './audioPlayer.js';
import { generateSpeechFile, type GenerateSpeechOptions, type SpeechFileResult } from './openaiTts.js';

export interface SpeakTextOptions extends GenerateSpeechOptions {
  autoplay?: boolean;
}

export interface TtsService {
  speakText(options: SpeakTextOptions): Promise<SpeechFileResult>;
}

export class OpenAITtsService implements TtsService {
  constructor(private readonly audioPlayer: AudioPlayer = new ShellAudioPlayer()) {}

  async speakText(options: SpeakTextOptions): Promise<SpeechFileResult> {
    const result = await generateSpeechFile(options);

    if (options.autoplay ?? true) {
      await this.audioPlayer.play(result.filePath);
    }

    return result;
  }
}

export interface TtsRuntimeOptions {
  envPath?: string;
  autoplay?: boolean;
}

export function loadTtsEnv(envPath = '.env'): void {
  loadEnv({ path: resolve(envPath), override: false });
}

export function createTtsService(options?: TtsRuntimeOptions): TtsService {
  if (options?.envPath) {
    loadTtsEnv(options.envPath);
  }

  const player = options?.autoplay === false ? new NoopAudioPlayer() : new ShellAudioPlayer();
  return new OpenAITtsService(player);
}
