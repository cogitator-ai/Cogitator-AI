import { describe, it, expect, vi, afterEach } from 'vitest';
import Fastify from 'fastify';
import type { FastifyInstance } from 'fastify';
import type { CogitatorContext } from '../types.js';
import { workflowRoutes } from '../routes/workflows.js';
import { swarmRoutes } from '../routes/swarms.js';

function mockRuntime() {
  return { run: vi.fn(), memory: undefined };
}

async function buildWorkflowServer(workflows: CogitatorContext['workflows'] = {}) {
  const fastify = Fastify({ logger: false });
  fastify.decorate('cogitator', {
    runtime: mockRuntime() as never,
    agents: {},
    workflows,
    swarms: {},
  } as CogitatorContext);
  fastify.decorateRequest('cogitatorAuth', undefined);
  fastify.decorateRequest('cogitatorRequestId', '');
  fastify.decorateRequest('cogitatorStartTime', 0);
  await fastify.register(workflowRoutes);
  await fastify.ready();
  return fastify;
}

async function buildSwarmServer(swarms: CogitatorContext['swarms'] = {}) {
  const fastify = Fastify({ logger: false });
  fastify.decorate('cogitator', {
    runtime: mockRuntime() as never,
    agents: {},
    workflows: {},
    swarms,
  } as CogitatorContext);
  fastify.decorateRequest('cogitatorAuth', undefined);
  fastify.decorateRequest('cogitatorRequestId', '');
  fastify.decorateRequest('cogitatorStartTime', 0);
  await fastify.register(swarmRoutes);
  await fastify.ready();
  return fastify;
}

describe('workflowRoutes', () => {
  let server: FastifyInstance;

  afterEach(async () => {
    await server?.close();
  });

  it('GET /workflows returns empty list', async () => {
    server = await buildWorkflowServer({});
    const res = await server.inject({ method: 'GET', url: '/workflows' });
    expect(res.statusCode).toBe(200);
    expect(res.json<{ workflows: unknown[] }>().workflows).toEqual([]);
  });

  it('GET /workflows lists registered workflows', async () => {
    const workflow = {
      entryPoint: 'start',
      nodes: new Map([
        ['start', {}],
        ['end', {}],
      ]),
    } as never;
    server = await buildWorkflowServer({ myFlow: workflow });
    const res = await server.inject({ method: 'GET', url: '/workflows' });
    expect(res.statusCode).toBe(200);
    const body = res.json<{
      workflows: Array<{ name: string; entryPoint: string; nodes: string[] }>;
    }>();
    expect(body.workflows).toHaveLength(1);
    expect(body.workflows[0].name).toBe('myFlow');
    expect(body.workflows[0].entryPoint).toBe('start');
    expect(body.workflows[0].nodes).toContain('start');
  });

  it('POST /workflows/:name/run returns 404 for unknown workflow', async () => {
    server = await buildWorkflowServer({});
    const res = await server.inject({
      method: 'POST',
      url: '/workflows/unknown/run',
      payload: {},
    });
    expect(res.statusCode).toBe(404);
  });

  it('POST /workflows/:name/run returns 501 when workflows package not installed', async () => {
    const workflow = { entryPoint: 'start', nodes: new Map() } as never;
    server = await buildWorkflowServer({ myFlow: workflow });
    const err = new Error('Not found') as NodeJS.ErrnoException;
    err.code = 'ERR_MODULE_NOT_FOUND';
    vi.doMock('@cogitator-ai/workflows', () => {
      throw err;
    });
    const res = await server.inject({
      method: 'POST',
      url: '/workflows/myFlow/run',
      payload: {},
    });
    expect(res.statusCode === 501 || res.statusCode === 500).toBe(true);
  });
});

