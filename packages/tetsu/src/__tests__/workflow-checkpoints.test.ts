import { afterEach, describe, expect, spyOn, test } from 'bun:test';
import { createApp, httpError } from '@tetsujs/core';
import { serve } from '@tetsujs/core/testing';
import { openapi } from '@tetsujs/openapi';
import { assertDescribed } from '@tetsujs/openapi/testing';
import { InMemoryCheckpointStore, WorkflowBuilder } from '@cogitator-ai/workflows';
import type { Workflow, WorkflowState } from '@cogitator-ai/types';
import { cogitatorController } from '../index.js';
import { fakeCogitator, readStream } from './helpers.js';

interface Steps extends WorkflowState {
  steps: string[];
}

/** a, then b, which fails the first `failing` times it runs, then c */
function flakyWorkflow(failing: number) {
  const ran: string[] = [];
  let failures = failing;
  const step = (name: string) => async (ctx: { state: Steps }) => {
    ran.push(name);
    if (name === 'b' && failures-- > 0) throw new Error('b failed');
    return { state: { steps: [...ctx.state.steps, name] } };
  };
  const workflow = new WorkflowBuilder<Steps>('flaky')
    .initialState({ steps: [] })
    .addNode('a', step('a'))
    .addNode('b', step('b'), { after: ['a'] })
    .addNode('c', step('c'), { after: ['b'] })
    .build();
  return { workflow: workflow as unknown as Workflow<WorkflowState>, ran };
}

const other = new WorkflowBuilder<Steps>('other')
  .initialState({ steps: [] })
  .addNode('only', async () => ({ state: { steps: ['only'] } }))
  .build() as unknown as Workflow<WorkflowState>;

function start(store?: InMemoryCheckpointStore, failing = 1) {
  const flaky = flakyWorkflow(failing);
  const { cogitator } = fakeCogitator();
  const app = createApp({
    routes: cogitatorController({
      cogitator,
      workflows: { flaky: flaky.workflow, other },
      sseHeartbeatMs: 0,
      auth: (ctx) => {
        const user = ctx.req.headers.get('x-user');
        return user ? { userId: user } : {};
      },
      ...(store && { workflowCheckpoints: store }),
    }),
    reportError: () => undefined,
  });
  const request = serve(app);
  const post = (path: string, body: unknown, user?: string) =>
    request(path, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...(user && { 'x-user': user }) },
      body: JSON.stringify(body),
    });
  return { post, ran: flaky.ran, document: openapi(app, { info }).document };
}

const info = { title: 'Cogitator', version: '1.0.0' };

interface Event {
  type: string;
  event?: string;
  data?: Record<string, unknown>;
  code?: string;
}

interface ErrorAnswer {
  status: number;
  message: string;
  error: string;
  checkpointId?: string;
}

type Started = ReturnType<typeof start>;

async function streamed(res: Response): Promise<Event[]> {
  return (await readStream(res)).events as unknown as Event[];
}

/** Runs the flaky workflow with checkpoints as alice: it fails on b and answers its checkpoint */
async function failedRun({ post, document }: Started): Promise<string> {
  const res = await post('/workflows/flaky/run', { options: { checkpoint: true } }, 'alice');
  expect(res.status).toBe(500);
  await assertDescribed(document, 'POST /workflows/flaky/run', res);
  const body = (await res.json()) as ErrorAnswer;
  expect(body.error).toBe('INTERNAL_SERVER_ERROR');
  expect(body.checkpointId).toEqual(expect.any(String));
  return body.checkpointId!;
}

