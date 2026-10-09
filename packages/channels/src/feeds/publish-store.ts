import { mkdir, readdir, readFile, rm } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
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
  /** Attempts that could have published: a wait for a full quota is not one. */
  attempts: number;
  /** The feed's idempotency key, kept from before the first attempt until it is published. */
  idempotencyKey?: string;
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

/** A worker's hold on a job: who holds it, and for how long a claim or an extension lasts. */
export interface JobClaim {
  owner: string;
  /** In ms. */
  ttl: number;
}

/**
 * Where a publisher keeps its jobs, so scheduled and retried posts survive a
 * restart. A worker claims a job before it publishes it, extends the claim
 * while it works, and can save the job only while the claim is its own, so
 * a worker that lost its claim never overwrites the one that took over.
 */
export interface PublishStore {
  /** Adds `job`, unless one with the same key exists: that one is returned instead. */
  add(job: PublishJob): Promise<PublishJob>;
  get(id: string): Promise<PublishJob | undefined>;
  /** Claims the job with the earliest delivery due by `now` that no one holds. */
  claimNext(now: number, claim: JobClaim): Promise<PublishJob | undefined>;
  /** Claims one job, `false` when someone holds it or it is missing. */
  claim(id: string, claim: JobClaim): Promise<boolean>;
  /** Extends `claim.owner`'s claim by `claim.ttl` from now, `false` when it lost it. */
  extend(id: string, claim: JobClaim): Promise<boolean>;
  /** Saves a job while `owner` holds it, `false` when the claim was lost and nothing was saved. */
  save(job: PublishJob, owner: string): Promise<boolean>;
  /** Releases `owner`'s claim on a job. */
  release(id: string, owner: string): Promise<void>;
  list(filter?: { pending?: boolean }): Promise<PublishJob[]>;
  /** Removes a job no worker holds, `false` when it is missing or held. */
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

const copyOf = (job: PublishJob): PublishJob => decodeJob(encodeJob(job));

/** Claims held by one process, for the in-memory and file stores. */
class LocalClaims {
  private readonly claims = new Map<string, { owner: string; until: number }>();

  constructor(private readonly now: () => number) {}

  held(id: string): boolean {
    return (this.claims.get(id)?.until ?? 0) > this.now();
  }

  holds(id: string, owner: string): boolean {
    const claim = this.claims.get(id);
    return claim?.owner === owner && claim.until > this.now();
  }

  take(id: string, claim: JobClaim): void {
    this.claims.set(id, { owner: claim.owner, until: this.now() + claim.ttl });
  }

  release(id: string, owner: string): void {
    if (this.claims.get(id)?.owner === owner) this.claims.delete(id);
  }

  drop(id: string): void {
    this.claims.delete(id);
  }
}

/** Jobs in memory, for tests and a publisher that needs no restart safety. */
export class MemoryPublishStore implements PublishStore {
  private readonly jobs = new Map<string, PublishJob>();
  private readonly claims: LocalClaims;

  constructor(now: () => number = Date.now) {
    this.claims = new LocalClaims(now);
  }

  async add(job: PublishJob): Promise<PublishJob> {
    const existing = job.key
      ? [...this.jobs.values()].find((candidate) => candidate.key === job.key)
      : undefined;
    if (existing) return copyOf(existing);
    this.jobs.set(job.id, copyOf(job));
    return copyOf(job);
  }

  async get(id: string): Promise<PublishJob | undefined> {
    const job = this.jobs.get(id);
    return job ? copyOf(job) : undefined;
  }

  async claimNext(now: number, claim: JobClaim): Promise<PublishJob | undefined> {
    const [next] = [...this.jobs.values()]
      .filter((job) => !this.claims.held(job.id) && (nextDueAt(job) ?? Infinity) <= now)
      .sort((a, b) => (nextDueAt(a) ?? 0) - (nextDueAt(b) ?? 0));
    if (!next) return undefined;
    this.claims.take(next.id, claim);
    return copyOf(next);
  }

  async claim(id: string, claim: JobClaim): Promise<boolean> {
    if (!this.jobs.has(id) || this.claims.held(id)) return false;
    this.claims.take(id, claim);
    return true;
  }

  async extend(id: string, claim: JobClaim): Promise<boolean> {
    if (!this.claims.holds(id, claim.owner)) return false;
    this.claims.take(id, claim);
    return true;
  }

  async save(job: PublishJob, owner: string): Promise<boolean> {
    if (!this.claims.holds(job.id, owner)) return false;
    this.jobs.set(job.id, copyOf(job));
    return true;
  }

  async release(id: string, owner: string): Promise<void> {
    this.claims.release(id, owner);
  }

  async list(filter: { pending?: boolean } = {}): Promise<PublishJob[]> {
    return [...this.jobs.values()]
      .filter((job) => filter.pending === undefined || isPending(job) === filter.pending)
      .sort((a, b) => a.createdAt - b.createdAt)
      .map(copyOf);
  }

