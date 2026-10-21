import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import type { MemoryAdapter, MemoryEntry, MemoryResult, Thread } from '@cogitator-ai/types';

/** A memory adapter under test. */
export interface MemoryAdapterConformanceTarget<T extends MemoryAdapter = MemoryAdapter> {
  /** A connected adapter. Cases only touch threads of their own, so it may be shared. */
  create(): Promise<T>;
  /** Called with each adapter `create` made once its case is done */
  release?(adapter: T): Promise<void>;
  /** Cases to leave out, with the reason */
  skip?: Partial<Record<MemoryAdapterScenario, string>>;
}

export type MemoryAdapterScenario =
  | 'thread-lifecycle'
  | 'missing-thread'
  | 'update-merges-metadata'
  | 'concurrent-updates'
  | 'entry-order'
  | 'entry-order-ties'
  | 'entry-limit-cuts-ties'
  | 'entry-limit'
  | 'entry-time-window'
  | 'tool-calls-on-request'
  | 'missing-not-null'
  | 'entry-needs-thread'
  | 'delete-entry'
  | 'clear-thread'
  | 'delete-thread-cascades'
  | 'returns-copies'
  | 'list-threads-filters'
  | 'list-threads-pages'
  | 'list-threads-refuses-bad-input'
  | 'list-threads-edges'
  | 'unserializable-values';

/** One case of the memory adapter contract. */
export interface MemoryAdapterConformanceCase {
  name: MemoryAdapterScenario;
  /** Why the case does not apply, when it does not */
  skip?: string;
  /** Runs the case; throws an `AssertionError` when the adapter breaks the contract */
  run(): Promise<void>;
}

function ok<T>(result: MemoryResult<T>, what: string): T {
  if (!result.success) assert.fail(`${what} failed: ${result.error}`);
  return result.data;
}

