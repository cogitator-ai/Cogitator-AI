import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import type {
  MemoryEntity,
  MemoryItem,
  MemoryItemAdapter,
  MemoryItemScope,
  MemoryResult,
} from '@cogitator-ai/types';

/** A memory item adapter under test. */
export interface MemoryItemAdapterConformanceTarget<
  T extends MemoryItemAdapter = MemoryItemAdapter,
> {
  /** A connected adapter. Cases only touch agents of their own, so it may be shared. */
  create(): Promise<T>;
  /** Called with each adapter `create` made once its case is done */
  release?(adapter: T): Promise<void>;
  /** Cases to leave out, with the reason */
  skip?: Partial<Record<MemoryItemAdapterScenario, string>>;
}

export type MemoryItemAdapterScenario =
  | 'item-round-trip'
  | 'item-without-optional-fields'
  | 'item-replaced-by-id'
  | 'missing-item-is-null'
  | 'find-filters'
  | 'find-visible-to'
  | 'find-scope'
  | 'find-order'
  | 'find-expired'
  | 'delete-items'
  | 'count-retrieved'
  | 'returns-copies'
  | 'entity-round-trip'
  | 'entity-names'
  | 'delete-entities';

/** One case of the memory item adapter contract. */
export interface MemoryItemAdapterConformanceCase {
  name: MemoryItemAdapterScenario;
  /** Why the case does not apply, when it does not */
  skip?: string;
  /** Runs the case; throws an `AssertionError` when the adapter breaks the contract */
  run(): Promise<void>;
}

function ok<T>(result: MemoryResult<T>, what: string): T {
  if (!result.success) assert.fail(`${what} failed: ${result.error}`);
  return result.data;
}

/** Ids no other case or run uses */
function scope() {
  const tag = randomUUID().replace(/-/g, '').slice(0, 12);
  let next = 0;
  return {
    agentId: `conformance-agent-${tag}`,
    id: (prefix: string) => `${prefix}-${tag}-${next++}`,
  };
}

const at = (minute: number) => new Date(Date.UTC(2026, 0, 1, 0, minute));

