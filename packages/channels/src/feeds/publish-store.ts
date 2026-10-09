import { mkdir, readdir, readFile, rm } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { nanoid } from 'nanoid';
import type { FeedPost } from '@cogitator-ai/types';
import type { FeedErrorCode } from './errors';
import {
  createIfMissing,
  fromJson,
  type PgClient,
  SerialQueue,
  TABLE_NAME,
  writeFileAtomic,
} from './storage';

/** How one feed of a job is doing. */
export interface FeedDelivery {
  feed: string;
  status: 'pending' | 'published' | 'failed';
  attempts: number;
  /** When to try next, in ms since the epoch, while pending. */
  nextAttemptAt: number;
  post?: { id: string; url: string; publishedAt: number };
  error?: { code: FeedErrorCode; message: string };
}

/** A post on its way to one or more feeds. */
export interface PublishJob {
  id: string;
  /** Publishing twice with the same key publishes once. */
  key?: string;
  post: FeedPost;
  createdAt: number;
  deliveries: FeedDelivery[];
}

/** Whether a job still has a feed to publish to. */
export function isPending(job: PublishJob): boolean {
  return job.deliveries.some((delivery) => delivery.status === 'pending');
}

/** When the job's next pending delivery is due, or `undefined` when it is done. */
export function nextDueAt(job: PublishJob): number | undefined {
  const due = job.deliveries
    .filter((delivery) => delivery.status === 'pending')
    .map((delivery) => delivery.nextAttemptAt);
  return due.length > 0 ? Math.min(...due) : undefined;
}

/** Where a publisher keeps its jobs, so scheduled and retried posts survive a restart. */
export interface PublishStore {
  /** Adds `job`, unless one with the same key exists: that one is returned instead. */
  add(job: PublishJob): Promise<PublishJob>;
  get(id: string): Promise<PublishJob | undefined>;
  /**
   * Claims up to `limit` jobs with a delivery due by `now` for `ttl` ms, so
   * no other worker takes them meanwhile.
   */
  claimDue(now: number, options: { limit: number; ttl: number }): Promise<PublishJob[]>;
  /** Claims one job for `ttl` ms; `false` when another worker holds it. */
  claim(id: string, ttl: number): Promise<boolean>;
  /** Saves a job this store's worker holds, keeping the claim. */
  save(job: PublishJob): Promise<void>;
  /** Releases this worker's claim on a job. */
  release(id: string): Promise<void>;
  list(filter?: { pending?: boolean }): Promise<PublishJob[]>;
  /** Removes a job no worker holds; `false` when it is missing or held. */
  remove(id: string): Promise<boolean>;
}

/** A job as JSON: attachment bytes become base64. */
export function encodeJob(job: PublishJob): string {
  return JSON.stringify(job, (_key, value: unknown) =>
    value instanceof Uint8Array ? { __bytes: Buffer.from(value).toString('base64') } : value
  );
}

/** A job back from `encodeJob`. */
export function decodeJob(json: string | unknown): PublishJob {
  const text = typeof json === 'string' ? json : JSON.stringify(json);
  return JSON.parse(text, (_key, value: unknown) =>
    typeof value === 'object' &&
    value !== null &&
    '__bytes' in value &&
    typeof value.__bytes === 'string'
      ? new Uint8Array(Buffer.from(value.__bytes, 'base64'))
      : value
  ) as PublishJob;
}

interface Held {
  job: PublishJob;
  claimedUntil: number;
}

/** Jobs in memory, for tests and a publisher that needs no restart safety. */
export class MemoryPublishStore implements PublishStore {
  private readonly jobs = new Map<string, Held>();

  constructor(private readonly now: () => number = Date.now) {}

  async add(job: PublishJob): Promise<PublishJob> {
    const existing = job.key ? this.byKey(job.key) : undefined;
    if (existing) return decodeJob(encodeJob(existing.job));
    this.jobs.set(job.id, { job: decodeJob(encodeJob(job)), claimedUntil: 0 });
    return decodeJob(encodeJob(job));
  }

  async get(id: string): Promise<PublishJob | undefined> {
    const held = this.jobs.get(id);
    return held ? decodeJob(encodeJob(held.job)) : undefined;
  }

  async claimDue(now: number, options: { limit: number; ttl: number }): Promise<PublishJob[]> {
    const due = [...this.jobs.values()]
      .filter((held) => held.claimedUntil <= this.now())
      .filter((held) => (nextDueAt(held.job) ?? Infinity) <= now)
      .sort((a, b) => (nextDueAt(a.job) ?? 0) - (nextDueAt(b.job) ?? 0))
      .slice(0, options.limit);
    for (const held of due) held.claimedUntil = this.now() + options.ttl;
    return due.map((held) => decodeJob(encodeJob(held.job)));
  }

  async claim(id: string, ttl: number): Promise<boolean> {
    const held = this.jobs.get(id);
    if (!held || held.claimedUntil > this.now()) return false;
    held.claimedUntil = this.now() + ttl;
    return true;
  }

