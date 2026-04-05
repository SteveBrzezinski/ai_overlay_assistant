import type { VoiceTask } from './voiceOverlay.js';

const MAX_MEMORY_ITEMS = 32;

export type ToolCallItem = {
  name: string;
  arguments?: string;
  call_id: string;
};

type PersistedVoiceSessionMemory = {
  disconnectReason: string;
  userTranscripts: string[];
  assistantTranscripts: string[];
  toolEvents: string[];
  taskEvents: string[];
};

export class SessionMemoryTracker {
  private userTranscripts: string[] = [];
  private assistantTranscripts: string[] = [];
  private toolEvents: string[] = [];
  private taskEvents: string[] = [];

  reset(): void {
    this.userTranscripts = [];
    this.assistantTranscripts = [];
    this.toolEvents = [];
    this.taskEvents = [];
  }

  rememberExternalUserTranscript(transcript: string): void {
    this.rememberUserTranscript(transcript);
  }

  rememberToolEvent(text: string | null | undefined): void {
    this.rememberLine(this.toolEvents, text);
  }

  rememberTaskEvent(text: string | null | undefined): void {
    this.rememberLine(this.taskEvents, text);
  }

  captureMemoryFromEvent(event: Record<string, unknown>): void {
    const eventType = typeof event.type === 'string' ? event.type : '';

    if (eventType === 'conversation.item.input_audio_transcription.completed') {
      this.rememberUserTranscript(
        firstString(event.transcript, asRecord(event.item)?.transcript, asRecord(event.item)?.text),
      );
      return;
    }

    if (eventType === 'response.audio_transcript.done' || eventType === 'response.audio_transcript.delta') {
      this.rememberAssistantTranscript(firstString(event.transcript, event.delta, event.text));
      return;
    }

    if (eventType === 'conversation.item.created' || eventType === 'response.output_item.done') {
      this.captureTextsFromItem(event.item);
      return;
    }

    if (eventType === 'response.done') {
      const responseRecord = asRecord(event.response);
      const output = Array.isArray(responseRecord?.output) ? responseRecord.output : [];
      for (const item of output) {
        this.captureTextsFromItem(item);
      }
    }
  }

  buildPersistPayload(reason: string): PersistedVoiceSessionMemory | null {
    const hasMaterial =
      this.userTranscripts.length ||
      this.assistantTranscripts.length ||
      this.toolEvents.length ||
      this.taskEvents.length;
    if (!hasMaterial) {
      return null;
    }

    return {
      disconnectReason: reason,
      userTranscripts: [...this.userTranscripts],
      assistantTranscripts: [...this.assistantTranscripts],
      toolEvents: [...this.toolEvents],
      taskEvents: [...this.taskEvents],
    };
  }

  describeToolRequest(toolName: string, args: Record<string, unknown>): string {
    return `Tool ${toolName} requested: ${safeJson(args)}`;
  }

  describeToolResult(toolName: string, result: Record<string, unknown>): string {
    const parts = [
      typeof result.message === 'string' ? result.message : '',
      typeof result.question === 'string' ? result.question : '',
      typeof result.path === 'string' ? `Path: ${result.path}` : '',
      typeof result.taskId === 'string' ? `Task: ${result.taskId}` : '',
      typeof result.status === 'string' ? `Status: ${result.status}` : '',
    ].filter(Boolean);

    if (!parts.length) {
      parts.push(safeJson(result));
    }

    return `Tool ${toolName} result: ${parts.join(' | ')}`;
  }

  describeTask(task: VoiceTask): string {
    const result = task.result ?? {};
    const parts = [
      `Task ${task.id}`,
      task.taskType,
      task.status,
      typeof result.message === 'string' ? result.message : '',
      typeof result.question === 'string' ? result.question : '',
      typeof result.path === 'string' ? `Path: ${result.path}` : '',
    ].filter(Boolean);
    return parts.join(' | ');
  }

  private captureTextsFromItem(item: unknown): void {
    const record = asRecord(item);
    if (!record) {
      return;
    }

    const role = typeof record.role === 'string' ? record.role : '';
    const texts = collectMessageTexts(record);
    if (!texts.length) {
      return;
    }

    if (role === 'assistant') {
      texts.forEach((text) => this.rememberAssistantTranscript(text));
      return;
    }

    if (role === 'user') {
      texts.forEach((text) => this.rememberUserTranscript(text));
    }
  }

  private rememberUserTranscript(text: string | null | undefined): void {
    this.rememberLine(this.userTranscripts, text);
  }

  private rememberAssistantTranscript(text: string | null | undefined): void {
    this.rememberLine(this.assistantTranscripts, text);
  }

  private rememberLine(target: string[], text: string | null | undefined): void {
    const normalized = normalizeMemoryText(text);
    if (!normalized || normalized.startsWith('SYSTEM_EVENT:')) {
      return;
    }

    const existingIndex = target.indexOf(normalized);
    if (existingIndex >= 0) {
      target.splice(existingIndex, 1);
    }

    target.push(normalized);
    if (target.length > MAX_MEMORY_ITEMS) {
      target.splice(0, target.length - MAX_MEMORY_ITEMS);
    }
  }
}

export function normalizeMemoryText(text: string | null | undefined): string {
  if (typeof text !== 'string') {
    return '';
  }

  const normalized = text.replace(/\s+/g, ' ').trim();
  if (!normalized) {
    return '';
  }

  return normalized.length > 500 ? `${normalized.slice(0, 497)}...` : normalized;
}

export function safeJson(value: unknown): string {
  const raw = JSON.stringify(value);
  if (!raw) {
    return '';
  }

  return raw.length > 500 ? `${raw.slice(0, 497)}...` : raw;
}

export function firstString(...values: unknown[]): string {
  for (const value of values) {
    if (typeof value === 'string' && value.trim()) {
      return value;
    }
  }

  return '';
}

export function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return null;
  }

  return value as Record<string, unknown>;
}

export function collectMessageTexts(item: Record<string, unknown>): string[] {
  const texts: string[] = [];
  const content = Array.isArray(item.content) ? item.content : [];
  for (const contentItem of content) {
    const contentRecord = asRecord(contentItem);
    if (!contentRecord) {
      continue;
    }

    const contentType = typeof contentRecord.type === 'string' ? contentRecord.type : '';
    if (
      contentType === 'input_text' ||
      contentType === 'text' ||
      contentType === 'output_text' ||
      contentType === 'audio'
    ) {
      const text = firstString(contentRecord.transcript, contentRecord.text);
      if (text) {
        texts.push(text);
      }
    }
  }

  if (!texts.length) {
    const direct = firstString(item.transcript, item.text);
    if (direct) {
      texts.push(direct);
    }
  }

  return texts.map((text) => normalizeMemoryText(text)).filter(Boolean);
}

export function isToolCallItem(value: unknown): value is ToolCallItem {
  const record = asRecord(value);
  return Boolean(
    record &&
      record.type === 'function_call' &&
      typeof record.name === 'string' &&
      typeof record.call_id === 'string',
  );
}