function item(agentId: string, id: string, fields: Partial<MemoryItem> = {}): MemoryItem {
  return {
    id,
    kind: 'fact',
    content: `item ${id}`,
    status: 'active',
    trust: 'user',
    confidence: 0.9,
    scope: { agentId },
    evidence: [],
    verified: true,
    saidAt: at(0),
    sessionAt: at(0),
    recordedAt: at(0),
    ...fields,
  };
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

const ids = (items: readonly { id: string }[]) => items.map((found) => found.id);

/** Items of one agent in each scope the scope filters tell apart */
function scopedItems(agentId: string, id: (prefix: string) => string) {
  const scoped = (prefix: string, narrowed: Omit<MemoryItemScope, 'agentId'>) =>
    item(agentId, id(prefix), { scope: { agentId, ...narrowed } });
  return {
    agentWide: scoped('agent-wide', {}),
    u1: { ...scoped('u1', { userId: 'u1' }), status: 'suggested' as const },
    u2: scoped('u2', { userId: 'u2' }),
    u1Thread: scoped('u1-thread', { userId: 'u1', threadId: 't1' }),
    u1Project: scoped('u1-project', { userId: 'u1', projectId: 'p1' }),
  };
}

const SCENARIOS: Record<MemoryItemAdapterScenario, (adapter: MemoryItemAdapter) => Promise<void>> =
  {
    async 'item-round-trip'(adapter) {
      const { agentId, id } = scope();
      const full = item(agentId, id('item'), {
        kind: 'preference',
        content: 'Ana prefers window seats on long flights',
        subject: 'Ana',
        entityId: id('entity'),
        attribute: 'seat',
        value: 'window',
        slot: 'ana:seat',
        status: 'superseded',
        trust: 'model',
        confidence: 0.42,
        scope: { agentId, userId: 'u1', projectId: 'p1', threadId: 't1' },
        evidence: [
          { entryId: 'e1', quote: 'window seat please' },
          { entryId: 'e2', toolCallId: 'c1', quote: 'ok' },
        ],
        verified: false,
        saidAt: at(1),
        sessionAt: at(2),
        about: { text: 'last Friday', start: at(3), end: at(4), precision: 'day' },
        validFrom: at(5),
        validTo: at(6),
        recordedAt: at(7),
        expiredAt: at(8),
        supersedes: ['old-1', 'old-2'],
        supersededBy: 'new-1',
        timesRetrieved: 3,
        lastRetrievedAt: at(9),
        metadata: { source: 'conformance', nested: { n: 1 } },
      });
      ok(await adapter.putItem(full), 'putItem');

      const read = ok(await adapter.getItem(full.id), 'getItem');
      assert.deepEqual(read, full);
      for (const date of [
        read?.saidAt,
        read?.about?.start,
        read?.validTo,
        read?.expiredAt,
        read?.lastRetrievedAt,
      ]) {
        assert.ok(date instanceof Date, 'dates come back as dates');
      }
    },

    async 'item-without-optional-fields'(adapter) {
      const { agentId, id } = scope();
      const bare = item(agentId, id('item'), { about: { precision: 'approximate', text: 'once' } });
      ok(await adapter.putItem(bare), 'putItem');

      const read = ok(await adapter.getItem(bare.id), 'getItem');
      assert.ok(read);
      assert.deepEqual(nullFields(read), [], 'a field never set is absent, not null');
      assert.deepEqual(read, bare);
    },

    async 'item-replaced-by-id'(adapter) {
      const { agentId, id } = scope();
      const first = item(agentId, id('item'));
      ok(await adapter.putItem(first), 'putItem');
      ok(
        await adapter.putItem({ ...first, status: 'superseded', validTo: at(9) }),
        'putItem again'
      );

      const found = ok(await adapter.findItems({ agentId }), 'findItems');
      assert.deepEqual(ids(found), [first.id], 'one item per id');
      assert.equal(found[0]?.status, 'superseded');
      assert.deepEqual(found[0]?.validTo, at(9));
    },

    async 'missing-item-is-null'(adapter) {
      assert.equal(ok(await adapter.getItem(`missing-${randomUUID()}`), 'getItem'), null);
    },

    async 'find-filters'(adapter) {
      const { agentId, id } = scope();
      const other = scope();
      const plain = item(agentId, id('plain'));
      const slotted = item(agentId, id('slotted'), { slot: 'ana:city', entityId: 'ent-1' });
      const event = item(agentId, id('event'), { kind: 'event', status: 'suggested' });
      const foreign = item(other.agentId, other.id('foreign'), { slot: 'ana:city' });
      for (const written of [plain, slotted, event, foreign]) {
        ok(await adapter.putItem(written), 'putItem');
      }

      const find = async (filter: Omit<Parameters<MemoryItemAdapter['findItems']>[0], 'agentId'>) =>
        ids(ok(await adapter.findItems({ agentId, ...filter }), 'findItems')).sort();

      assert.deepEqual(
        await find({}),
        ids([plain, slotted, event]).sort(),
        'only the agent asked for'
      );
      assert.deepEqual(await find({ ids: [plain.id, foreign.id] }), [plain.id]);
      assert.deepEqual(await find({ slots: ['ana:city'] }), [slotted.id]);
      assert.deepEqual(await find({ entityIds: ['ent-1'] }), [slotted.id]);
      assert.deepEqual(await find({ kinds: ['event'] }), [event.id]);
      assert.deepEqual(await find({ statuses: ['suggested'] }), [event.id]);
      assert.deepEqual(
        await find({ kinds: ['fact'], statuses: ['active'] }),
        ids([plain, slotted]).sort()
      );
      assert.deepEqual(
        await find({ slots: ['ana:city'], kinds: ['event'] }),
        [],
        'every condition holds'
      );
    },

    async 'find-visible-to'(adapter) {
      const { agentId, id } = scope();
      const other = scope();
      const items = scopedItems(agentId, id);
      const foreign = item(other.agentId, other.id('foreign'), {
        scope: { agentId: other.agentId, userId: 'u1' },
      });
      for (const written of [...Object.values(items), foreign]) {
        ok(await adapter.putItem(written), 'putItem');
      }

      const visibleTo = async (narrowed: Omit<MemoryItemScope, 'agentId'>) =>
        ids(
          ok(await adapter.findItems({ agentId, visibleTo: { agentId, ...narrowed } }), 'findItems')
        ).sort();
      const { agentWide, u1, u2, u1Thread, u1Project } = items;

      assert.deepEqual(
        await visibleTo({}),
        [agentWide.id],
        'a scope without a user sees only agent-wide items'
      );
      assert.deepEqual(await visibleTo({ userId: 'u1' }), ids([agentWide, u1]).sort());
      assert.deepEqual(await visibleTo({ userId: 'u2' }), ids([agentWide, u2]).sort());
      assert.deepEqual(
        await visibleTo({ userId: 'u1', threadId: 't1' }),
        ids([agentWide, u1, u1Thread]).sort(),
        'a thread sees its own items and those of its user'
      );
      assert.deepEqual(
        await visibleTo({ userId: 'u1', projectId: 'p1' }),
        ids([agentWide, u1, u1Project]).sort()
      );
      assert.deepEqual(
        await visibleTo({ userId: 'u1', projectId: 'p1', threadId: 't1' }),
        ids([agentWide, u1, u1Thread, u1Project]).sort()
      );
      assert.deepEqual(
        await visibleTo({ threadId: 't1' }),
        [agentWide.id],
        'an item of a user is not seen without that user'
      );
      assert.deepEqual(
        ids(
          ok(
            await adapter.findItems({
              agentId,
              visibleTo: { agentId, userId: 'u1' },
              statuses: ['suggested'],
            }),
            'findItems'
          )
        ),
        [u1.id],
        'with the other conditions'
      );
    },

    async 'find-scope'(adapter) {
      const { agentId, id } = scope();
      const items = scopedItems(agentId, id);
      for (const written of Object.values(items)) ok(await adapter.putItem(written), 'putItem');

      const exactly = async (narrowed: Omit<MemoryItemScope, 'agentId'>) =>
        ids(ok(await adapter.findItems({ agentId, scope: { agentId, ...narrowed } }), 'findItems'));
      const { agentWide, u1, u2, u1Thread, u1Project } = items;

      assert.deepEqual(await exactly({}), [agentWide.id], 'an absent field matches only absent');
      assert.deepEqual(await exactly({ userId: 'u1' }), [u1.id]);
      assert.deepEqual(await exactly({ userId: 'u2' }), [u2.id]);
      assert.deepEqual(await exactly({ userId: 'u1', threadId: 't1' }), [u1Thread.id]);
      assert.deepEqual(await exactly({ userId: 'u1', projectId: 'p1' }), [u1Project.id]);
      assert.deepEqual(await exactly({ threadId: 't1' }), []);
      assert.deepEqual(await exactly({ userId: 'u3' }), []);
    },

    async 'find-order'(adapter) {
      const { agentId, id } = scope();
      const late = item(agentId, id('b'), { recordedAt: at(3) });
      const early = item(agentId, id('c'), { recordedAt: at(1) });
      const tieB = item(agentId, `${id('tie')}-b`, { recordedAt: at(2) });
      const tieA = item(agentId, tieB.id.replace(/-b$/, '-a'), { recordedAt: at(2) });
      for (const written of [late, tieB, early, tieA])
        ok(await adapter.putItem(written), 'putItem');

      const found = ok(await adapter.findItems({ agentId }), 'findItems');
      assert.deepEqual(
        ids(found),
        [early.id, tieA.id, tieB.id, late.id],
        'oldest recorded first, then by id'
      );
    },

    async 'find-expired'(adapter) {
      const { agentId, id } = scope();
      const kept = item(agentId, id('kept'));
      const gone = item(agentId, id('gone'), { expiredAt: at(5) });
      const later = item(agentId, id('later'), {
        expiredAt: new Date(Date.now() + 365 * 24 * 3600_000),
      });
      for (const written of [kept, gone, later]) ok(await adapter.putItem(written), 'putItem');

      assert.deepEqual(
        ids(ok(await adapter.findItems({ agentId }), 'findItems')).sort(),
        [kept.id, later.id].sort(),
        'an item let go at a time still to come is found'
      );
      assert.deepEqual(
        ids(ok(await adapter.findItems({ agentId, includeExpired: true }), 'findItems')).sort(),
        [kept.id, gone.id, later.id].sort()
      );
    },

    async 'delete-items'(adapter) {
      const { agentId, id } = scope();
      const a = item(agentId, id('a'));
      const b = item(agentId, id('b'));
      for (const written of [a, b]) ok(await adapter.putItem(written), 'putItem');

      ok(await adapter.deleteItems([a.id, `missing-${randomUUID()}`]), 'deleteItems');
      assert.equal(ok(await adapter.getItem(a.id), 'getItem'), null);
      assert.deepEqual(ids(ok(await adapter.findItems({ agentId }), 'findItems')), [b.id]);
      ok(await adapter.deleteItems([]), 'deleteItems of nothing');
    },

    async 'count-retrieved'(adapter) {
      if (!adapter.countRetrieved) return;
      const { agentId, id } = scope();
      const counted = item(agentId, id('counted'), {
        evidence: [{ entryId: 'e1', quote: 'q' }],
        expiredAt: at(5),
      });
      const gone = item(agentId, id('gone'));
      for (const written of [counted, gone]) ok(await adapter.putItem(written), 'putItem');
      ok(await adapter.deleteItems([gone.id]), 'deleteItems');

      ok(await adapter.countRetrieved([counted.id, gone.id, counted.id], at(10)), 'countRetrieved');
      ok(await adapter.countRetrieved([counted.id], at(20)), 'countRetrieved');

      assert.equal(ok(await adapter.getItem(gone.id), 'getItem'), null);
      assert.deepEqual(ok(await adapter.getItem(counted.id), 'getItem'), {
        ...counted,
        timesRetrieved: 2,
        lastRetrievedAt: at(20),
      });
      ok(await adapter.countRetrieved([], at(30)), 'countRetrieved of nothing');
    },

    async 'returns-copies'(adapter) {
      const { agentId, id } = scope();
      const written = item(agentId, id('item'), { evidence: [{ entryId: 'e1', quote: 'q' }] });
      const put = ok(await adapter.putItem(written), 'putItem');
      put.evidence.push({ entryId: 'e2', quote: 'changed' });
      written.evidence.push({ entryId: 'e3', quote: 'changed too' });
      const read = ok(await adapter.getItem(written.id), 'getItem');
      read?.evidence.push({ entryId: 'e4', quote: 'and again' });

      const again = ok(await adapter.getItem(written.id), 'getItem');
      assert.deepEqual(again?.evidence, [{ entryId: 'e1', quote: 'q' }]);
    },

    async 'entity-round-trip'(adapter) {
      const { agentId, id } = scope();
      const entity: MemoryEntity = {
        id: id('entity'),
        scope: { agentId, userId: 'u1' },
        name: 'Ana Lima',
        aliases: ['Ana', 'Dr. Lima'],
        type: 'person',
        firstSeenAt: at(1),
        lastSeenAt: at(2),
      };
      ok(await adapter.putEntity(entity), 'putEntity');
      ok(await adapter.putEntity({ ...entity, lastSeenAt: at(5) }), 'putEntity again');

      const found = ok(await adapter.findEntities({ agentId, ids: [entity.id] }), 'findEntities');
      assert.deepEqual(found, [{ ...entity, lastSeenAt: at(5) }]);
      const bare: MemoryEntity = {
        id: id('bare'),
        scope: { agentId },
        name: 'Lisbon',
        aliases: [],
        firstSeenAt: at(1),
        lastSeenAt: at(1),
      };
      ok(await adapter.putEntity(bare), 'putEntity');
      const [read] = ok(await adapter.findEntities({ agentId, ids: [bare.id] }), 'findEntities');
      assert.ok(read);
      assert.deepEqual(nullFields(read), [], 'a field never set is absent, not null');
      assert.deepEqual(read, bare);
    },

    async 'entity-names'(adapter) {
      const { agentId, id } = scope();
      const other = scope();
      const tower: MemoryEntity = {
        id: id('tower'),
        scope: { agentId },
        name: 'The Eiffel Tower',
        aliases: ['Tour  Eiffel'],
        firstSeenAt: at(1),
        lastSeenAt: at(1),
      };
      const foreign = { ...tower, id: other.id('tower'), scope: { agentId: other.agentId } };
      for (const written of [tower, foreign]) ok(await adapter.putEntity(written), 'putEntity');

      const byName = async (names: string[]) =>
        ids(ok(await adapter.findEntities({ agentId, names }), 'findEntities'));
      assert.deepEqual(await byName(['eiffel tower']), [tower.id], 'by its name, normalized');
      assert.deepEqual(await byName(['tour eiffel']), [tower.id], 'by an alias, normalized');
      assert.deepEqual(
        await byName(['the eiffel tower', 'louvre']),
        [],
        'names are matched normalized'
      );
      assert.deepEqual(await byName(['louvre']), []);
    },

    async 'delete-entities'(adapter) {
      const { agentId, id } = scope();
      const entity: MemoryEntity = {
        id: id('entity'),
        scope: { agentId },
        name: 'Porto',
        aliases: [],
        firstSeenAt: at(1),
        lastSeenAt: at(1),
      };
      ok(await adapter.putEntity(entity), 'putEntity');
      ok(await adapter.deleteEntities([entity.id]), 'deleteEntities');
      assert.deepEqual(ok(await adapter.findEntities({ agentId }), 'findEntities'), []);
      ok(await adapter.deleteEntities([]), 'deleteEntities of nothing');
    },
  };

/**
 * The cases of the memory item adapter contract, each against an adapter `target` makes.
 * Framework agnostic, so any test runner can run them:
 *
 * ```ts
 * for (const c of memoryItemAdapterConformanceCases(target)) {
 *   (c.skip ? it.skip : it)(c.name, () => c.run());
 * }
 * ```
 */
export function memoryItemAdapterConformanceCases<T extends MemoryItemAdapter>(
  target: MemoryItemAdapterConformanceTarget<T>
): MemoryItemAdapterConformanceCase[] {
  return (Object.keys(SCENARIOS) as MemoryItemAdapterScenario[]).map((name) => {
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
