import { describe, it, expect, vi, afterEach } from 'vitest';
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
    async getEntries({ threadId, before, limit }) {
      let list = entries.get(threadId) ?? [];
      if (before) list = list.filter((entry) => entry.createdAt < before);
      if (limit !== undefined) list = list.slice(-limit);
      return { success: true, data: list };
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

async function start(
  memory: ThreadMemory,
  auth?: AuthFunction,
  overrides: Partial<CogitatorPluginOptions> = {}
) {
  app = Fastify({ logger: false });
  await app.register(cogitatorPlugin, {
    cogitator: {
      memory,
      getMemory: async () => memory,
    } as unknown as CogitatorPluginOptions['cogitator'],
    prefix: '/api',
    auth,
    ...overrides,
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

describe('thread pages', () => {
  interface Page {
    messages: Array<{ role: string; content: string }>;
    nextCursor?: string;
  }

  async function seeded(count: number) {
    const { memory } = threadMemory();
    const server = await start(memory);
    for (let at = 1; at <= count; at++) {
      expect((await postMessage(server, 't1', undefined, `m${at}`)).statusCode).toBe(201);
    }
    return server;
  }

  const read = async (server: FastifyInstance, query = '') =>
    (await server.inject({ method: 'GET', url: `/api/threads/t1${query}` })).json<Page>();
  const contents = (page: Page) => page.messages.map((message) => message.content);

  it('reads a thread newest page first and walks back with nextCursor', async () => {
    const server = await seeded(5);

    const first = await read(server, '?limit=2');
    const second = await read(server, `?limit=2&cursor=${first.nextCursor}`);
    const last = await read(server, `?limit=2&cursor=${second.nextCursor}`);

    expect(contents(first)).toEqual(['m4', 'm5']);
    expect(contents(second)).toEqual(['m2', 'm3']);
    expect(contents(last)).toEqual(['m1']);
    expect(last.nextCursor).toBeUndefined();
  });

  it('answers the whole thread without a limit, messages as stored', async () => {
    const server = await seeded(3);
    const page = await read(server);
    expect(page.messages).toEqual([
      { role: 'user', content: 'm1' },
      { role: 'user', content: 'm2' },
      { role: 'user', content: 'm3' },
    ]);
    expect(page.nextCursor).toBeUndefined();
  });

  it.each([
    ['a limit of zero', 'limit=0', 'limit must be a whole number from 1 to 1000'],
    ['a fractional limit', 'limit=1.5', 'limit must be a whole number from 1 to 1000'],
    ['a limit over the maximum', 'limit=1001', 'limit must be a whole number from 1 to 1000'],
    ['a cursor the server never gave', 'cursor=not-a-cursor', 'cursor is not one this server gave'],
  ])('refuses %s with the shared message', async (_name, query, message) => {
    const server = await seeded(1);
    const res = await server.inject({ method: 'GET', url: `/api/threads/t1?${query}` });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toEqual({ error: { message, code: 'INVALID_INPUT' } });
  });
});

describe('authorizeThread', () => {
  it('refuses every thread route on a thread it keeps the caller from, leaving it untouched', async () => {
    const { memory, entries } = threadMemory();
    const authorizeThread = vi.fn((_auth: unknown, threadId: string) => threadId !== 'locked');
    const server = await start(memory, userFromHeader, { authorizeThread });
    await memory.addEntry({
      threadId: 'locked',
      message: { role: 'user', content: 'kept' },
      tokenCount: 0,
    });

    const answers = [
      await server.inject({ method: 'GET', url: '/api/threads/locked', headers: headers('alice') }),
      await postMessage(server, 'locked', 'alice', 'injected'),
      await server.inject({
        method: 'DELETE',
        url: '/api/threads/locked',
        headers: headers('alice'),
      }),
    ];

    for (const res of answers) {
      expect(res.statusCode).toBe(403);
      expect(res.json()).toEqual({
        error: { message: "Access to thread 'locked' is not allowed", code: 'THREAD_FORBIDDEN' },
      });
    }
    expect(entries.get('locked')).toHaveLength(1);
    expect(authorizeThread).toHaveBeenCalledWith({ userId: 'alice' }, 'locked');
  });

  it('lets the caller through to the threads it allows', async () => {
    const { memory } = threadMemory();
    const server = await start(memory, userFromHeader, { authorizeThread: () => true });
    expect((await postMessage(server, 'open', 'alice', 'hi')).statusCode).toBe(201);
    const res = await server.inject({
      method: 'GET',
      url: '/api/threads/open',
      headers: headers('alice'),
    });
    expect(res.statusCode).toBe(200);
  });
});

describe('anonymous policy', () => {
  it('refuses callers without a user id on the API under deny', async () => {
    const { memory } = threadMemory();
    const server = await start(memory, userFromHeader, { anonymous: 'deny' });

    const anonymous = await server.inject({ method: 'GET', url: '/api/threads/t1' });
    const known = await server.inject({
      method: 'GET',
      url: '/api/threads/t1',
      headers: headers('alice'),
    });

    expect(anonymous.statusCode).toBe(401);
    expect(anonymous.json()).toEqual({
      error: { message: 'Authentication required', code: 'UNAUTHORIZED' },
    });
    expect(known.statusCode).toBe(200);
  });

  it('keeps health, ready and the docs open under deny', async () => {
    const { memory } = threadMemory();
    const server = await start(memory, undefined, { anonymous: 'deny', enableSwagger: true });

    for (const url of ['/api/health', '/api/ready', '/api/docs/json', '/api/docs']) {
      const res = await server.inject({ method: 'GET', url });
      expect(res.statusCode, url).toBeLessThan(400);
    }
    expect((await server.inject({ method: 'GET', url: '/api/agents' })).statusCode).toBe(401);
  });

  it('lets anonymous callers in by default', async () => {
    const { memory } = threadMemory();
    const server = await start(memory);
    expect((await server.inject({ method: 'GET', url: '/api/threads/t1' })).statusCode).toBe(200);
  });

  it('answers an unknown path with 401 under deny, before telling whether it exists', async () => {
    const { memory } = threadMemory();
    const server = await start(memory, userFromHeader, { anonymous: 'deny' });

    const anonymous = await server.inject({ method: 'GET', url: '/api/no-such-route' });
    expect(anonymous.statusCode).toBe(401);
    expect(anonymous.json()).toEqual({
      error: { message: 'Authentication required', code: 'UNAUTHORIZED' },
    });

    const known = await server.inject({
      method: 'GET',
      url: '/api/no-such-route',
      headers: headers('alice'),
    });
    expect(known.statusCode).toBe(404);
    expect(known.json()).toEqual({ error: { message: 'Not found', code: 'NOT_FOUND' } });
  });

  it('answers an unknown path with 404 in the envelope under allow', async () => {
    const { memory } = threadMemory();
    const server = await start(memory);
    const res = await server.inject({ method: 'POST', url: '/api/no-such-route' });
    expect(res.statusCode).toBe(404);
    expect(res.json()).toEqual({ error: { message: 'Not found', code: 'NOT_FOUND' } });
  });
});
