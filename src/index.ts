#!/usr/bin/env node
import { createTtsService, loadTtsEnv } from './lib/ttsService.js';

function getArg(flag: string): string | undefined {
  const index = process.argv.indexOf(flag);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

async function main(): Promise<void> {
  const text = getArg('--text') ?? process.argv.slice(2).filter((arg) => !arg.startsWith('--')).join(' ').trim();

  if (!text) {
    throw new Error('Usage: npm run tts -- --text "Hello from OpenAI TTS"');
  }

  loadTtsEnv(getArg('--env') ?? '.env');

  const service = createTtsService({
    autoplay: getArg('--no-play') ? false : true,
  });

  const result = await service.speakText({
    text,
    voice: (getArg('--voice') as never) ?? 'alloy',
    format: (getArg('--format') as never) ?? 'wav',
    fileName: getArg('--file-name'),
    outputDir: getArg('--output-dir'),
    autoplay: getArg('--no-play') ? false : true,
  });

  console.debug(`Saved speech to ${result.filePath}`);
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`TTS failed: ${message}`);
  process.exitCode = 1;
});
