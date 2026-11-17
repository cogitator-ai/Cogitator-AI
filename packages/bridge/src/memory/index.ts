import { BM25Index, MemoryItems, SQLiteAdapter, isMemoryItemAdapter } from '@cogitator-ai/memory';
import type {
  MemoryItem,
  MemoryItemAdapter,
  MemoryItemKind,
  MemoryItemScope,
} from '@cogitator-ai/types';
import {
  DEFAULT_RECALL_LIMIT,
  type BoardFact,
  type BoardQuery,
  type FactBoard,
  type FactKind,
  type NewBoardFact,
} from '../board.js';
import { PERSON } from '../types.js';

/** The agent the notes of the board belong to in memory: the bridge itself, for every project. */
export const BOARD_AGENT = 'cogitator-bridge';

export interface MemoryBoardOptions {
  /**
   * Where the notes are kept: the path of a SQLite file (`:memory:` for none), or any store of
   * `@cogitator-ai/memory` that keeps memory items, connected already
   */
  store: string | MemoryItemAdapter;
  /** The clock, for tests */
  now?: () => Date;
}

const KIND_IN_MEMORY: Record<FactKind, MemoryItemKind> = {
  fact: 'fact',
  lesson: 'lesson',
  outcome: 'event',
};

const KIND_ON_BOARD: Partial<Record<MemoryItemKind, FactKind>> = {
  fact: 'fact',
  lesson: 'lesson',
  event: 'outcome',
};

/** The shortest start of an id `find` takes for the id. */
const MIN_ID_PREFIX = 6;

const threadOf = (job: number): string => `job-${job}`;

function jobOfThread(thread: string | undefined): number | undefined {
  const match = thread === undefined ? null : /^job-(\d+)$/.exec(thread);
  return match ? Number(match[1]) : undefined;
}

function scopeOf(project: string, job?: number): MemoryItemScope {
  return {
    agentId: BOARD_AGENT,
    projectId: project,
    ...(job !== undefined && { threadId: threadOf(job) }),
  };
}

function toFact(item: MemoryItem): BoardFact | undefined {
  const kind = KIND_ON_BOARD[item.kind];
  const project = item.scope.projectId;
  if (!kind || project === undefined) return undefined;
  const source = (item.metadata?.source ?? {}) as { by?: unknown; job?: unknown };
  const job = jobOfThread(item.scope.threadId);
  return {
    id: item.id,
    kind,
    text: item.content,
    project,
    ...(job !== undefined && { job }),
    source: {
      by: typeof source.by === 'string' ? source.by : 'unknown',
      ...(typeof source.job === 'number' && { job: source.job }),
      at: item.saidAt.toISOString(),
    },
  };
}

/**
 * The board of facts on `@cogitator-ai/memory`: every note is a memory item of the bridge, in
 * the scope of its project and, for a note kept to one job, of that job. So notes are never
 * rewritten or deleted: one that is forgotten is closed and found no more. What an agent said
 * is kept as the words of a model and what the person said as the person's, which is how the
 * rest of the runtime tells them apart too. A look with words ranks the notes by those words
 * (BM25), newest first among equals.
 *
 * @example
 * ```ts
 * import { hostBridge, bridgePaths } from '@cogitator-ai/bridge';
 * import { memoryBoard } from '@cogitator-ai/bridge/memory';
 * import { join } from 'node:path';
 *
 * const paths = bridgePaths();
 * const board = await memoryBoard({ store: join(paths.home, 'memory.db') });
 * const host = await hostBridge({ board });
 * ```
 */
export async function memoryBoard(options: MemoryBoardOptions): Promise<FactBoard> {
  let owned: SQLiteAdapter | undefined;
  let adapter: MemoryItemAdapter;
  if (typeof options.store === 'string') {
    owned = new SQLiteAdapter({ provider: 'sqlite', path: options.store });
    const connected = await owned.connect();
    if (!connected.success) throw new Error(`The board could not be opened: ${connected.error}`);
    if (!isMemoryItemAdapter(owned)) throw new Error('The SQLite store keeps no memory items');
    adapter = owned;
  } else {
    adapter = options.store;
  }
  const items = new MemoryItems({ adapter, ...(options.now && { now: options.now }) });
  const now = options.now ?? (() => new Date());

  /** Whether memory let the note go already, by the clock of the board */
  const gone = (item: MemoryItem): boolean =>
    item.expiredAt !== undefined && item.expiredAt.getTime() <= now().getTime();

  /** The notes a look may see: those of the project, and those kept to each job it names */
  async function visible(query: BoardQuery): Promise<BoardFact[]> {
    const kinds = (query.kinds ?? (Object.keys(KIND_IN_MEMORY) as FactKind[])).map(
      (kind) => KIND_IN_MEMORY[kind]
    );
    const scopes = [
      scopeOf(query.project),
      ...(query.jobs ?? []).map((job) => scopeOf(query.project, job)),
    ];
    const looks = await Promise.all(
      scopes.map((scope) => items.query({ scope, kinds, statuses: ['suggested', 'active'] }))
    );
    const found = new Map<string, BoardFact>();
    for (const item of looks.flat()) {
      const fact = toFact(item);
      if (fact) found.set(fact.id, fact);
    }
    return [...found.values()].sort((a, b) => b.source.at.localeCompare(a.source.at));
  }

  return {
    async remember(fact: NewBoardFact): Promise<BoardFact> {
      const at = new Date(fact.source.at);
      const said = Number.isNaN(at.getTime()) ? now() : at;
      const [written] = await items.write([
        {
          kind: KIND_IN_MEMORY[fact.kind],
          content: fact.text,
          trust:
            fact.source.by === PERSON ? 'user' : fact.source.by === 'bridge' ? 'system' : 'model',
          confidence: 1,
          scope: scopeOf(fact.project, fact.job),
          evidence: [],
          verified: false,
          saidAt: said,
          sessionAt: said,
          metadata: {
            source: {
              by: fact.source.by,
              ...(fact.source.job !== undefined && { job: fact.source.job }),
            },
          },
        },
      ]);
      const kept = toFact(written);
      if (!kept) throw new Error('The board lost the note it was given');
      return kept;
    },

    async recall(query: BoardQuery): Promise<BoardFact[]> {
      const limit = query.limit ?? DEFAULT_RECALL_LIMIT;
      const all = await visible(query);
      const words = query.text?.trim();
      if (!words) return all.slice(0, limit);
      const index = new BM25Index();
      index.addDocuments(all.map((fact) => ({ id: fact.id, content: fact.text })));
      const byId = new Map(all.map((fact) => [fact.id, fact]));
      return index.search(words, limit).flatMap((hit) => byId.get(hit.id) ?? []);
    },

    async find(id: string): Promise<BoardFact | undefined> {
      const wanted = id.trim();
      if (!wanted) return undefined;
      const exact = await items.get(wanted);
      if (exact && exact.scope.agentId === BOARD_AGENT && !gone(exact)) return toFact(exact);
      if (wanted.length < MIN_ID_PREFIX) return undefined;
      const result = await adapter.findItems({
        agentId: BOARD_AGENT,
        statuses: ['suggested', 'active'],
      });
      const matches = (result.success ? result.data : []).filter(
        (item) => item.id.startsWith(wanted) && !gone(item)
      );
      return matches.length === 1 ? toFact(matches[0]) : undefined;
    },

    async forget(id: string): Promise<boolean> {
      const item = await items.get(id);
      if (!item || item.scope.agentId !== BOARD_AGENT || gone(item)) return false;
      await items.expire([id]);
      return true;
    },

    async close(): Promise<void> {
      await owned?.disconnect();
    },
  };
}
