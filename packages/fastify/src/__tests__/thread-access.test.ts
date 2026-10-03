import { describe, it, expect, afterEach } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import type { MemoryAdapter, MemoryEntry, Thread } from '@cogitator-ai/types';
import { cogitatorPlugin } from '../plugin.js';
import type { AuthFunction, CogitatorPluginOptions } from '../types.js';

type ThreadMemory = Pick<
  MemoryAdapter,
  'createThread' | 'getThread' | 'addEntry' | 'getEntries' | 'clearThread'
>;

function threadMemory() {
  const threads = new Map<string, Thread>();
  const entries = new Map<string, MemoryEntry[]>();
  let sequence = 0;

  const memory: ThreadMemory = {
    async createThread(agentId, metadata = {}, threadId = `thread_${++sequence}`) {
      const now = new Date();
      const thread: Thread = { id: threadId, agentId, metadata, createdAt: now, updatedAt: now };
      threads.set(threadId, thread);
      return { success: true, data: thread };
    },
    async getThread(threadId) {
      return { success: true, data: threads.get(threadId) ?? null };
    },
    async addEntry(entry) {
      const stored: MemoryEntry = { ...entry, id: `entry_${++sequence}`, createdAt: new Date() };
      entries.set(entry.threadId, [...(entries.get(entry.threadId) ?? []), stored]);
      return { success: true, data: stored };
    },
    async getEntries({ threadId }) {
      return { success: true, data: entries.get(threadId) ?? [] };
    },
    async clearThread(threadId) {
      entries.delete(threadId);
      return { success: true, data: undefined };
    },
  };

  return { memory, threads, entries };
}

const userFromHeader: AuthFunction = (request) => {
  const user = request.headers['x-user'];
  return typeof user === 'string' ? { userId: user } : undefined;
};

let app: FastifyInstance | undefined;

afterEach(async () => {
  await app?.close();
  app = undefined;
});

async function start(memory: ThreadMemory, auth?: AuthFunction) {
  app = Fastify({ logger: false });
  await app.register(cogitatorPlugin, {
    cogitator: { memory } as unknown as CogitatorPluginOptions['cogitator'],
    prefix: '/api',
    auth,
  });
  await app.ready();
  return app;
}

function headers(user: string | undefined): Record<string, string> {
  return user ? { 'x-user': user } : {};
}

function postMessage(
  server: FastifyInstance,
  threadId: string,
  user: string | undefined,
  content: string
) {
  return server.inject({
    method: 'POST',
    url: `/api/threads/${threadId}/messages`,
    headers: headers(user),
    payload: { role: 'user', content },
  });
}

describe('thread routes ownership', () => {
  it('lets the owner read their own thread', async () => {
    const { memory } = threadMemory();
    const server = await start(memory, userFromHeader);

    expect((await postMessage(server, 't1', 'alice', 'hello')).statusCode).toBe(201);
    const res = await server.inject({
      method: 'GET',
      url: '/api/threads/t1',
      headers: headers('alice'),
    });

    expect(res.statusCode).toBe(200);
    const body = res.json<{ id: string; messages: Array<{ content: string }> }>();
    expect(body.id).toBe('t1');
    expect(body.messages.map((m) => m.content)).toEqual(['hello']);
  });

  it('creates a thread owned by the caller on the first message', async () => {
    const { memory, threads } = threadMemory();
    const server = await start(memory, userFromHeader);

    const res = await postMessage(server, 'fresh', 'alice', 'hi');

    expect(res.statusCode).toBe(201);
    expect(threads.get('fresh')).toMatchObject({
      id: 'fresh',
      agentId: '',
      metadata: { agentId: '', userId: 'alice' },
    });
  });

  it("answers 403 THREAD_ACCESS_DENIED for another user's thread and leaves it untouched", async () => {
    const { memory, entries } = threadMemory();
    const server = await start(memory, userFromHeader);
    await postMessage(server, 't1', 'alice', 'secret');

    const read = await server.inject({
      method: 'GET',
      url: '/api/threads/t1',
      headers: headers('bob'),
    });
    const write = await postMessage(server, 't1', 'bob', 'injected');
    const remove = await server.inject({
      method: 'DELETE',
      url: '/api/threads/t1',
      headers: headers('bob'),
    });

    for (const res of [read, write, remove]) {
      expect(res.statusCode).toBe(403);
      expect(res.json<{ error: { code: string } }>().error.code).toBe('THREAD_ACCESS_DENIED');
    }
    expect(entries.get('t1')?.map((e) => e.message.content)).toEqual(['secret']);
  });

  it('denies an anonymous caller access to an owned thread', async () => {
    const { memory } = threadMemory();
    const server = await start(memory, userFromHeader);
    await postMessage(server, 't1', 'alice', 'secret');

    const res = await server.inject({ method: 'GET', url: '/api/threads/t1' });

    expect(res.statusCode).toBe(403);
  });

  it('keeps ownerless threads open when no auth is configured', async () => {
    const { memory, threads, entries } = threadMemory();
    await memory.createThread('bot', {}, 'legacy');
    const server = await start(memory);

    const write = await postMessage(server, 'legacy', undefined, 'hello');
    const read = await server.inject({ method: 'GET', url: '/api/threads/legacy' });
    const fresh = await postMessage(server, 'fresh', undefined, 'hi');
    const remove = await server.inject({ method: 'DELETE', url: '/api/threads/legacy' });

    expect(write.statusCode).toBe(201);
    expect(read.statusCode).toBe(200);
    expect(read.json<{ messages: unknown[] }>().messages).toHaveLength(1);
    expect(fresh.statusCode).toBe(201);
    expect(threads.get('fresh')?.metadata).toEqual({ agentId: '' });
    expect(remove.statusCode).toBe(204);
    expect(entries.has('legacy')).toBe(false);
  });

  it('returns an empty thread for an unknown id', async () => {
    const { memory } = threadMemory();
    const server = await start(memory, userFromHeader);

    const res = await server.inject({
      method: 'GET',
      url: '/api/threads/missing',
      headers: headers('alice'),
    });

    expect(res.statusCode).toBe(200);
    expect(res.json<{ messages: unknown[] }>().messages).toEqual([]);
  });
});