describe('workflow checkpoints', () => {
  let quiet: ReturnType<typeof spyOn> | undefined;

  afterEach(() => {
    quiet?.mockRestore();
    quiet = undefined;
  });

  test('answers a run with checkpoints with its last checkpoint, owned by the caller', async () => {
    const store = new InMemoryCheckpointStore();
    const { post, document } = start(store);

    const res = await post('/workflows/other/run', { options: { checkpoint: true } }, 'alice');
    expect(res.status).toBe(200);
    await assertDescribed(document, 'POST /workflows/other/run', res);
    const body = (await res.json()) as { checkpointId?: string };
    expect(body.checkpointId).toEqual(expect.any(String));
    expect(await store.load(String(body.checkpointId))).toMatchObject({ owner: 'alice' });
  });

  test('answers a failed run with its checkpoint, and resuming it finishes the nodes left', async () => {
    quiet = spyOn(console, 'error').mockImplementation(() => undefined);
    const store = new InMemoryCheckpointStore();
    const started = start(store);
    const { post, ran, document } = started;

    const checkpointId = await failedRun(started);
    expect(await store.load(checkpointId)).toMatchObject({
      owner: 'alice',
      completedNodes: ['a'],
    });

    const res = await post('/workflows/flaky/resume', { checkpointId }, 'alice');
    expect(res.status).toBe(200);
    await assertDescribed(document, 'POST /workflows/flaky/resume', res);
    const body = (await res.json()) as { state: Steps; checkpointId?: string };
    expect(body.state.steps).toEqual(['a', 'b', 'c']);
    expect(body.checkpointId).toEqual(expect.any(String));
    expect(await store.load(String(body.checkpointId))).toMatchObject({ owner: 'alice' });
    expect(ran).toEqual(['a', 'b', 'b', 'c']);
  });

  test('answers a failed resume with the checkpoint it can be resumed from again', async () => {
    quiet = spyOn(console, 'error').mockImplementation(() => undefined);
    const started = start(new InMemoryCheckpointStore(), 2);
    const checkpointId = await failedRun(started);

    const res = await started.post('/workflows/flaky/resume', { checkpointId }, 'alice');
    expect(res.status).toBe(500);
    await assertDescribed(started.document, 'POST /workflows/flaky/resume', res);
    expect(((await res.json()) as ErrorAnswer).checkpointId).toBe(checkpointId);
  });

  test('streams workflow_failed with the checkpoint before the error, and resumes over SSE', async () => {
    quiet = spyOn(console, 'error').mockImplementation(() => undefined);
    const { post } = start(new InMemoryCheckpointStore());

    const failed = await streamed(
      await post('/workflows/flaky/stream', { options: { checkpoint: true } }, 'alice')
    );
    const [failure, error] = failed.slice(-2);
    expect(failure).toMatchObject({ type: 'workflow', event: 'workflow_failed' });
    expect(error).toMatchObject({ type: 'error', code: 'INTERNAL_ERROR' });
    const checkpointId = failure?.data?.checkpointId;
    expect(checkpointId).toEqual(expect.any(String));

    const res = await post('/workflows/flaky/resume/stream', { checkpointId }, 'alice');
    expect(res.headers.get('content-type')).toContain('text/event-stream');
    const events = await streamed(res);
    const nodes = events
      .filter((event) => event.event === 'node_started')
      .map((event) => event.data?.nodeName);
    expect(nodes).toEqual(['b', 'c']);
    const completed = events.find((event) => event.event === 'workflow_completed');
    expect(completed?.data).toMatchObject({ checkpointId: expect.any(String) });
    expect(events.at(-1)?.type).toBe('finish');
  });

  test('answers an HttpError a node throws with its own status, plus the checkpoint', async () => {
    const conflict = new WorkflowBuilder<Steps>('conflict')
      .initialState({ steps: [] })
      .addNode('a', async () => ({ state: { steps: ['a'] } }))
      .addNode(
        'b',
        async () => {
          throw httpError(409, 'CONFLICT', 'The order changed meanwhile');
        },
        { after: ['a'] }
      )
      .build() as unknown as Workflow<WorkflowState>;
    const request = (store?: InMemoryCheckpointStore) =>
      serve(
        createApp({
          routes: cogitatorController({
            cogitator: fakeCogitator().cogitator,
            workflows: { conflict },
            ...(store && { workflowCheckpoints: store }),
          }),
          reportError: () => undefined,
        })
      )('/workflows/conflict/run', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(store ? { options: { checkpoint: true } } : {}),
      });

    const plain = await request();
    expect(plain.status).toBe(409);
    expect(await plain.json()).toMatchObject({ error: 'CONFLICT' });

    const checkpointed = await request(new InMemoryCheckpointStore());
    expect(checkpointed.status).toBe(409);
    expect(await checkpointed.json()).toMatchObject({
      error: 'CONFLICT',
      message: 'The order changed meanwhile',
      checkpointId: expect.any(String),
    });
  });

  test('names no checkpoint for a failed run that saved none', async () => {
    quiet = spyOn(console, 'error').mockImplementation(() => undefined);
    const { post } = start(new InMemoryCheckpointStore(), 2);

    const res = await post('/workflows/flaky/run', {}, 'alice');
    expect(res.status).toBe(500);
    expect((await res.json()) as ErrorAnswer).not.toHaveProperty('checkpointId');

    const events = await streamed(await post('/workflows/flaky/stream', {}, 'alice'));
    expect(events.at(-2)).toMatchObject({ event: 'workflow_failed', data: {} });
    expect(events.at(-1)?.type).toBe('error');
  });

  test('refuses the checkpoint of another user as unknown, before anything runs', async () => {
    quiet = spyOn(console, 'error').mockImplementation(() => undefined);
    const started = start(new InMemoryCheckpointStore());
    const { post, ran, document } = started;
    const checkpointId = await failedRun(started);

    for (const user of ['bob', undefined]) {
      const res = await post('/workflows/flaky/resume', { checkpointId }, user);
      expect(res.status).toBe(404);
      await assertDescribed(document, 'POST /workflows/flaky/resume', res);
      expect(((await res.json()) as ErrorAnswer).error).toBe('CHECKPOINT_NOT_FOUND');
    }
    const stream = await post('/workflows/flaky/resume/stream', { checkpointId }, 'bob');
    expect(stream.status).toBe(404);
    expect(((await stream.json()) as ErrorAnswer).error).toBe('CHECKPOINT_NOT_FOUND');
    expect(ran).toEqual(['a', 'b']);
  });

  test('refuses the checkpoint of another workflow and an unknown one with 404', async () => {
    const { post } = start(new InMemoryCheckpointStore());
    const run = await post('/workflows/other/run', { options: { checkpoint: true } }, 'alice');
    const { checkpointId } = (await run.json()) as { checkpointId: string };

    for (const id of [checkpointId, 'cp_missing']) {
      const res = await post('/workflows/flaky/resume', { checkpointId: id }, 'alice');
      expect(res.status).toBe(404);
      expect(((await res.json()) as ErrorAnswer).error).toBe('CHECKPOINT_NOT_FOUND');
    }
  });

  test('refuses checkpoints and answers every resume with 404 without a store', async () => {
    const { post } = start();

    const run = await post('/workflows/other/run', { options: { checkpoint: true } });
    expect(run.status).toBe(422);
    const resume = await post('/workflows/other/resume', { checkpointId: 'cp_1' });
    expect(resume.status).toBe(404);
    expect(((await resume.json()) as ErrorAnswer).error).toBe('CHECKPOINT_NOT_FOUND');
  });

  test('refuses a resume without a checkpointId', async () => {
    const { post } = start(new InMemoryCheckpointStore());
    const res = await post('/workflows/flaky/resume', {});
    expect(res.status).toBe(422);
    expect(((await res.json()) as ErrorAnswer).error).toBe('VALIDATION_FAILED');
  });
});
