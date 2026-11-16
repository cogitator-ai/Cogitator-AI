import type BetterSqlite3 from 'better-sqlite3';
import { chmodSync, closeSync, constants, lstatSync, mkdirSync, openSync, statSync } from 'node:fs';
import { dirname } from 'node:path';
import {
  TASK_AGENT_KEY,
  compareTasksNewestFirst,
  isTaskVisibleTo,
  taskCreatedAt,
  taskTime,
  type A2ATask,
  type TaskFilter,
  type TaskStore,
} from '@cogitator-ai/a2a';
import { BridgeError } from '../errors.js';
import { jobRecordOf } from '../job-record.js';
import {
  AdapterCapabilitiesSchema,
  BRIDGE_JOB_KEY,
  type AgentRecord,
  type AgentStatus,
  type DeliveryState,
  type JournalEntry,
  type JournalEntryType,
  type Letter,
  type LetterKind,
  type PermissionAsk,
  type Verdict,
  type ReportOutcome,
} from '../types.js';
import type {
  AcquireLeaseOptions,
  AcquireLeaseResult,
  AgentFilter,
  BridgeStore,
  JobTaskFilter,
  JournalQuery,
  Lease,
  LeaseCandidate,
  LetterFilter,
  LetterPatch,
} from './store.js';

/** The version of the schema this code reads and writes, kept in `PRAGMA user_version`. */
export const BRIDGE_SCHEMA_VERSION = 2;

/**
 * What each version of the schema added to the one before it: the first entry takes a database
 * of version 1 to version 2, and so on. `SCHEMA` is always the newest one whole
 */
const UPGRADES: readonly string[] = [
  `
  ALTER TABLE letters ADD COLUMN ask TEXT;
  ALTER TABLE letters ADD COLUMN verdict TEXT;
  ALTER TABLE letters ADD COLUMN needs_person INTEGER NOT NULL DEFAULT 0;
  ALTER TABLE letters ADD COLUMN person_asked_at INTEGER;
  ALTER TABLE agents ADD COLUMN permission_mode TEXT;
  CREATE INDEX letters_reply ON letters (in_reply_to) WHERE in_reply_to IS NOT NULL;
  CREATE INDEX letters_person ON letters (seq) WHERE needs_person = 1;
  `,
];

const MEMORY_PATH = ':memory:';
const LEASE_KEY = 'lease';

const SCHEMA = `
  CREATE TABLE meta (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );

  CREATE TABLE tasks (
    id TEXT PRIMARY KEY,
    context_id TEXT NOT NULL,
    state TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    job_number INTEGER UNIQUE,
    job_from TEXT,
    job_to TEXT,
    job_project TEXT,
    job_deadline_at INTEGER,
    job_parent INTEGER,
    job_created_at INTEGER,
    data TEXT NOT NULL
  );
  CREATE INDEX tasks_context ON tasks (context_id);
  CREATE INDEX tasks_updated ON tasks (updated_at DESC, id DESC);
  CREATE INDEX tasks_job_state ON tasks (state, job_deadline_at) WHERE job_number IS NOT NULL;
  CREATE INDEX tasks_job_to ON tasks (job_to, state) WHERE job_number IS NOT NULL;
  CREATE INDEX tasks_job_from ON tasks (job_from, job_created_at) WHERE job_number IS NOT NULL;
  CREATE INDEX tasks_job_parent ON tasks (job_parent) WHERE job_parent IS NOT NULL;

  CREATE TABLE job_numbers (
    number INTEGER PRIMARY KEY AUTOINCREMENT
  );

  CREATE TABLE agents (
    name TEXT PRIMARY KEY,
    harness TEXT NOT NULL,
    session_id TEXT NOT NULL,
    session_name TEXT,
    project TEXT NOT NULL,
    cwd TEXT NOT NULL,
    delivery TEXT NOT NULL,
    capabilities TEXT NOT NULL,
    status TEXT NOT NULL,
    registered_at INTEGER NOT NULL,
    last_seen_at INTEGER NOT NULL,
    permission_mode TEXT
  );
  CREATE UNIQUE INDEX agents_session ON agents (harness, session_id) WHERE session_id <> '';
  CREATE INDEX agents_project ON agents (project, harness);
  CREATE INDEX agents_seen ON agents (status, last_seen_at);

  CREATE TABLE letters (
    seq INTEGER PRIMARY KEY AUTOINCREMENT,
    id TEXT NOT NULL UNIQUE,
    job INTEGER NOT NULL,
    kind TEXT NOT NULL,
    sender TEXT NOT NULL,
    recipient TEXT NOT NULL,
    body TEXT NOT NULL,
    in_reply_to TEXT,
    outcome TEXT,
    state TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    delivered_at INTEGER,
    read_at INTEGER,
    handled_at INTEGER,
    attempts INTEGER NOT NULL DEFAULT 0,
    last_error TEXT,
    next_attempt_at INTEGER,
    reply_due_at INTEGER,
    reminded_at INTEGER,
    ask TEXT,
    verdict TEXT,
    needs_person INTEGER NOT NULL DEFAULT 0,
    person_asked_at INTEGER
  );
  CREATE INDEX letters_recipient ON letters (recipient, state, seq);
  CREATE INDEX letters_job ON letters (job, seq);
  CREATE INDEX letters_due ON letters (reply_due_at) WHERE reply_due_at IS NOT NULL;
  CREATE INDEX letters_reply ON letters (in_reply_to) WHERE in_reply_to IS NOT NULL;
  CREATE INDEX letters_person ON letters (seq) WHERE needs_person = 1;

  CREATE TABLE journal (
    seq INTEGER PRIMARY KEY AUTOINCREMENT,
    at INTEGER NOT NULL,
    type TEXT NOT NULL,
    job INTEGER,
    letter TEXT,
    agent TEXT,
    data TEXT
  );
  CREATE INDEX journal_job ON journal (job, seq);
  CREATE TRIGGER journal_no_update BEFORE UPDATE ON journal
  BEGIN
    SELECT RAISE(ABORT, 'the bridge journal is append-only');
  END;
  CREATE TRIGGER journal_no_delete BEFORE DELETE ON journal
  BEGIN
    SELECT RAISE(ABORT, 'the bridge journal is append-only');
  END;
`;

