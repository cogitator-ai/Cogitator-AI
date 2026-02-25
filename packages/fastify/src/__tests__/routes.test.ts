import { describe, it, expect, vi, beforeEach } from 'vitest';
import Fastify from 'fastify';
import type { FastifyInstance } from 'fastify';
import type { CogitatorContext } from '../types.js';
import { healthRoutes } from '../routes/health.js';
import { agentRoutes } from '../routes/agents.js';
import { threadRoutes } from '../routes/threads.js';
import { toolRoutes } from '../routes/tools.js';

function mockAgent(name: string, tools: unknown[] = []) {
  return {
    config: {
      instructions: `Instructions for ${name}`,
      tools,
    },
  };
}

function mockTool(toolName: string) {
  return {
    name: toolName,
    description: `Tool ${toolName}`,
    toJSON: () => ({
      name: toolName,
      description: `Tool ${toolName}`,
      parameters: { type: 'object', properties: { q: { type: 'string' } }, required: ['q'] },
    }),
  };
}

function mockRuntime(runResult?: object, memoryResult?: object) {
  const defaultRun = {
    output: 'hello',
    threadId: 'thread-1',
    usage: { inputTokens: 10, outputTokens: 20, totalTokens: 30 },
    toolCalls: [],
  };
  return {
    run: vi.fn().mockResolvedValue(runResult ?? defaultRun),
    memory: memoryResult,
  };
}

async function buildServer(context: Partial<CogitatorContext> = {}) {
  const fastify = Fastify({ logger: false });

  const cogitator: CogitatorContext = {
    runtime: mockRuntime() as unknown as CogitatorContext['runtime'],
    agents: {},
    workflows: {},
    swarms: {},
    ...context,
  };

  fastify.decorate('cogitator', cogitator);
  fastify.decorateRequest('cogitatorAuth', undefined);
  fastify.decorateRequest('cogitatorRequestId', '');
  fastify.decorateRequest('cogitatorStartTime', 0);

  await fastify.register(healthRoutes);
  await fastify.register(agentRoutes);
  await fastify.register(threadRoutes);
  await fastify.register(toolRoutes);

  await fastify.ready();
  return fastify;
}

describe('healthRoutes', () => {
  let server: FastifyInstance;
  beforeEach(async () => {
    server = await buildServer();
  });

  it('GET /health returns ok', async () => {
    const res = await server.inject({ method: 'GET', url: '/health' });
    expect(res.statusCode).toBe(200);
    const body = res.json<{ status: string; uptime: number; timestamp: number }>();
    expect(body.status).toBe('ok');
    expect(body.uptime).toBeGreaterThanOrEqual(0);
    expect(body.timestamp).toBeGreaterThan(0);
  });

  it('GET /ready returns ok', async () => {
    const res = await server.inject({ method: 'GET', url: '/ready' });
    expect(res.statusCode).toBe(200);
    expect(res.json<{ status: string }>().status).toBe('ok');
  });
});