function refused<T>(result: MemoryResult<T>, what: string): void {
  assert.equal(result.success, false, `${what} should fail`);
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** A scope of its own for one case: ids no other case or run uses. */
function scope() {
  const tag = randomUUID().replace(/-/g, '').slice(0, 12);
  let next = 0;
  return {
    agentId: `conformance-agent-${tag}`,
    threadId: () => `conformance-thread-${tag}-${next++}`,
  };
}

function user(content: string) {
  return { role: 'user' as const, content };
}

function contents(entries: readonly MemoryEntry[]): string[] {
  return entries.map((entry) => String(entry.message.content));
}

async function newThread(
  adapter: MemoryAdapter,
  agentId: string,
  threadId: string,
  metadata: Record<string, unknown> = {}
): Promise<Thread> {
  return ok(await adapter.createThread(agentId, metadata, threadId), 'createThread');
}

async function addAll(adapter: MemoryAdapter, threadId: string, texts: readonly string[]) {
  const added: MemoryEntry[] = [];
  for (const text of texts) {
    added.push(
      ok(await adapter.addEntry({ threadId, message: user(text), tokenCount: 1 }), 'addEntry')
    );
  }
  return added;
}

function nullFields(value: object, path = ''): string[] {
  return Object.entries(value).flatMap(([key, field]) =>
    field === null
      ? [`${path}${key}`]
      : typeof field === 'object' && !(field instanceof Date) && !Array.isArray(field)
        ? nullFields(field as object, `${path}${key}.`)
        : []
  );
}

const SCENARIOS: Record<MemoryAdapterScenario, (adapter: MemoryAdapter) => Promise<void>> = {
  async 'thread-lifecycle'(adapter) {
    const { agentId, threadId } = scope();
    const id = threadId();
    const created = await newThread(adapter, agentId, id, { title: 'first', tags: ['a'] });
    assert.equal(created.id, id);
    assert.equal(created.agentId, agentId);
    assert.ok(created.createdAt instanceof Date && created.updatedAt instanceof Date);

    const read = ok(await adapter.getThread(id), 'getThread');
    assert.ok(read, 'the created thread is found');
    assert.deepEqual(read.metadata, { title: 'first', tags: ['a'] });
    assert.equal(read.agentId, agentId);

    await addAll(adapter, id, ['kept']);
    const again = await newThread(adapter, agentId, id, { title: 'second' });
    assert.deepEqual(again.metadata, { title: 'second' });
    const entries = ok(await adapter.getEntries({ threadId: id }), 'getEntries');
    assert.deepEqual(contents(entries), ['kept'], 'creating an existing thread keeps its entries');
  },

  async 'missing-thread'(adapter) {
    const { threadId } = scope();
    assert.equal(ok(await adapter.getThread(threadId()), 'getThread'), null);
    refused(await adapter.updateThread(threadId(), { a: 1 }), 'updateThread of a missing thread');
    assert.deepEqual(ok(await adapter.getEntries({ threadId: threadId() }), 'getEntries'), []);
  },

  async 'update-merges-metadata'(adapter) {
    const { agentId, threadId } = scope();
    const id = threadId();
    const created = await newThread(adapter, agentId, id, { a: 1, keep: 'yes' });
    await sleep(5);
    const updated = ok(await adapter.updateThread(id, { a: 2, b: true }), 'updateThread');
    assert.deepEqual(updated.metadata, { a: 2, keep: 'yes', b: true });
    assert.ok(updated.updatedAt.getTime() > created.updatedAt.getTime(), 'updatedAt moves on');
    const read = ok(await adapter.getThread(id), 'getThread');
    assert.deepEqual(read?.metadata, { a: 2, keep: 'yes', b: true });
  },

  async 'concurrent-updates'(adapter) {
    const { agentId, threadId } = scope();
    const id = threadId();
    await newThread(adapter, agentId, id, { base: true });
    const keys = Array.from({ length: 20 }, (_, i) => `k${i}`);
    const results = await Promise.all(keys.map((key, i) => adapter.updateThread(id, { [key]: i })));
    for (const result of results) ok(result, 'updateThread');
    const read = ok(await adapter.getThread(id), 'getThread');
    assert.ok(read);
    for (const [i, key] of keys.entries()) {
      assert.equal(read.metadata[key], i, `update of ${key} was lost`);
    }
    assert.equal(read.metadata.base, true);
  },

  async 'entry-order'(adapter) {
    const { agentId, threadId } = scope();
    const id = threadId();
    await newThread(adapter, agentId, id);
    await addAll(adapter, id, ['one', 'two', 'three', 'four', 'five']);
    const entries = ok(await adapter.getEntries({ threadId: id }), 'getEntries');
    assert.deepEqual(contents(entries), ['one', 'two', 'three', 'four', 'five']);
    for (let i = 1; i < entries.length; i++) {
      assert.ok(entries[i].createdAt.getTime() >= entries[i - 1].createdAt.getTime());
    }
  },

  async 'entry-order-ties'(adapter) {
    const { agentId, threadId } = scope();
    const id = threadId();
    await newThread(adapter, agentId, id);
    const at = new Date('2026-01-01T00:00:00.000Z');
    for (const text of ['first', 'second', 'third', 'fourth']) {
      ok(
        await adapter.addEntry({ threadId: id, message: user(text), tokenCount: 1, createdAt: at }),
        'addEntry'
      );
    }
    const entries = ok(await adapter.getEntries({ threadId: id }), 'getEntries');
    assert.deepEqual(
      contents(entries),
      ['first', 'second', 'third', 'fourth'],
      'entries with one creation time come back in the order they were added'
    );
  },

  async 'entry-limit-cuts-ties'(adapter) {
    const { agentId, threadId } = scope();
    const id = threadId();
    await newThread(adapter, agentId, id);
    const at = new Date('2026-01-01T00:00:00.000Z');
    const texts = Array.from({ length: 12 }, (_, i) => `t${i}`);
    for (const text of texts) {
      ok(
        await adapter.addEntry({ threadId: id, message: user(text), tokenCount: 1, createdAt: at }),
        'addEntry'
      );
    }
    assert.deepEqual(
      contents(ok(await adapter.getEntries({ threadId: id, limit: 3 }), 'getEntries')),
      ['t9', 't10', 't11'],
      'a limit keeps the entries added last among those with one creation time'
    );
  },

  async 'entry-limit'(adapter) {
    const { agentId, threadId } = scope();
    const id = threadId();
    await newThread(adapter, agentId, id);
    await addAll(adapter, id, ['one', 'two', 'three', 'four']);
    assert.deepEqual(
      contents(ok(await adapter.getEntries({ threadId: id, limit: 2 }), 'limit 2')),
      ['three', 'four']
    );
    assert.equal(ok(await adapter.getEntries({ threadId: id, limit: 0 }), 'limit 0').length, 4);
    assert.equal(ok(await adapter.getEntries({ threadId: id, limit: 10 }), 'limit 10').length, 4);
    refused(await adapter.getEntries({ threadId: id, limit: -1 }), 'a negative limit');
    refused(await adapter.getEntries({ threadId: id, limit: 1.5 }), 'a fractional limit');
  },

  async 'entry-time-window'(adapter) {
    const { agentId, threadId } = scope();
    const id = threadId();
    await newThread(adapter, agentId, id);
    const base = Date.UTC(2026, 0, 1);
    for (const [i, text] of ['one', 'two', 'three'].entries()) {
      ok(
        await adapter.addEntry({
          threadId: id,
          message: user(text),
          tokenCount: 1,
          createdAt: new Date(base + i * 1000),
        }),
        'addEntry'
      );
    }
    const after = ok(
      await adapter.getEntries({ threadId: id, after: new Date(base) }),
      'getEntries after'
    );
    assert.deepEqual(contents(after), ['two', 'three']);
    const before = ok(
      await adapter.getEntries({ threadId: id, before: new Date(base + 2000) }),
      'getEntries before'
    );
    assert.deepEqual(contents(before), ['one', 'two']);
  },

  async 'tool-calls-on-request'(adapter) {
    const { agentId, threadId } = scope();
    const id = threadId();
    await newThread(adapter, agentId, id);
    ok(
      await adapter.addEntry({
        threadId: id,
        message: { role: 'assistant', content: '' },
        tokenCount: 1,
        toolCalls: [{ id: 'call_1', name: 'search', arguments: { q: 'x' } }],
        toolResults: [{ callId: 'call_1', name: 'search', result: { hits: 1 } }],
      }),
      'addEntry'
    );
    const [plain] = ok(await adapter.getEntries({ threadId: id }), 'getEntries');
    assert.equal(plain.toolCalls, undefined);
    assert.equal(plain.toolResults, undefined);
    const [full] = ok(
      await adapter.getEntries({ threadId: id, includeToolCalls: true }),
      'getEntries with tool calls'
    );
    assert.deepEqual(full.toolCalls, [{ id: 'call_1', name: 'search', arguments: { q: 'x' } }]);
    assert.deepEqual(full.toolResults, [{ callId: 'call_1', name: 'search', result: { hits: 1 } }]);
  },

  async 'missing-not-null'(adapter) {
    const { agentId, threadId } = scope();
    const id = threadId();
    await newThread(adapter, agentId, id);
    const [added] = await addAll(adapter, id, ['plain']);
    const read = ok(await adapter.getEntry(added.id), 'getEntry');
    assert.ok(read, 'the added entry is found');
    for (const entry of [
      added,
      read,
      ...ok(await adapter.getEntries({ threadId: id, includeToolCalls: true }), 'getEntries'),
    ]) {
      assert.deepEqual(
        nullFields(entry),
        [],
        'a field that was never set comes back absent, not null'
      );
      assert.deepEqual(entry.metadata ?? {}, {});
    }
    assert.equal(ok(await adapter.getEntry(`missing-${randomUUID()}`), 'getEntry'), null);
  },

  async 'entry-needs-thread'(adapter) {
    const { threadId } = scope();
    refused(
      await adapter.addEntry({ threadId: threadId(), message: user('orphan'), tokenCount: 1 }),
      'addEntry into a thread that does not exist'
    );
  },

  async 'delete-entry'(adapter) {
    const { agentId, threadId } = scope();
    const id = threadId();
    await newThread(adapter, agentId, id);
    const [first] = await addAll(adapter, id, ['gone', 'stays']);
    ok(await adapter.deleteEntry(first.id), 'deleteEntry');
    assert.equal(ok(await adapter.getEntry(first.id), 'getEntry'), null);
    assert.deepEqual(contents(ok(await adapter.getEntries({ threadId: id }), 'getEntries')), [
      'stays',
    ]);
    ok(await adapter.deleteEntry(first.id), 'deleting a deleted entry');
  },

  async 'clear-thread'(adapter) {
    const { agentId, threadId } = scope();
    const id = threadId();
    await newThread(adapter, agentId, id, { kept: true });
    await addAll(adapter, id, ['one', 'two']);
    ok(await adapter.clearThread(id), 'clearThread');
    assert.deepEqual(ok(await adapter.getEntries({ threadId: id }), 'getEntries'), []);
    assert.deepEqual(ok(await adapter.getThread(id), 'getThread')?.metadata, { kept: true });
    await addAll(adapter, id, ['after']);
    assert.deepEqual(contents(ok(await adapter.getEntries({ threadId: id }), 'getEntries')), [
      'after',
    ]);
  },

  async 'delete-thread-cascades'(adapter) {
    const { agentId, threadId } = scope();
    const id = threadId();
    await newThread(adapter, agentId, id);
    const [entry] = await addAll(adapter, id, ['one']);
    ok(await adapter.deleteThread(id), 'deleteThread');
    assert.equal(ok(await adapter.getThread(id), 'getThread'), null);
    assert.equal(ok(await adapter.getEntry(entry.id), 'getEntry'), null);
    assert.deepEqual(ok(await adapter.getEntries({ threadId: id }), 'getEntries'), []);
    await newThread(adapter, agentId, id);
    assert.deepEqual(
      ok(await adapter.getEntries({ threadId: id }), 'getEntries'),
      [],
      'a thread made again under a deleted id starts empty'
    );
  },

  async 'returns-copies'(adapter) {
    const { agentId, threadId } = scope();
    const id = threadId();
    const created = await newThread(adapter, agentId, id, { nested: { value: 1 } });
    (created.metadata.nested as { value: number }).value = 99;
    const read = ok(await adapter.getThread(id), 'getThread');
    assert.ok(read);
    (read.metadata.nested as { value: number }).value = 98;
    read.metadata.added = true;
    assert.deepEqual(ok(await adapter.getThread(id), 'getThread')?.metadata, {
      nested: { value: 1 },
    });
    const [entry] = await addAll(adapter, id, ['text']);
    entry.message.content = 'changed';
    assert.deepEqual(contents(ok(await adapter.getEntries({ threadId: id }), 'getEntries')), [
      'text',
    ]);
  },

  async 'list-threads-filters'(adapter) {
    const { agentId, threadId } = scope();
    const other = `${agentId}-other`;
    const a = await newThread(adapter, agentId, threadId(), {
      userId: 'u1',
      archived: false,
      n: 1,
    });
    await newThread(adapter, agentId, threadId(), { userId: 'u2', archived: false, n: 2 });
    await newThread(adapter, other, threadId(), { userId: 'u1', archived: false, n: 1 });
    await sleep(20);
    const cutoff = new Date();
    await sleep(20);
    const late = await newThread(adapter, agentId, threadId(), { userId: 'u1', archived: true });

    const ids = async (options: Parameters<MemoryAdapter['listThreads']>[0]) =>
      ok(await adapter.listThreads(options), 'listThreads').threads.map((thread) => thread.id);

    assert.deepEqual((await ids({ agentId })).length, 3);
    assert.deepEqual(await ids({ agentId, metadata: { userId: 'u1' } }), [late.id, a.id]);
    assert.deepEqual(await ids({ agentId, metadata: { userId: 'u1', archived: false } }), [a.id]);
    assert.deepEqual(await ids({ agentId, metadata: { n: 1 } }), [a.id]);
    assert.deepEqual(await ids({ agentId, metadata: { n: '1' } }), [], 'values compare by type');
    assert.deepEqual(await ids({ agentId, updatedAfter: cutoff }), [late.id]);
    assert.deepEqual(await ids({ agentId, metadata: { userId: 'u1' }, order: 'asc' }), [
      a.id,
      late.id,
    ]);
    const [listed] = ok(await adapter.listThreads({ agentId: other }), 'listThreads').threads;
    assert.deepEqual(listed.metadata, { userId: 'u1', archived: false, n: 1 });
    assert.ok(listed.createdAt instanceof Date && listed.updatedAt instanceof Date);
  },

  async 'list-threads-pages'(adapter) {
    const { agentId, threadId } = scope();
    const made: string[] = [];
    for (let i = 0; i < 7; i++) made.push((await newThread(adapter, agentId, threadId())).id);
    for (const order of ['desc', 'asc'] as const) {
      const seen: string[] = [];
      let cursor: string | undefined;
      let pages = 0;
      do {
        const page = ok(
          await adapter.listThreads({ agentId, limit: 3, order, ...(cursor && { cursor }) }),
          'listThreads'
        );
        assert.ok(page.threads.length <= 3);
        seen.push(...page.threads.map((thread) => thread.id));
        cursor = page.nextCursor;
        pages++;
      } while (cursor && pages < 10);
      assert.equal(pages, 3, `${order}: seven threads in pages of three`);
      assert.deepEqual([...seen].sort(), [...made].sort(), `${order}: every thread once`);
    }
    const desc = ok(await adapter.listThreads({ agentId, limit: 7 }), 'listThreads').threads;
    for (let i = 1; i < desc.length; i++) {
      assert.ok(desc[i - 1].updatedAt.getTime() >= desc[i].updatedAt.getTime());
    }
    assert.equal(
      ok(await adapter.listThreads({ agentId, limit: 7 }), 'listThreads').nextCursor,
      undefined
    );
  },

  async 'list-threads-edges'(adapter) {
    const { agentId, threadId } = scope();
    const tag = `tag-${randomUUID()}`;
    const made: Thread[] = [];
    for (let i = 0; i < 6; i++) {
      made.push(await newThread(adapter, agentId, threadId(), { tag, 'a.b': i, list: ['x'] }));
    }
    const first = ok(await adapter.listThreads({ metadata: { tag }, limit: 3 }), 'listThreads');
    assert.equal(first.threads.length, 3);
    assert.ok(first.nextCursor, 'a full first page has a cursor');
    const second = ok(
      await adapter.listThreads({ metadata: { tag }, limit: 3, cursor: first.nextCursor }),
      'listThreads'
    );
    assert.equal(second.threads.length, 3);
    assert.equal(second.nextCursor, undefined, 'the page that ends the list has no cursor');

    const dotted = ok(
      await adapter.listThreads({ metadata: { tag, 'a.b': 2 } }),
      'listThreads with a dotted key'
    );
    assert.deepEqual(
      dotted.threads.map((thread) => thread.id),
      [made[2].id]
    );
    assert.deepEqual(
      ok(await adapter.listThreads({ metadata: { tag, list: 'x' } }), 'listThreads').threads,
      [],
      'an array does not match one of its items'
    );
    const newest = ok(await adapter.getThread(made[5].id), 'getThread');
    assert.ok(newest);
    const since = ok(
      await adapter.listThreads({ metadata: { tag }, updatedAfter: newest.updatedAt }),
      'listThreads'
    ).threads.map((thread) => thread.id);
    assert.ok(since.includes(made[5].id), 'updatedAfter takes in a thread updated at that time');
  },

  async 'unserializable-values'(adapter) {
    const { agentId, threadId } = scope();
    const id = threadId();
    const withFunction = { label: 'kept', run: () => 'not storable' };
    let created: MemoryResult<Thread>;
    try {
      created = await adapter.createThread(agentId, withFunction, id);
    } catch (error) {
      assert.fail(`createThread threw instead of returning a result: ${String(error)}`);
    }
    if (!created.success) return;
    const read = ok(await adapter.getThread(id), 'getThread');
    assert.equal(read?.metadata.label, 'kept');
    try {
      await adapter.addEntry({
        threadId: id,
        message: { role: 'tool', content: 'done', toolCallId: 'c1', name: 'x' },
        tokenCount: 1,
        toolResults: [{ callId: 'c1', name: 'x', result: { ok: true, fn: () => 1 } }],
      });
    } catch (error) {
      assert.fail(`addEntry threw instead of returning a result: ${String(error)}`);
    }
  },

  async 'list-threads-refuses-bad-input'(adapter) {
    refused(await adapter.listThreads({ limit: 0 }), 'listThreads with limit 0');
    refused(await adapter.listThreads({ limit: 501 }), 'listThreads above the page limit');
    refused(await adapter.listThreads({ cursor: 'not a cursor' }), 'listThreads with a bad cursor');
    refused(
      await adapter.listThreads({ metadata: { "a'b": 'x' } }),
      'listThreads with a metadata key that is not a plain name'
    );
  },
};

/**
 * The cases of the memory adapter contract, each against an adapter `target` makes. Framework
 * agnostic, so any test runner can run them:
 *
 * ```ts
 * for (const c of memoryAdapterConformanceCases(target)) {
 *   (c.skip ? it.skip : it)(c.name, () => c.run());
 * }
 * ```
 */
export function memoryAdapterConformanceCases<T extends MemoryAdapter>(
  target: MemoryAdapterConformanceTarget<T>
): MemoryAdapterConformanceCase[] {
  return (Object.keys(SCENARIOS) as MemoryAdapterScenario[]).map((name) => {
    const skip = target.skip?.[name];
    return {
      name,
      ...(skip && { skip }),
      run: async () => {
        const adapter = await target.create();
        try {
          await SCENARIOS[name](adapter);
        } finally {
          await target.release?.(adapter);
        }
      },
    };
  });
}
