import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import {
  MEMORY_FILE_CONFLICT,
  type MemoryFileAdapter,
  type MemoryFileVersion,
  type MemoryItemScope,
  type MemoryResult,
} from '@cogitator-ai/types';

/** A memory file adapter under test. */
export interface MemoryFileAdapterConformanceTarget<
  T extends MemoryFileAdapter = MemoryFileAdapter,
> {
  /** A connected adapter. Cases only touch agents of their own, so it may be shared. */
  create(): Promise<T>;
  /** Called with each adapter `create` made once its case is done */
  release?(adapter: T): Promise<void>;
  /** Cases to leave out, with the reason */
  skip?: Partial<Record<MemoryFileAdapterScenario, string>>;
}

export type MemoryFileAdapterScenario =
  | 'file-round-trip'
  | 'file-place-taken'
  | 'file-place-race'
  | 'file-batch-whole-or-none'
  | 'file-find-filters'
  | 'file-find-visible-to'
  | 'file-find-heads'
  | 'file-redact'
  | 'file-delete'
  | 'file-returns-copies';

/** One case of the memory file adapter contract. */
export interface MemoryFileAdapterConformanceCase {
  name: MemoryFileAdapterScenario;
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

function version(
  agentId: string,
  id: string,
  fields: Partial<MemoryFileVersion> = {}
): MemoryFileVersion {
  return {
    id,
    scope: { agentId, userId: 'u1' },
    path: '/memories/notes.md',
    sequence: 1,
    content: `content of ${id}`,
    sha256: 'a'.repeat(64),
    previousId: null,
    author: 'model',
    createdAt: at(1),
    ...fields,
  };
}

const ids = (versions: readonly { id: string }[]) => versions.map((found) => found.id);

const SCENARIOS: Record<MemoryFileAdapterScenario, (adapter: MemoryFileAdapter) => Promise<void>> =
  {
    async 'file-round-trip'(adapter) {
      const { agentId, id } = scope();
      const full = version(agentId, id('full'), {
        scope: { agentId, userId: 'u1', projectId: 'p1', threadId: 't1' },
        path: '/memories/plan/trip.md',
        sequence: 2,
        previousId: 'previous-version',
        place: { threadId: 't1', entryId: 'e1' },
        renamedFrom: '/memories/trip.md',
        author: 'user',
        createdAt: at(5),
      });
      const deletion = version(agentId, id('deletion'), {
        sequence: 1,
        content: null,
        sha256: null,
        createdAt: at(6),
      });
      ok(await adapter.putFileVersions([full, deletion]), 'putFileVersions');

      const found = ok(await adapter.findFileVersions({ agentId }), 'findFileVersions');
      assert.deepEqual(found, [full, deletion]);
      assert.ok(found[0]?.createdAt instanceof Date, 'createdAt comes back as a date');
    },

    async 'file-place-taken'(adapter) {
      const { agentId, id } = scope();
      const first = version(agentId, id('first'));
      ok(await adapter.putFileVersions([first]), 'putFileVersions');

      const again = await adapter.putFileVersions([version(agentId, id('again'))]);
      assert.equal(again.success, false, 'a second version in a taken place is refused');
      assert.equal(!again.success && again.error, MEMORY_FILE_CONFLICT);

      const elsewhere = [
        version(agentId, id('other-path'), { path: '/memories/other.md' }),
        version(agentId, id('other-user'), { scope: { agentId, userId: 'u2' } }),
        version(agentId, id('agent-wide'), { scope: { agentId } }),
        version(agentId, id('next'), { sequence: 2 }),
      ];
      ok(await adapter.putFileVersions(elsewhere), 'putFileVersions of free places');
      assert.equal(ok(await adapter.findFileVersions({ agentId }), 'findFileVersions').length, 5);
    },

    async 'file-place-race'(adapter) {
      const { agentId, id } = scope();
      const results = await Promise.all(
        Array.from({ length: 5 }, (_, at) =>
          adapter.putFileVersions([version(agentId, id(`racer-${at}`))])
        )
      );

      assert.equal(
        results.filter((result) => result.success).length,
        1,
        'one of writers racing for one place gets it'
      );
      for (const result of results) {
        if (!result.success) assert.equal(result.error, MEMORY_FILE_CONFLICT);
      }
      assert.equal(ok(await adapter.findFileVersions({ agentId }), 'findFileVersions').length, 1);
    },

    async 'file-batch-whole-or-none'(adapter) {
      const { agentId, id } = scope();
      ok(await adapter.putFileVersions([version(agentId, id('kept'))]), 'putFileVersions');

      const batch = await adapter.putFileVersions([
        version(agentId, id('new'), { path: '/memories/new.md' }),
        version(agentId, id('clash')),
      ]);

      assert.equal(!batch.success && batch.error, MEMORY_FILE_CONFLICT);
      const found = ok(await adapter.findFileVersions({ agentId }), 'findFileVersions');
      assert.deepEqual(
        found.map((kept) => kept.path),
        ['/memories/notes.md'],
        'no version of a refused batch is kept'
      );
      ok(await adapter.putFileVersions([]), 'putFileVersions of nothing');
    },

    async 'file-find-filters'(adapter) {
      const { agentId, id } = scope();
      const a = version(agentId, id('a'), { path: '/memories/notes/a.md', createdAt: at(1) });
      const b = version(agentId, id('b'), { path: '/memories/notes/b.md', createdAt: at(2) });
      const c = version(agentId, id('c'), { path: '/memories/other.md', createdAt: at(3) });
      const a2 = version(agentId, id('a2'), {
        path: '/memories/notes/a.md',
        sequence: 2,
        createdAt: at(1),
      });
      ok(await adapter.putFileVersions([c, a2, b, a]), 'putFileVersions');

      const find = async (filter: Parameters<MemoryFileAdapter['findFileVersions']>[0]) =>
        ids(ok(await adapter.findFileVersions(filter), 'findFileVersions'));
      assert.deepEqual(await find({ agentId }), [a.id, a2.id, b.id, c.id], 'oldest first');
      assert.deepEqual(await find({ agentId, paths: ['/memories/notes/a.md'] }), [a.id, a2.id]);
      assert.deepEqual(await find({ agentId, prefix: '/memories/notes/' }), [a.id, a2.id, b.id]);
      assert.deepEqual(await find({ agentId, ids: [c.id, b.id] }), [b.id, c.id]);
      assert.deepEqual(await find({ agentId, ids: [] }), []);
      const emoji = version(agentId, id('emoji'), {
        path: '/memories/\u{1F600}/x.md',
        createdAt: at(4),
      });
      ok(await adapter.putFileVersions([emoji]), 'putFileVersions');
      assert.deepEqual(
        await find({ agentId, prefix: '/memories/\u{1F600}/' }),
        [emoji.id],
        'a prefix with a character outside the basic plane'
      );
      assert.deepEqual(await find({ agentId: `${agentId}-other` }), []);
    },

    async 'file-find-heads'(adapter) {
      if (!adapter.findFileHeads) return;
      const { agentId, id } = scope();
      const user = { agentId, userId: 'u1' };
      const agent = { agentId };
      const v = (name: string, fields: Partial<MemoryFileVersion>) =>
        version(agentId, id(name), { scope: user, ...fields });
      const first = v('first', { sequence: 1, createdAt: at(1) });
      const second = v('second', { sequence: 2, createdAt: at(2) });
      const onOther = v('other-branch', {
        sequence: 3,
        createdAt: at(3),
        place: { threadId: 't1', entryId: 'e-other' },
      });
      const onMine = v('my-branch', {
        sequence: 4,
        createdAt: at(4),
        place: { threadId: 't1', entryId: 'e-mine' },
      });
      const elsewhere = v('another-thread', {
        sequence: 5,
        createdAt: at(5),
        place: { threadId: 't2', entryId: 'e-x' },
      });
      const wide = version(agentId, id('wide'), { scope: agent, sequence: 1, createdAt: at(6) });
      const gone = v('gone', {
        path: '/memories/old.md',
        sequence: 1,
        content: null,
        sha256: null,
        createdAt: at(7),
      });
      const stranger = version(agentId, id('stranger'), {
        scope: { agentId, userId: 'u2' },
        path: '/memories/theirs.md',
        createdAt: at(8),
      });
      for (const one of [first, second, onOther, onMine, elsewhere, wide, gone, stranger]) {
        ok(await adapter.putFileVersions([one]), 'putFileVersions');
      }

      const everywhere = ok(
        await adapter.findFileHeads({ agentId, visibleTo: { agentId, userId: 'u1' } }),
        'findFileHeads'
      );
      assert.deepEqual(
        ids(everywhere),
        ids([elsewhere, wide, gone]),
        'the newest of each scope and path'
      );

      const onBranch = ok(
        await adapter.findFileHeads({
          agentId,
          visibleTo: { agentId, userId: 'u1', threadId: 't1' },
          place: { threadId: 't1', pathIds: ['e-mine'] },
        }),
        'findFileHeads on a branch'
      );
      assert.deepEqual(
        ids(onBranch),
        ids([elsewhere, wide, gone]),
        'a version of another thread is seen, the newest one of this branch would be too'
      );

      const beforeMine = ok(
        await adapter.findFileHeads({
          agentId,
          visibleTo: { agentId, userId: 'u1' },
          paths: ['/memories/notes.md'],
          place: { threadId: 't2', pathIds: [] },
        }),
        'findFileHeads on another branch of t2'
      );
      assert.deepEqual(
        ids(beforeMine),
        ids([onMine, wide]),
        'a version of t2 placed off its branch is not seen, the newest seen one stands'
      );
    },

    async 'file-find-visible-to'(adapter) {
      const { agentId, id } = scope();
      const of = (name: string, scopeOf: MemoryItemScope) =>
        version(agentId, id(name), { scope: scopeOf, path: `/memories/${name}.md` });
      const wide = of('wide', { agentId });
      const u1 = of('u1', { agentId, userId: 'u1' });
      const u2 = of('u2', { agentId, userId: 'u2' });
      const thread = of('thread', { agentId, userId: 'u1', threadId: 't1' });
      ok(await adapter.putFileVersions([wide, u1, u2, thread]), 'putFileVersions');

      const seen = async (visibleTo: MemoryItemScope) =>
        ids(ok(await adapter.findFileVersions({ agentId, visibleTo }), 'findFileVersions')).sort();
      assert.deepEqual(await seen({ agentId, userId: 'u1' }), [u1.id, wide.id].sort());
      assert.deepEqual(
        await seen({ agentId, userId: 'u1', threadId: 't1' }),
        [thread.id, u1.id, wide.id].sort()
      );
      assert.deepEqual(await seen({ agentId }), [wide.id]);
      assert.deepEqual(
        ids(
          ok(
            await adapter.findFileVersions({ agentId, scope: { agentId, userId: 'u1' } }),
            'findFileVersions'
          )
        ),
        [u1.id],
        'scope finds exactly that scope'
      );
    },

    async 'file-redact'(adapter) {
      const { agentId, id } = scope();
      const secret = version(agentId, id('secret'), { content: 'card 4111' });
      const other = version(agentId, id('other'), { path: '/memories/other.md' });
      ok(await adapter.putFileVersions([secret, other]), 'putFileVersions');

      ok(
        await adapter.redactFileVersions([secret.id, `missing-${randomUUID()}`], {
          content: '[redacted]',
          sha256: 'c'.repeat(64),
          at: at(9),
          reason: 'card number',
        }),
        'redactFileVersions'
      );

      const found = ok(await adapter.findFileVersions({ agentId }), 'findFileVersions');
      const redacted = found.find((kept) => kept.id === secret.id);
      const untouched = found.find((kept) => kept.id === other.id);
      assert.deepEqual(redacted, {
        ...secret,
        content: '[redacted]',
        sha256: 'c'.repeat(64),
        redacted: { at: at(9), reason: 'card number' },
      });
      assert.deepEqual(untouched, other);
    },

    async 'file-delete'(adapter) {
      const { agentId, id } = scope();
      const gone = version(agentId, id('gone'));
      const kept = version(agentId, id('kept'), { path: '/memories/kept.md' });
      ok(await adapter.putFileVersions([gone, kept]), 'putFileVersions');

      ok(
        await adapter.deleteFileVersions([gone.id, `missing-${randomUUID()}`]),
        'deleteFileVersions'
      );

      assert.deepEqual(ids(ok(await adapter.findFileVersions({ agentId }), 'find')), [kept.id]);
      ok(
        await adapter.putFileVersions([version(agentId, id('again'))]),
        'the place of a deleted version is free again'
      );
      ok(await adapter.deleteFileVersions([]), 'deleteFileVersions of nothing');
    },

    async 'file-returns-copies'(adapter) {
      const { agentId, id } = scope();
      const written = version(agentId, id('file'), { place: { threadId: 't', entryId: 'e' } });
      const [put] = ok(await adapter.putFileVersions([written]), 'putFileVersions');
      if (put?.place) put.place.entryId = 'changed';
      if (written.place) written.place.entryId = 'changed too';

      const [read] = ok(await adapter.findFileVersions({ agentId }), 'findFileVersions');
      assert.deepEqual(read?.place, { threadId: 't', entryId: 'e' });
    },
  };

/**
 * The cases of the memory file adapter contract for `target`, for any test runner:
 *
 * ```ts
 * for (const c of memoryFileAdapterConformanceCases({ create: async () => adapter })) {
 *   it.skipIf(c.skip !== undefined)(c.name, () => c.run());
 * }
 * ```
 */
export function memoryFileAdapterConformanceCases<T extends MemoryFileAdapter>(
  target: MemoryFileAdapterConformanceTarget<T>
): MemoryFileAdapterConformanceCase[] {
  return (Object.keys(SCENARIOS) as MemoryFileAdapterScenario[]).map((name) => {
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
