import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Hono } from 'hono';
import { serve, type ServerType } from '@hono/node-server';
import type { AddressInfo } from 'net';
import { cogitatorApp } from '@cogitator-ai/hono';
import type { Cogitator } from '@cogitator-ai/core';
import { InMemoryCheckpointStore, WorkflowBuilder } from '@cogitator-ai/workflows';
import {
  describeResumeStream,
  describeServerAdapter,
  type ServerFactory,
} from '../../helpers/server-test-utils';
import { createOfflineCogitator } from '../../helpers/server-adapter-fixtures';

let httpServer: ServerType;

const factory: ServerFactory = {
  async start(cogitator, agents) {
    const app = cogitatorApp({
      cogitator,
      agents,
      enableSwagger: false,
    });

    const root = new Hono();
    root.route('/cogitator', app);

    httpServer = serve({ fetch: root.fetch, port: 0 });
    const addr = httpServer.address() as AddressInfo;
    return { port: addr.port };
  },
  async stop() {
    return new Promise((resolve) => {
      httpServer?.close(() => resolve());
    });
  },
};

describeServerAdapter('Hono', factory);
describeResumeStream('Hono', factory);

describe('Hono adapter: workflow checkpoints', () => {
  let cogitator: Cogitator;
  let base: string;
  let checkpointServer: ServerType;
  const store = new InMemoryCheckpointStore();
  let failures = 1;

  const post = (path: string, body: unknown, user: string) =>
    fetch(`${base}${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-user': user },
      body: JSON.stringify(body),
    });

  beforeAll(async () => {
    cogitator = createOfflineCogitator();
    const shipping = new WorkflowBuilder<{ steps: string[] }>('shipping')
      .initialState({ steps: [] })
      .addNode('pack', async (ctx) => ({ state: { steps: [...ctx.state.steps, 'pack'] } }))
      .addNode(
        'ship',
        async (ctx) => {
          if (failures-- > 0) throw new Error('carrier unavailable');
          return { state: { steps: [...ctx.state.steps, 'ship'] } };
        },
        { after: ['pack'] }
      )
      .build();
    const app = cogitatorApp({
      cogitator,
      workflows: { shipping },
      enableSwagger: false,
      auth: (c) => ({ userId: c.req.header('x-user') }),
      workflowCheckpoints: store,
    });
    const root = new Hono();
    root.route('/cogitator', app);
    checkpointServer = serve({ fetch: root.fetch, port: 0 });
    base = `http://localhost:${(checkpointServer.address() as AddressInfo).port}/cogitator`;
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => checkpointServer?.close(() => resolve()));
    await cogitator?.close();
  });

  it('answers a failed run with its checkpoint and resumes it for its owner only', async () => {
    const failed = await post('/workflows/shipping/run', { options: { checkpoint: true } }, 'ada');
    expect(failed.status).toBe(500);
    const { error } = (await failed.json()) as { error: { checkpointId?: string } };
    expect(error.checkpointId).toEqual(expect.any(String));
    expect((await store.load(error.checkpointId!))?.owner).toBe('ada');

    const stranger = await post(
      '/workflows/shipping/resume',
      { checkpointId: error.checkpointId },
      'eve'
    );
    expect(stranger.status).toBe(404);

    const resumed = await post(
      '/workflows/shipping/resume',
      { checkpointId: error.checkpointId },
      'ada'
    );
    expect(resumed.status).toBe(200);
    const body = (await resumed.json()) as { state: { steps: string[] }; checkpointId?: string };
    expect(body.state.steps).toEqual(['pack', 'ship']);
    expect(body.checkpointId).toEqual(expect.any(String));
  });
});
