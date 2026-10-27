/**
 * The inbox: results, failures and questions of routines, kept for a person to read, and told to
 * whoever listens (a channel, a webhook, Studio) as they come
 */

import { createHmac } from 'node:crypto';
import { nanoid } from 'nanoid';
import type {
  InboxFilter,
  InboxItem,
  InboxItemInput,
  InboxItemPatch,
  InboxItemStatus,
  InboxStore,
  InboxWriter,
  NotificationSink,
} from '@cogitator-ai/types';
import { CogitatorError, ErrorCode } from '@cogitator-ai/types';
import { getLogger } from '../logger';
import { SharedJsonFile } from './json-file';
import { createIfMissing, fromJson, tablePrefix, type TriggerStorePgClient } from './pg';
import type { TriggerStoreRedisClient } from './routine-stores';

const STATUSES: readonly InboxItemStatus[] = ['unread', 'read', 'archived'];

function asList<T>(value: T | readonly T[] | undefined): readonly T[] | undefined {
  return value === undefined ? undefined : Array.isArray(value) ? value : [value as T];
}

/** Whether an item is one `filter` asks for, apart from `before` and `limit` */
export function matchesInboxFilter(item: InboxItem, filter: InboxFilter | undefined): boolean {
  if (!filter) return true;
  const statuses = asList(filter.status);
  if (statuses && !statuses.includes(item.status)) return false;
  const kinds = asList(filter.kind);
  if (kinds && !kinds.includes(item.kind)) return false;
  if (filter.routineId !== undefined && item.routineId !== filter.routineId) return false;
  if (filter.userId === null && item.userId !== undefined) return false;
  if (typeof filter.userId === 'string' && item.userId !== filter.userId) return false;
  if (filter.before !== undefined && item.createdAt >= filter.before) return false;
  return true;
}

function newestFirst(a: InboxItem, b: InboxItem): number {
  return b.createdAt - a.createdAt || (a.id < b.id ? 1 : -1);
}

function select(items: Iterable<InboxItem>, filter: InboxFilter | undefined): InboxItem[] {
  return [...items]
    .filter((item) => matchesInboxFilter(item, filter))
    .sort(newestFirst)
    .slice(0, filter?.limit ?? 50)
    .map((item) => structuredClone(item));
}

function patched(item: InboxItem, patch: InboxItemPatch): InboxItem {
  if (patch.status !== undefined && !STATUSES.includes(patch.status)) {
    throw new CogitatorError({
      message: `An inbox item's status is unread, read or archived, got ${String(patch.status)}`,
      code: ErrorCode.VALIDATION_ERROR,
    });
  }
  return {
    ...item,
    ...(patch.status !== undefined && { status: patch.status }),
    ...(patch.metadata !== undefined && { metadata: { ...item.metadata, ...patch.metadata } }),
    updatedAt: Date.now(),
  };
}

/** Experimental. Inbox items in memory, for one process */
export class experimental_InMemoryInboxStore implements InboxStore {
  private readonly items = new Map<string, InboxItem>();

  async add(item: InboxItem): Promise<void> {
    this.items.set(item.id, structuredClone(item));
  }

  async get(id: string): Promise<InboxItem | null> {
    const item = this.items.get(id);
    return item ? structuredClone(item) : null;
  }

  async list(filter?: InboxFilter): Promise<InboxItem[]> {
    return select(this.items.values(), filter);
  }

  async update(id: string, patch: InboxItemPatch): Promise<InboxItem | null> {
    const item = this.items.get(id);
    if (!item) return null;
    const next = patched(item, patch);
    this.items.set(id, next);
    return structuredClone(next);
  }

  async delete(id: string): Promise<void> {
    this.items.delete(id);
  }
}

function parseItems(value: unknown): InboxItem[] {
  if (!Array.isArray(value)) throw new Error('An inbox file holds an array of items');
  return value as InboxItem[];
}

/**
 * Experimental. Inbox items in a JSON file (mode 0600) that the CLI and a runtime can share.
 * `maxItems` (default 5000) keeps the newest, archived items go first
 */
export class experimental_FileInboxStore implements InboxStore {
  private readonly file: SharedJsonFile<InboxItem[]>;

  constructor(
    path: string,
    private readonly options: { maxItems?: number } = {}
  ) {
    this.file = new SharedJsonFile(path, { empty: () => [], parse: parseItems });
  }

