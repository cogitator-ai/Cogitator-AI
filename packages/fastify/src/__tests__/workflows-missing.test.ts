import { describe, it, expect, vi, afterEach } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { workflowRoutes } from '../routes/workflows.js';
import type { CogitatorContext } from '../types.js';

vi.mock('@cogitator-ai/workflows', () => ({
  get WorkflowExecutor(): never {
    const error = new Error(
      "Cannot find package '@cogitator-ai/workflows'"
    ) as NodeJS.ErrnoException;
    error.code = 'ERR_MODULE_NOT_FOUND';
    throw error;
  },
}));

let server: FastifyInstance | undefined;

afterEach(async () => {
  await server?.close();
  server = undefined;
});

async function serveWorkflow() {
  server = Fastify({ logger: false });
  server.decorate('cogitator', {
    runtime: {} as never,
    agents: {},
    workflows: { flow: { name: 'flow', entryPoint: 'start', nodes: new Map() } as never },
    swarms: {},
  } as CogitatorContext);
  server.decorateRequest('cogitatorAuth', undefined);
  server.decorateRequest('cogitatorRequestId', '');
  server.decorateRequest('cogitatorStartTime', 0);
  await server.register(workflowRoutes);
  await server.ready();
  return server;
}

describe('workflow routes without @cogitator-ai/workflows', () => {
  it('answers a run with 501 UNIMPLEMENTED', async () => {
    const app = await serveWorkflow();
    const res = await app.inject({ method: 'POST', url: '/workflows/flow/run', payload: {} });

    expect(res.statusCode).toBe(501);
    expect(res.json()).toMatchObject({ error: { code: 'UNIMPLEMENTED' } });
  });

  it('ends a stream with an UNIMPLEMENTED error event', async () => {
    const app = await serveWorkflow();
    const res = await app.inject({ method: 'POST', url: '/workflows/flow/stream', payload: {} });

    const events = res.body
      .split('\n\n')
      .map((block) => block.replace(/^data: /, ''))
      .filter((data) => data.startsWith('{'))
      .map((data) => JSON.parse(data) as { type: string; code?: string });
    expect(events.at(-1)).toMatchObject({ type: 'error', code: 'UNIMPLEMENTED' });
  });
});