  async remove(id: string): Promise<boolean> {
    if (this.claims.held(id)) return false;
    return this.jobs.delete(id);
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
  private readonly claims: LocalClaims;

  constructor(options: FilePublishStoreOptions = {}, now: () => number = Date.now) {
    this.directory = options.directory ?? join(homedir(), '.cogitator', 'feed-jobs');
    this.claims = new LocalClaims(now);
  }

  async add(job: PublishJob): Promise<PublishJob> {
    return this.queue.run(async () => {
      if (job.key) {
        const existing = (await this.readAll()).find((candidate) => candidate.key === job.key);
        if (existing) return existing;
      }
      await this.write(job);
      return copyOf(job);
    });
  }

  async get(id: string): Promise<PublishJob | undefined> {
    return this.queue.run(() => this.read(id));
  }

  async claimNext(now: number, claim: JobClaim): Promise<PublishJob | undefined> {
    return this.queue.run(async () => {
      const [next] = (await this.readAll())
        .filter((job) => !this.claims.held(job.id) && (nextDueAt(job) ?? Infinity) <= now)
        .sort((a, b) => (nextDueAt(a) ?? 0) - (nextDueAt(b) ?? 0));
      if (next) this.claims.take(next.id, claim);
      return next;
    });
  }

  async claim(id: string, claim: JobClaim): Promise<boolean> {
    return this.queue.run(async () => {
      if (this.claims.held(id) || !(await this.read(id))) return false;
      this.claims.take(id, claim);
      return true;
    });
  }

  async extend(id: string, claim: JobClaim): Promise<boolean> {
    return this.queue.run(async () => {
      if (!this.claims.holds(id, claim.owner)) return false;
      this.claims.take(id, claim);
      return true;
    });
  }

  async save(job: PublishJob, owner: string): Promise<boolean> {
    return this.queue.run(async () => {
      if (!this.claims.holds(job.id, owner)) return false;
      await this.write(job);
      return true;
    });
  }

  async release(id: string, owner: string): Promise<void> {
    await this.queue.run(async () => this.claims.release(id, owner));
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
      if (this.claims.held(id) || !(await this.read(id))) return false;
      await rm(this.fileOf(id), { force: true });
      this.claims.drop(id);
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
  /** Table name (default `cogitator_feed_jobs`), created on first use. */
  table?: string;
}

/**
 * Jobs in a Postgres table. Claims are leases on the database clock, taken
 * with `FOR UPDATE SKIP LOCKED`, so several publishing workers split the due
 * jobs between them, and a worker saves a job only while its lease holds.
 */
export class PostgresPublishStore implements PublishStore {
  private readonly client: PgClient;
  private readonly table: string;
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

  async claimNext(now: number, claim: JobClaim): Promise<PublishJob | undefined> {
    await this.ensureTable();
    const { rows } = await this.client.query(
      `UPDATE ${this.table}
          SET claimed_until = now() + $2::double precision * interval '1 millisecond',
              claimed_by = $3
        WHERE id = (
          SELECT id FROM ${this.table}
           WHERE next_due_at IS NOT NULL AND next_due_at <= $1
             AND (claimed_until IS NULL OR claimed_until < now())
           ORDER BY next_due_at
           LIMIT 1
           FOR UPDATE SKIP LOCKED)
        RETURNING data`,
      [now, claim.ttl, claim.owner]
    );
    return rows[0] ? decodeJob(fromJson(rows[0].data)) : undefined;
  }

  async claim(id: string, claim: JobClaim): Promise<boolean> {
    await this.ensureTable();
    const { rows } = await this.client.query(
      `UPDATE ${this.table}
          SET claimed_until = now() + $2::double precision * interval '1 millisecond',
              claimed_by = $3
        WHERE id = $1 AND (claimed_until IS NULL OR claimed_until < now())
        RETURNING id`,
      [id, claim.ttl, claim.owner]
    );
    return rows.length > 0;
  }

  async extend(id: string, claim: JobClaim): Promise<boolean> {
    await this.ensureTable();
    const { rows } = await this.client.query(
      `UPDATE ${this.table}
          SET claimed_until = now() + $2::double precision * interval '1 millisecond'
        WHERE id = $1 AND claimed_by = $3 AND claimed_until > now()
        RETURNING id`,
      [id, claim.ttl, claim.owner]
    );
    return rows.length > 0;
  }

  async save(job: PublishJob, owner: string): Promise<boolean> {
    await this.ensureTable();
    const { rows } = await this.client.query(
      `UPDATE ${this.table} SET data = $2::jsonb, next_due_at = $3
        WHERE id = $1 AND claimed_by = $4 AND claimed_until > now()
        RETURNING id`,
      [job.id, encodeJob(job), nextDueAt(job) ?? null, owner]
    );
    return rows.length > 0;
  }

  async release(id: string, owner: string): Promise<void> {
    await this.ensureTable();
    await this.client.query(
      `UPDATE ${this.table} SET claimed_until = NULL, claimed_by = NULL
        WHERE id = $1 AND claimed_by = $2`,
      [id, owner]
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