  async save(job: PublishJob): Promise<void> {
    const held = this.jobs.get(job.id);
    this.jobs.set(job.id, {
      job: decodeJob(encodeJob(job)),
      claimedUntil: held?.claimedUntil ?? 0,
    });
  }

  async release(id: string): Promise<void> {
    const held = this.jobs.get(id);
    if (held) held.claimedUntil = 0;
  }

  async list(filter: { pending?: boolean } = {}): Promise<PublishJob[]> {
    return [...this.jobs.values()]
      .map((held) => held.job)
      .filter((job) => filter.pending === undefined || isPending(job) === filter.pending)
      .sort((a, b) => a.createdAt - b.createdAt)
      .map((job) => decodeJob(encodeJob(job)));
  }

  async remove(id: string): Promise<boolean> {
    const held = this.jobs.get(id);
    if (!held || held.claimedUntil > this.now()) return false;
    return this.jobs.delete(id);
  }

  private byKey(key: string): Held | undefined {
    for (const held of this.jobs.values()) if (held.job.key === key) return held;
    return undefined;
  }
}

export interface FilePublishStoreOptions {
  /** The directory with one JSON file per job (default `~/.cogitator/feed-jobs`). */
  directory?: string;
}

/**
 * Jobs as one JSON file each, written atomically, for a single publishing
 * process: claims live in that process. Several workers need
 * `PostgresPublishStore`.
 */
export class FilePublishStore implements PublishStore {
  readonly directory: string;
  private readonly queue = new SerialQueue();
  private readonly claims = new Map<string, number>();

  constructor(
    options: FilePublishStoreOptions = {},
    private readonly now: () => number = Date.now
  ) {
    this.directory = options.directory ?? join(homedir(), '.cogitator', 'feed-jobs');
  }

  async add(job: PublishJob): Promise<PublishJob> {
    return this.queue.run(async () => {
      if (job.key) {
        const existing = (await this.readAll()).find((candidate) => candidate.key === job.key);
        if (existing) return existing;
      }
      await this.write(job);
      return decodeJob(encodeJob(job));
    });
  }

  async get(id: string): Promise<PublishJob | undefined> {
    return this.queue.run(() => this.read(id));
  }

  async claimDue(now: number, options: { limit: number; ttl: number }): Promise<PublishJob[]> {
    return this.queue.run(async () => {
      const due = (await this.readAll())
        .filter((job) => (this.claims.get(job.id) ?? 0) <= this.now())
        .filter((job) => (nextDueAt(job) ?? Infinity) <= now)
        .sort((a, b) => (nextDueAt(a) ?? 0) - (nextDueAt(b) ?? 0))
        .slice(0, options.limit);
      for (const job of due) this.claims.set(job.id, this.now() + options.ttl);
      return due;
    });
  }

  async claim(id: string, ttl: number): Promise<boolean> {
    return this.queue.run(async () => {
      if ((this.claims.get(id) ?? 0) > this.now() || !(await this.read(id))) return false;
      this.claims.set(id, this.now() + ttl);
      return true;
    });
  }

  async save(job: PublishJob): Promise<void> {
    await this.queue.run(() => this.write(job));
  }

  async release(id: string): Promise<void> {
    this.claims.delete(id);
  }

  async list(filter: { pending?: boolean } = {}): Promise<PublishJob[]> {
    return this.queue.run(async () =>
      (await this.readAll())
        .filter((job) => filter.pending === undefined || isPending(job) === filter.pending)
        .sort((a, b) => a.createdAt - b.createdAt)
    );
  }

  async remove(id: string): Promise<boolean> {
    return this.queue.run(async () => {
      if ((this.claims.get(id) ?? 0) > this.now() || !(await this.read(id))) return false;
      await rm(this.fileOf(id), { force: true });
      this.claims.delete(id);
      return true;
    });
  }

  private fileOf(id: string): string {
    return join(this.directory, `${id.replace(/[^\w-]/g, '_')}.json`);
  }

  private async write(job: PublishJob): Promise<void> {
    await writeFileAtomic(this.fileOf(job.id), encodeJob(job));
  }

  private async read(id: string): Promise<PublishJob | undefined> {
    try {
      return decodeJob(await readFile(this.fileOf(id), 'utf-8'));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
      throw error;
    }
  }

  private async readAll(): Promise<PublishJob[]> {
    await mkdir(this.directory, { recursive: true });
    const jobs: PublishJob[] = [];
    for (const name of await readdir(this.directory)) {
      if (!name.endsWith('.json')) continue;
      try {
        jobs.push(decodeJob(await readFile(join(this.directory, name), 'utf-8')));
      } catch {
        console.warn(`[feeds] Skipping unreadable job file ${join(this.directory, name)}`);
      }
    }
    return jobs;
  }
}

export interface PostgresPublishStoreOptions {
  client: PgClient;
  /** Table name (default `cogitator_feed_jobs`); created on first use. */
  table?: string;
}

/**
 * Jobs in a Postgres table. Claims are leases on the database clock, taken
 * with `FOR UPDATE SKIP LOCKED`, so several publishing workers split the due
 * jobs between them and never post one twice at the same time.
 */
