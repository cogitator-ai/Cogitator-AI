import { describe, it, expect, vi, afterEach } from 'vitest';
import Koa from 'koa';
import type { Server } from 'http';
import type { AddressInfo } from 'net';
import { InMemoryCheckpointStore, WorkflowBuilder } from '@cogitator-ai/workflows';
import type { WorkflowState } from '@cogitator-ai/types';
import { cogitatorApp } from '../app.js';
import type { CogitatorAppOptions, CogitatorState } from '../types.js';

type Options = CogitatorAppOptions;

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
  return { workflow, ran };
}

const other = new WorkflowBuilder<Steps>('other')
  .initialState({ steps: [] })
  .addNode('only', async () => ({ state: { steps: ['only'] } }))
  .build();

let server: Server | undefined;

afterEach(async () => {
  vi.restoreAllMocks();
  if (server) await new Promise<void>((resolve) => server!.close(() => resolve()));
  server = undefined;
});

async function start(store?: InMemoryCheckpointStore, failing = 1) {
  const flaky = flakyWorkflow(failing);
  const app = new Koa<CogitatorState>();
  const router = cogitatorApp({
    cogitator: {} as unknown as Options['cogitator'],
    workflows: { flaky: flaky.workflow, other } as unknown as Options['workflows'],
    sseHeartbeatMs: 0,
    auth: (ctx) => {
      const user = ctx.get('x-user');
      return user ? { userId: user } : undefined;
    },
    ...(store && { workflowCheckpoints: store }),
  });
  app.use(router.routes());
  app.use(router.allowedMethods());
  server = await new Promise<Server>((resolve) => {
    const listening = app.listen(0, () => resolve(listening));
  });
  const { port } = server.address() as AddressInfo;
  const post = (path: string, body: unknown, user?: string) =>
    fetch(`http://127.0.0.1:${port}${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...(user && { 'x-user': user }) },
      body: JSON.stringify(body),
    });
  return { post, ran: flaky.ran };
}

interface Event {
  type: string;
  event?: string;
  data?: Record<string, unknown>;
  code?: string;
}

function events(raw: string): Event[] {
  return raw
    .split('\n')
    .filter((line) => line.startsWith('data: ') && line !== 'data: [DONE]')
    .map((line) => JSON.parse(line.slice(6)) as Event);
}

interface ErrorAnswer {
  error: { code: string; message: string; checkpointId?: string };
}

type Post = Awaited<ReturnType<typeof start>>['post'];

/** Runs the flaky workflow with checkpoints as alice: it fails on b and answers its checkpoint */
async function failedRun(post: Post): Promise<string> {
  const res = await post('/workflows/flaky/run', { options: { checkpoint: true } }, 'alice');
  expect(res.status).toBe(500);
  const { error } = (await res.json()) as ErrorAnswer;
  expect(error.code).toBe('INTERNAL_ERROR');
  expect(error.checkpointId).toEqual(expect.any(String));
  return error.checkpointId!;
}

describe('workflow checkpoints', () => {
  it('answers a run with checkpoints with its last checkpoint, owned by the caller', async () => {
    const store = new InMemoryCheckpointStore();
    const { post } = await start(store);

    const res = await post('/workflows/other/run', { options: { checkpoint: true } }, 'alice');
    expect(res.status).toBe(200);
    const body = (await res.json()) as { checkpointId?: string };
    expect(body.checkpointId).toEqual(expect.any(String));
    expect(await store.load(body.checkpointId!)).toMatchObject({ owner: 'alice' });
  });

  it('answers a failed run with its checkpoint, and resuming it finishes the nodes left', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const store = new InMemoryCheckpointStore();
    const { post, ran } = await start(store);

    const checkpointId = await failedRun(post);
    expect(await store.load(checkpointId)).toMatchObject({
      owner: 'alice',
      completedNodes: ['a'],
    });

    const res = await post('/workflows/flaky/resume', { checkpointId }, 'alice');
    expect(res.status).toBe(200);
    const body = (await res.json()) as { state: Steps; checkpointId?: string };
    expect(body.state.steps).toEqual(['a', 'b', 'c']);
    expect(body.checkpointId).toEqual(expect.any(String));
    expect(ran).toEqual(['a', 'b', 'b', 'c']);
  });

  it('answers a failed resume with the checkpoint it can be resumed from again', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const { post } = await start(new InMemoryCheckpointStore(), 2);
    const checkpointId = await failedRun(post);

    const res = await post('/workflows/flaky/resume', { checkpointId }, 'alice');
    expect(res.status).toBe(500);
    expect(((await res.json()) as ErrorAnswer).error.checkpointId).toBe(checkpointId);
  });

  it('streams workflow_failed with the checkpoint before the error, and resumes over SSE', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const { post } = await start(new InMemoryCheckpointStore());

    const failed = events(
      await (
        await post('/workflows/flaky/stream', { options: { checkpoint: true } }, 'alice')
      ).text()
    );
    const [failure, error] = failed.slice(-2);
    expect(failure).toMatchObject({ type: 'workflow', event: 'workflow_failed' });
    expect(error).toMatchObject({ type: 'error', code: 'INTERNAL_ERROR' });
    const checkpointId = failure?.data?.checkpointId;
    expect(checkpointId).toEqual(expect.any(String));

    const res = await post('/workflows/flaky/resume/stream', { checkpointId }, 'alice');
    expect(res.headers.get('content-type')).toContain('text/event-stream');
    const streamed = events(await res.text());
    const started = streamed
      .filter((event) => event.event === 'node_started')
      .map((event) => event.data?.nodeName);
    expect(started).toEqual(['b', 'c']);
    const completed = streamed.find((event) => event.event === 'workflow_completed');
    expect(completed?.data).toMatchObject({ checkpointId: expect.any(String) });
    expect(streamed.at(-1)?.type).toBe('finish');
  });

  it('names no checkpoint for a failed run that saved none', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const { post } = await start(new InMemoryCheckpointStore(), 2);

    const res = await post('/workflows/flaky/run', {}, 'alice');
    expect(res.status).toBe(500);
    expect(((await res.json()) as ErrorAnswer).error).not.toHaveProperty('checkpointId');

    const streamed = events(await (await post('/workflows/flaky/stream', {}, 'alice')).text());
    expect(streamed.at(-2)).toMatchObject({ event: 'workflow_failed', data: {} });
    expect(streamed.at(-1)?.type).toBe('error');
  });

  it('refuses the checkpoint of another user as unknown, before anything runs', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const { post, ran } = await start(new InMemoryCheckpointStore());
    const checkpointId = await failedRun(post);

    for (const user of ['bob', undefined]) {
      const res = await post('/workflows/flaky/resume', { checkpointId }, user);
      expect(res.status).toBe(404);
      expect(((await res.json()) as ErrorAnswer).error.code).toBe('CHECKPOINT_NOT_FOUND');
    }
    const stream = await post('/workflows/flaky/resume/stream', { checkpointId }, 'bob');
    expect(stream.status).toBe(404);
    expect(stream.headers.get('content-type')).toContain('application/json');
    expect(ran).toEqual(['a', 'b']);
  });

  it('refuses the checkpoint of another workflow and an unknown one with 404', async () => {
    const { post } = await start(new InMemoryCheckpointStore());
    const run = await post('/workflows/other/run', { options: { checkpoint: true } }, 'alice');
    const { checkpointId } = (await run.json()) as { checkpointId: string };

    for (const id of [checkpointId, 'cp_missing']) {
      const res = await post('/workflows/flaky/resume', { checkpointId: id }, 'alice');
      expect(res.status).toBe(404);
      expect(((await res.json()) as ErrorAnswer).error.code).toBe('CHECKPOINT_NOT_FOUND');
    }
  });

  it('refuses checkpoints and answers every resume with 404 without a store', async () => {
    const { post } = await start();

    const run = await post('/workflows/other/run', { options: { checkpoint: true } });
    expect(run.status).toBe(400);
    const resume = await post('/workflows/other/resume', { checkpointId: 'cp_1' });
    expect(resume.status).toBe(404);
    expect(((await resume.json()) as ErrorAnswer).error.code).toBe('CHECKPOINT_NOT_FOUND');
  });

  it('refuses a resume without a checkpointId with 400', async () => {
    const { post } = await start(new InMemoryCheckpointStore());
    const res = await post('/workflows/flaky/resume', {});
    expect(res.status).toBe(400);
    expect(((await res.json()) as ErrorAnswer).error.message).toBe(
      'Missing required field: checkpointId'
    );
  });
});