describe('agentRoutes', () => {
  it('GET /agents returns empty list when no agents', async () => {
    const server = await buildServer({ agents: {} });
    const res = await server.inject({ method: 'GET', url: '/agents' });
    expect(res.statusCode).toBe(200);
    expect(res.json<{ agents: unknown[] }>().agents).toEqual([]);
    await server.close();
  });

  it('GET /agents lists registered agents', async () => {
    const server = await buildServer({
      agents: { myAgent: mockAgent('myAgent', [mockTool('search')]) as never },
    });
    const res = await server.inject({ method: 'GET', url: '/agents' });
    expect(res.statusCode).toBe(200);
    const body = res.json<{ agents: Array<{ name: string; tools: string[] }> }>();
    expect(body.agents).toHaveLength(1);
    expect(body.agents[0].name).toBe('myAgent');
    expect(body.agents[0].tools).toEqual(['search']);
    await server.close();
  });

  it('POST /agents/:name/run returns 404 for unknown agent', async () => {
    const server = await buildServer({ agents: {} });
    const res = await server.inject({
      method: 'POST',
      url: '/agents/unknown/run',
      payload: { input: 'hello' },
    });
    expect(res.statusCode).toBe(404);
    await server.close();
  });

  it('POST /agents/:name/run returns 400 when input missing', async () => {
    const server = await buildServer({
      agents: { myAgent: mockAgent('myAgent') as never },
    });
    const res = await server.inject({
      method: 'POST',
      url: '/agents/myAgent/run',
      payload: {},
    });
    expect(res.statusCode).toBe(400);
    await server.close();
  });

  it('POST /agents/:name/run returns agent output', async () => {
    const runResult = {
      output: 'I am fine',
      threadId: 'thread-42',
      usage: { inputTokens: 5, outputTokens: 10, totalTokens: 15 },
      toolCalls: [],
    };
    const runtime = mockRuntime(runResult);
    const server = await buildServer({
      agents: { myAgent: mockAgent('myAgent') as never },
      runtime: runtime as unknown as CogitatorContext['runtime'],
    });
    const res = await server.inject({
      method: 'POST',
      url: '/agents/myAgent/run',
      payload: { input: 'hello' },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json<{ output: string; threadId: string }>();
    expect(body.output).toBe('I am fine');
    expect(body.threadId).toBe('thread-42');
    await server.close();
  });

  it('POST /agents/:name/run returns 500 on runtime error', async () => {
    const runtime = {
      run: vi.fn().mockRejectedValue(new Error('model unavailable')),
      memory: undefined,
    };
    const server = await buildServer({
      agents: { myAgent: mockAgent('myAgent') as never },
      runtime: runtime as unknown as CogitatorContext['runtime'],
    });
    const res = await server.inject({
      method: 'POST',
      url: '/agents/myAgent/run',
      payload: { input: 'hello' },
    });
    expect(res.statusCode).toBe(500);
    await server.close();
  });
});

describe('threadRoutes', () => {
  function mockMemory(entries: Array<{ message: unknown; createdAt: Date }> = []) {
    return {
      getEntries: vi.fn().mockResolvedValue({ success: true, data: entries }),
      addEntry: vi.fn().mockResolvedValue({ success: true, data: {} }),
      clearThread: vi.fn().mockResolvedValue({ success: true }),
    };
  }

  it('GET /threads/:id returns 503 when memory not configured', async () => {
    const server = await buildServer({ runtime: { run: vi.fn(), memory: undefined } as never });
    const res = await server.inject({ method: 'GET', url: '/threads/t1' });
    expect(res.statusCode).toBe(503);
    await server.close();
  });

  it('GET /threads/:id returns thread with messages', async () => {
    const createdAt = new Date('2025-01-01T00:00:00Z');
    const updatedAt = new Date('2025-06-01T00:00:00Z');
    const entries = [
      { message: { role: 'user', content: 'hello' }, createdAt },
      { message: { role: 'assistant', content: 'hi' }, createdAt: updatedAt },
    ];
    const memory = mockMemory(entries);
    const server = await buildServer({
      runtime: { run: vi.fn(), memory } as never,
    });
    const res = await server.inject({ method: 'GET', url: '/threads/t1' });
    expect(res.statusCode).toBe(200);
    const body = res.json<{
      id: string;
      messages: unknown[];
      createdAt: number;
      updatedAt: number;
    }>();
    expect(body.id).toBe('t1');
    expect(body.messages).toHaveLength(2);
    expect(body.createdAt).toBe(createdAt.getTime());
    expect(body.updatedAt).toBe(updatedAt.getTime());
    await server.close();
  });

  it('GET /threads/:id uses Date.now() for empty thread', async () => {
    const memory = mockMemory([]);
    const server = await buildServer({ runtime: { run: vi.fn(), memory } as never });
    const before = Date.now();
    const res = await server.inject({ method: 'GET', url: '/threads/empty' });
    const after = Date.now();
    expect(res.statusCode).toBe(200);
    const body = res.json<{ createdAt: number; updatedAt: number }>();
    expect(body.createdAt).toBeGreaterThanOrEqual(before);
    expect(body.createdAt).toBeLessThanOrEqual(after);
    await server.close();
  });

  it('GET /threads/:id propagates memory error message', async () => {
    const memory = {
      getEntries: vi.fn().mockResolvedValue({ success: false, error: 'storage error' }),
    };
    const server = await buildServer({ runtime: { run: vi.fn(), memory } as never });
    const res = await server.inject({ method: 'GET', url: '/threads/t1' });
    expect(res.statusCode).toBe(500);
    expect(res.json<{ error: { message: string } }>().error.message).toBe('storage error');
    await server.close();
  });

  it('GET /threads/:id returns Unknown error when error is missing', async () => {
    const memory = {
      getEntries: vi.fn().mockResolvedValue({ success: false }),
    };
    const server = await buildServer({ runtime: { run: vi.fn(), memory } as never });
    const res = await server.inject({ method: 'GET', url: '/threads/t1' });
    expect(res.statusCode).toBe(500);
    expect(res.json<{ error: { message: string } }>().error.message).toBe('Unknown error');
    await server.close();
  });

  it('POST /threads/:id/messages adds entry', async () => {
    const memory = mockMemory();
    const server = await buildServer({ runtime: { run: vi.fn(), memory } as never });
    const res = await server.inject({
      method: 'POST',
      url: '/threads/t1/messages',
      payload: { role: 'user', content: 'hello' },
    });
    expect(res.statusCode).toBe(201);
    expect(memory.addEntry).toHaveBeenCalledWith(
      expect.objectContaining({ threadId: 't1', message: { role: 'user', content: 'hello' } })
    );
    await server.close();
  });

  it('DELETE /threads/:id clears thread', async () => {
    const memory = mockMemory();
    const server = await buildServer({ runtime: { run: vi.fn(), memory } as never });
    const res = await server.inject({ method: 'DELETE', url: '/threads/t1' });
    expect(res.statusCode).toBe(204);
    expect(memory.clearThread).toHaveBeenCalledWith('t1');
    await server.close();
  });
});

describe('toolRoutes', () => {
  it('GET /tools returns empty list when no agents', async () => {
    const server = await buildServer({ agents: {} });
    const res = await server.inject({ method: 'GET', url: '/tools' });
    expect(res.statusCode).toBe(200);
    expect(res.json<{ tools: unknown[] }>().tools).toEqual([]);
    await server.close();
  });

  it('GET /tools returns tools from registered agents', async () => {
    const tool = mockTool('search');
    const server = await buildServer({
      agents: { agent1: { config: { tools: [tool] } } as never },
    });
    const res = await server.inject({ method: 'GET', url: '/tools' });
    expect(res.statusCode).toBe(200);
    const body = res.json<{ tools: Array<{ name: string; parameters: object }> }>();
    expect(body.tools).toHaveLength(1);
    expect(body.tools[0].name).toBe('search');
    expect(body.tools[0].parameters).toEqual({
      type: 'object',
      properties: { q: { type: 'string' } },
      required: ['q'],
    });
    await server.close();
  });

  it('GET /tools deduplicates tools with same name across agents', async () => {
    const tool1 = mockTool('search');
    const tool2 = mockTool('search');
    const server = await buildServer({
      agents: {
        agent1: { config: { tools: [tool1] } } as never,
        agent2: { config: { tools: [tool2] } } as never,
      },
    });
    const res = await server.inject({ method: 'GET', url: '/tools' });
    expect(res.statusCode).toBe(200);
    const body = res.json<{ tools: unknown[] }>();
    expect(body.tools).toHaveLength(1);
    await server.close();
  });
});