interface TaskRow {
  data: string;
}

interface AgentRow {
  name: string;
  harness: string;
  session_id: string;
  session_name: string | null;
  project: string;
  cwd: string;
  delivery: string;
  capabilities: string;
  status: string;
  registered_at: number;
  last_seen_at: number;
  permission_mode?: string | null;
}

interface LetterRow {
  seq: number;
  id: string;
  job: number;
  kind: string;
  sender: string;
  recipient: string;
  body: string;
  in_reply_to: string | null;
  outcome: string | null;
  state: string;
  created_at: number;
  delivered_at: number | null;
  read_at: number | null;
  handled_at: number | null;
  attempts: number;
  last_error: string | null;
  next_attempt_at: number | null;
  reply_due_at: number | null;
  reminded_at: number | null;
  ask?: string | null;
  verdict?: string | null;
  needs_person?: number;
  person_asked_at?: number | null;
}

interface JournalRow {
  seq: number;
  at: number;
  type: string;
  job: number | null;
  letter: string | null;
  agent: string | null;
  data: string | null;
}

type Bind = string | number | null;

function iso(ms: number): string {
  return new Date(ms).toISOString();
}

function ms(time: string): number {
  const value = Date.parse(time);
  if (Number.isNaN(value)) throw new BridgeError('storage', `Not a time: ${time}`);
  return value;
}

function optionalMs(time: string | undefined): number | null {
  return time === undefined ? null : ms(time);
}

function processIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

function toAgent(row: AgentRow): AgentRecord {
  return {
    name: row.name,
    harness: row.harness,
    sessionId: row.session_id,
    ...(row.session_name !== null && { sessionName: row.session_name }),
    project: row.project,
    cwd: row.cwd,
    delivery: row.delivery,
    capabilities: AdapterCapabilitiesSchema.parse(JSON.parse(row.capabilities)),
    status: row.status as AgentStatus,
    registeredAt: iso(row.registered_at),
    lastSeenAt: iso(row.last_seen_at),
    ...(row.permission_mode && { permissionMode: row.permission_mode }),
  };
}