  get path(): string {
    return this.file.path;
  }

  async add(item: InboxItem): Promise<void> {
    const max = this.options.maxItems ?? 5000;
    await this.file.update((items) => {
      const kept = items.filter((existing) => existing.id !== item.id);
      kept.push(structuredClone(item));
      while (kept.length > max) {
        const oldest = [...kept].sort((a, b) => {
          const archived = Number(b.status === 'archived') - Number(a.status === 'archived');
          return archived || a.createdAt - b.createdAt;
        })[0];
        kept.splice(kept.indexOf(oldest), 1);
      }
      items.splice(0, items.length, ...kept);
    });
  }

  async get(id: string): Promise<InboxItem | null> {
    const item = (await this.file.read()).find((candidate) => candidate.id === id);
    return item ? structuredClone(item) : null;
  }

  async list(filter?: InboxFilter): Promise<InboxItem[]> {
    return select(await this.file.read(), filter);
  }

  update(id: string, patch: InboxItemPatch): Promise<InboxItem | null> {
    return this.file.update((items) => {
      const at = items.findIndex((item) => item.id === id);
      if (at === -1) return null;
      items[at] = patched(items[at], patch);
      return structuredClone(items[at]);
    });
  }

  async delete(id: string): Promise<void> {
    await this.file.update((items) => {
      const at = items.findIndex((item) => item.id === id);
      if (at !== -1) items.splice(at, 1);
    });
  }
}

export interface RedisInboxStoreOptions {
  client: TriggerStoreRedisClient;
  /** Prefix of every key (default `cogitator:inbox`) */
  keyPrefix?: string;
}

/** Experimental. Inbox items in Redis: JSON under each id, a sorted set by creation time */
export class experimental_RedisInboxStore implements InboxStore {
  private readonly client: TriggerStoreRedisClient;
  private readonly prefix: string;

  constructor(options: RedisInboxStoreOptions) {
    this.client = options.client;
    this.prefix = options.keyPrefix ?? 'cogitator:inbox';
  }

  private itemKey(id: string): string {
    return `${this.prefix}:item:${id}`;
  }

  private get indexKey(): string {
    return `${this.prefix}:items`;
  }

  async add(item: InboxItem): Promise<void> {
    await this.client.set(this.itemKey(item.id), JSON.stringify(item));
    await this.client.zadd(this.indexKey, item.createdAt, item.id);
  }

  async get(id: string): Promise<InboxItem | null> {
    const raw = await this.client.get(this.itemKey(id));
    return raw ? (JSON.parse(raw) as InboxItem) : null;
  }

  async list(filter?: InboxFilter): Promise<InboxItem[]> {
    const ids = await this.client.zrange(this.indexKey, 0, -1);
    if (ids.length === 0) return [];
    const values = await this.client.mget(...ids.map((id) => this.itemKey(id)));
    const items = values
      .filter((value): value is string => value !== null)
      .map((value) => JSON.parse(value) as InboxItem);
    return select(items, filter);
  }

  async update(id: string, patch: InboxItemPatch): Promise<InboxItem | null> {
    const item = await this.get(id);
    if (!item) return null;
    const next = patched(item, patch);
    await this.client.set(this.itemKey(id), JSON.stringify(next));
    return next;
  }

  async delete(id: string): Promise<void> {
    await this.client.del(this.itemKey(id));
    await this.client.zrem(this.indexKey, id);
  }
}

export interface PostgresInboxStoreOptions {
  client: TriggerStorePgClient;
  /** The table (default `cogitator_inbox`), created on first use */
  table?: string;
}

/** Experimental. Inbox items in Postgres: the item as JSONB with indexed status, user and time */
export class experimental_PostgresInboxStore implements InboxStore {
  private readonly client: TriggerStorePgClient;
  private readonly table: string;
  private ready?: Promise<void>;

  constructor(options: PostgresInboxStoreOptions) {
    this.client = options.client;
    this.table = tablePrefix(options.table ?? 'cogitator_inbox', 'inbox');
  }

  private ensure(): Promise<void> {
    this.ready ??= this.create().catch((error: unknown) => {
      this.ready = undefined;
      throw error;
    });
    return this.ready;
  }