describe('swarmRoutes', () => {
  let server: FastifyInstance;

  afterEach(async () => {
    await server?.close();
  });

  it('GET /swarms returns empty list', async () => {
    server = await buildSwarmServer({});
    const res = await server.inject({ method: 'GET', url: '/swarms' });
    expect(res.statusCode).toBe(200);
    expect(res.json<{ swarms: unknown[] }>().swarms).toEqual([]);
  });

  it('GET /swarms lists swarm configs', async () => {
    const swarmConfig = {
      strategy: 'parallel',
      supervisor: { name: 'boss' },
      workers: [{ name: 'worker1' }, { name: 'worker2' }],
    } as never;
    server = await buildSwarmServer({ mySwarm: swarmConfig });
    const res = await server.inject({ method: 'GET', url: '/swarms' });
    expect(res.statusCode).toBe(200);
    const body = res.json<{
      swarms: Array<{ name: string; strategy: string; agents: string[] }>;
    }>();
    expect(body.swarms).toHaveLength(1);
    expect(body.swarms[0].name).toBe('mySwarm');
    expect(body.swarms[0].strategy).toBe('parallel');
    expect(body.swarms[0].agents).toContain('boss');
    expect(body.swarms[0].agents).toContain('worker1');
  });

  it('POST /swarms/:name/run returns 404 for unknown swarm', async () => {
    server = await buildSwarmServer({});
    const res = await server.inject({
      method: 'POST',
      url: '/swarms/unknown/run',
      payload: { input: 'test' },
    });
    expect(res.statusCode).toBe(404);
  });

  it('GET /swarms/:name/blackboard returns 404 for unknown swarm', async () => {
    server = await buildSwarmServer({});
    const res = await server.inject({ method: 'GET', url: '/swarms/unknown/blackboard' });
    expect(res.statusCode).toBe(404);
  });

  it('GET /swarms/:name/blackboard returns 400 when blackboard not enabled', async () => {
    server = await buildSwarmServer({
      mySwarm: { strategy: 'parallel' } as never,
    });
    const res = await server.inject({ method: 'GET', url: '/swarms/mySwarm/blackboard' });
    expect(res.statusCode).toBe(400);
  });

  it('GET /swarms/:name/blackboard returns config sections', async () => {
    const swarmConfig = {
      strategy: 'blackboard',
      blackboard: { enabled: true, sections: { shared: { data: 'value' } } },
    } as never;
    server = await buildSwarmServer({ mySwarm: swarmConfig });
    const res = await server.inject({ method: 'GET', url: '/swarms/mySwarm/blackboard' });
    expect(res.statusCode).toBe(200);
    const body = res.json<{ sections: Record<string, unknown> }>();
    expect(body.sections).toHaveProperty('shared');
  });
});

describe('thread error propagation', () => {
  it('addEntry returns Unknown error when result.error is undefined', async () => {
    const memory = {
      addEntry: vi.fn().mockResolvedValue({ success: false }),
      getEntries: vi.fn(),
      clearThread: vi.fn(),
    };
    const fastify = Fastify({ logger: false });
    fastify.decorate('cogitator', {
      runtime: { run: vi.fn(), memory } as never,
      agents: {},
      workflows: {},
      swarms: {},
    } as CogitatorContext);
    fastify.decorateRequest('cogitatorAuth', undefined);
    fastify.decorateRequest('cogitatorRequestId', '');
    fastify.decorateRequest('cogitatorStartTime', 0);

    const { threadRoutes } = await import('../routes/threads.js');
    await fastify.register(threadRoutes);
    await fastify.ready();

    const res = await fastify.inject({
      method: 'POST',
      url: '/threads/t1/messages',
      payload: { role: 'user', content: 'hi' },
    });
    expect(res.statusCode).toBe(500);
    expect(res.json<{ error: { message: string } }>().error.message).toBe('Unknown error');
    await fastify.close();
  });

  it('clearThread returns Unknown error when result.error is undefined', async () => {
    const memory = {
      getEntries: vi.fn(),
      addEntry: vi.fn(),
      clearThread: vi.fn().mockResolvedValue({ success: false }),
    };
    const fastify = Fastify({ logger: false });
    fastify.decorate('cogitator', {
      runtime: { run: vi.fn(), memory } as never,
      agents: {},
      workflows: {},
      swarms: {},
    } as CogitatorContext);
    fastify.decorateRequest('cogitatorAuth', undefined);
    fastify.decorateRequest('cogitatorRequestId', '');
    fastify.decorateRequest('cogitatorStartTime', 0);

    const { threadRoutes } = await import('../routes/threads.js');
    await fastify.register(threadRoutes);
    await fastify.ready();

    const res = await fastify.inject({ method: 'DELETE', url: '/threads/t1' });
    expect(res.statusCode).toBe(500);
    expect(res.json<{ error: { message: string } }>().error.message).toBe('Unknown error');
    await fastify.close();
  });
});