function toLetter(row: LetterRow): Letter {
  return {
    id: row.id,
    seq: row.seq,
    job: row.job,
    kind: row.kind as LetterKind,
    from: row.sender,
    to: row.recipient,
    body: row.body,
    ...(row.in_reply_to !== null && { inReplyTo: row.in_reply_to }),
    ...(row.outcome !== null && { outcome: row.outcome as ReportOutcome }),
    state: row.state as DeliveryState,
    createdAt: iso(row.created_at),
    ...(row.delivered_at !== null && { deliveredAt: iso(row.delivered_at) }),
    ...(row.read_at !== null && { readAt: iso(row.read_at) }),
    ...(row.handled_at !== null && { handledAt: iso(row.handled_at) }),
    attempts: row.attempts,
    ...(row.last_error !== null && { lastError: row.last_error }),
    ...(row.next_attempt_at !== null && { nextAttemptAt: iso(row.next_attempt_at) }),
    ...(row.reply_due_at !== null && { replyDueAt: iso(row.reply_due_at) }),
    ...(row.reminded_at !== null && { remindedAt: iso(row.reminded_at) }),
    ...(row.ask && { ask: JSON.parse(row.ask) as PermissionAsk }),
    ...(row.verdict && { verdict: row.verdict as Verdict }),
    ...(row.needs_person === 1 && { needsPerson: true }),
    ...(typeof row.person_asked_at === 'number' && { personAskedAt: iso(row.person_asked_at) }),
  };
}

function toJournalEntry(row: JournalRow): JournalEntry {
  return {
    seq: row.seq,
    at: iso(row.at),
    type: row.type as JournalEntryType,
    ...(row.job !== null && { job: row.job }),
    ...(row.letter !== null && { letter: row.letter }),
    ...(row.agent !== null && { agent: row.agent }),
    ...(row.data !== null && { data: JSON.parse(row.data) as Record<string, unknown> }),
  };
}

/**
 * Makes sure the folder and the database are this user's and nobody else's before anything is
 * written to them: the database is created with mode 0600 from the start (SQLite gives its
 * `-wal` and `-shm` files the same mode), a file that is already there is narrowed, and a folder
 * or a file that belongs to someone else is refused. A filesystem without owners and modes
 * (Windows) keeps the protection of the user's profile, and root, who owns everything anyway, is
 * not asked whose the files are (a container often runs as root on a volume of the host's user).
 *
 * @throws BridgeError `storage` when the folder or the file belongs to another user, or the
 * file is not a plain file
 */