  private async create(): Promise<void> {
    const index = this.table.replace('.', '_');
    await createIfMissing(
      this.client,
      `CREATE TABLE IF NOT EXISTS ${this.table} (
         id TEXT PRIMARY KEY,
         status TEXT NOT NULL,
         kind TEXT NOT NULL,
         routine_id TEXT,
         user_id TEXT,
         created_at DOUBLE PRECISION NOT NULL,
         data JSONB NOT NULL)`
    );
    await createIfMissing(
      this.client,
      `CREATE INDEX IF NOT EXISTS ${index}_created_idx ON ${this.table} (user_id, created_at)`
    );
  }

  async add(item: InboxItem): Promise<void> {
    await this.ensure();
    await this.client.query(
      `INSERT INTO ${this.table} (id, status, kind, routine_id, user_id, created_at, data)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       ON CONFLICT (id) DO UPDATE SET status = EXCLUDED.status, kind = EXCLUDED.kind,
         routine_id = EXCLUDED.routine_id, user_id = EXCLUDED.user_id,
         created_at = EXCLUDED.created_at, data = EXCLUDED.data`,
      [
        item.id,
        item.status,
        item.kind,
        item.routineId ?? null,
        item.userId ?? null,
        item.createdAt,
        JSON.stringify(item),
      ]
    );
  }

  async get(id: string): Promise<InboxItem | null> {
    await this.ensure();
    const { rows } = await this.client.query(`SELECT data FROM ${this.table} WHERE id = $1`, [id]);
    return rows[0] ? fromJson<InboxItem>(rows[0].data) : null;
  }

  async list(filter?: InboxFilter): Promise<InboxItem[]> {
    await this.ensure();
    const conditions: string[] = [];
    const values: unknown[] = [];
    const add = (condition: (at: string) => string, value: unknown): void => {
      values.push(value);
      conditions.push(condition(`$${values.length}`));
    };
    const statuses = asList(filter?.status);
    if (statuses) add((at) => `status = ANY(${at}::text[])`, [...statuses]);
    const kinds = asList(filter?.kind);
    if (kinds) add((at) => `kind = ANY(${at}::text[])`, [...kinds]);
    if (filter?.routineId !== undefined) add((at) => `routine_id = ${at}`, filter.routineId);
    if (filter?.userId === null) conditions.push('user_id IS NULL');
    else if (filter?.userId !== undefined) add((at) => `user_id = ${at}`, filter.userId);
    if (filter?.before !== undefined) add((at) => `created_at < ${at}`, filter.before);
    values.push(filter?.limit ?? 50);
    const { rows } = await this.client.query(
      `SELECT data FROM ${this.table} ${conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : ''}
       ORDER BY created_at DESC, id DESC LIMIT $${values.length}`,
      values
    );
    return rows.map((row) => fromJson<InboxItem>(row.data));
  }

  async update(id: string, patch: InboxItemPatch): Promise<InboxItem | null> {
    const item = await this.get(id);
    if (!item) return null;
    const next = patched(item, patch);
    await this.client.query(`UPDATE ${this.table} SET status = $2, data = $3 WHERE id = $1`, [
      id,
      next.status,
      JSON.stringify(next),
    ]);
    return next;
  }

  async delete(id: string): Promise<void> {
    await this.ensure();
    await this.client.query(`DELETE FROM ${this.table} WHERE id = $1`, [id]);
  }
}

/** What happened to an item, as `subscribe` tells it */
export type InboxChange =
  | { type: 'added'; item: InboxItem }
  | { type: 'updated'; item: InboxItem }
  | { type: 'deleted'; id: string };

/** Options of {@link experimental_Inbox} */
export interface InboxOptions {
  /** Default: in memory */
  store?: InboxStore;
  /** Who hears of new items */
  sinks?: readonly NotificationSink[];
}

const MAX_TITLE = 200;
const MAX_SUMMARY = 1000;

function shorten(text: string, limit: number): string {
  const flat = text.trim();
  return flat.length <= limit ? flat : `${flat.slice(0, limit - 3)}...`;
}

/**
 * Experimental. An inbox over a store: adds items, tells sinks and subscribers of them, marks
 * them read or archived. A sink that fails is logged, the others still hear of the item
 */
