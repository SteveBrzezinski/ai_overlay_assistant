import OpenAI from 'openai';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';

export type TtsVoice = 'alloy' | 'ash' | 'ballad' | 'coral' | 'echo' | 'fable' | 'nova' | 'onyx' | 'sage' | 'shimmer';
export type TtsFormat = 'mp3' | 'wav';

export interface GenerateSpeechOptions {
  text: string;
  voice?: TtsVoice;
  model?: string;
  format?: TtsFormat;
  outputDir?: string;
  fileName?: string;
}

export interface SpeechFileResult {
  filePath: string;
  bytesWritten: number;
  mimeType: string;
  voice: TtsVoice;
  model: string;
  format: TtsFormat;
}

const DEFAULT_MODEL = 'gpt-4o-mini-tts';
const DEFAULT_VOICE: TtsVoice = 'shimmer';
const DEFAULT_FORMAT: TtsFormat = 'mp3';

function getClient(): OpenAI {
  const apiKey = process.env.OPENAI_API_KEY;

  if (!apiKey) {
    throw new Error('OPENAI_API_KEY is missing. Load your .env before calling the TTS service.');
  }

  return new OpenAI({ apiKey });
}

function sanitizeBaseName(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9-_]+/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '') || 'speech';
}

function buildOutputPath(outputDir?: string, fileName?: string, format: TtsFormat = DEFAULT_FORMAT): string {
  const baseDir = resolve(outputDir ?? join(tmpdir(), 'voice-overlay-assistant', 'tts-output'));
  const safeName = sanitizeBaseName(fileName ?? `speech-${Date.now()}`);

  return join(baseDir, `${safeName}.${format}`);
}

export async function generateSpeechFile(options: GenerateSpeechOptions): Promise<SpeechFileResult> {
  const text = options.text.trim();

  if (!text) {
    throw new Error('Text is empty. Provide some text to synthesize.');
  }

  const voice = options.voice ?? DEFAULT_VOICE;
  const model = options.model ?? DEFAULT_MODEL;
  const format = options.format ?? DEFAULT_FORMAT;
  const filePath = buildOutputPath(options.outputDir, options.fileName, format);

  await mkdir(dirname(filePath), { recursive: true });

  const client = getClient();
  const response = await client.audio.speech.create({
    model,
    voice,
    input: text,
    response_format: format,
  });

  const buffer = Buffer.from(await response.arrayBuffer());
  await writeFile(filePath, buffer);

  return {
    filePath,
    bytesWritten: buffer.byteLength,
    mimeType: format === 'wav' ? 'audio/wav' : 'audio/mpeg',
    voice,
    model,
    format,
  };
}
