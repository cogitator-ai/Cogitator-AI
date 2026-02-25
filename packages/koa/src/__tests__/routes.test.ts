import { describe, it, expect, vi, beforeEach } from 'vitest';
import Koa from 'koa';
import request from 'supertest';
import { cogitatorApp } from '../app.js';
import type { CogitatorAppOptions, CogitatorState } from '../types.js';

function mockTool(name: string) {
  return {
    name,
    description: `Tool ${name}`,
    parameters: { type: 'object', properties: { q: { type: 'string' } }, required: ['q'] },
  };
}

function mockAgent(name: string, tools: unknown[] = []) {
  return {
    name,
    config: {
      instructions: `Instructions for ${name}`,
      tools,
    },
  };
}

function mockRuntime(overrides?: { run?: unknown; memory?: unknown }) {
  return {
    run: vi.fn().mockResolvedValue({
      output: 'hello world',
      threadId: 'thread-1',
      usage: { inputTokens: 10, outputTokens: 20, totalTokens: 30 },
      toolCalls: [],
    }),
    memory: undefined,
    ...overrides,
  };
}

function mockMemory(entries: Array<{ message: unknown; createdAt: Date }> = []) {
  return {
    getEntries: vi.fn().mockResolvedValue({ success: true, data: entries }),
    addEntry: vi.fn().mockResolvedValue({ success: true, data: {} }),
    clearThread: vi.fn().mockResolvedValue({ success: true }),
  };
}

function buildApp(overrides: Partial<CogitatorAppOptions> = {}) {
  const app = new Koa<CogitatorState>();
  const router = cogitatorApp({
    cogitator: mockRuntime() as unknown as CogitatorAppOptions['cogitator'],
    agents: {},
    workflows: {},
    swarms: {},
    ...overrides,
  });
  app.use(router.routes());
  app.use(router.allowedMethods());
  return app;
}

describe('healthRoutes', () => {
  let app: Koa<CogitatorState>;

  beforeEach(() => {
    app = buildApp();
  });

  it('GET /health returns ok status', async () => {
    const res = await request(app.callback()).get('/health');
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('ok');
    expect(res.body.uptime).toBeGreaterThanOrEqual(0);
    expect(res.body.timestamp).toBeGreaterThan(0);
  });

  it('GET /ready returns ok', async () => {
    const res = await request(app.callback()).get('/ready');
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('ok');
  });
});

