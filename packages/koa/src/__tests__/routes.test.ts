import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import Koa from 'koa';
import request from 'supertest';
import Router from '@koa/router';
import { cogitatorApp } from '../app.js';
import type { CogitatorAppOptions, CogitatorState } from '../types.js';

beforeEach(() => {
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
});

function mockTool(name: string) {
  const schema = {
    name,
    description: `Tool ${name}`,
    parameters: { type: 'object', properties: { q: { type: 'string' } }, required: ['q'] },
  };
  return { ...schema, toJSON: () => schema };
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
    getMemory() {
      return Promise.resolve(this.memory);
    },
    ...overrides,
  };
}

function storedThread(id: string, metadata: Record<string, unknown>) {
  return { id, agentId: '', metadata, createdAt: new Date(0), updatedAt: new Date(0) };
}

function mockMemory(
  entries: Array<{ message: unknown; createdAt: Date }> = [],
  threads: Record<string, Record<string, unknown>> = {}
) {
  return {
    getThread: vi.fn(async (id: string) => ({
      success: true,
      data: Object.hasOwn(threads, id) ? storedThread(id, threads[id]) : null,
    })),
    createThread: vi.fn(
      async (_agentId: string, metadata: Record<string, unknown>, id: string) => ({
        success: true,
        data: storedThread(id, metadata),
      })
    ),
    getEntries: vi.fn().mockResolvedValue({ success: true, data: entries }),
    addEntry: vi.fn().mockResolvedValue({ success: true, data: {} }),
    clearThread: vi.fn().mockResolvedValue({ success: true }),
  };
}

function buildRouter(overrides: Partial<CogitatorAppOptions> = {}) {
  return cogitatorApp({
    cogitator: mockRuntime() as unknown as CogitatorAppOptions['cogitator'],
    agents: {},
    workflows: {},
    swarms: {},
    ...overrides,
  });
}

function buildApp(overrides: Partial<CogitatorAppOptions> = {}) {
  const app = new Koa<CogitatorState>();
  const router = buildRouter(overrides);
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

  it('GET /agents exposes the agent description, never its instructions', async () => {
    const agent = {
      config: { instructions: 'secret system prompt', description: 'Public summary', tools: [] },
    };
    const bare = { config: { instructions: 'another secret', tools: [] } };
    const app = buildApp({ agents: { described: agent as never, bare: bare as never } });
    const res = await request(app.callback()).get('/agents');
    expect(res.body.agents[0].description).toBe('Public summary');
    expect(res.body.agents[1].description).toBeUndefined();
    expect(JSON.stringify(res.body)).not.toContain('secret');
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
    expect(res.body.error.code).toBe('INTERNAL_ERROR');
    expect(res.body.error.message).toBe('Internal server error');
  });

  it('POST /agents/:name/run masks non-Error throws', async () => {
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
    expect(res.body.error.message).toBe('Internal server error');
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
      ...mockMemory(),
      getEntries: vi.fn().mockResolvedValue({ success: false, error: 'disk full' }),
    };
    const runtime = mockRuntime({ memory });
    const app = buildApp({
      cogitator: runtime as unknown as CogitatorAppOptions['cogitator'],
    });

    const res = await request(app.callback()).get('/threads/t1');
    expect(res.status).toBe(500);
    expect(res.body.error.message).toBe('Internal server error');
  });

  it('GET /threads/:id returns 500 on thrown exception', async () => {
    const memory = {
      ...mockMemory(),
      getEntries: vi.fn().mockRejectedValue(new Error('connection lost')),
    };
    const runtime = mockRuntime({ memory });
    const app = buildApp({
      cogitator: runtime as unknown as CogitatorAppOptions['cogitator'],
    });

    const res = await request(app.callback()).get('/threads/t1');
    expect(res.status).toBe(500);
    expect(res.body.error.message).toBe('Internal server error');
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
        tokenCount: expect.any(Number),
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
    expect(res.body.error.message).toBe('Internal server error');
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
    expect(res.body.error.message).toBe('Internal server error');
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
    expect(res.body.error.message).toBe('Internal server error');
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
    expect(res.body.error.message).toBe('Internal server error');
  });
});

