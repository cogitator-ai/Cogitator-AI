import { describe, it, expect } from 'vitest';
import { StreamWriter } from '../streaming/stream-writer.js';

function createTestStream() {
  const { readable, writable } = new TransformStream<Uint8Array>();
  const writer = writable.getWriter();

  const readAll = async () => {
    const decoder = new TextDecoder();
    const chunks: string[] = [];
    const reader = readable.getReader();
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(decoder.decode(value));
    }
    return chunks;
  };

  return { writer, readAll };
}

function parseSSEChunks(chunks: string[]) {
  const events: unknown[] = [];
  for (const chunk of chunks) {
    for (const line of chunk.split('\n')) {
      const trimmed = line.trim();
      if (trimmed.startsWith('data: ') && trimmed.slice(6) !== '[DONE]') {
        try {
          events.push(JSON.parse(trimmed.slice(6)));
        } catch {}
      }
    }
  }
  return events;
}

describe('StreamWriter', () => {
  it('writes start event', async () => {
    const { writer, readAll } = createTestStream();
    const sw = new StreamWriter(writer);
    const reading = readAll();

    await sw.start('msg_1');
    await sw.close();

    const chunks = await reading;
    const events = parseSSEChunks(chunks);
    expect(events).toContainEqual({ type: 'start', messageId: 'msg_1' });
  });

  it('writes text flow', async () => {
    const { writer, readAll } = createTestStream();
    const sw = new StreamWriter(writer);
    const reading = readAll();

    await sw.textStart('txt_1');
    await sw.textDelta('txt_1', 'Hello');
    await sw.textDelta('txt_1', ' world');
    await sw.textEnd('txt_1');
    await sw.close();

    const chunks = await reading;
    const events = parseSSEChunks(chunks);

    expect(events).toContainEqual({ type: 'text-start', id: 'txt_1' });
    expect(events).toContainEqual({ type: 'text-delta', id: 'txt_1', delta: 'Hello' });
    expect(events).toContainEqual({ type: 'text-delta', id: 'txt_1', delta: ' world' });
    expect(events).toContainEqual({ type: 'text-end', id: 'txt_1' });
  });

  it('skips empty text deltas', async () => {
    const { writer, readAll } = createTestStream();
    const sw = new StreamWriter(writer);
    const reading = readAll();

    await sw.textStart('txt_1');
    await sw.textDelta('txt_1', '');
    await sw.textDelta('txt_1', 'ok');
    await sw.textEnd('txt_1');
    await sw.close();

    const chunks = await reading;
    const events = parseSSEChunks(chunks);
    const deltas = events.filter((e) => (e as { type: string }).type === 'text-delta');
    expect(deltas).toHaveLength(1);
  });

  it('writes tool call flow', async () => {
    const { writer, readAll } = createTestStream();
    const sw = new StreamWriter(writer);
    const reading = readAll();

    await sw.toolCallStart('tc_1', 'search');
    await sw.toolCallDelta('tc_1', '{"q":"test"}');
    await sw.toolCallEnd('tc_1');
    await sw.toolResult('tr_1', 'tc_1', { found: true });
    await sw.close();

    const chunks = await reading;
    const events = parseSSEChunks(chunks);

    expect(events).toContainEqual({ type: 'tool-call-start', id: 'tc_1', toolName: 'search' });
    expect(events).toContainEqual({
      type: 'tool-call-delta',
      id: 'tc_1',
      argsTextDelta: '{"q":"test"}',
    });
    expect(events).toContainEqual({ type: 'tool-call-end', id: 'tc_1' });
    expect(events).toContainEqual({
      type: 'tool-result',
      id: 'tr_1',
      toolCallId: 'tc_1',
      result: { found: true },
    });
  });

  it('writes error event', async () => {
    const { writer, readAll } = createTestStream();
    const sw = new StreamWriter(writer);
    const reading = readAll();

    await sw.error('something broke', 'ERR_500');
    await sw.close();

    const chunks = await reading;
    const events = parseSSEChunks(chunks);
    expect(events).toContainEqual({ type: 'error', message: 'something broke', code: 'ERR_500' });
  });

  it('writes finish with [DONE]', async () => {
    const { writer, readAll } = createTestStream();
    const sw = new StreamWriter(writer);
    const reading = readAll();

    const usage = { inputTokens: 5, outputTokens: 10, totalTokens: 15 };
    await sw.finish('msg_1', usage);
    await sw.close();

    const chunks = await reading;
    const raw = chunks.join('');
    expect(raw).toContain('[DONE]');

    const events = parseSSEChunks(chunks);
    expect(events).toContainEqual({ type: 'finish', messageId: 'msg_1', usage });
  });

  it('ignores writes after close', async () => {
    const { writer, readAll } = createTestStream();
    const sw = new StreamWriter(writer);
    const reading = readAll();

    await sw.start('msg_1');
    await sw.close();

    await sw.textStart('txt_1');
    await sw.textDelta('txt_1', 'late');

    const chunks = await reading;
    const events = parseSSEChunks(chunks);
    expect(events).toHaveLength(1);
  });

  it('handles double close gracefully', async () => {
    const { writer, readAll } = createTestStream();
    const sw = new StreamWriter(writer);
    const reading = readAll();

    await sw.start('msg_1');
    await sw.close();
    await sw.close();

    const chunks = await reading;
    expect(chunks.length).toBeGreaterThan(0);
  });
});
