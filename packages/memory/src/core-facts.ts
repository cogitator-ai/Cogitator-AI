import { mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';
import type {
  MemoryItem,
  MemoryItemAdapter,
  MemoryItemScope,
  MemoryResult,
} from '@cogitator-ai/types';
import { MemoryItems, byRecorded, normalizeName } from './memory-items';
import { sqliteMemoryItems, type SqliteItemsDatabase } from './adapters/sqlite-memory-items';

/**
 * The database a {@link CoreFactsStore} shares when given `{ db }`. A `better-sqlite3` `Database`
 * satisfies it. It is declared here instead of imported so the published types do not require
 * `better-sqlite3`, and the store assigns the real driver to it, so drift fails to compile.
 */
interface Database extends SqliteItemsDatabase {
  close(): void;
  pragma(pragma: string): unknown;
}

export interface FactHistoryEntry {
  value: string;
  setAt: Date;
}

export type CoreFactsStoreConfig = (
  { path: string; db?: never } | { db: Database; path?: never }
) & {
  /** Who the facts belong to, `{ agentId: 'core' }` by default */
  scope?: MemoryItemScope;
};

const DEFAULT_SCOPE: MemoryItemScope = { agentId: 'core' };
const SLOT_PREFIX = 'core:';
const LEGACY_FACTS = 'core_facts';
const LEGACY_HISTORY = 'core_facts_history';

const slotOf = (key: string) => `${SLOT_PREFIX}${key}`;
const keyOf = (item: MemoryItem) => (item.slot ?? '').slice(SLOT_PREFIX.length);

function sameScope(a: MemoryItemScope, b: MemoryItemScope): boolean {
  return (
    a.agentId === b.agentId &&
    a.userId === b.userId &&
    a.projectId === b.projectId &&
    a.threadId === b.threadId
  );
}

function unwrap<T>(result: MemoryResult<T>): T {
  if (!result.success) throw new Error(result.error);
  return result.data;
}

/** The items of one slot in the order they were set: by when they started to hold, then were recorded */
function inOrder(items: MemoryItem[]): MemoryItem[] {
  const started = (item: MemoryItem) => (item.validFrom ?? item.recordedAt).getTime();
  return [...items].sort((a, b) => started(a) - started(b) || byRecorded(a, b));
}

/** When to let `item` go at `at`: never before memory took it in */
function lettingGo(item: MemoryItem, at: Date): Date {
  return item.recordedAt > at ? item.recordedAt : at;
}

interface LegacyRow {
  key: string;
  value: string;
  at: string;
}

interface Opened {
  db: Database;
  adapter: MemoryItemAdapter;
  items: MemoryItems;
}

/**
 * A small set of key/value facts that are always in context, kept as memory items in SQLite.
 *
 * Each key is the slot `core:<key>` of `system` facts in {@link CoreFactsStoreConfig.scope}, so a
 * new value supersedes the one before it and the history of a key is the history of its slot.
 * Deleting a key lets its current value go and keeps its history. A database written by an
 * earlier version, with `core_facts` and `core_facts_history` tables, is moved into memory items
 * on {@link initialize}, its history kept, and its tables are renamed with a `_legacy` suffix.
 */
export class CoreFactsStore {
  private db: Database | null = null;
  private opened: Opened | null = null;
  private opening: Promise<void> | null = null;
  private ownsDb: boolean;
  private path: string | null;
  private readonly scope: MemoryItemScope;
  private writes: Promise<unknown> = Promise.resolve();

  constructor(config: CoreFactsStoreConfig) {
    if ('db' in config && config.db) {
      this.db = config.db;
      this.ownsDb = false;
      this.path = null;
    } else {
      this.path = config.path ?? null;
      this.ownsDb = true;
    }
    this.scope = config.scope ? { ...config.scope } : DEFAULT_SCOPE;
  }

  async initialize(): Promise<void> {
    this.opening ??= this.open().catch((err: unknown) => {
      this.opened = null;
      this.opening = null;
      throw err;
    });
    return this.opening;
  }

  private async open(): Promise<void> {
    if (!this.db) {
      if (!this.path) throw new Error('No database path configured');
      let DatabaseCtor: typeof import('better-sqlite3');
      try {
        DatabaseCtor = (await import('better-sqlite3')).default;
      } catch {
        throw new Error('better-sqlite3 not installed. Run: pnpm add better-sqlite3');
      }
      if (this.path !== ':memory:') await mkdir(dirname(this.path), { recursive: true });
      this.db = new DatabaseCtor(this.path);

      if (this.path !== ':memory:') {
        this.db.pragma('journal_mode = WAL');
      }
    }

    const adapter = sqliteMemoryItems(this.db);
    this.opened = { db: this.db, adapter, items: new MemoryItems({ adapter }) };
    await this.exclusive((opened) => this.migrate(opened));
  }

  async close(): Promise<void> {
    if (this.db && this.ownsDb) {
      await this.writes;
      this.db.close();
      this.db = null;
      this.opened = null;
      this.opening = null;
    }
  }

  private ensureOpen(): Opened {
    if (!this.opened) throw new Error('Not initialized');
    return this.opened;
  }

  async set(key: string, value: string): Promise<void> {
    await this.exclusive((opened) => this.record(opened, key, value, new Date()));
  }

  async get(key: string): Promise<string | null> {
    return (await this.current(this.ensureOpen(), key))?.value ?? null;
  }

  async getAll(): Promise<Record<string, string>> {
    const { adapter } = this.ensureOpen();
    const found = unwrap(
      await adapter.findItems({
        agentId: this.scope.agentId,
        kinds: ['fact'],
        statuses: ['active'],
      })
    );
    const facts = new Map<string, string>();
    for (const item of found) {
      if (this.isCurrent(item) && item.value !== undefined) {
        facts.set(keyOf(item), item.value);
      }
    }
    return Object.fromEntries([...facts].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));
  }

  async delete(key: string): Promise<void> {
    await this.exclusive(async (opened) => {
      const current = await this.current(opened, key);
      if (current) await opened.items.expire([current.id], lettingGo(current, new Date()));
    });
  }

  async getHistory(key: string): Promise<FactHistoryEntry[]> {
    const found = await this.slotItems(this.ensureOpen(), key);
    return inOrder(found).flatMap((item) =>
      item.value === undefined
        ? []
        : [{ value: item.value, setAt: item.validFrom ?? item.recordedAt }]
    );
  }

  async formatForPrompt(): Promise<string> {
    const facts = await this.getAll();
    const keys = Object.keys(facts);
    if (keys.length === 0) return '';
    return keys.map((k) => `${k}: ${facts[k]}`).join('\n');
  }

  private isFact(item: MemoryItem): boolean {
    return item.slot?.startsWith(SLOT_PREFIX) === true && sameScope(item.scope, this.scope);
  }

  /**
   * Whether `item` is the value of its key now: no newer value closed it and it was not deleted.
   * A deleted value is let go at once, never later, so any `expiredAt` means it is gone, even one
   * a millisecond ahead of the clock to keep the history in order.
   */
  private isCurrent(item: MemoryItem): boolean {
    return this.isFact(item) && item.validTo === undefined && item.expiredAt === undefined;
  }

  /** The value `key` holds now: the item of its slot no newer one closed and not let go */
  private async current(opened: Opened, key: string): Promise<MemoryItem | undefined> {
    return unwrap(
      await opened.adapter.findItems({
        agentId: this.scope.agentId,
        slots: [slotOf(key)],
        kinds: ['fact'],
        statuses: ['active'],
      })
    )
      .filter((item) => this.isCurrent(item))
      .at(-1);
  }

  /** Every item of the slot of `key`, let go or not, oldest recorded first */
  private async slotItems(opened: Opened, key: string): Promise<MemoryItem[]> {
    return unwrap(
      await opened.adapter.findItems({
        agentId: this.scope.agentId,
        slots: [slotOf(key)],
        kinds: ['fact'],
        includeExpired: true,
      })
    ).filter((item) => this.isFact(item));
  }

  /**
   * Sets `key` to `value` as of `at`. The same value again changes nothing. A new value never
   * starts before the latest one of its key, so it always supersedes the current one, even set in
   * the same millisecond, and it is recorded at least a millisecond after it, so the history keeps
   * the order values were set in. Memory takes a value that differs from the current one only in
   * case or spacing for the same one, so the current one is let go first and the new one starts
   * fresh.
   */
  private async record(opened: Opened, key: string, value: string, at: Date): Promise<void> {
    const known = await this.slotItems(opened, key);
    const current = known
      .filter(
        (item) =>
          item.status === 'active' && item.validTo === undefined && item.expiredAt === undefined
      )
      .at(-1);
    if (current?.value === value) return;
    const latest = known.at(-1);
    const recordedAt = new Date(
      Math.max(at.getTime(), (latest?.recordedAt.getTime() ?? -Infinity) + 1)
    );
    const validFrom = new Date(
      Math.max(at.getTime(), (latest?.validFrom ?? latest?.recordedAt)?.getTime() ?? -Infinity)
    );
    if (current?.value !== undefined && normalizeName(current.value) === normalizeName(value)) {
      await opened.items.expire([current.id], recordedAt);
    }
    await opened.items.write([
      {
        kind: 'fact',
        content: `${key}: ${value}`,
        attribute: key,
        value,
        slot: slotOf(key),
        trust: 'system',
        confidence: 1,
        scope: this.scope,
        evidence: [],
        saidAt: at,
        sessionAt: at,
        validFrom,
        recordedAt,
      },
    ]);
  }

  /**
   * Runs `work` after every write before it, in one savepoint, so concurrent writes of the store
   * neither interleave nor leave half of themselves behind
   */
  private exclusive<T>(work: (opened: Opened) => Promise<T>): Promise<T> {
    const run = this.writes.then(async () => {
      const opened = this.ensureOpen();
      const { db } = opened;
      db.exec('SAVEPOINT core_facts');
      try {
        const result = await work(opened);
        db.exec('RELEASE core_facts');
        return result;
      } catch (err) {
        db.exec('ROLLBACK TO core_facts');
        db.exec('RELEASE core_facts');
        throw err;
      }
    });
    this.writes = run.catch(() => undefined);
    return run;
  }

  /**
   * Moves the facts of the tables an earlier version kept into memory items, once: when they
   * exist and the scope has no facts yet. Each key gets its history in order, then the value of
   * `core_facts` as the current one, or none when it was deleted. The old tables are renamed.
   */
  private async migrate(opened: Opened): Promise<void> {
    const { db, adapter } = opened;
    const tables = this.tables(db);
    if (!tables.has(LEGACY_FACTS) && !tables.has(LEGACY_HISTORY)) return;
    const known = unwrap(
      await adapter.findItems({
        agentId: this.scope.agentId,
        kinds: ['fact'],
        includeExpired: true,
      })
    );
    if (known.some((item) => this.isFact(item))) return;

    const history = tables.has(LEGACY_HISTORY)
      ? (db
          .prepare(`SELECT key, value, set_at AS at FROM ${LEGACY_HISTORY} ORDER BY id ASC`)
          .all() as LegacyRow[])
      : [];
    const facts = tables.has(LEGACY_FACTS)
      ? (db
          .prepare(`SELECT key, value, updated_at AS at FROM ${LEGACY_FACTS}`)
          .all() as LegacyRow[])
      : [];

    const histories = new Map<string, LegacyRow[]>();
    for (const row of history) histories.set(row.key, [...(histories.get(row.key) ?? []), row]);
    const current = new Map(facts.map((row) => [row.key, row]));
    for (const key of current.keys()) if (!histories.has(key)) histories.set(key, []);
    const now = new Date();
    for (const [key, rows] of histories) {
      for (const row of rows) await this.record(opened, key, row.value, new Date(row.at));
      const fact = current.get(key);
      if (fact) {
        await this.record(opened, key, fact.value, new Date(fact.at));
      } else {
        const last = await this.current(opened, key);
        if (last) await opened.items.expire([last.id], lettingGo(last, now));
      }
    }

    for (const table of [LEGACY_FACTS, LEGACY_HISTORY]) {
      if (tables.has(table)) {
        db.exec(`ALTER TABLE ${table} RENAME TO ${this.freeName(tables, `${table}_legacy`)}`);
      }
    }
  }

  private tables(db: Database): Set<string> {
    const rows = db.prepare(`SELECT name FROM sqlite_master WHERE type = 'table'`).all() as {
      name: string;
    }[];
    return new Set(rows.map((row) => row.name));
  }

  /** `name`, or `name` with the first number after it no table has yet */
  private freeName(tables: Set<string>, name: string): string {
    if (!tables.has(name)) return name;
    let n = 2;
    while (tables.has(`${name}_${n}`)) n++;
    return `${name}_${n}`;
  }
}
