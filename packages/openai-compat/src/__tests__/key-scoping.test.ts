import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createHash } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import type { Cogitator } from '@cogitator-ai/core';
import type { Agent, RunOptions, RunResult } from '@cogitator-ai/types';
import { OpenAIServer } from '../server/api-server';
import { apiKeyOwner } from '../server/middleware/auth';
import { InMemoryThreadStorage } from '../client/storage';
import type { Run, RunStep, Thread } from '../types/openai-types';

let release: (() => void) | undefined;
let holdRuns = false;

const cogitator = {
  run: async (agent: Agent, options: RunOptions) => {
    if (holdRuns) {
      await new Promise<void>((resolve) => {
        release = resolve;
        options.signal?.addEventListener('abort', () => resolve());
      });
    }
    return {
      output: 'answer',
      runId: 'run',
      agentId: agent.id,
      threadId: options.threadId ?? 'thread',
      usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2, cost: 0, duration: 1 },
      toolCalls: [],
      messages: [],
      trace: { traceId: 't', spans: [] },
    } as unknown as RunResult;
  },
} as unknown as Cogitator;

const KEY_A = 'sk-key-a';
const KEY_B = 'sk-key-b';

describe('threads and runs scoped to the API key', () => {
  let server: OpenAIServer;
  let fastify: FastifyInstance;
  let storage: InMemoryThreadStorage;
  let assistantId: string;

  async function call(
    key: string,
    method: 'GET' | 'POST' | 'DELETE',
    url: string,
    payload?: Record<string, unknown>
  ) {
    return fastify.inject({
      method,
      url,
      headers: { authorization: `Bearer ${key}` },
      ...(payload && { payload }),
    });
  }

  async function finishedRun(key: string, threadId: string): Promise<Run> {
    const created = await call(key, 'POST', `/v1/threads/${threadId}/runs`, {
      assistant_id: assistantId,
    });
    expect(created.statusCode).toBe(201);
    const run = created.json<Run>();
    for (let i = 0; i < 100; i++) {
      const polled = (await call(key, 'GET', `/v1/threads/${threadId}/runs/${run.id}`)).json<Run>();
      if (polled.status === 'completed') return polled;
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    throw new Error(`run ${run.id} did not complete`);
  }

  beforeAll(async () => {
    storage = new InMemoryThreadStorage();
    server = new OpenAIServer(cogitator, { apiKeys: [KEY_A, KEY_B], storage });
    await server.waitUntilReady();
    fastify = server.getFastify();
    const assistant = await call(KEY_A, 'POST', '/v1/assistants', { model: 'm' });
    assistantId = assistant.json<{ id: string }>().id;
  });

  afterAll(async () => {
    await fastify.close();
  });

  it('stores the digest of the key with the thread, never the key', async () => {
    const created = await call(KEY_A, 'POST', '/v1/threads', {});
    const thread = created.json<Thread>();
    const stored = await storage.loadThread(thread.id);

    expect(stored?.owner).toBe(createHash('sha256').update(KEY_A).digest('hex'));
    expect(stored?.owner).toBe(apiKeyOwner(KEY_A));
    expect(JSON.stringify(stored)).not.toContain(KEY_A);
    expect(thread).not.toHaveProperty('owner');
  });

  it('answers 404 to another key for the thread and its messages', async () => {
    const thread = (
      await call(KEY_A, 'POST', '/v1/threads', {
        messages: [{ role: 'user', content: 'secret' }],
      })
    ).json<Thread>();
    const messages = (await call(KEY_A, 'GET', `/v1/threads/${thread.id}/messages`)).json<{
      data: { id: string }[];
    }>();
    const messageId = messages.data[0].id;
    const base = `/v1/threads/${thread.id}`;

    const refused = await Promise.all([
      call(KEY_B, 'GET', base),
      call(KEY_B, 'POST', base, { metadata: { hijacked: 'yes' } }),
      call(KEY_B, 'DELETE', base),
      call(KEY_B, 'POST', `${base}/messages`, { role: 'user', content: 'injected' }),
      call(KEY_B, 'GET', `${base}/messages`),
      call(KEY_B, 'GET', `${base}/messages/${messageId}`),
      call(KEY_B, 'POST', `${base}/runs`, { assistant_id: assistantId }),
      call(KEY_B, 'GET', `${base}/runs`),
    ]);

    for (const response of refused) {
      expect(response.statusCode).toBe(404);
      expect(response.json()).toMatchObject({ error: { code: 'not_found' } });
    }
    const own = await call(KEY_A, 'GET', `${base}/messages`);
    expect(own.json<{ data: unknown[] }>().data).toHaveLength(1);
    expect((await call(KEY_A, 'GET', base)).json<Thread>().metadata).toEqual({});
  });

  it('answers 404 to another key for the run and its steps', async () => {
    const thread = (
      await call(KEY_A, 'POST', '/v1/threads', {
        messages: [{ role: 'user', content: 'hi' }],
      })
    ).json<Thread>();
    const run = await finishedRun(KEY_A, thread.id);
    const steps = (await call(KEY_A, 'GET', `/v1/threads/${thread.id}/runs/${run.id}/steps`)).json<{
      data: RunStep[];
    }>();
    const base = `/v1/threads/${thread.id}/runs/${run.id}`;

    const refused = await Promise.all([
      call(KEY_B, 'GET', base),
      call(KEY_B, 'POST', `${base}/cancel`),
      call(KEY_B, 'POST', `${base}/submit_tool_outputs`, { tool_outputs: [] }),
      call(KEY_B, 'GET', `${base}/steps`),
      call(KEY_B, 'GET', `${base}/steps/${steps.data[0].id}`),
    ]);

    expect(steps.data).toHaveLength(1);
    for (const response of refused) expect(response.statusCode).toBe(404);
    expect(server.getAdapter().getRun(thread.id, run.id, apiKeyOwner(KEY_B))).toBeUndefined();
    expect(server.getAdapter().getRun(thread.id, run.id)).toBeDefined();
  });

  it('scopes threads created together with a run', async () => {
    const created = await call(KEY_A, 'POST', '/v1/threads/runs', {
      assistant_id: assistantId,
      thread: { messages: [{ role: 'user', content: 'hi' }] },
    });
    const run = created.json<Run>();

    expect((await call(KEY_B, 'GET', `/v1/threads/${run.thread_id}`)).statusCode).toBe(404);
    expect((await call(KEY_A, 'GET', `/v1/threads/${run.thread_id}`)).statusCode).toBe(200);
  });

  it('keeps threads stored without an owner reachable by every key, but not each other runs', async () => {
    const legacy: Thread = { id: 'thread_legacy', object: 'thread', created_at: 1, metadata: {} };
    await storage.saveThread(legacy.id, { thread: legacy, messages: [] });
    await call(KEY_A, 'POST', `/v1/threads/${legacy.id}/messages`, {
      role: 'user',
      content: 'from A',
    });

    const seenByB = await call(KEY_B, 'GET', `/v1/threads/${legacy.id}/messages`);
    expect(seenByB.statusCode).toBe(200);
    expect(seenByB.json<{ data: unknown[] }>().data).toHaveLength(1);

    const runOfA = await finishedRun(KEY_A, legacy.id);
    const runsSeenByB = await call(KEY_B, 'GET', `/v1/threads/${legacy.id}/runs`);
    const runsSeenByA = await call(KEY_A, 'GET', `/v1/threads/${legacy.id}/runs`);

    expect(runsSeenByB.json<{ data: Run[] }>().data).toEqual([]);
    expect(runsSeenByA.json<{ data: Run[] }>().data.map((r) => r.id)).toEqual([runOfA.id]);
    expect(
      (await call(KEY_B, 'GET', `/v1/threads/${legacy.id}/runs/${runOfA.id}`)).statusCode
    ).toBe(404);
    expect((await storage.loadThread(legacy.id))?.owner).toBeUndefined();
  });

  it('does not name the active run of another key on a shared thread', async () => {
    const legacy: Thread = { id: 'thread_shared', object: 'thread', created_at: 1, metadata: {} };
    await storage.saveThread(legacy.id, {
      thread: legacy,
      messages: [],
    });
    await call(KEY_A, 'POST', `/v1/threads/${legacy.id}/messages`, { role: 'user', content: 'x' });
    holdRuns = true;
    try {
      const first = await call(KEY_A, 'POST', `/v1/threads/${legacy.id}/runs`, {
        assistant_id: assistantId,
      });
      const runId = first.json<Run>().id;

      const fromB = await call(KEY_B, 'POST', `/v1/threads/${legacy.id}/runs`, {
        assistant_id: assistantId,
      });
      const fromA = await call(KEY_A, 'POST', `/v1/threads/${legacy.id}/runs`, {
        assistant_id: assistantId,
      });

      expect(fromB.statusCode).toBe(400);
      expect(fromB.body).not.toContain(runId);
      expect(fromA.statusCode).toBe(400);
      expect(fromA.body).toContain(runId);
    } finally {
      holdRuns = false;
      release?.();
    }
  });

  it('lists the threads of one key from storage for operators', async () => {
    const page = await server
      .getAdapter()
      .getThreadManager()
      .listThreads({ owner: apiKeyOwner(KEY_B) });

    expect(page.threads).toEqual([]);
    const ofA = await server
      .getAdapter()
      .getThreadManager()
      .listThreads({ owner: apiKeyOwner(KEY_A), limit: 500 });
    expect(ofA.threads.length).toBeGreaterThan(0);
    expect(ofA.threads.every((stored) => stored.owner === apiKeyOwner(KEY_A))).toBe(true);
  });
});