describe('multi-user isolation', () => {
  function buildUserApp(runtime: ReturnType<typeof mockRuntime>) {
    return buildApp({
      cogitator: runtime as unknown as CogitatorAppOptions['cogitator'],
      agents: { bot: mockAgent('bot') as never },
      auth: (ctx) => ({ userId: ctx.get('x-user') || undefined }),
    });
  }

  function postAs(app: Koa<CogitatorState>, path: string, userId: string, body: unknown) {
    return request(app.callback())
      .post(path)
      .set('x-user', userId)
      .set('Content-Type', 'application/json')
      .send(JSON.stringify(body));
  }

  it('POST /agents/:name/run runs as the authenticated user', async () => {
    const runtime = mockRuntime();
    const app = buildUserApp(runtime);

    const res = await postAs(app, '/agents/bot/run', 'alice', { input: 'hi', threadId: 't1' });

    expect(res.status).toBe(200);
    expect(runtime.run).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ threadId: 't1', userId: 'alice' })
    );
  });

  it('POST /agents/:name/stream runs as the authenticated user', async () => {
    const runtime = mockRuntime();
    const app = buildUserApp(runtime);

    await postAs(app, '/agents/bot/stream', 'alice', { input: 'hi', threadId: 't1' });

    expect(runtime.run).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ threadId: 't1', userId: 'alice', stream: true })
    );
  });

  it('GET /threads/:id returns a thread owned by the caller', async () => {
    const entries = [{ message: { role: 'user', content: 'mine' }, createdAt: new Date() }];
    const memory = mockMemory(entries, { t1: { userId: 'alice' } });
    const app = buildUserApp(mockRuntime({ memory }));

    const res = await request(app.callback()).get('/threads/t1').set('x-user', 'alice');

    expect(res.status).toBe(200);
    expect(res.body.messages).toEqual([{ role: 'user', content: 'mine' }]);
  });

  it('GET /threads/:id answers 403 for a thread owned by another user without reading it', async () => {
    const memory = mockMemory([], { t1: { userId: 'alice' } });
    const app = buildUserApp(mockRuntime({ memory }));

    const res = await request(app.callback()).get('/threads/t1').set('x-user', 'bob');

    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('THREAD_ACCESS_DENIED');
    expect(memory.getEntries).not.toHaveBeenCalled();
  });

  it('POST /threads/:id/messages answers 403 for a thread owned by another user without writing', async () => {
    const memory = mockMemory([], { t1: { userId: 'alice' } });
    const app = buildUserApp(mockRuntime({ memory }));

    const res = await postAs(app, '/threads/t1/messages', 'bob', {
      role: 'user',
      content: 'sneaky',
    });

    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('THREAD_ACCESS_DENIED');
    expect(memory.addEntry).not.toHaveBeenCalled();
    expect(memory.createThread).not.toHaveBeenCalled();
  });

  it('DELETE /threads/:id answers 403 for a thread owned by another user without clearing it', async () => {
    const memory = mockMemory([], { t1: { userId: 'alice' } });
    const app = buildUserApp(mockRuntime({ memory }));

    const res = await request(app.callback()).delete('/threads/t1').set('x-user', 'bob');

    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('THREAD_ACCESS_DENIED');
    expect(memory.clearThread).not.toHaveBeenCalled();
  });

  it('POST /threads/:id/messages creates a missing thread owned by the caller', async () => {
    const memory = mockMemory();
    const app = buildUserApp(mockRuntime({ memory }));

    const res = await postAs(app, '/threads/fresh/messages', 'alice', {
      role: 'user',
      content: 'hello',
    });

    expect(res.status).toBe(201);
    expect(memory.createThread).toHaveBeenCalledWith('', { agentId: '', userId: 'alice' }, 'fresh');
    expect(memory.addEntry).toHaveBeenCalledWith(expect.objectContaining({ threadId: 'fresh' }));
  });

  it('keeps threads without an owner closed to authenticated callers', async () => {
    const memory = mockMemory([], { legacy: {} });
    const app = buildUserApp(mockRuntime({ memory }));

    const res = await request(app.callback()).get('/threads/legacy').set('x-user', 'alice');

    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('THREAD_ACCESS_DENIED');
  });

  it('GET /threads/:id answers 500 without reading entries when the thread cannot be read', async () => {
    const memory = {
      ...mockMemory(),
      getThread: vi.fn().mockResolvedValue({ success: false, error: 'db down' }),
    };
    const app = buildUserApp(mockRuntime({ memory }));

    const res = await request(app.callback()).get('/threads/t1').set('x-user', 'alice');

    expect(res.status).toBe(500);
    expect(res.body.error.code).toBe('MEMORY_READ_FAILED');
    expect(memory.getEntries).not.toHaveBeenCalled();
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

  it("describes the refusal of another user's thread", async () => {
    const app = buildApp({ enableSwagger: true });
    const res = await request(app.callback()).get('/openapi.json');
    const paths = res.body.paths as Record<string, Record<string, { responses: object }>>;

    for (const [path, method] of [
      ['/threads/{id}', 'get'],
      ['/threads/{id}', 'delete'],
      ['/threads/{id}/messages', 'post'],
    ]) {
      expect(paths[path][method].responses).toHaveProperty('403');
    }
  });

  it('swagger routes not available when enableSwagger is false', async () => {
    const app = buildApp({ enableSwagger: false });
    const res = await request(app.callback()).get('/openapi.json');
    expect(res.status).toBe(404);
  });

  it('points servers at the path the router is mounted under', async () => {
    const app = new Koa<CogitatorState>();
    const parent = new Router<CogitatorState>();
    const router = buildRouter({ enableSwagger: true });
    parent.use('/api/ai', router.routes(), router.allowedMethods());
    app.use(parent.routes());

    const spec = await request(app.callback()).get('/api/ai/openapi.json');
    expect(spec.body.servers).toEqual([{ url: '/api/ai' }]);

    const root = await request(buildApp({ enableSwagger: true }).callback()).get('/openapi.json');
    expect(root.body.servers).toEqual([{ url: '/' }]);
  });

  it('keeps servers set in the swagger config', async () => {
    const app = buildApp({
      enableSwagger: true,
      swagger: { servers: [{ url: 'https://api.example.com/ai' }] },
    });
    const res = await request(app.callback()).get('/openapi.json');
    expect(res.body.servers).toEqual([{ url: 'https://api.example.com/ai' }]);
  });

  it('declares bearer auth only when the router checks credentials', async () => {
    const open = await request(buildApp({ enableSwagger: true }).callback()).get('/openapi.json');
    expect(open.body.security).toBeUndefined();
    expect(open.body.components.securitySchemes).toBeUndefined();

    const guarded = buildApp({ enableSwagger: true, auth: () => ({ userId: 'u1' }) });
    const res = await request(guarded.callback()).get('/openapi.json');
    expect(res.body.components.securitySchemes).toEqual({
      bearerAuth: { type: 'http', scheme: 'bearer' },
    });
    expect(res.body.security).toEqual([{ bearerAuth: [] }, {}]);
  });

  it('caches the OpenAPI spec across requests', async () => {
    const app = buildApp({ enableSwagger: true });
    const res1 = await request(app.callback()).get('/openapi.json');
    const res2 = await request(app.callback()).get('/openapi.json');
    expect(res1.body).toEqual(res2.body);
  });
});