function makePrivate(path: string): void {
  const folder = dirname(path);
  if (process.platform === 'win32') {
    mkdirSync(folder, { recursive: true });
    return;
  }
  mkdirSync(folder, { recursive: true, mode: 0o700 });
  const self = process.getuid?.();
  const uid = self === 0 ? undefined : self;
  if (uid !== undefined && statSync(folder).uid !== uid) {
    throw new BridgeError(
      'storage',
      `The bridge folder ${folder} belongs to another user. Point COGITATOR_BRIDGE_HOME at a folder of your own`
    );
  }
  try {
    closeSync(openSync(path, constants.O_CREAT | constants.O_EXCL | constants.O_RDWR, 0o600));
    return;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
  }
  const file = lstatSync(path);
  if (!file.isFile() || (uid !== undefined && file.uid !== uid)) {
    throw new BridgeError(
      'storage',
      `The bridge database ${path} is not a plain file of this user. Remove it or point COGITATOR_BRIDGE_HOME elsewhere`
    );
  }
  for (const each of [path, `${path}-wal`, `${path}-shm`]) {
    try {
      chmodSync(each, 0o600);
    } catch (error) {
      if (each === path || (error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
  }
}

function placeholders(count: number): string {
  return Array.from({ length: count }, () => '?').join(', ');
}

class SqliteTaskStore implements TaskStore {
  constructor(private readonly db: BetterSqlite3.Database) {}

  async create(task: A2ATask): Promise<void> {
    this.write(task, 'INSERT');
  }

  async get(taskId: string): Promise<A2ATask | null> {
    return this.read(taskId) ?? null;
  }

  async update(taskId: string, update: Partial<A2ATask>): Promise<void> {
    this.db.transaction(() => {
      const existing = this.read(taskId);
      if (!existing) return;
      this.write({ ...existing, ...update }, 'REPLACE');
    })();
  }

  async list(filter?: TaskFilter): Promise<A2ATask[]> {
    const where: string[] = [];
    const binds: Bind[] = [];
    if (filter?.contextId) {
      where.push('context_id = ?');
      binds.push(filter.contextId);
    }
    if (filter?.state) {
      where.push('state = ?');
      binds.push(filter.state);
    }
    const clause = where.length > 0 ? `WHERE ${where.join(' AND ')}` : '';
    const rows = this.db.prepare<Bind[], TaskRow>(`SELECT data FROM tasks ${clause}`).all(...binds);
    let tasks = rows.map((row) => JSON.parse(row.data) as A2ATask);
    if (filter?.visibleTo !== undefined) {
      const userId = filter.visibleTo;
      tasks = tasks.filter((task) => isTaskVisibleTo(task, userId));
    }
    tasks.sort(compareTasksNewestFirst);
    const offset = filter?.offset ?? 0;
    return tasks.slice(offset, offset + (filter?.limit ?? tasks.length));
  }

  async delete(taskId: string): Promise<void> {
    this.db.prepare('DELETE FROM tasks WHERE id = ?').run(taskId);
  }

  read(taskId: string): A2ATask | undefined {
    const row = this.db
      .prepare<[string], TaskRow>('SELECT data FROM tasks WHERE id = ?')
      .get(taskId);
    return row ? (JSON.parse(row.data) as A2ATask) : undefined;
  }

  write(task: A2ATask, verb: 'INSERT' | 'REPLACE'): void {
    const job = jobRecordOf(task);
    this.db
      .prepare(
        `${verb} INTO tasks
           (id, context_id, state, created_at, updated_at, job_number, job_from, job_to, job_project, job_deadline_at, job_parent, job_created_at, data)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        task.id,
        task.contextId,
        task.status.state,
        taskCreatedAt(task),
        taskTime(task),
        job?.number ?? null,
        job?.from ?? null,
        job?.to ?? null,
        job?.project ?? null,
        job ? ms(job.deadlineAt) : null,
        job?.parent ?? null,
        job ? ms(job.createdAt) : null,
        JSON.stringify(task)
      );
  }
}

export interface OpenBridgeStoreOptions {
  /** Open to read only: the file must exist and nothing is written, the schema included */
  readonly?: boolean;
}

/**
 * The bridge's store in one SQLite file. Reads and writes are synchronous underneath, and a
 * transaction spans the awaits of the work it wraps, which holds as long as one piece of work
 * runs at a time, as the dispatcher's queue makes sure.
 */
export class SqliteBridgeStore implements BridgeStore {
  readonly tasks: TaskStore;
  private readonly taskRows: SqliteTaskStore;
  private open = true;
  private inTransaction = false;

  private constructor(
    private readonly db: BetterSqlite3.Database,
    readonly readonly: boolean
  ) {
    this.taskRows = new SqliteTaskStore(db);
    this.tasks = this.taskRows;
  }

  /**
   * Opens the store at `path` (`:memory:` for one that lives with the process), creating the
   * file and its folder when they are missing.
   *
   * @throws BridgeError `storage` when `better-sqlite3` is not installed, the file cannot be
   * opened, or it was written by a newer version of the bridge
   */
  static async open(
    path: string,
    options: OpenBridgeStoreOptions = {}
  ): Promise<SqliteBridgeStore> {
    let Database: typeof BetterSqlite3;
    try {
      Database = (await import('better-sqlite3')).default;
    } catch {
      throw new BridgeError(
        'storage',
        'The bridge keeps its state in SQLite and needs the "better-sqlite3" package. Install it: pnpm add better-sqlite3'
      );
    }

    const readonly = options.readonly ?? false;
    const inMemory = path === MEMORY_PATH;
    let db: BetterSqlite3.Database;
    try {
      if (!readonly && !inMemory) makePrivate(path);
      db = readonly ? new Database(path, { fileMustExist: true }) : new Database(path);
    } catch (error) {
      if (error instanceof BridgeError) throw error;
      throw new BridgeError(
        'storage',
        `Cannot open the bridge database ${path}: ${error instanceof Error ? error.message : String(error)}`
      );
    }

    try {
      db.pragma('busy_timeout = 5000');
      if (readonly) {
        db.pragma('query_only = ON');
      } else {
        if (!inMemory) {
          db.pragma('journal_mode = WAL');
          db.pragma('synchronous = NORMAL');
        }
      }
      SqliteBridgeStore.migrate(db, path, readonly);
    } catch (error) {
      db.close();
      throw error;
    }
    return new SqliteBridgeStore(db, readonly);
  }

  /**
   * Brings a database to the schema this code writes: an empty one gets it whole, an older one
   * the steps it lacks. A reader changes nothing, and reads an older database as it is: what a
   * newer schema added is simply absent from it.
   */
  private static migrate(db: BetterSqlite3.Database, path: string, readonly: boolean): void {
    const version = (): number => {
      const found = db.pragma('user_version', { simple: true }) as number;
      if (found > BRIDGE_SCHEMA_VERSION) {
        throw new BridgeError(
          'storage',
          `The bridge database ${path} was written by a newer version (schema ${found}, this one reads ${BRIDGE_SCHEMA_VERSION}). Update @cogitator-ai/bridge`
        );
      }
      return found;
    };
    const found = version();
    if (found === BRIDGE_SCHEMA_VERSION) return;
    if (readonly) {
      if (found > 0) return;
      throw new BridgeError(
        'storage',
        `The bridge database ${path} is empty: no dispatcher ran yet`
      );
    }
    db.transaction(() => {
      const from = version();
      if (from === BRIDGE_SCHEMA_VERSION) return;
      if (from === 0) db.exec(SCHEMA);
      else for (const step of UPGRADES.slice(from - 1)) db.exec(step);
      db.pragma(`user_version = ${BRIDGE_SCHEMA_VERSION}`);
    }).immediate();
  }

  async transaction<T>(work: () => Promise<T>): Promise<T> {
    if (this.inTransaction) {
      throw new BridgeError('storage', 'A bridge transaction is already running');
    }
    this.db.exec('BEGIN IMMEDIATE');
    this.inTransaction = true;
    try {
      const result = await work();
      this.db.exec('COMMIT');
      return result;
    } catch (error) {
      if (this.open && this.db.inTransaction) this.db.exec('ROLLBACK');
      throw error;
    } finally {
      this.inTransaction = false;
    }
  }

  acquireLease(candidate: LeaseCandidate, options: AcquireLeaseOptions): AcquireLeaseResult {
    const isAlive = options.isAlive ?? processIsAlive;
    return this.db
      .transaction((): AcquireLeaseResult => {
        const holder = this.readLease();
        if (
          holder &&
          holder.nonce !== candidate.nonce &&
          isAlive(holder.pid) &&
          options.now - holder.heartbeatAt <= options.ttlMs
        ) {
          return { acquired: false, holder };
        }
        const lease: Lease = { ...candidate, acquiredAt: options.now, heartbeatAt: options.now };
        this.db
          .prepare(
            'INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value'
          )
          .run(LEASE_KEY, JSON.stringify(lease));
        return { acquired: true, lease };
      })
      .immediate();
  }

  renewLease(nonce: string, now: number): boolean {
    return this.db
      .transaction((): boolean => {
        const holder = this.readLease();
        if (holder?.nonce !== nonce) return false;
        this.db
          .prepare('UPDATE meta SET value = ? WHERE key = ?')
          .run(JSON.stringify({ ...holder, heartbeatAt: now }), LEASE_KEY);
        return true;
      })
      .immediate();
  }

  releaseLease(nonce: string): void {
    this.db
      .transaction(() => {
        if (this.readLease()?.nonce === nonce) {
          this.db.prepare('DELETE FROM meta WHERE key = ?').run(LEASE_KEY);
        }
      })
      .immediate();
  }

  readLease(): Lease | undefined {
    const row = this.db
      .prepare<[string], { value: string }>('SELECT value FROM meta WHERE key = ?')
      .get(LEASE_KEY);
    return row ? (JSON.parse(row.value) as Lease) : undefined;
  }

  nextJobNumber(): number {
    const result = this.db.prepare('INSERT INTO job_numbers DEFAULT VALUES').run();
    return Number(result.lastInsertRowid);
  }

  taskOfJob(number: number): A2ATask | undefined {
    const row = this.db
      .prepare<[number], TaskRow>('SELECT data FROM tasks WHERE job_number = ?')
      .get(number);
    return row ? (JSON.parse(row.data) as A2ATask) : undefined;
  }

  jobTasks(filter: JobTaskFilter = {}): A2ATask[] {
    const where = ['job_number IS NOT NULL'];
    const binds: Bind[] = [];
    if (filter.states) {
      if (filter.states.length === 0) return [];
      where.push(`state IN (${placeholders(filter.states.length)})`);
      binds.push(...filter.states);
    }
    if (filter.from !== undefined) {
      where.push('job_from = ?');
      binds.push(filter.from);
    }
    if (filter.to !== undefined) {
      where.push('job_to = ?');
      binds.push(filter.to);
    }
    if (filter.party !== undefined) {
      where.push('(job_from = ? OR job_to = ?)');
      binds.push(filter.party, filter.party);
    }
    if (filter.project !== undefined) {
      where.push('job_project = ?');
      binds.push(filter.project);
    }
    if (filter.deadlineBy !== undefined) {
      where.push('job_deadline_at <= ?');
      binds.push(filter.deadlineBy);
    }
    if (filter.parent !== undefined) {
      where.push('job_parent = ?');
      binds.push(filter.parent);
    }
    if (filter.createdSince !== undefined) {
      where.push('job_created_at >= ?');
      binds.push(filter.createdSince);
    }
    const limit = filter.limit !== undefined ? 'LIMIT ?' : '';
    if (filter.limit !== undefined) binds.push(filter.limit);
    return this.db
      .prepare<Bind[], TaskRow>(
        `SELECT data FROM tasks WHERE ${where.join(' AND ')} ORDER BY job_number DESC ${limit}`
      )
      .all(...binds)
      .map((row) => JSON.parse(row.data) as A2ATask);
  }

  putAgent(agent: AgentRecord): void {
    this.db
      .prepare(
        `INSERT INTO agents
           (name, harness, session_id, session_name, project, cwd, delivery, capabilities, status, registered_at, last_seen_at,
            permission_mode)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (name) DO UPDATE SET
           harness = excluded.harness,
           session_id = excluded.session_id,
           session_name = excluded.session_name,
           project = excluded.project,
           cwd = excluded.cwd,
           delivery = excluded.delivery,
           capabilities = excluded.capabilities,
           status = excluded.status,
           registered_at = excluded.registered_at,
           last_seen_at = excluded.last_seen_at,
           permission_mode = excluded.permission_mode`
      )
      .run(
        agent.name,
        agent.harness,
        agent.sessionId,
        agent.sessionName ?? null,
        agent.project,
        agent.cwd,
        agent.delivery,
        JSON.stringify(agent.capabilities),
        agent.status,
        ms(agent.registeredAt),
        ms(agent.lastSeenAt),
        agent.permissionMode ?? null
      );
  }

  getAgent(name: string): AgentRecord | undefined {
    const row = this.db
      .prepare<[string], AgentRow>('SELECT * FROM agents WHERE name = ?')
      .get(name);
    return row ? toAgent(row) : undefined;
  }

  agentOfSession(harness: string, sessionId: string): AgentRecord | undefined {
    if (sessionId === '') return undefined;
    const row = this.db
      .prepare<[string, string], AgentRow>(
        'SELECT * FROM agents WHERE harness = ? AND session_id = ?'
      )
      .get(harness, sessionId);
    return row ? toAgent(row) : undefined;
  }

  listAgents(filter: AgentFilter = {}): AgentRecord[] {
    const where: string[] = [];
    const binds: Bind[] = [];
    if (filter.project !== undefined) {
      where.push('project = ?');
      binds.push(filter.project);
    }
    if (filter.harness !== undefined) {
      where.push('harness = ?');
      binds.push(filter.harness);
    }
    if (filter.statuses) {
      if (filter.statuses.length === 0) return [];
      where.push(`status IN (${placeholders(filter.statuses.length)})`);
      binds.push(...filter.statuses);
    }
    if (filter.seenBefore !== undefined) {
      where.push('last_seen_at < ?');
      binds.push(filter.seenBefore);
    }
    const clause = where.length > 0 ? `WHERE ${where.join(' AND ')}` : '';
    return this.db
      .prepare<Bind[], AgentRow>(`SELECT * FROM agents ${clause} ORDER BY registered_at, name`)
      .all(...binds)
      .map(toAgent);
  }

  mergeAgent(from: string, to: string): void {
    if (from === to) return;
    this.db.transaction(() => {
      this.db.prepare('UPDATE letters SET sender = ? WHERE sender = ?').run(to, from);
      this.db.prepare('UPDATE letters SET recipient = ? WHERE recipient = ?').run(to, from);
      const rows = this.db
        .prepare<[string, string], TaskRow>(
          'SELECT data FROM tasks WHERE job_from = ? OR job_to = ?'
        )
        .all(from, from);
      for (const row of rows) {
        const task = JSON.parse(row.data) as A2ATask;
        const record = jobRecordOf(task);
        if (!record) continue;
        this.taskRows.write(
          {
            ...task,
            metadata: {
              ...task.metadata,
              ...(task.metadata?.[TASK_AGENT_KEY] === from && { [TASK_AGENT_KEY]: to }),
              [BRIDGE_JOB_KEY]: {
                ...record,
                from: record.from === from ? to : record.from,
                to: record.to === from ? to : record.to,
              },
            },
          },
          'REPLACE'
        );
      }
      this.db.prepare('DELETE FROM agents WHERE name = ?').run(from);
    })();
  }

  insertLetter(letter: Omit<Letter, 'seq'>): Letter {
    const result = this.db
      .prepare(
        `INSERT INTO letters
           (id, job, kind, sender, recipient, body, in_reply_to, outcome, state, created_at,
            delivered_at, read_at, handled_at, attempts, last_error, next_attempt_at, reply_due_at, reminded_at,
            ask, verdict, needs_person, person_asked_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        letter.id,
        letter.job,
        letter.kind,
        letter.from,
        letter.to,
        letter.body,
        letter.inReplyTo ?? null,
        letter.outcome ?? null,
        letter.state,
        ms(letter.createdAt),
        optionalMs(letter.deliveredAt),
        optionalMs(letter.readAt),
        optionalMs(letter.handledAt),
        letter.attempts,
        letter.lastError ?? null,
        optionalMs(letter.nextAttemptAt),
        optionalMs(letter.replyDueAt),
        optionalMs(letter.remindedAt),
        letter.ask ? JSON.stringify(letter.ask) : null,
        letter.verdict ?? null,
        letter.needsPerson ? 1 : 0,
        optionalMs(letter.personAskedAt)
      );
    return { ...letter, seq: Number(result.lastInsertRowid) };
  }

  getLetter(id: string): Letter | undefined {
    const row = this.db.prepare<[string], LetterRow>('SELECT * FROM letters WHERE id = ?').get(id);
    return row ? toLetter(row) : undefined;
  }

  updateLetter(id: string, patch: LetterPatch): Letter {
    const sets: string[] = [];
    const binds: Bind[] = [];
    const set = (column: string, value: Bind) => {
      sets.push(`${column} = ?`);
      binds.push(value);
    };
    if (patch.state !== undefined) set('state', patch.state);
    if (patch.deliveredAt !== undefined) set('delivered_at', ms(patch.deliveredAt));
    if (patch.readAt !== undefined) set('read_at', ms(patch.readAt));
    if (patch.handledAt !== undefined) set('handled_at', ms(patch.handledAt));
    if (patch.attempts !== undefined) set('attempts', patch.attempts);
    if (patch.lastError !== undefined) set('last_error', patch.lastError);
    if (patch.nextAttemptAt !== undefined) set('next_attempt_at', ms(patch.nextAttemptAt));
    if (patch.replyDueAt !== undefined) set('reply_due_at', ms(patch.replyDueAt));
    if (patch.remindedAt !== undefined) set('reminded_at', ms(patch.remindedAt));
    if (patch.needsPerson !== undefined) set('needs_person', patch.needsPerson ? 1 : 0);
    if (patch.personAskedAt !== undefined) set('person_asked_at', ms(patch.personAskedAt));
    const clearable = {
      lastError: 'last_error',
      nextAttemptAt: 'next_attempt_at',
      replyDueAt: 'reply_due_at',
      remindedAt: 'reminded_at',
    } as const;
    for (const field of patch.clear ?? []) set(clearable[field], null);

    if (sets.length > 0) {
      this.db.prepare(`UPDATE letters SET ${sets.join(', ')} WHERE id = ?`).run(...binds, id);
    }
    const letter = this.getLetter(id);
    if (!letter)
      throw new BridgeError('unknown_letter', `There is no letter ${id}`, { letter: id });
    return letter;
  }

  listLetters(filter: LetterFilter = {}): Letter[] {
    const query = this.letterQuery(filter);
    if (!query) return [];
    const order = filter.newestFirst ? 'DESC' : 'ASC';
    const limit = filter.limit !== undefined ? 'LIMIT ?' : '';
    const binds = filter.limit !== undefined ? [...query.binds, filter.limit] : query.binds;
    return this.db
      .prepare<Bind[], LetterRow>(
        `SELECT * FROM letters ${query.clause} ORDER BY seq ${order} ${limit}`
      )
      .all(...binds)
      .map(toLetter);
  }

  countLetters(filter: LetterFilter = {}): number {
    const query = this.letterQuery(filter);
    if (!query) return 0;
    const row = this.db
      .prepare<Bind[], { total: number }>(`SELECT COUNT(*) AS total FROM letters ${query.clause}`)
      .get(...query.binds);
    return row?.total ?? 0;
  }

  queuedRecipients(): string[] {
    return this.db
      .prepare<[], { recipient: string }>(
        "SELECT DISTINCT recipient FROM letters WHERE state = 'queued' ORDER BY recipient"
      )
      .all()
      .map((row) => row.recipient);
  }

  private letterQuery(filter: LetterFilter): { clause: string; binds: Bind[] } | undefined {
    const where: string[] = [];
    const binds: Bind[] = [];
    if (filter.job !== undefined) {
      where.push('job = ?');
      binds.push(filter.job);
    }
    if (filter.from !== undefined) {
      where.push('sender = ?');
      binds.push(filter.from);
    }
    if (filter.to !== undefined) {
      where.push('recipient = ?');
      binds.push(filter.to);
    }
    if (filter.states) {
      if (filter.states.length === 0) return undefined;
      where.push(`state IN (${placeholders(filter.states.length)})`);
      binds.push(...filter.states);
    }
    if (filter.kinds) {
      if (filter.kinds.length === 0) return undefined;
      where.push(`kind IN (${placeholders(filter.kinds.length)})`);
      binds.push(...filter.kinds);
    }
    if (filter.afterSeq !== undefined) {
      where.push('seq > ?');
      binds.push(filter.afterSeq);
    }
    if (filter.attemptsBelow !== undefined) {
      where.push('attempts < ?');
      binds.push(filter.attemptsBelow);
    }
    if (filter.replyDueBy !== undefined) {
      where.push('reply_due_at IS NOT NULL AND reply_due_at <= ?');
      binds.push(filter.replyDueBy);
    }
    if (filter.needsPerson !== undefined) {
      where.push('needs_person = ?');
      binds.push(filter.needsPerson ? 1 : 0);
    }
    if (filter.inReplyTo !== undefined) {
      where.push('in_reply_to = ?');
      binds.push(filter.inReplyTo);
    }
    return { clause: where.length > 0 ? `WHERE ${where.join(' AND ')}` : '', binds };
  }

  appendJournal(entry: Omit<JournalEntry, 'seq'>): JournalEntry {
    const result = this.db
      .prepare('INSERT INTO journal (at, type, job, letter, agent, data) VALUES (?, ?, ?, ?, ?, ?)')
      .run(
        ms(entry.at),
        entry.type,
        entry.job ?? null,
        entry.letter ?? null,
        entry.agent ?? null,
        entry.data === undefined ? null : JSON.stringify(entry.data)
      );
    return { ...entry, seq: Number(result.lastInsertRowid) };
  }

  readJournal(query: JournalQuery = {}): JournalEntry[] {
    const where: string[] = [];
    const binds: Bind[] = [];
    if (query.afterSeq !== undefined) {
      where.push('seq > ?');
      binds.push(query.afterSeq);
    }
    if (query.job !== undefined) {
      where.push('job = ?');
      binds.push(query.job);
    }
    const clause = where.length > 0 ? `WHERE ${where.join(' AND ')}` : '';
    if (query.tail !== undefined) {
      return this.db
        .prepare<Bind[], JournalRow>(
          `SELECT * FROM (SELECT * FROM journal ${clause} ORDER BY seq DESC LIMIT ?) ORDER BY seq ASC`
        )
        .all(...binds, query.tail)
        .map(toJournalEntry);
    }
    const limit = query.limit !== undefined ? 'LIMIT ?' : '';
    if (query.limit !== undefined) binds.push(query.limit);
    return this.db
      .prepare<Bind[], JournalRow>(`SELECT * FROM journal ${clause} ORDER BY seq ASC ${limit}`)
      .all(...binds)
      .map(toJournalEntry);
  }

  close(): void {
    if (!this.open) return;
    this.open = false;
    this.db.close();
  }
}
