import type { StreamEvent } from '../streaming/protocol.js';

export async function* parseSSEStream(
  reader: ReadableStreamDefaultReader<Uint8Array>
): AsyncGenerator<StreamEvent> {
  const decoder = new TextDecoder();
  let buffer = '';

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;

    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split('\n');
    buffer = lines.pop() ?? '';

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith(':')) continue;

      if (trimmed.startsWith('data: ')) {
        const data = trimmed.slice(6);
        if (data === '[DONE]') return;

        try {
          yield JSON.parse(data) as StreamEvent;
        } catch {}
      }
    }
  }

  if (buffer.trim()) {
    const trimmed = buffer.trim();
    if (trimmed.startsWith('data: ')) {
      const data = trimmed.slice(6);
      if (data !== '[DONE]') {
        try {
          yield JSON.parse(data) as StreamEvent;
        } catch {}
      }
    }
  }
}