describe('agentRoutes', () => {
  it('GET /agents returns empty list when no agents', async () => {
    const app = buildApp({ agents: {} });
    const res = await request(app.callback()).get('/agents');
    expect(res.status).toBe(200);
    expect(res.body.agents).toEqual([]);
  });

  it('GET /agents lists registered agents with tools', async () => {
    const app = buildApp({
      agents: {
        writer: mockAgent('writer', [mockTool('search')]) as never,
      },
    });
    const res = await request(app.callback()).get('/agents');
    expect(res.status).toBe(200);
    expect(res.body.agents).toHaveLength(1);
    expect(res.body.agents[0].name).toBe('writer');
    expect(res.body.agents[0].tools).toEqual(['search']);
  });

  it('GET /agents truncates instructions to 100 chars', async () => {
    const longInstructions = 'A'.repeat(200);
    const agent = { config: { instructions: longInstructions, tools: [] } };
    const app = buildApp({ agents: { long: agent as never } });
    const res = await request(app.callback()).get('/agents');
    expect(res.body.agents[0].description).toHaveLength(100);
  });

  it('GET /agents handles agent with no tools', async () => {
    const app = buildApp({
      agents: { bare: mockAgent('bare') as never },
    });
    const res = await request(app.callback()).get('/agents');
    expect(res.body.agents[0].tools).toEqual([]);
  });

  it('POST /agents/:name/run returns 404 for unknown agent', async () => {
    const app = buildApp();
    const res = await request(app.callback())
      .post('/agents/ghost/run')
      .send({ input: 'hi' })
      .set('Content-Type', 'application/json');
    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe('NOT_FOUND');
    expect(res.body.error.message).toContain('ghost');
  });

  it('POST /agents/:name/run returns 400 when input is missing', async () => {
    const app = buildApp({
      agents: { bot: mockAgent('bot') as never },
    });
    const res = await request(app.callback())
      .post('/agents/bot/run')
      .send({})
      .set('Content-Type', 'application/json');
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('INVALID_INPUT');
    expect(res.body.error.message).toContain('input');
  });

  it('POST /agents/:name/run returns 400 for invalid JSON', async () => {
    const app = buildApp({
      agents: { bot: mockAgent('bot') as never },
    });
    const res = await request(app.callback())
      .post('/agents/bot/run')
      .send('not json{{{')
      .set('Content-Type', 'application/json');
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('INVALID_INPUT');
  });

  it('POST /agents/:name/run returns agent output on success', async () => {
    const runResult = {
      output: 'response text',
      threadId: 'thread-42',
      usage: { inputTokens: 5, outputTokens: 10, totalTokens: 15 },
      toolCalls: [{ name: 'search', arguments: { q: 'test' } }],
    };
    const runtime = mockRuntime({ run: vi.fn().mockResolvedValue(runResult) });
    const app = buildApp({
      cogitator: runtime as unknown as CogitatorAppOptions['cogitator'],
      agents: { bot: mockAgent('bot') as never },
    });

    const res = await request(app.callback())
      .post('/agents/bot/run')
      .send({ input: 'hello' })
      .set('Content-Type', 'application/json');
    expect(res.status).toBe(200);
    expect(res.body.output).toBe('response text');
    expect(res.body.threadId).toBe('thread-42');
    expect(res.body.usage.totalTokens).toBe(15);
    expect(res.body.toolCalls).toHaveLength(1);
  });

  it('POST /agents/:name/run forwards context and threadId', async () => {
    const run = vi.fn().mockResolvedValue({
      output: 'ok',
      threadId: 't1',
      usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
      toolCalls: [],
    });
    const runtime = mockRuntime({ run });
    const app = buildApp({
      cogitator: runtime as unknown as CogitatorAppOptions['cogitator'],
      agents: { bot: mockAgent('bot') as never },
    });

    await request(app.callback())
      .post('/agents/bot/run')
      .send({ input: 'hi', context: { key: 'val' }, threadId: 'my-thread' })
      .set('Content-Type', 'application/json');

    expect(run).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        input: 'hi',
        context: { key: 'val' },
        threadId: 'my-thread',
      })
    );
  });

  it('POST /agents/:name/run returns 500 on runtime error', async () => {
    const runtime = mockRuntime({
      run: vi.fn().mockRejectedValue(new Error('model unavailable')),
    });
    const app = buildApp({
      cogitator: runtime as unknown as CogitatorAppOptions['cogitator'],
      agents: { bot: mockAgent('bot') as never },
    });

    const res = await request(app.callback())
      .post('/agents/bot/run')
      .send({ input: 'hi' })
      .set('Content-Type', 'application/json');
    expect(res.status).toBe(500);
    expect(res.body.error.code).toBe('INTERNAL');
    expect(res.body.error.message).toBe('model unavailable');
  });

  it('POST /agents/:name/run returns Unknown error for non-Error throws', async () => {
    const runtime = mockRuntime({
      run: vi.fn().mockRejectedValue('string error'),
    });
    const app = buildApp({
      cogitator: runtime as unknown as CogitatorAppOptions['cogitator'],
      agents: { bot: mockAgent('bot') as never },
    });

    const res = await request(app.callback())
      .post('/agents/bot/run')
      .send({ input: 'hi' })
      .set('Content-Type', 'application/json');
    expect(res.status).toBe(500);
    expect(res.body.error.message).toBe('Unknown error');
  });
});

