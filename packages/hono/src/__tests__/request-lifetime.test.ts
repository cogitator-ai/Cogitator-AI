import { describe, it, expect, vi } from 'vitest';
import type { Agent, RunOptions } from '@cogitator-ai/types';
import { cogitatorApp, type CogitatorAppOptions } from '../index';

function collectGarbage(): void {
  const { gc } = globalThis as { gc?: () => void };
  if (!gc) throw new Error('Run with --expose-gc (see vitest.config.ts)');
  gc();
}

describe('request lifetime', () => {
  it('aborts a streamed run when the client goes away, even after the request is collected', async () => {
    let runSignal: AbortSignal | undefined;
    const run = vi.fn(
      (_agent: Agent, options: RunOptions) =>
        new Promise((_resolve, reject) => {
          runSignal = options.signal;
          options.signal?.addEventListener('abort', () => reject(new Error('Run aborted')));
        })
    );
    const app = cogitatorApp({
      cogitator: { run } as unknown as CogitatorAppOptions['cogitator'],
      agents: { bot: { config: { instructions: 'x', tools: [] } } as never },
    });
    const client = new AbortController();

    const res = await app.fetch(
      new Request('http://localhost/agents/bot/stream', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ input: 'hi' }),
        signal: client.signal,
      })
    );
    const text = res.text();
    await vi.waitFor(() => expect(runSignal).toBeDefined());
    collectGarbage();
    await new Promise((resolve) => setTimeout(resolve, 10));
    collectGarbage();
    client.abort();

    await vi.waitFor(() => expect(runSignal?.aborted).toBe(true));
    await text.catch(() => '');
  });
});