export class PostgresPublishStore implements PublishStore {
  private readonly client: PgClient;
  private readonly table: string;
  private readonly owner = nanoid();
  private ready?: Promise<void>;

  constructor(options: PostgresPublishStoreOptions) {
    const table = options.table ?? 'cogitator_feed_jobs';
    if (!TABLE_NAME.test(table)) throw new Error(`Invalid feed job table name: ${table}`);
    this.client = options.client;
    this.table = table;
  }

  async add(job: PublishJob): Promise<PublishJob> {
    await this.ensureTable();
    const { rows } = await this.client.query(
      `INSERT INTO ${this.table} (id, key, next_due_at, created_at, data)
       VALUES ($1, $2, $3, $4, $5::jsonb)
       ON CONFLICT DO NOTHING
       RETURNING data`,
      [job.id, job.key ?? null, nextDueAt(job) ?? null, job.createdAt, encodeJob(job)]
    );
    if (rows[0]) return decodeJob(fromJson(rows[0].data));
    const existing = job.key
      ? await this.client.query(`SELECT data FROM ${this.table} WHERE key = $1`, [job.key])
      : await this.client.query(`SELECT data FROM ${this.table} WHERE id = $1`, [job.id]);
    if (!existing.rows[0]) throw new Error(`Could not add feed job ${job.id}`);
    return decodeJob(fromJson(existing.rows[0].data));
  }

  async get(id: string): Promise<PublishJob | undefined> {
    await this.ensureTable();
    const { rows } = await this.client.query(`SELECT data FROM ${this.table} WHERE id = $1`, [id]);
    return rows[0] ? decodeJob(fromJson(rows[0].data)) : undefined;
  }

  async claimDue(now: number, options: { limit: number; ttl: number }): Promise<PublishJob[]> {
    await this.ensureTable();
    const { rows } = await this.client.query(
      `UPDATE ${this.table}
          SET claimed_until = now() + $3::double precision * interval '1 millisecond',
              claimed_by = $4
        WHERE id IN (
          SELECT id FROM ${this.table}
           WHERE next_due_at IS NOT NULL AND next_due_at <= $1
             AND (claimed_until IS NULL OR claimed_until < now())
           ORDER BY next_due_at
           LIMIT $2
           FOR UPDATE SKIP LOCKED)
        RETURNING data`,
      [now, options.limit, options.ttl, this.owner]
    );
    return rows.map((row) => decodeJob(fromJson(row.data)));
  }

  async claim(id: string, ttl: number): Promise<boolean> {
    await this.ensureTable();
    const { rows } = await this.client.query(
      `UPDATE ${this.table}
          SET claimed_until = now() + $2::double precision * interval '1 millisecond',
              claimed_by = $3
        WHERE id = $1 AND (claimed_until IS NULL OR claimed_until < now() OR claimed_by = $3)
        RETURNING id`,
      [id, ttl, this.owner]
    );
    return rows.length > 0;
  }

  async save(job: PublishJob): Promise<void> {
    await this.ensureTable();
    await this.client.query(
      `UPDATE ${this.table} SET data = $2::jsonb, next_due_at = $3 WHERE id = $1`,
      [job.id, encodeJob(job), nextDueAt(job) ?? null]
    );
  }

  async release(id: string): Promise<void> {
    await this.ensureTable();
    await this.client.query(
      `UPDATE ${this.table} SET claimed_until = NULL, claimed_by = NULL
        WHERE id = $1 AND claimed_by = $2`,
      [id, this.owner]
    );
  }

  async list(filter: { pending?: boolean } = {}): Promise<PublishJob[]> {
    await this.ensureTable();
    const where =
      filter.pending === undefined
        ? ''
        : filter.pending
          ? 'WHERE next_due_at IS NOT NULL'
          : 'WHERE next_due_at IS NULL';
    const { rows } = await this.client.query(
      `SELECT data FROM ${this.table} ${where} ORDER BY created_at`
    );
    return rows.map((row) => decodeJob(fromJson(row.data)));
  }

  async remove(id: string): Promise<boolean> {
    await this.ensureTable();
    const { rows } = await this.client.query(
      `DELETE FROM ${this.table}
        WHERE id = $1 AND (claimed_until IS NULL OR claimed_until < now())
        RETURNING id`,
      [id]
    );
    return rows.length > 0;
  }

  private ensureTable(): Promise<void> {
    this.ready ??= (async () => {
      await createIfMissing(
        this.client,
        `CREATE TABLE IF NOT EXISTS ${this.table} (
           id text PRIMARY KEY,
           key text UNIQUE,
           next_due_at bigint,
           created_at bigint NOT NULL,
           claimed_until timestamptz,
           claimed_by text,
           data jsonb NOT NULL
         )`
      );
      const index = `${this.table.replace('.', '_')}_due_idx`;
      await createIfMissing(
        this.client,
        `CREATE INDEX IF NOT EXISTS ${index} ON ${this.table} (next_due_at) WHERE next_due_at IS NOT NULL`
      );
    })().catch((error: unknown) => {
      this.ready = undefined;
      throw error;
    });
    return this.ready;
  }
}
