import type { StreamEvent } from '../streaming/protocol.js';

type LineResult = { done: true } | { done: false; event?: StreamEvent };

function parseLine(line: string): LineResult {
  const trimmed = line.trim();
  if (!trimmed || trimmed.startsWith(':') || !trimmed.startsWith('data:')) {
    return { done: false };
  }

  const data = trimmed.slice(5).trimStart();
  if (data === '[DONE]') return { done: true };

  try {
    return { done: false, event: JSON.parse(data) as StreamEvent };
  } catch {
    console.warn('[cogitator] Failed to parse SSE data:', data);
    return { done: false };
  }
}

export async function* parseSSEStream(
  reader: ReadableStreamDefaultReader<Uint8Array>
): AsyncGenerator<StreamEvent> {
  const decoder = new TextDecoder();
  let buffer = '';

  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;

    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split('\n');
    buffer = lines.pop() ?? '';

    for (const line of lines) {
      const result = parseLine(line);
      if (result.done) return;
      if (result.event) yield result.event;
    }
  }

  buffer += decoder.decode();
  for (const line of buffer.split('\n')) {
    const result = parseLine(line);
    if (result.done) return;
    if (result.event) yield result.event;
  }
}