describe('threadRoutes', () => {
  it('GET /threads/:id returns 503 when memory not configured', async () => {
    const app = buildApp();
    const res = await request(app.callback()).get('/threads/t1');
    expect(res.status).toBe(503);
    expect(res.body.error.code).toBe('UNAVAILABLE');
    expect(res.body.error.message).toContain('Memory not configured');
  });

  it('GET /threads/:id returns thread with messages', async () => {
    const createdAt = new Date('2025-01-01T00:00:00Z');
    const updatedAt = new Date('2025-06-01T00:00:00Z');
    const entries = [
      { message: { role: 'user', content: 'hello' }, createdAt },
      { message: { role: 'assistant', content: 'hi' }, createdAt: updatedAt },
    ];
    const memory = mockMemory(entries);
    const runtime = mockRuntime({ memory });
    const app = buildApp({
      cogitator: runtime as unknown as CogitatorAppOptions['cogitator'],
    });

    const res = await request(app.callback()).get('/threads/t1');
    expect(res.status).toBe(200);
    expect(res.body.id).toBe('t1');
    expect(res.body.messages).toHaveLength(2);
    expect(res.body.messages[0]).toEqual({ role: 'user', content: 'hello' });
    expect(res.body.createdAt).toBe(createdAt.getTime());
    expect(res.body.updatedAt).toBe(updatedAt.getTime());
  });

  it('GET /threads/:id uses Date.now() for empty thread', async () => {
    const memory = mockMemory([]);
    const runtime = mockRuntime({ memory });
    const app = buildApp({
      cogitator: runtime as unknown as CogitatorAppOptions['cogitator'],
    });

    const before = Date.now();
    const res = await request(app.callback()).get('/threads/empty');
    const after = Date.now();
    expect(res.status).toBe(200);
    expect(res.body.createdAt).toBeGreaterThanOrEqual(before);
    expect(res.body.createdAt).toBeLessThanOrEqual(after);
    expect(res.body.updatedAt).toBeGreaterThanOrEqual(before);
    expect(res.body.updatedAt).toBeLessThanOrEqual(after);
  });

  it('GET /threads/:id returns 500 when getEntries fails', async () => {
    const memory = {
      getEntries: vi.fn().mockResolvedValue({ success: false, error: 'disk full' }),
    };
    const runtime = mockRuntime({ memory });
    const app = buildApp({
      cogitator: runtime as unknown as CogitatorAppOptions['cogitator'],
    });

    const res = await request(app.callback()).get('/threads/t1');
    expect(res.status).toBe(500);
    expect(res.body.error.message).toBe('disk full');
  });

  it('GET /threads/:id returns 500 on thrown exception', async () => {
    const memory = {
      getEntries: vi.fn().mockRejectedValue(new Error('connection lost')),
    };
    const runtime = mockRuntime({ memory });
    const app = buildApp({
      cogitator: runtime as unknown as CogitatorAppOptions['cogitator'],
    });

    const res = await request(app.callback()).get('/threads/t1');
    expect(res.status).toBe(500);
    expect(res.body.error.message).toBe('connection lost');
  });

  it('POST /threads/:id/messages returns 503 when memory not configured', async () => {
    const app = buildApp();
    const res = await request(app.callback())
      .post('/threads/t1/messages')
      .send({ role: 'user', content: 'hello' })
      .set('Content-Type', 'application/json');
    expect(res.status).toBe(503);
    expect(res.body.error.code).toBe('UNAVAILABLE');
  });

  it('POST /threads/:id/messages returns 400 when role is missing', async () => {
    const memory = mockMemory();
    const runtime = mockRuntime({ memory });
    const app = buildApp({
      cogitator: runtime as unknown as CogitatorAppOptions['cogitator'],
    });

    const res = await request(app.callback())
      .post('/threads/t1/messages')
      .send({ content: 'hello' })
      .set('Content-Type', 'application/json');
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('INVALID_INPUT');
    expect(res.body.error.message).toContain('role');
  });

  it('POST /threads/:id/messages returns 400 when content is missing', async () => {
    const memory = mockMemory();
    const runtime = mockRuntime({ memory });
    const app = buildApp({
      cogitator: runtime as unknown as CogitatorAppOptions['cogitator'],
    });

    const res = await request(app.callback())
      .post('/threads/t1/messages')
      .send({ role: 'user' })
      .set('Content-Type', 'application/json');
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('INVALID_INPUT');
  });

  it('POST /threads/:id/messages adds entry and returns 201', async () => {
    const memory = mockMemory();
    const runtime = mockRuntime({ memory });
    const app = buildApp({
      cogitator: runtime as unknown as CogitatorAppOptions['cogitator'],
    });

    const res = await request(app.callback())
      .post('/threads/t1/messages')
      .send({ role: 'user', content: 'hello' })
      .set('Content-Type', 'application/json');
    expect(res.status).toBe(201);
    expect(res.body.success).toBe(true);
    expect(memory.addEntry).toHaveBeenCalledWith(
      expect.objectContaining({
        threadId: 't1',
        message: { role: 'user', content: 'hello' },
        tokenCount: 0,
      })
    );
  });

  it('POST /threads/:id/messages returns 500 when addEntry fails', async () => {
    const memory = {
      ...mockMemory(),
      addEntry: vi.fn().mockResolvedValue({ success: false, error: 'write failed' }),
    };
    const runtime = mockRuntime({ memory });
    const app = buildApp({
      cogitator: runtime as unknown as CogitatorAppOptions['cogitator'],
    });

    const res = await request(app.callback())
      .post('/threads/t1/messages')
      .send({ role: 'user', content: 'test' })
      .set('Content-Type', 'application/json');
    expect(res.status).toBe(500);
    expect(res.body.error.message).toBe('write failed');
  });

  it('POST /threads/:id/messages returns 500 on thrown exception', async () => {
    const memory = {
      ...mockMemory(),
      addEntry: vi.fn().mockRejectedValue(new Error('timeout')),
    };
    const runtime = mockRuntime({ memory });
    const app = buildApp({
      cogitator: runtime as unknown as CogitatorAppOptions['cogitator'],
    });

    const res = await request(app.callback())
      .post('/threads/t1/messages')
      .send({ role: 'user', content: 'test' })
      .set('Content-Type', 'application/json');
    expect(res.status).toBe(500);
    expect(res.body.error.message).toBe('timeout');
  });

  it('DELETE /threads/:id returns 503 when memory not configured', async () => {
    const app = buildApp();
    const res = await request(app.callback()).delete('/threads/t1');
    expect(res.status).toBe(503);
    expect(res.body.error.code).toBe('UNAVAILABLE');
  });

  it('DELETE /threads/:id clears thread and returns 204', async () => {
    const memory = mockMemory();
    const runtime = mockRuntime({ memory });
    const app = buildApp({
      cogitator: runtime as unknown as CogitatorAppOptions['cogitator'],
    });

    const res = await request(app.callback()).delete('/threads/t1');
    expect(res.status).toBe(204);
    expect(memory.clearThread).toHaveBeenCalledWith('t1');
  });

  it('DELETE /threads/:id returns 500 when clearThread fails', async () => {
    const memory = {
      ...mockMemory(),
      clearThread: vi.fn().mockResolvedValue({ success: false, error: 'locked' }),
    };
    const runtime = mockRuntime({ memory });
    const app = buildApp({
      cogitator: runtime as unknown as CogitatorAppOptions['cogitator'],
    });

    const res = await request(app.callback()).delete('/threads/t1');
    expect(res.status).toBe(500);
    expect(res.body.error.message).toBe('locked');
  });

  it('DELETE /threads/:id returns 500 on thrown exception', async () => {
    const memory = {
      ...mockMemory(),
      clearThread: vi.fn().mockRejectedValue(new Error('crash')),
    };
    const runtime = mockRuntime({ memory });
    const app = buildApp({
      cogitator: runtime as unknown as CogitatorAppOptions['cogitator'],
    });

    const res = await request(app.callback()).delete('/threads/t1');
    expect(res.status).toBe(500);
    expect(res.body.error.message).toBe('crash');
  });
});

