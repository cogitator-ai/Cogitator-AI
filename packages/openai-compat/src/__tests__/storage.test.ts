import { describe, it, expect } from 'vitest';
import {
  InMemoryThreadStorage,
  RedisThreadStorage,
  PostgresThreadStorage,
  createThreadStorage,
} from '../client/storage';
import type { StoredThread, StoredAssistant } from '../client/thread-manager';

const makeThread = (id: string): StoredThread => ({
  thread: {
    id,
    object: 'thread',
    created_at: Math.floor(Date.now() / 1000),
    metadata: {},
  },
  messages: [],
});

const makeAssistant = (id: string): StoredAssistant => ({
  id,
  name: 'Test',
  model: 'gpt-4',
  instructions: null,
  tools: [],
  metadata: {},
  created_at: Math.floor(Date.now() / 1000),
});

describe('InMemoryThreadStorage', () => {
  describe('threads', () => {
    it('saves and loads a thread', async () => {
      const storage = new InMemoryThreadStorage();
      const thread = makeThread('thread_1');

      await storage.saveThread('thread_1', thread);
      const loaded = await storage.loadThread('thread_1');

      expect(loaded).toEqual(thread);
    });

    it('returns null for non-existent thread', async () => {
      const storage = new InMemoryThreadStorage();
      expect(await storage.loadThread('nope')).toBeNull();
    });

    it('deletes a thread', async () => {
      const storage = new InMemoryThreadStorage();
      await storage.saveThread('t1', makeThread('t1'));

      expect(await storage.deleteThread('t1')).toBe(true);
      expect(await storage.loadThread('t1')).toBeNull();
    });

    it('returns false when deleting non-existent thread', async () => {
      const storage = new InMemoryThreadStorage();
      expect(await storage.deleteThread('nope')).toBe(false);
    });

    it('lists all threads', async () => {
      const storage = new InMemoryThreadStorage();
      await storage.saveThread('t1', makeThread('t1'));
      await storage.saveThread('t2', makeThread('t2'));

      const list = await storage.listThreads();
      expect(list).toHaveLength(2);
    });
  });

  describe('assistants', () => {
    it('saves and loads an assistant', async () => {
      const storage = new InMemoryThreadStorage();
      const asst = makeAssistant('asst_1');

      await storage.saveAssistant('asst_1', asst);
      const loaded = await storage.loadAssistant('asst_1');

      expect(loaded).toEqual(asst);
    });

    it('returns null for non-existent assistant', async () => {
      const storage = new InMemoryThreadStorage();
      expect(await storage.loadAssistant('nope')).toBeNull();
    });

    it('deletes an assistant', async () => {
      const storage = new InMemoryThreadStorage();
      await storage.saveAssistant('a1', makeAssistant('a1'));

      expect(await storage.deleteAssistant('a1')).toBe(true);
      expect(await storage.loadAssistant('a1')).toBeNull();
    });

    it('lists all assistants', async () => {
      const storage = new InMemoryThreadStorage();
      await storage.saveAssistant('a1', makeAssistant('a1'));
      await storage.saveAssistant('a2', makeAssistant('a2'));

      const list = await storage.listAssistants();
      expect(list).toHaveLength(2);
    });
  });

  describe('files', () => {
    it('saves and loads a file', async () => {
      const storage = new InMemoryThreadStorage();
      const file = {
        id: 'file_1',
        content: Buffer.from('hello'),
        filename: 'test.txt',
        created_at: 123,
      };

      await storage.saveFile('file_1', file);
      const loaded = await storage.loadFile('file_1');

      expect(loaded).toEqual(file);
    });

    it('returns null for non-existent file', async () => {
      const storage = new InMemoryThreadStorage();
      expect(await storage.loadFile('nope')).toBeNull();
    });

    it('deletes a file', async () => {
      const storage = new InMemoryThreadStorage();
      await storage.saveFile('f1', {
        id: 'f1',
        content: Buffer.from('x'),
        filename: 'x.txt',
        created_at: 1,
      });

      expect(await storage.deleteFile('f1')).toBe(true);
      expect(await storage.loadFile('f1')).toBeNull();
    });

    it('lists all files', async () => {
      const storage = new InMemoryThreadStorage();
      await storage.saveFile('f1', {
        id: 'f1',
        content: Buffer.from('a'),
        filename: 'a.txt',
        created_at: 1,
      });
      await storage.saveFile('f2', {
        id: 'f2',
        content: Buffer.from('b'),
        filename: 'b.txt',
        created_at: 2,
      });

      const list = await storage.listFiles();
      expect(list).toHaveLength(2);
    });
  });
});

describe('PostgresThreadStorage', () => {
  it('rejects invalid schema names', () => {
    expect(
      () => new PostgresThreadStorage({ connectionString: 'x', schema: 'DROP TABLE' })
    ).toThrow('Invalid schema');
  });

  it('rejects invalid table names', () => {
    expect(
      () => new PostgresThreadStorage({ connectionString: 'x', tableName: '; DROP TABLE' })
    ).toThrow('Invalid tableName');
  });

  it('accepts valid identifiers', () => {
    expect(
      () =>
        new PostgresThreadStorage({
          connectionString: 'x',
          schema: 'my_schema',
          tableName: 'my_table_123',
        })
    ).not.toThrow();
  });

  it('throws when not connected', async () => {
    const storage = new PostgresThreadStorage({ connectionString: 'x' });
    await expect(storage.loadThread('t1')).rejects.toThrow('not connected');
  });
});

describe('RedisThreadStorage', () => {
  it('throws when not connected', async () => {
    const storage = new RedisThreadStorage();
    await expect(storage.loadThread('t1')).rejects.toThrow('not connected');
  });
});

describe('createThreadStorage', () => {
  it('creates InMemoryThreadStorage by default', () => {
    const storage = createThreadStorage();
    expect(storage).toBeInstanceOf(InMemoryThreadStorage);
  });

  it('creates InMemoryThreadStorage for type=memory', () => {
    const storage = createThreadStorage({ type: 'memory' });
    expect(storage).toBeInstanceOf(InMemoryThreadStorage);
  });

  it('creates RedisThreadStorage for type=redis', () => {
    const storage = createThreadStorage({ type: 'redis' });
    expect(storage).toBeInstanceOf(RedisThreadStorage);
  });

  it('creates PostgresThreadStorage for type=postgres', () => {
    const storage = createThreadStorage({
      type: 'postgres',
      connectionString: 'postgresql://localhost/test',
    });
    expect(storage).toBeInstanceOf(PostgresThreadStorage);
  });
});
