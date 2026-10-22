import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import Koa from 'koa';
import type { AddressInfo } from 'net';
import type { Server } from 'http';
import { cogitatorApp } from '@cogitator-ai/koa';
import type { Cogitator } from '@cogitator-ai/core';
import { InMemoryCheckpointStore, WorkflowBuilder } from '@cogitator-ai/workflows';
import {
  describeResumeStream,
  describeServerAdapter,
  type ServerFactory,
} from '../../helpers/server-test-utils';
import { createOfflineCogitator } from '../../helpers/server-adapter-fixtures';

let httpServer: Server;

const factory: ServerFactory = {
  async start(cogitator, agents) {
    const koa = new Koa();
    const router = cogitatorApp({ cogitator, agents, enableSwagger: false });
    router.prefix('/cogitator');
    koa.use(router.routes());
    koa.use(router.allowedMethods());

    return new Promise((resolve) => {
      httpServer = koa.listen(0, () => {
        const addr = httpServer.address() as AddressInfo;
        resolve({ port: addr.port });
      });
    });
  },
  async stop() {
    return new Promise((resolve) => {
      httpServer?.close(() => resolve());
    });
  },
};

describeServerAdapter('Koa', factory);
describeResumeStream('Koa', factory);

describe('Koa adapter: workflow checkpoints', () => {
  let cogitator: Cogitator;
  let base: string;
  let checkpointServer: Server;
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
    const koa = new Koa();
    const router = cogitatorApp({
      cogitator,
      workflows: { shipping },
      enableSwagger: false,
      auth: (ctx) => ({ userId: ctx.get('x-user') }),
      workflowCheckpoints: store,
    });
    router.prefix('/cogitator');
    koa.use(router.routes());
    koa.use(router.allowedMethods());
    checkpointServer = await new Promise<Server>((resolve) => {
      const listening = koa.listen(0, () => resolve(listening));
    });
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
