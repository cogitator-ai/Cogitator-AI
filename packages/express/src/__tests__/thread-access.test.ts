import { describe, it, expect, afterEach } from 'vitest';
import express from 'express';
import type { Request } from 'express';
import type { Server } from 'http';
import type { AddressInfo } from 'net';
import type { MemoryAdapter, MemoryEntry, Thread } from '@cogitator-ai/types';
import { Cogitator } from '@cogitator-ai/core';
import { CogitatorServer } from '../server.js';
import type { AuthFunction, CogitatorServerConfig } from '../types.js';

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

const userFromHeader: AuthFunction = (req: Request) => {
  const user = req.header('x-user');
  return user ? { userId: user } : undefined;
};

let server: Server | undefined;

async function start(memory: ThreadMemory, auth?: AuthFunction) {
  const app = express();
  const srv = new CogitatorServer({
    app,
    cogitator: {
      memory,
      getMemory: async () => memory,
    } as unknown as CogitatorServerConfig['cogitator'],
    config: { basePath: '/api', enableSwagger: false, auth },
  });
  await srv.init();
  server = await new Promise<Server>((resolve) => {
    const s = app.listen(0, () => resolve(s));
  });
  const { port } = server.address() as AddressInfo;
  return `http://127.0.0.1:${port}/api`;
}

afterEach(async () => {
  if (server) await new Promise<void>((resolve) => server!.close(() => resolve()));
  server = undefined;
});

function as(user: string | undefined, init: RequestInit = {}): RequestInit {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (user) headers['x-user'] = user;
  return { ...init, headers };
}

function postMessage(base: string, threadId: string, user: string | undefined, content: string) {
  return fetch(
    `${base}/threads/${threadId}/messages`,
    as(user, { method: 'POST', body: JSON.stringify({ role: 'user', content }) })
  );
}

describe('thread routes ownership', () => {
  it('lets the owner read their own thread', async () => {
    const { memory } = threadMemory();
    const base = await start(memory, userFromHeader);

    expect((await postMessage(base, 't1', 'alice', 'hello')).status).toBe(201);
    const res = await fetch(`${base}/threads/t1`, as('alice'));

    expect(res.status).toBe(200);
    const body = (await res.json()) as { id: string; messages: Array<{ content: string }> };
    expect(body.id).toBe('t1');
    expect(body.messages.map((m) => m.content)).toEqual(['hello']);
  });

  it('creates a thread owned by the caller on the first message', async () => {
    const { memory, threads } = threadMemory();
    const base = await start(memory, userFromHeader);

    const res = await postMessage(base, 'fresh', 'alice', 'hi');

    expect(res.status).toBe(201);
    expect(threads.get('fresh')).toMatchObject({
      id: 'fresh',
      agentId: '',
      metadata: { agentId: '', userId: 'alice' },
    });
  });

  it("answers 403 THREAD_ACCESS_DENIED for another user's thread and leaves it untouched", async () => {
    const { memory, entries } = threadMemory();
    const base = await start(memory, userFromHeader);
    await postMessage(base, 't1', 'alice', 'secret');

    const read = await fetch(`${base}/threads/t1`, as('bob'));
    const write = await postMessage(base, 't1', 'bob', 'injected');
    const remove = await fetch(`${base}/threads/t1`, as('bob', { method: 'DELETE' }));

    for (const res of [read, write, remove]) {
      expect(res.status).toBe(403);
      const body = (await res.json()) as { error: { code: string } };
      expect(body.error.code).toBe('THREAD_ACCESS_DENIED');
    }
    expect(entries.get('t1')?.map((e) => e.message.content)).toEqual(['secret']);
  });

  it('denies an anonymous caller access to an owned thread', async () => {
    const { memory } = threadMemory();
    const base = await start(memory, userFromHeader);
    await postMessage(base, 't1', 'alice', 'secret');

    const res = await fetch(`${base}/threads/t1`, as(undefined));

    expect(res.status).toBe(403);
  });

  it('keeps ownerless threads open when no auth is configured', async () => {
    const { memory, threads, entries } = threadMemory();
    await memory.createThread('bot', {}, 'legacy');
    const base = await start(memory);

    const write = await postMessage(base, 'legacy', undefined, 'hello');
    const read = await fetch(`${base}/threads/legacy`);
    const fresh = await postMessage(base, 'fresh', undefined, 'hi');
    const remove = await fetch(`${base}/threads/legacy`, { method: 'DELETE' });

    expect(write.status).toBe(201);
    expect(read.status).toBe(200);
    expect(((await read.json()) as { messages: unknown[] }).messages).toHaveLength(1);
    expect(fresh.status).toBe(201);
    expect(threads.get('fresh')?.metadata).toEqual({ agentId: '' });
    expect(remove.status).toBe(204);
    expect(entries.has('legacy')).toBe(false);
  });

  it('returns an empty thread for an unknown id', async () => {
    const { memory } = threadMemory();
    const base = await start(memory, userFromHeader);

    const res = await fetch(`${base}/threads/missing`, as('alice'));

    expect(res.status).toBe(200);
    expect(((await res.json()) as { messages: unknown[] }).messages).toEqual([]);
  });
});

describe('threads before any run', () => {
  it('connect the configured memory instead of answering 503', async () => {
    const cogitator = new Cogitator({ memory: { adapter: 'memory' } });
    const app = express();
    await new CogitatorServer({
      app,
      cogitator,
      config: { basePath: '/api', enableSwagger: false },
    }).init();
    server = await new Promise<Server>((resolve) => {
      const s = app.listen(0, () => resolve(s));
    });
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api`;

    const added = await postMessage(base, 'fresh', undefined, 'hello');
    const thread = await fetch(`${base}/threads/fresh`);

    expect(added.status).toBe(201);
    expect(thread.status).toBe(200);
    expect((await thread.json()).messages).toHaveLength(1);
    await cogitator.close();
  });
});