describe('toolRoutes', () => {
  it('GET /tools returns empty list when no agents', async () => {
    const app = buildApp({ agents: {} });
    const res = await request(app.callback()).get('/tools');
    expect(res.status).toBe(200);
    expect(res.body.tools).toEqual([]);
  });

  it('GET /tools lists tools from agents', async () => {
    const tool = mockTool('search');
    const app = buildApp({
      agents: { a1: { config: { tools: [tool] } } as never },
    });
    const res = await request(app.callback()).get('/tools');
    expect(res.status).toBe(200);
    expect(res.body.tools).toHaveLength(1);
    expect(res.body.tools[0].name).toBe('search');
    expect(res.body.tools[0].description).toBe('Tool search');
    expect(res.body.tools[0].parameters).toEqual({
      type: 'object',
      properties: { q: { type: 'string' } },
      required: ['q'],
    });
  });

  it('GET /tools deduplicates tools with same name across agents', async () => {
    const t1 = mockTool('calc');
    const t2 = mockTool('calc');
    const app = buildApp({
      agents: {
        a1: { config: { tools: [t1] } } as never,
        a2: { config: { tools: [t2] } } as never,
      },
    });
    const res = await request(app.callback()).get('/tools');
    expect(res.status).toBe(200);
    expect(res.body.tools).toHaveLength(1);
  });

  it('GET /tools merges unique tools from multiple agents', async () => {
    const app = buildApp({
      agents: {
        a1: { config: { tools: [mockTool('search')] } } as never,
        a2: { config: { tools: [mockTool('calc')] } } as never,
      },
    });
    const res = await request(app.callback()).get('/tools');
    expect(res.status).toBe(200);
    expect(res.body.tools).toHaveLength(2);
    const names = res.body.tools.map((t: { name: string }) => t.name).sort();
    expect(names).toEqual(['calc', 'search']);
  });

  it('GET /tools handles agent with no tools array', async () => {
    const app = buildApp({
      agents: { bare: { config: {} } as never },
    });
    const res = await request(app.callback()).get('/tools');
    expect(res.status).toBe(200);
    expect(res.body.tools).toEqual([]);
  });
});

