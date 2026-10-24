import { describe, it, expect, vi, beforeEach, afterEach, onTestFinished } from 'vitest';
import express from 'express';
import type { Server } from 'http';
import type { AddressInfo } from 'net';
import { createLogger, getLogger, setLogger } from '@cogitator-ai/core';
import { CogitatorServer } from '../server.js';
import type { CogitatorServerConfig } from '../types.js';

const swarms = vi.hoisted(() => ({
  instances: [] as Array<{ close: () => Promise<void> }>,
  runs: [] as Array<{ timeout?: number }>,
  fail: false,
  error: undefined as Error | undefined,
}));

const workflows = vi.hoisted(() => ({
  executions: [] as Array<{ maxIterations?: number; maxConcurrency?: number }>,
}));

vi.mock('@cogitator-ai/swarms', () => ({
  Swarm: class {
    id = 'swarm_1';
    name = 'team';
    strategyType = 'round-robin';
    run = vi.fn(async (options: { timeout?: number }) => {
      swarms.runs.push(options);
      if (swarms.error) throw swarms.error;
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

vi.mock('@cogitator-ai/workflows', () => ({
  WorkflowExecutor: class {
    execute = vi.fn(
      async (
        _workflow: unknown,
        _input: unknown,
        options: (typeof workflows.executions)[number]
      ) => {
        workflows.executions.push(options);
        return {
          workflowId: 'wf_1',
          workflowName: 'flow',
          state: {},
          duration: 1,
          nodeResults: new Map(),
        };
      }
    );
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
    workflows: { flow: { name: 'flow', entryPoint: 'a', nodes: new Map() } as never },
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

  function afterHeartbeats(intervalMs: number, beats: number): Promise<void> {
    const realSetInterval = globalThis.setInterval;
    let ticks = 0;
    return new Promise((resolve) => {
      const spy = vi.spyOn(globalThis, 'setInterval').mockImplementation((callback, ms, ...args) =>
        ms === intervalMs
          ? realSetInterval(() => {
              callback(...args);
              if (++ticks === beats) resolve();
            }, ms)
          : realSetInterval(callback, ms, ...args)
      );
      onTestFinished(() => spy.mockRestore());
    });
  }

  it('writes comments while a run is silent, so proxies do not cut the stream', async () => {
    const heartbeats = afterHeartbeats(20, 3);
    const run = vi.fn(async () => {
      await heartbeats;
      return runResult();
    });
    const { base } = await start(run, { sseHeartbeatMs: 20 });
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

  it.each(['/swarms/team/run', '/swarms/team/stream'])(
    'ignores a multitask strategy in the body of %s, since a swarm has no thread queue',
    async (path) => {
      const { base } = await start();
      const res = await post(`${base}${path}`, { input: 'go', multitaskStrategy: 'queue' });
      await res.text();
      expect(res.status).toBe(200);
      expect(swarms.instances).toHaveLength(1);
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

describe('run limits', () => {
  const limits = { swarmTimeout: 5000, workflowMaxIterations: 10, workflowMaxConcurrency: 2 };

  beforeEach(() => {
    swarms.instances.length = 0;
    swarms.runs.length = 0;
    swarms.fail = false;
    swarms.error = undefined;
    workflows.executions.length = 0;
  });

  it.each(['/swarms/team/run', '/swarms/team/stream'])(
    'holds a swarm timeout to the limit and gives it to a swarm that asks for none on %s',
    async (path) => {
      const { base } = await start(undefined, { limits });
      await (await post(`${base}${path}`, { input: 'go', timeout: 60_000 })).text();
      await (await post(`${base}${path}`, { input: 'go', timeout: 1000 })).text();
      await (await post(`${base}${path}`, { input: 'go' })).text();
      expect(swarms.runs.map((options) => options.timeout)).toEqual([5000, 1000, 5000]);
    }
  );

  it('leaves the swarm timeout to the request without limits', async () => {
    const { base } = await start();
    await (await post(`${base}/swarms/team/run`, { input: 'go' })).text();
    expect(swarms.runs[0].timeout).toBeUndefined();
  });

  it.each(['/workflows/flow/run', '/workflows/flow/stream'])(
    'holds workflow iterations and concurrency to the limits on %s',
    async (path) => {
      const { base } = await start(undefined, { limits });
      await (
        await post(`${base}${path}`, { options: { maxIterations: 50, maxConcurrency: 1 } })
      ).text();
      await (await post(`${base}${path}`, {})).text();
      expect(workflows.executions).toMatchObject([
        { maxIterations: 10, maxConcurrency: 1 },
        { maxIterations: 10, maxConcurrency: 2 },
      ]);
    }
  );

  it('shows the limits in the OpenAPI spec as defaults, not maximums', async () => {
    const { base } = await start(undefined, { limits, enableSwagger: true });
    const spec = await (await fetch(`${base}/openapi.json`)).json();
    const options = spec.components.schemas.WorkflowRunRequest.properties.options.properties;
    expect(options.maxIterations).toMatchObject({ default: 10 });
    expect(options.maxIterations.maximum).toBeUndefined();
    expect(spec.components.schemas.SwarmRunRequest.properties.timeout.description).toContain(
      '5000 ms'
    );
  });

  it('refuses a limit that is not a positive integer when the server is built', () => {
    expect(
      () =>
        new CogitatorServer({
          app: express(),
          cogitator: {} as Cogitator,
          config: { limits: { workflowMaxIterations: 0 } },
        })
    ).toThrow('limits.workflowMaxIterations must be a positive integer');
  });
});

describe('swarm refusals', () => {
  beforeEach(() => {
    swarms.instances.length = 0;
    swarms.runs.length = 0;
    swarms.error = undefined;
  });

  it.each(['/swarms/team/run', '/swarms/team/stream'])(
    'refuses %s on a thread authorizeThread keeps the caller from, without building a swarm',
    async (path) => {
      const { base } = await start(undefined, {
        authorizeThread: (_auth, threadId) => threadId !== 'private',
      });
      const res = await post(`${base}${path}`, { input: 'go', threadId: 'private' });
      expect(res.status).toBe(403);
      expect(await res.json()).toEqual({
        error: { message: "Access to thread 'private' is not allowed", code: 'THREAD_FORBIDDEN' },
      });
      expect(swarms.instances).toHaveLength(0);
    }
  );

  it('answers a swarm that ran out of time with 504 RUN_TIMEOUT', async () => {
    swarms.error = Object.assign(new Error('Swarm timed out after 5000ms'), {
      name: 'SwarmTimeoutError',
    });
    const { base } = await start();
    const res = await post(`${base}/swarms/team/run`, { input: 'go' });
    expect(res.status).toBe(504);
    expect(await res.json()).toEqual({
      error: { message: 'Swarm timed out after 5000ms', code: 'RUN_TIMEOUT' },
    });
  });
});
