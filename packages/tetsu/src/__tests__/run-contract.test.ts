import { afterEach, describe, expect, test } from 'bun:test';
import { createApp, group } from '@tetsujs/core';
import { serve } from '@tetsujs/core/testing';
import { cogitatorController } from '../index.js';
import type { CogitatorDeps } from '../index.js';
import { chatAgent, fakeCogitator, json, runResult } from './helpers.js';

function app(deps: CogitatorDeps) {
  return createApp({
    routes: group('/cogitator', { children: [cogitatorController(deps)] }),
    reportError: () => {},
  });
}

function slowRun(ms: number) {
  return () =>
    new Promise<ReturnType<typeof runResult>>((resolve) => {
      setTimeout(() => resolve(runResult()), ms);
    });
}

describe('blank input', () => {
  const { cogitator, run } = fakeCogitator();
  const request = serve(app({ cogitator, agents: { chat: chatAgent() }, swarms: {} }));

  test.each(['/cogitator/agents/chat/run', '/cogitator/agents/chat/stream'])(
    'is refused on %s before the model is called',
    async (path) => {
      for (const input of ['', '   ', '\n\t ']) {
        const res = await request(path, json({ input }));
        expect(res.status).toBe(422);
        const body = (await res.json()) as { error: string; issues: Array<{ path: string[] }> };
        expect(body.error).toBe('VALIDATION_FAILED');
        expect(body.issues.map((issue) => issue.path.join('.'))).toEqual(['body.input']);
      }
      expect(run).not.toHaveBeenCalled();
    }
  );
});

describe('SSE heartbeat', () => {
  test('writes comments while a run is silent', async () => {
    const { cogitator } = fakeCogitator(slowRun(120));
    const request = serve(app({ cogitator, agents: { chat: chatAgent() }, sseHeartbeatMs: 20 }));
    const text = await (
      await request('/cogitator/agents/chat/stream', json({ input: 'hi' }))
    ).text();
    expect(text.match(/^:.*$/gm)?.length).toBeGreaterThanOrEqual(3);
    expect(text.trimEnd().endsWith('data: [DONE]')).toBe(true);
  });

  test('refuses an invalid interval when the controller is built', () => {
    const { cogitator } = fakeCogitator();
    expect(() => cogitatorController({ cogitator, sseHeartbeatMs: -1 })).toThrow(RangeError);
  });
});

/**
 * Bun checks idle timeouts on a 4 s tick and cuts at once below `idleTimeout: 5`, so the
 * server below cuts a connection silent for 8 s and the runs stay silent for 9.
 */
const IDLE_TIMEOUT_S = 5;
const SILENCE_MS = 9_000;

describe('the idle timeout of Bun.serve', () => {
  const servers: Array<{ stop(force?: boolean): Promise<void> }> = [];

  afterEach(async () => {
    for (const server of servers.splice(0)) await server.stop(true);
  });

  function listen(deps: CogitatorDeps): string {
    const server = Bun.serve({
      ...app(deps),
      port: 0,
      hostname: '127.0.0.1',
      idleTimeout: IDLE_TIMEOUT_S,
    });
    servers.push(server);
    return `http://127.0.0.1:${server.port}/cogitator`;
  }

  async function streamText(base: string): Promise<string> {
    const res = await fetch(`${base}/agents/chat/stream`, json({ input: 'hi' }));
    return res.text().catch(() => '');
  }

  test(
    'cuts neither a JSON run nor a stream that stays silent for longer',
    async () => {
      const { cogitator } = fakeCogitator(slowRun(SILENCE_MS));
      const agents = { chat: chatAgent() };
      const [run, stream, unguarded] = await Promise.all([
        fetch(`${listen({ cogitator, agents })}/agents/chat/run`, json({ input: 'hi' })).then(
          async (res) => ({ status: res.status, body: (await res.json()) as { output: string } })
        ),
        streamText(listen({ cogitator, agents, sseHeartbeatMs: 1_000 })),
        streamText(listen({ cogitator, agents, sseHeartbeatMs: 0 })),
      ]);

      expect(run).toEqual({
        status: 200,
        body: expect.objectContaining({ output: 'hello world' }),
      });
      expect(stream).toContain('"type":"finish"');
      expect(stream.trimEnd().endsWith('data: [DONE]')).toBe(true);
      expect(unguarded).not.toContain('"type":"finish"');
    },
    SILENCE_MS + 10_000
  );
});
