import { describe, it, expect, vi } from 'vitest';
import { cogitatorApp } from '../app.js';
import { createClientState, handleWebSocketMessage } from '../websocket/handler.js';
import type { CogitatorAppOptions, CogitatorContext } from '../types.js';

vi.mock('@cogitator-ai/swarms', () => ({
  Swarm: class {
    id = 'swarm_1';
    name = 'team';
    strategyType = 'round-robin';
    run = vi.fn().mockResolvedValue({ output: 'swarm-out', agentResults: new Map() });
    abort = vi.fn();
    getResourceUsage = () => ({
      totalTokens: 0,
      totalCost: 0,
      elapsedTime: 0,
      agentUsage: new Map(),
    });
  },
}));

function runResult(usage: Record<string, number> = {}) {
  return {
    output: 'done',
    threadId: 'thread-1',
    usage: { inputTokens: 1, outputTokens: 2, totalTokens: 3, cost: 0, duration: 1, ...usage },
    toolCalls: [],
  };
}

function buildApp(
  run = vi.fn().mockResolvedValue(runResult()),
  options: Partial<CogitatorAppOptions> = {}
) {
  const app = cogitatorApp({
    cogitator: { run } as unknown as CogitatorAppOptions['cogitator'],
    agents: { bot: { config: { instructions: 'x', tools: [] } } as never },
    swarms: { team: { strategy: 'round-robin' } as never },
    ...options,
  });
  return { app, run };
}

function post(body: unknown): RequestInit {
  return {
    method: 'POST',
    body: JSON.stringify(body),
    headers: { 'Content-Type': 'application/json' },
  };
}

describe('blank input', () => {
  it.each(['/agents/bot/run', '/agents/bot/stream', '/swarms/team/run', '/swarms/team/stream'])(
    'is refused on %s before the model is called',
    async (path) => {
      const { app, run } = buildApp();
      for (const input of ['', '   ', '\n\t ']) {
        const res = await app.request(path, post({ input }));
        expect(res.status).toBe(400);
        expect(await res.json()).toEqual({
          error: { message: 'Field "input" must not be blank', code: 'INVALID_INPUT' },
        });
      }
      expect(run).not.toHaveBeenCalled();
    }
  );

  it('is refused over the WebSocket too', async () => {
    const run = vi.fn();
    const sent: string[] = [];
    const ctx: CogitatorContext = {
      runtime: { run } as unknown as CogitatorContext['runtime'],
      agents: { bot: { config: { instructions: 'x', tools: [] } } as never },
      workflows: {},
      swarms: {},
    };
    await handleWebSocketMessage(
      { send: (data: string) => sent.push(data), readyState: 1 },
      JSON.stringify({
        type: 'run',
        id: 'r1',
        payload: { type: 'agent', name: 'bot', input: '  ' },
      }),
      ctx,
      createClientState()
    );
    expect(sent.map((message) => JSON.parse(message).error)).toEqual([
      'Invalid run payload: "input" is required',
    ]);
    expect(run).not.toHaveBeenCalled();
  });
});

describe('run usage', () => {
  it('passes the provider token counts through, like Tetsu and Next', async () => {
    const { app } = buildApp(
      vi
        .fn()
        .mockResolvedValue(
          runResult({ reasoningTokens: 5, cachedInputTokens: 4, cacheWriteTokens: 2 })
        )
    );
    const res = await app.request('/agents/bot/run', post({ input: 'hi' }));
    expect((await res.json()).usage).toEqual({
      inputTokens: 1,
      outputTokens: 2,
      totalTokens: 3,
      reasoningTokens: 5,
      cachedInputTokens: 4,
      cacheWriteTokens: 2,
    });
  });
});

describe('SSE heartbeat', () => {
  function slowRun(ms: number) {
    return vi.fn(() => new Promise((resolve) => setTimeout(() => resolve(runResult()), ms)));
  }

  it('writes comments while a run is silent, so idle timeouts do not cut the stream', async () => {
    const { app } = buildApp(slowRun(120), { sseHeartbeatMs: 20 });
    const res = await app.request('/agents/bot/stream', post({ input: 'hi' }));
    const text = await res.text();
    expect(text.match(/^: keep-alive$/gm)?.length).toBeGreaterThanOrEqual(3);
    expect(text.trimEnd().endsWith('data: [DONE]')).toBe(true);
  });

  it('writes none when turned off', async () => {
    const { app } = buildApp(slowRun(60), { sseHeartbeatMs: 0 });
    const res = await app.request('/agents/bot/stream', post({ input: 'hi' }));
    expect(await res.text()).not.toContain(': keep-alive');
  });

  it('refuses an invalid interval when the app is built', () => {
    expect(() => buildApp(undefined, { sseHeartbeatMs: -1 })).toThrow(RangeError);
  });
});

describe('Bun idle timeout', () => {
  function bunServer() {
    return { timeout: vi.fn(), requestIP: vi.fn(), upgrade: vi.fn() };
  }

  it.each(['/agents/bot/run', '/swarms/team/run'])(
    'is lifted for the JSON run on %s',
    async (path) => {
      const server = bunServer();
      const { app } = buildApp();
      const res = await app.request(path, post({ input: 'hi' }), server);
      expect(res.status).toBe(200);
      expect(server.timeout).toHaveBeenCalledWith(expect.any(Request), 0);
    }
  );

  it('is found under env.server as well', async () => {
    const server = bunServer();
    const { app } = buildApp();
    await app.request('/agents/bot/run', post({ input: 'hi' }), { server });
    expect(server.timeout).toHaveBeenCalledWith(expect.any(Request), 0);
  });

  it('is left alone for a refused request', async () => {
    const server = bunServer();
    const { app } = buildApp();
    await app.request('/agents/bot/run', post({ input: ' ' }), server);
    expect(server.timeout).not.toHaveBeenCalled();
  });

  it('does nothing outside Bun', async () => {
    const { app } = buildApp();
    const res = await app.request('/agents/bot/run', post({ input: 'hi' }), {
      incoming: {},
      outgoing: {},
    });
    expect(res.status).toBe(200);
  });
});
