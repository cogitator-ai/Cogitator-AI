import { describe, it, expect, vi } from 'vitest';
import Koa from 'koa';
import request from 'supertest';
import { cogitatorApp } from '../app.js';
import type { CogitatorAppOptions, CogitatorState } from '../types.js';

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
  const app = new Koa<CogitatorState>();
  const router = cogitatorApp({
    cogitator: { run } as unknown as CogitatorAppOptions['cogitator'],
    agents: { bot: { config: { instructions: 'x', tools: [] } } as never },
    swarms: { team: { strategy: 'round-robin' } as never },
    ...options,
  });
  app.use(router.routes());
  app.use(router.allowedMethods());
  return { app, run };
}

describe('blank input', () => {
  it.each(['/agents/bot/run', '/agents/bot/stream', '/swarms/team/run', '/swarms/team/stream'])(
    'is refused on %s before the model is called',
    async (path) => {
      const { app, run } = buildApp();
      for (const input of ['', '   ', '\n\t ']) {
        const res = await request(app.callback()).post(path).send({ input });
        expect(res.status).toBe(400);
        expect(res.body).toEqual({
          error: { message: 'Field "input" must not be blank', code: 'INVALID_INPUT' },
        });
      }
      expect(run).not.toHaveBeenCalled();
    }
  );
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
    const res = await request(app.callback()).post('/agents/bot/run').send({ input: 'hi' });
    expect(res.body.usage).toEqual({
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

  it('writes comments while a run is silent, so proxies do not cut the stream', async () => {
    const { app } = buildApp(slowRun(120), { sseHeartbeatMs: 20 });
    const res = await request(app.callback()).post('/agents/bot/stream').send({ input: 'hi' });
    expect(res.text.match(/^: keep-alive$/gm)?.length).toBeGreaterThanOrEqual(3);
    expect(res.text.trimEnd().endsWith('data: [DONE]')).toBe(true);
  });

  it('writes none when turned off', async () => {
    const { app } = buildApp(slowRun(60), { sseHeartbeatMs: 0 });
    const res = await request(app.callback()).post('/agents/bot/stream').send({ input: 'hi' });
    expect(res.text).not.toContain(': keep-alive');
  });

  it('refuses an invalid interval when the router is built', () => {
    expect(() => buildApp(undefined, { sseHeartbeatMs: 1.5 })).toThrow(RangeError);
  });
});
