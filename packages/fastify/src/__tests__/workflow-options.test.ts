import { describe, it, expect, vi, afterEach } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { WorkflowBuilder, WorkflowExecutor } from '@cogitator-ai/workflows';
import type { Workflow, WorkflowState } from '@cogitator-ai/types';
import { workflowRoutes } from '../routes/workflows.js';
import type { CogitatorContext } from '../types.js';

let server: FastifyInstance | undefined;

afterEach(async () => {
  await server?.close();
  server = undefined;
  vi.restoreAllMocks();
});

describe('workflow run options', () => {
  it('hands the executor only the options a request may set, held to the limits', async () => {
    const execute = vi.spyOn(WorkflowExecutor.prototype, 'execute');
    const flow = new WorkflowBuilder('flow')
      .addNode('only', async () => ({ output: 'done' }))
      .build() as unknown as Workflow<WorkflowState>;
    server = Fastify({ logger: false });
    server.decorate('cogitator', {
      runtime: {} as never,
      agents: {},
      workflows: { flow },
      swarms: {},
      limits: { workflowMaxIterations: 5 },
    } as CogitatorContext);
    server.decorateRequest('cogitatorAuth', undefined);
    server.decorateRequest('cogitatorRequestId', '');
    server.decorateRequest('cogitatorStartTime', 0);
    await server.register(workflowRoutes);
    await server.ready();

    await server.inject({
      method: 'POST',
      url: '/workflows/flow/run',
      payload: {
        options: {
          maxIterations: 50,
          defaultRetry: { maxRetries: 5, initialDelay: 1e12 },
        },
      },
    });

    const options = execute.mock.calls[0]?.[2];
    expect(options).toMatchObject({ maxIterations: 5 });
    expect(options).not.toHaveProperty('defaultRetry');
  });
});
