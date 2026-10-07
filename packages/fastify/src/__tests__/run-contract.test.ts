import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import type { AddressInfo } from 'net';
import { cogitatorPlugin } from '../plugin.js';
import type { CogitatorPluginOptions } from '../types.js';

const swarms = vi.hoisted(() => ({
  instances: [] as Array<{ close: () => Promise<void> }>,
  fail: false,
}));

vi.mock('@cogitator-ai/swarms', () => ({
  Swarm: class {
    id = 'swarm_1';
    name = 'team';
    strategyType = 'round-robin';
    run = vi.fn(async () => {
      if (swarms.fail) throw new Error('swarm failed');
      return { output: 'swarm-out', agentResults: new Map() };
    });
    abort = vi.fn();
    close = vi.fn(async () => undefined);
    getResourceUsage = () => ({
      totalTokens: 0,
      totalCost: 0,
      elapsedTime: 0,
      agentUsage: new Map(),
    });
    constructor() {
      swarms.instances.push(this);
    }
  },
}));

type Cogitator = CogitatorPluginOptions['cogitator'];

function runResult(usage: Record<string, number> = {}) {
  return {
    output: 'done',
    threadId: 'thread-1',
    usage: { inputTokens: 1, outputTokens: 2, totalTokens: 3, cost: 0, duration: 1, ...usage },
    toolCalls: [],
    trace: { traceId: 'trace-1', spans: [] },
  };
}

let app: FastifyInstance | undefined;

afterEach(async () => {
  await app?.close();
  app = undefined;
});

async function start(
  run = vi.fn().mockResolvedValue(runResult()),
  overrides: Partial<CogitatorPluginOptions> = {}
) {
  app = Fastify({ logger: false });
  await app.register(cogitatorPlugin, {
    cogitator: { run } as unknown as Cogitator,
    agents: { bot: { name: 'bot', config: { instructions: 'x', tools: [] } } as never },
    swarms: { team: { strategy: 'round-robin' } as never },
    prefix: '/api',
    ...overrides,
  });
  await app.listen({ port: 0, host: '127.0.0.1' });
  const { port } = app.server.address() as AddressInfo;
  return { run, base: `http://127.0.0.1:${port}/api` };
}

function post(url: string, body: unknown) {
  return fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

describe('blank input', () => {
  it.each(['/agents/bot/run', '/agents/bot/stream', '/swarms/team/run', '/swarms/team/stream'])(
    'is refused on %s before the model is called',
    async (path) => {
      const { base, run } = await start();
      for (const input of ['', '   ', '\n\t ']) {
        const res = await post(`${base}${path}`, { input });
        expect(res.status).toBe(400);
        expect((await res.json()).error.code).toBe('INVALID_INPUT');
      }
      expect(run).not.toHaveBeenCalled();
    }
  );
});

const detailedUsage = {
  inputTokens: 1,
  outputTokens: 2,
  totalTokens: 3,
  reasoningTokens: 5,
  cachedInputTokens: 4,
  cacheWriteTokens: 2,
};

function finishEvent(sse: string): unknown {
  return sse
    .split('\n')
    .filter((line) => line.startsWith('data: {'))
    .map((line) => JSON.parse(line.slice('data: '.length)) as { type: string })
    .find((event) => event.type === 'finish');
}

describe('run usage', () => {
  it('passes the provider token counts through, like Tetsu and Next', async () => {
    const { base } = await start(
      vi
        .fn()
        .mockResolvedValue(
          runResult({ reasoningTokens: 5, cachedInputTokens: 4, cacheWriteTokens: 2 })
        )
    );
    const res = await post(`${base}/agents/bot/run`, { input: 'hi' });
    expect((await res.json()).usage).toEqual({
      inputTokens: 1,
      outputTokens: 2,
      totalTokens: 3,
      reasoningTokens: 5,
      cachedInputTokens: 4,
      cacheWriteTokens: 2,
    });
  });

  it('ends a stream with a finish event carrying the same counts, without the cost', async () => {
    const { base } = await start(
      vi.fn().mockResolvedValue(runResult({ ...detailedUsage, cost: 0.5 }))
    );
    const text = await (await post(`${base}/agents/bot/stream`, { input: 'hi' })).text();
    expect(finishEvent(text)).toEqual({
      type: 'finish',
      messageId: expect.any(String),
      usage: detailedUsage,
      threadId: 'thread-1',
      status: 'completed',
    });
  });
});

describe('SSE heartbeat', () => {
  function slowRun(ms: number) {
    return vi.fn(() => new Promise((resolve) => setTimeout(() => resolve(runResult()), ms)));
  }

  it('writes comments while a run is silent, so proxies do not cut the stream', async () => {
    const { base } = await start(slowRun(120), { sseHeartbeatMs: 20 });
    const text = await (await post(`${base}/agents/bot/stream`, { input: 'hi' })).text();
    expect(text.match(/^: keep-alive$/gm)?.length).toBeGreaterThanOrEqual(3);
    expect(text.trimEnd().endsWith('data: [DONE]')).toBe(true);
  });

  it('writes none when turned off', async () => {
    const { base } = await start(slowRun(60), { sseHeartbeatMs: 0 });
    const text = await (await post(`${base}/agents/bot/stream`, { input: 'hi' })).text();
    expect(text).not.toContain(': keep-alive');
  });

  it('refuses an invalid interval when the plugin is registered', async () => {
    await expect(start(undefined, { sseHeartbeatMs: Number.NaN })).rejects.toThrow(RangeError);
  });
});

describe('swarm resources', () => {
  beforeEach(() => {
    swarms.instances.length = 0;
    swarms.fail = false;
  });

  it.each(['/swarms/team/run', '/swarms/team/stream'])(
    'closes the swarm a request built once %s is done',
    async (path) => {
      const { base } = await start();
      await (await post(`${base}${path}`, { input: 'go' })).text();
      expect(swarms.instances).toHaveLength(1);
      expect(swarms.instances[0].close).toHaveBeenCalledOnce();
    }
  );

  it('closes the swarm of a run that fails', async () => {
    swarms.fail = true;
    const { base } = await start();
    const res = await post(`${base}/swarms/team/run`, { input: 'go' });
    expect(res.status).toBe(500);
    expect(swarms.instances[0].close).toHaveBeenCalledOnce();
  });
});
