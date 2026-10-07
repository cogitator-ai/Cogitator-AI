import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import express from 'express';
import type { Server } from 'http';
import type { AddressInfo } from 'net';
import { createLogger, getLogger, setLogger } from '@cogitator-ai/core';
import { CogitatorServer } from '../server.js';
import type { CogitatorServerConfig } from '../types.js';

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

type Cogitator = CogitatorServerConfig['cogitator'];
type Agent = NonNullable<CogitatorServerConfig['agents']>[string];

function runResult(usage: Record<string, number> = {}) {
  return {
    output: 'done',
    threadId: 'thread-1',
    usage: { inputTokens: 1, outputTokens: 2, totalTokens: 3, cost: 0, duration: 1, ...usage },
    toolCalls: [],
    trace: { traceId: 'trace-1', spans: [] },
  };
}

let server: Server | undefined;

afterEach(async () => {
  if (server) await new Promise<void>((resolve) => server!.close(() => resolve()));
  server = undefined;
  vi.restoreAllMocks();
});

async function start(
  run = vi.fn().mockResolvedValue(runResult()),
  config: CogitatorServerConfig['config'] = {}
) {
  const app = express();
  const cogitatorServer = new CogitatorServer({
    app,
    cogitator: { run } as unknown as Cogitator,
    agents: { bot: { name: 'bot', config: { instructions: 'x', tools: [] } } as unknown as Agent },
    swarms: { team: { strategy: 'round-robin' } as never },
    config: { basePath: '/api', enableSwagger: false, ...config },
  });
  await cogitatorServer.init();
  server = await new Promise<Server>((resolve) => {
    const listening = app.listen(0, () => resolve(listening));
  });
  const { port } = server.address() as AddressInfo;
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
        expect(await res.json()).toEqual({
          error: { message: 'Field "input" must not be blank', code: 'INVALID_INPUT' },
        });
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

  it('refuses an invalid interval when the server is built', () => {
    expect(
      () =>
        new CogitatorServer({
          app: express(),
          cogitator: {} as Cogitator,
          config: { sseHeartbeatMs: -5 },
        })
    ).toThrow(RangeError);
  });
});

describe('init', () => {
  it('writes nothing to the console', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const info = vi.spyOn(console, 'info').mockImplementation(() => {});
    await start();
    expect(log).not.toHaveBeenCalled();
    expect(info).not.toHaveBeenCalled();
  });

  it('reports to the core logger at debug level', async () => {
    const previous = getLogger();
    const logger = createLogger({ level: 'debug' });
    const debug = vi.spyOn(logger, 'debug').mockImplementation(() => {});
    setLogger(logger);
    try {
      await start();
    } finally {
      setLogger(previous);
    }
    expect(debug).toHaveBeenCalledWith('[CogitatorServer] Initialized', { basePath: '/api' });
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
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    swarms.fail = true;
    const { base } = await start();
    const res = await post(`${base}/swarms/team/run`, { input: 'go' });
    expect(res.status).toBe(500);
    expect(swarms.instances[0].close).toHaveBeenCalledOnce();
  });
});