describe('workflowRoutes', () => {
  it('GET /workflows returns empty list when no workflows', async () => {
    const app = buildApp({ workflows: {} });
    const res = await request(app.callback()).get('/workflows');
    expect(res.status).toBe(200);
    expect(res.body.workflows).toEqual([]);
  });

  it('GET /workflows lists registered workflows', async () => {
    const nodes = new Map();
    nodes.set('start', {});
    nodes.set('end', {});
    const workflow = { entryPoint: 'start', nodes };
    const app = buildApp({ workflows: { pipeline: workflow as never } });
    const res = await request(app.callback()).get('/workflows');
    expect(res.status).toBe(200);
    expect(res.body.workflows).toHaveLength(1);
    expect(res.body.workflows[0].name).toBe('pipeline');
    expect(res.body.workflows[0].entryPoint).toBe('start');
    expect(res.body.workflows[0].nodes).toEqual(['start', 'end']);
  });
});

describe('swarmRoutes', () => {
  it('GET /swarms returns empty list when no swarms', async () => {
    const app = buildApp({ swarms: {} });
    const res = await request(app.callback()).get('/swarms');
    expect(res.status).toBe(200);
    expect(res.body.swarms).toEqual([]);
  });

  it('GET /swarms lists swarms with supervisor and workers', async () => {
    const swarmConfig = {
      strategy: 'hierarchical',
      supervisor: { name: 'boss' },
      workers: [{ name: 'w1' }, { name: 'w2' }],
    };
    const app = buildApp({ swarms: { team: swarmConfig as never } });
    const res = await request(app.callback()).get('/swarms');
    expect(res.status).toBe(200);
    expect(res.body.swarms).toHaveLength(1);
    expect(res.body.swarms[0].name).toBe('team');
    expect(res.body.swarms[0].strategy).toBe('hierarchical');
    expect(res.body.swarms[0].agents).toEqual(['boss', 'w1', 'w2']);
  });

  it('GET /swarms lists swarms with agents array', async () => {
    const swarmConfig = {
      strategy: 'round-robin',
      agents: [{ name: 'a1' }, { name: 'a2' }],
    };
    const app = buildApp({ swarms: { pool: swarmConfig as never } });
    const res = await request(app.callback()).get('/swarms');
    const body = res.body;
    expect(body.swarms[0].agents).toEqual(['a1', 'a2']);
  });

  it('GET /swarms includes moderator in agent list', async () => {
    const swarmConfig = {
      strategy: 'debate',
      agents: [{ name: 'a1' }],
      moderator: { name: 'mod' },
    };
    const app = buildApp({ swarms: { debate: swarmConfig as never } });
    const res = await request(app.callback()).get('/swarms');
    const body = res.body;
    expect(body.swarms[0].agents).toContain('mod');
    expect(body.swarms[0].agents).toContain('a1');
  });

  it('GET /swarms/:name/blackboard returns 404 for unknown swarm', async () => {
    const app = buildApp();
    const res = await request(app.callback()).get('/swarms/ghost/blackboard');
    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe('NOT_FOUND');
  });

  it('GET /swarms/:name/blackboard returns 400 when blackboard not enabled', async () => {
    const swarmConfig = { strategy: 'round-robin', agents: [{ name: 'a1' }] };
    const app = buildApp({ swarms: { pool: swarmConfig as never } });
    const res = await request(app.callback()).get('/swarms/pool/blackboard');
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('INVALID_INPUT');
  });

  it('GET /swarms/:name/blackboard returns sections when enabled', async () => {
    const swarmConfig = {
      strategy: 'blackboard',
      agents: [{ name: 'a1' }],
      blackboard: { enabled: true, sections: { facts: ['fact1'], goals: ['goal1'] } },
    };
    const app = buildApp({ swarms: { bb: swarmConfig as never } });
    const res = await request(app.callback()).get('/swarms/bb/blackboard');
    expect(res.status).toBe(200);
    expect(res.body.sections).toEqual({ facts: ['fact1'], goals: ['goal1'] });
  });
});

describe('swaggerRoutes', () => {
  it('GET /openapi.json returns OpenAPI spec', async () => {
    const app = buildApp({ enableSwagger: true });
    const res = await request(app.callback()).get('/openapi.json');
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toMatch(/json/);
    expect(res.body.openapi).toMatch(/^3\.0\./);

    expect(res.body.paths).toBeDefined();
  });

  it('GET /docs returns HTML', async () => {
    const app = buildApp({ enableSwagger: true });
    const res = await request(app.callback()).get('/docs');
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toMatch(/html/);
    expect(res.text).toContain('swagger');
  });

  it('swagger routes not available when enableSwagger is false', async () => {
    const app = buildApp({ enableSwagger: false });
    const res = await request(app.callback()).get('/openapi.json');
    expect(res.status).toBe(404);
  });

  it('caches the OpenAPI spec across requests', async () => {
    const app = buildApp({ enableSwagger: true });
    const res1 = await request(app.callback()).get('/openapi.json');
    const res2 = await request(app.callback()).get('/openapi.json');
    expect(res1.body).toEqual(res2.body);
  });
});