export class experimental_Inbox implements InboxWriter {
  readonly store: InboxStore;
  private readonly sinks: NotificationSink[];
  private readonly listeners = new Set<(change: InboxChange) => void>();

  constructor(options: InboxOptions = {}) {
    this.store = options.store ?? new experimental_InMemoryInboxStore();
    this.sinks = [...(options.sinks ?? [])];
  }

  /** Adds a sink, returns what removes it */
  addSink(sink: NotificationSink): () => void {
    this.sinks.push(sink);
    return () => {
      const at = this.sinks.indexOf(sink);
      if (at !== -1) this.sinks.splice(at, 1);
    };
  }

  /** Hears of every change, as Studio's live view does. Returns what stops it */
  subscribe(listener: (change: InboxChange) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** Adds an item, unread unless said otherwise, and tells the sinks. Resolves once they heard */
  async add(input: InboxItemInput): Promise<InboxItem> {
    if (typeof input.title !== 'string' || input.title.trim() === '') {
      throw new CogitatorError({
        message: 'An inbox item needs a title',
        code: ErrorCode.VALIDATION_ERROR,
      });
    }
    const item: InboxItem = {
      ...input,
      id: input.id ?? `inbox_${nanoid(16)}`,
      title: shorten(input.title, MAX_TITLE),
      summary: shorten(input.summary ?? '', MAX_SUMMARY),
      status: input.status ?? 'unread',
      createdAt: Date.now(),
    };
    await this.store.add(item);
    this.emit({ type: 'added', item });
    await Promise.all(
      this.sinks.map(async (sink) => {
        try {
          await sink.notify(item);
        } catch (error) {
          getLogger().warn('An inbox notification failed', {
            sink: sink.name,
            item: item.id,
            error: error instanceof Error ? error.message : String(error),
          });
        }
      })
    );
    return item;
  }

  get(id: string): Promise<InboxItem | null> {
    return this.store.get(id);
  }

  list(filter?: InboxFilter): Promise<InboxItem[]> {
    return this.store.list(filter);
  }

  /** Changes an item's status or metadata, null when there is no such item */
  async update(id: string, patch: InboxItemPatch): Promise<InboxItem | null> {
    const item = await this.store.update(id, patch);
    if (item) this.emit({ type: 'updated', item });
    return item;
  }

  markRead(id: string): Promise<InboxItem | null> {
    return this.update(id, { status: 'read' });
  }

  markUnread(id: string): Promise<InboxItem | null> {
    return this.update(id, { status: 'unread' });
  }

  archive(id: string): Promise<InboxItem | null> {
    return this.update(id, { status: 'archived' });
  }

  async delete(id: string): Promise<void> {
    await this.store.delete(id);
    this.emit({ type: 'deleted', id });
  }

  private emit(change: InboxChange): void {
    for (const listener of this.listeners) {
      try {
        listener(change);
      } catch (error) {
        getLogger().warn('An inbox subscriber failed', {
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
  }
}

/** Options of {@link experimental_webhookSink} */
export interface WebhookSinkOptions {
  url: string;
  headers?: Record<string, string>;
  /** Signs the body: `X-Cogitator-Signature: sha256=<hex HMAC of the body>` */
  secret?: string;
  /** Default 10 000 ms */
  timeoutMs?: number;
  fetch?: typeof fetch;
}

/**
 * Experimental. A sink that POSTs each new item as `{ "type": "inbox.item", "item": ... }` to a
 * URL, signed with HMAC when given a secret. An answer other than 2xx counts as a failure
 */
export function experimental_webhookSink(options: WebhookSinkOptions): NotificationSink {
  const send = options.fetch ?? fetch;
  return {
    name: `webhook ${new URL(options.url).host}`,
    async notify(item) {
      const body = JSON.stringify({ type: 'inbox.item', item });
      const headers: Record<string, string> = {
        'content-type': 'application/json',
        ...options.headers,
      };
      if (options.secret) {
        headers['x-cogitator-signature'] =
          `sha256=${createHmac('sha256', options.secret).update(body).digest('hex')}`;
      }
      const response = await send(options.url, {
        method: 'POST',
        headers,
        body,
        signal: AbortSignal.timeout(options.timeoutMs ?? 10_000),
      });
      if (!response.ok) {
        throw new Error(`The inbox webhook answered ${response.status}`);
      }
    },
  };
}
