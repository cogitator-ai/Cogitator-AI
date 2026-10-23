import { randomUUID } from 'node:crypto';
import { posix } from 'node:path';
import { z } from 'zod';
import {
  WORKSPACE_SNAPSHOT_DEFAULT_EXCLUDE,
  WorkspaceError,
  workspaceGlobMatcher,
  type Workspace,
  type WorkspaceEntry,
  type WorkspaceEntryType,
  type WorkspaceErrorCode,
  type WorkspaceExecOptions,
  type WorkspaceExecResult,
  type WorkspaceListOptions,
  type WorkspaceReadOptions,
  type WorkspaceRemoveOptions,
  type WorkspaceRemoveResult,
  type WorkspaceRenameOptions,
  type WorkspaceSnapshot,
  type WorkspaceSnapshotOptions,
  type WorkspaceStat,
  type WorkspaceWriteOptions,
} from '@cogitator-ai/types';
import {
  aborted,
  ioError,
  MarkerScanner,
  message,
  normalizeCwd,
  StreamText,
  trimTrailingSlashes,
} from '../exec-stream';
import type { RemoteProcess, RemoteShellConnection, RemoteShellDriver } from './driver';
import * as scripts from './scripts';
import { SCRIPT_EXIT } from './scripts';

const DEFAULT_MAX_FILE_BYTES = 10 * 1024 * 1024;
const DEFAULT_EXEC_TIMEOUT = 120_000;
const DEFAULT_MAX_OUTPUT_BYTES = 1024 * 1024;
const DEFAULT_KILL_GRACE = 2_000;
const DEFAULT_MAX_STREAM_BYTES = 64 * 1024 * 1024;
const DEFAULT_MAX_SNAPSHOT_BYTES = 1024 * 1024 * 1024;
const INTERNAL_TIMEOUT = 10 * 60_000;
/** Bytes a listing or a snapshot's tree may ship from the sandbox before it is refused. */
const LISTING_CAP = 64 * 1024 * 1024;
const KEEP_ALIVE_INTERVAL = 60_000;
const STDIO_GRACE = 200;
/** Exit code of a command stopped with SIGTERM (128 + 15), what a command stopped for its output reports. */
const STOPPED_EXIT_CODE = 143;
/** What `setsid -w` prints when the command it waits for was killed by a signal. */
const SETSID_NOTE = /^setsid: child \d+ did not exit normally[^\n]*\n?/gm;
const PROVIDER_TIMEOUT_MARGIN = 10_000;
const SERVICE_DIR = '.cogitator';
const TRASH_DIR = `${SERVICE_DIR}/trash`;
const SNAPSHOT_ID = /^snap_[a-z0-9]+_[a-f0-9]+$/;

/** Options every remote workspace takes, whatever the provider. */
export interface RemoteWorkspaceOptions {
  /** Id of the workspace (default: generated) */
  id?: string;
  /**
   * The directory in the sandbox the workspace is confined to, absolute or relative to the
   * provider's working directory (default: that directory, e.g. `/home/user` on E2B)
   */
  root?: string;
  /** Create the root when it is missing (default: true) */
  createRoot?: boolean;
  /** The current directory, relative to the root (default: `.`) */
  cwd?: string;
  /** Environment variables every command gets */
  env?: Record<string, string>;
  /** Largest file `read` and `write` accept, in bytes (default: 10 MiB) */
  maxFileBytes?: number;
  /** Milliseconds before a command is killed (default: 120000) */
  timeout?: number;
  /** Bytes of stdout and of stderr a result keeps (default: 1 MiB each) */
  maxOutputBytes?: number;
  /** Milliseconds between SIGTERM and SIGKILL when a command is stopped (default: 2000) */
  killGrace?: number;
  /** What happens to processes a command leaves in the background, when the call does not say (default: `kill`) */
  background?: 'kill' | 'keep';
  /**
   * Bytes a command may print (stdout and stderr together) before it is stopped like on a
   * timeout, with `truncated` set and exit code 143 (default: 64 MiB). The providers' SDKs keep
   * a command's whole output in memory, E2B's even when it is streamed, so endless output
   * (`yes`, a log tail) would otherwise grow without bound
   */
  maxStreamBytes?: number;
  /**
   * Bytes of files a snapshot may hold, refused with `TOO_LARGE` beyond (default: 1 GiB).
   * Exclude what can be rebuilt (`node_modules/**`, build output) to stay under it
   */
  maxSnapshotBytes?: number;
}

export interface RemoteShellWorkspaceOptions extends RemoteWorkspaceOptions {
  /** How the sandbox is reached */
  driver: RemoteShellDriver;
}

/** What a workspace and its `withCwd()` views share. */
interface RemoteState {
  connection?: RemoteShellConnection;
  starting?: Promise<RemoteShellConnection>;
  realRoot?: string;
  /** The sandbox's temporary directory, where uploads and read copies go */
  temp?: string;
  disposed: boolean;
  /** Commands running right now */
  running: number;
  /** Process groups of commands that may still have processes */
  groups: Set<number>;
}

interface Listing {
  /** The listed directory, relative to the root */
  base: string;
  entries: ListedEntry[];
}

interface ListedEntry {
  type: string;
  size: string;
  modified: string;
  path: string;
}

interface TreeEntry {
  type: WorkspaceEntryType;
  size: number;
  key: string;
  name: string;
}

interface ScriptResult {
  code: number;
  stdout: string;
}

const snapshotRecordSchema = z.object({
  id: z.string().regex(SNAPSHOT_ID),
  workspaceId: z.string(),
  createdAt: z.string(),
  label: z.string().optional(),
  metadata: z.record(z.string(), z.unknown()).optional(),
  exclude: z.array(z.string()),
});

/**
 * A workspace in a remote sandbox, the same on every provider: the driver only creates the
 * sandbox, moves bytes and runs programs, and everything else (path checks, listing, moves, the
 * trash, process groups, snapshots) runs as shell scripts in the sandbox. The sandbox needs
 * `sh`, GNU coreutils, findutils and tar, and util-linux `setsid`, as the Debian, Ubuntu and
 * Amazon Linux images of E2B, Daytona and Vercel have; `start()` names what is missing.
 *
 * Paths are checked like a `LocalWorkspace` does: normalized against the root, then resolved in
 * the sandbox with every symlink followed (`realpath -m`), and refused with `OUTSIDE_ROOT` when
 * they land outside. The sandbox is the security boundary: a command can reach any file of the
 * sandbox anyway, so the check keeps the file tools in the root rather than guarding the machine.
 *
 * Each command runs in a session and process group of its own (`setsid`), and a timeout, an abort
 * or output past `maxStreamBytes` sends SIGTERM to the group, SIGKILL after `killGrace`. A process
 * that starts a session of its own (`setsid`) leaves the group and lives on until the sandbox
 * goes. Like `LocalWorkspace`, `remove` and `rename` are refused with `BUSY` while a command of
 * the workspace still runs or left processes in the background.
 *
 * Snapshots are tar archives in `.cogitator/snapshots` inside the sandbox: they live and die with
 * it, and always leave `.cogitator/**` out, whatever `exclude` adds. The workspace starts itself
 * on first use, keeps the sandbox alive while it is used (where the provider has a lifetime),
 * and `dispose()` kills the processes its commands left running and releases the sandbox as the
 * provider's options say.
 */
export class RemoteShellWorkspace implements Workspace {
  readonly id: string;
  readonly cwd: string;
  private readonly driver: RemoteShellDriver;
  private readonly givenRoot: string | undefined;
  private readonly createRoot: boolean;
  private readonly env: Record<string, string>;
  private readonly maxFileBytes: number;
  private readonly timeout: number;
  private readonly maxOutputBytes: number;
  private readonly killGrace: number;
  private readonly background: 'kill' | 'keep';
  private readonly maxStreamBytes: number;
  private readonly maxSnapshotBytes: number;
  private readonly state: RemoteState;

  constructor(options: RemoteShellWorkspaceOptions) {
    this.driver = options.driver;
    this.id = options.id ?? `workspace_${randomUUID().replace(/-/g, '').slice(0, 10)}`;
    this.cwd = normalizeCwd(options.cwd ?? '.');
    if (options.root !== undefined && (options.root === '' || options.root.includes('\0'))) {
      throw new WorkspaceError('INVALID_PATH', `Invalid root: ${JSON.stringify(options.root)}`);
    }
    this.givenRoot = options.root;
    this.createRoot = options.createRoot ?? true;
    this.env = { ...options.env };
    this.maxFileBytes = positive(options.maxFileBytes, DEFAULT_MAX_FILE_BYTES, 'maxFileBytes');
    this.timeout = positive(options.timeout, DEFAULT_EXEC_TIMEOUT, 'timeout');
    this.maxOutputBytes = positive(
      options.maxOutputBytes,
      DEFAULT_MAX_OUTPUT_BYTES,
      'maxOutputBytes'
    );
    this.killGrace = positive(options.killGrace, DEFAULT_KILL_GRACE, 'killGrace');
    this.background = options.background ?? 'kill';
    this.maxStreamBytes = positive(
      options.maxStreamBytes,
      DEFAULT_MAX_STREAM_BYTES,
      'maxStreamBytes'
    );
    this.maxSnapshotBytes = positive(
      options.maxSnapshotBytes,
      DEFAULT_MAX_SNAPSHOT_BYTES,
      'maxSnapshotBytes'
    );
    this.state = { disposed: false, running: 0, groups: new Set() };
  }

  /** The root with symlinks resolved once started, the configured one before */
  get root(): string {
    return this.state.realRoot ?? this.rootFrom(undefined);
  }

  /** Id of the sandbox, once started */
  get sandboxId(): string | undefined {
    return this.state.connection?.sandboxId;
  }

  async start(): Promise<void> {
    await this.ready();
  }

  async dispose(): Promise<void> {
    if (this.state.disposed) return;
    this.state.disposed = true;
    const connection = await this.state.starting?.catch(() => undefined);
    if (!connection) return;
    if (this.state.groups.size > 0) {
      const groups = [...this.state.groups].map(String);
      this.state.groups.clear();
      await connection
        .run(['sh', '-c', scripts.SIGNAL_GROUPS, 'cogitator', 'KILL', ...groups], {
          cwd: '/',
          timeout: 30_000,
        })
        .catch(() => undefined);
    }
    await connection.close();
  }

  withCwd(cwd: string): this {
    const view = Object.create(Object.getPrototypeOf(this) as object) as this;
    return Object.assign(view, this, { cwd: normalizeCwd(cwd) });
  }

  async contains(path: string): Promise<boolean> {
    try {
      const target = await this.lexical(path);
      const { code } = await this.script(scripts.CONTAINS, [target], path);
      return code === 0;
    } catch {
      return false;
    }
  }

  async read(path: string, options?: WorkspaceReadOptions): Promise<string> {
    const bytes = await this.readBytes(path, options);
    return Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).toString('utf8');
  }

  async readBytes(path: string, options: WorkspaceReadOptions = {}): Promise<Uint8Array> {
    const limit = positive(options.maxBytes, this.maxFileBytes, 'maxBytes');
    const target = await this.lexical(path);
    const name = `cogitator-read-${randomUUID().replace(/-/g, '')}`;
    try {
      const { code, stdout } = await this.script(
        scripts.READ,
        [target, integer(limit), name],
        path
      );
      if (code === SCRIPT_EXIT.tooLarge) throw tooLarge(path, Number(stdout), limit);
      this.check(code, path);
      const connection = await this.ready();
      const bytes = await connection.readFile(stdout).catch((error: unknown) => {
        throw new WorkspaceError(
          'IO',
          `Could not read ${path} from the sandbox: ${message(error)}`,
          {
            path,
            cause: error,
          }
        );
      });
      if (bytes.byteLength > limit) throw tooLarge(path, bytes.byteLength, limit);
      return bytes;
    } finally {
      await this.discard([name], path);
    }
  }

  async write(
    path: string,
    content: string | Uint8Array,
    options: WorkspaceWriteOptions = {}
  ): Promise<void> {
    const limit = positive(options.maxBytes, this.maxFileBytes, 'maxBytes');
    const bytes = typeof content === 'string' ? Buffer.from(content, 'utf8') : content;
    if (bytes.byteLength > limit) throw tooLarge(path, bytes.byteLength, limit);
    const target = await this.lexical(path);
    if (target === this.root) {
      throw new WorkspaceError('NOT_A_FILE', 'The root is not a file', { path });
    }
    const upload = await this.upload('upload', bytes, path);
    const { code } = await this.script(
      scripts.COMMIT_WRITE,
      [
        target,
        upload,
        options.createParents === false ? '0' : '1',
        options.force ? '1' : '0',
        String(bytes.byteLength),
        token(),
      ],
      path
    ).catch(async (error: unknown) => {
      await this.discard([upload], path);
      throw error;
    });
    if (code === SCRIPT_EXIT.uploadChanged) {
      throw new WorkspaceError('IO', `${path}: the upload changed before it was moved into place`, {
        path,
      });
    }
    this.check(code, path);
  }

  async list(path = '.', options: WorkspaceListOptions = {}): Promise<WorkspaceEntry[]> {
    const target = await this.lexical(path);
    const remoteLimit =
      options.limit === undefined || options.glob ? '' : integer(Math.max(0, options.limit));
    const listed =
      (await this.listing(target, path, remoteLimit, 'sorted', options)) ??
      (await this.listing(target, path, '', 'raw', options));
    const matches = options.glob ? workspaceGlobMatcher(options.glob) : undefined;
    const entries: { segments: string[]; entry: WorkspaceEntry }[] = [];
    for (const found of listed.entries) {
      if (matches && !matches(found.path)) continue;
      const segments = found.path.split('/');
      entries.push({
        segments,
        entry: {
          name: segments[segments.length - 1],
          path: listed.base === '.' ? found.path : `${listed.base}/${found.path}`,
          type: entryType(found.type),
          size: Number(found.size),
          modifiedAt: Number(found.modified) * 1000,
        },
      });
    }
    entries.sort((a, b) => compareSegments(a.segments, b.segments));
    const limit = options.limit ?? Infinity;
    return entries.slice(0, limit).map(({ entry }) => entry);
  }

  /**
   * The entries of a listing as the sandbox sends them. `sorted` sends them in tree order and cut
   * at the limit, but cannot tell a `/` from an STX byte in a name, so it answers `undefined` when
   * a name holds SOH or STX, and `raw` (hex-encoded, every entry) is asked instead.
   */
  private async listing(
    target: string,
    path: string,
    limit: string,
    mode: 'raw',
    options: WorkspaceListOptions
  ): Promise<Listing>;
  private async listing(
    target: string,
    path: string,
    limit: string,
    mode: 'sorted',
    options: WorkspaceListOptions
  ): Promise<Listing | undefined>;
  private async listing(
    target: string,
    path: string,
    limit: string,
    mode: 'sorted' | 'raw',
    options: WorkspaceListOptions
  ): Promise<Listing | undefined> {
    const { code, stdout } = await this.script(
      scripts.LIST,
      [target, limit, integer(LISTING_CAP), mode, ...findExpression(options, mode)],
      path
    );
    this.check(code, path);
    const end = stdout.indexOf('\0');
    const base = end === -1 ? '.' : stdout.slice(0, end);
    const body = end === -1 ? '' : stdout.slice(end + 1);
    const shipped = mode === 'raw' ? body.length / 2 : Buffer.byteLength(body, 'utf8');
    if (shipped > LISTING_CAP) {
      throw new WorkspaceError(
        'TOO_LARGE',
        `The listing of ${path} is over ${LISTING_CAP} bytes: narrow it with skipDirs, glob or limit`,
        { path }
      );
    }
    const entries: ListedEntry[] = [];
    if (mode === 'raw') {
      const fields = Buffer.from(body, 'hex').toString('utf8').split('\0');
      for (let i = 0; i + 4 < fields.length; i += 5) {
        entries.push({
          type: fields[i],
          size: fields[i + 1],
          modified: fields[i + 2],
          path: fields[i + 4],
        });
      }
      return { base, entries };
    }
    for (const record of body.split('\0')) {
      if (!record) continue;
      const fields = record.split('\u0001');
      if (fields.length !== 5) return undefined;
      const [key, type, size, modified, depth] = fields;
      if (count(key, '\u0002') !== Number(depth) - 1) return undefined;
      entries.push({ type, size, modified, path: key.replaceAll('\u0002', '/') });
    }
    return { base, entries };
  }

  async stat(path: string): Promise<WorkspaceStat> {
    const target = await this.lexical(path);
    const { code, stdout } = await this.script(scripts.STAT, [target], path);
    this.check(code, path);
    const [type, size, modified, rel] = stdout.split('\0');
    return {
      path: rel,
      type: entryType(type),
      size: Number(size),
      modifiedAt: Number(modified) * 1000,
    };
  }

  async exists(path: string): Promise<boolean> {
    const target = await this.lexical(path);
    const { code, stdout } = await this.script(scripts.EXISTS, [target], path);
    this.check(code, path);
    return stdout === '1';
  }

  async mkdir(path: string): Promise<void> {
    const target = await this.lexical(path);
    const { code } = await this.script(scripts.MKDIR, [target], path);
    this.check(code, path);
  }

  async remove(path: string, options: WorkspaceRemoveOptions = {}): Promise<WorkspaceRemoveResult> {
    const target = await this.lexical(path);
    this.refuseWhileRunning(path);
    const stamp = options.trash
      ? `${new Date().toISOString().replace(/[:.]/g, '-')}-${randomUUID().slice(0, 6)}`
      : undefined;
    const groups = [...this.state.groups];
    const { code, stdout } = await this.script(
      scripts.REMOVE,
      [
        target,
        options.recursive ? '1' : '0',
        stamp ? posix.join(this.root, TRASH_DIR, stamp) : '',
        ...groups.map(String),
      ],
      path
    );
    if (code !== SCRIPT_EXIT.busy) this.forget(groups);
    if (code === SCRIPT_EXIT.rootPath) {
      throw new WorkspaceError('INVALID_PATH', 'The root cannot be removed', { path });
    }
    if (code === SCRIPT_EXIT.notEmpty) {
      throw new WorkspaceError(
        'NOT_EMPTY',
        `${path} is a directory with entries, pass recursive to remove it`,
        { path }
      );
    }
    this.check(code, path);
    return { path: stdout, ...(stamp && { trashedTo: `${TRASH_DIR}/${stamp}/${stdout}` }) };
  }

  async rename(from: string, to: string, options: WorkspaceRenameOptions = {}): Promise<void> {
    const source = await this.lexical(from);
    const target = await this.lexical(to);
    this.refuseWhileRunning(from);
    const groups = [...this.state.groups];
    const { code } = await this.script(
      scripts.RENAME,
      [source, target, options.overwrite ? '1' : '0', ...groups.map(String)],
      from
    );
    if (code !== SCRIPT_EXIT.busy) this.forget(groups);
    switch (code) {
      case SCRIPT_EXIT.rootPath:
        throw new WorkspaceError('INVALID_PATH', 'The root cannot be moved', { path: from });
      case SCRIPT_EXIT.insideItself:
        throw new WorkspaceError('INVALID_PATH', `${to} is inside ${from}`, { path: to });
      case SCRIPT_EXIT.outsideTarget:
      case SCRIPT_EXIT.internalTarget:
        throw scriptError(code, to);
      case SCRIPT_EXIT.exists:
        throw new WorkspaceError('EXISTS', `${to} already exists`, { path: to });
      case SCRIPT_EXIT.isDirectory:
        throw new WorkspaceError('NOT_A_FILE', `${to} is a directory`, { path: to });
      case SCRIPT_EXIT.notADirectory:
        throw new WorkspaceError('NOT_A_DIRECTORY', `${to} is not a directory`, { path: to });
      case SCRIPT_EXIT.notEmpty:
        throw new WorkspaceError('NOT_EMPTY', `${to} is a directory with entries`, { path: to });
      default:
        this.check(code, from);
    }
  }

  async exec(command: string, options: WorkspaceExecOptions = {}): Promise<WorkspaceExecResult> {
    const timeout = positive(options.timeout, this.timeout, 'timeout');
    const maxOutput = positive(options.maxOutputBytes, this.maxOutputBytes, 'maxOutputBytes');
    if (options.signal?.aborted) throw aborted(options.signal);
    const cwdPath = options.cwd ?? this.cwd;
    const cwd = await this.lexical(cwdPath);
    const connection = await this.ready();
    this.state.running++;
    void connection.keepAlive?.().catch(() => undefined);
    const keepAlive = setInterval(
      () => void connection.keepAlive?.().catch(() => undefined),
      KEEP_ALIVE_INTERVAL
    );
    keepAlive.unref();
    try {
      return await this.run(connection, command, {
        cwd,
        cwdPath,
        env: { ...this.env, ...options.env },
        timeout,
        maxOutput,
        background: options.background ?? this.background,
        signal: options.signal,
        onStdout: options.onStdout,
        onStderr: options.onStderr,
      });
    } finally {
      clearInterval(keepAlive);
      this.state.running--;
    }
  }

  /**
   * Records the files of the root as a tar archive in `.cogitator/snapshots` inside the sandbox,
   * but for what `exclude` leaves out, and always `.cogitator/**`. Refused with `TOO_LARGE` when
   * the files are over `maxSnapshotBytes`.
   */
  async snapshot(options: WorkspaceSnapshotOptions = {}): Promise<WorkspaceSnapshot> {
    const exclude = [
      ...new Set([...WORKSPACE_SNAPSHOT_DEFAULT_EXCLUDE, ...(options.exclude ?? [])]),
    ];
    const record: WorkspaceSnapshot = {
      id: `snap_${Date.now().toString(36)}_${randomUUID().replace(/-/g, '').slice(0, 8)}`,
      workspaceId: this.id,
      createdAt: new Date().toISOString(),
      ...(options.label !== undefined && { label: options.label }),
      ...(options.metadata !== undefined && { metadata: options.metadata }),
      exclude,
    };
    const excluded = excludedBy(exclude);
    const kept = (await this.tree(exclude)).filter((entry) => !excluded(entry.name));
    const bytes = kept.reduce(
      (sum, entry) => sum + (entry.type === 'directory' ? 0 : entry.size),
      0
    );
    if (bytes > this.maxSnapshotBytes) {
      throw new WorkspaceError(
        'TOO_LARGE',
        `A snapshot would hold ${bytes} bytes, over the limit of ${this.maxSnapshotBytes} bytes: exclude what can be rebuilt (node_modules/**, build output) or raise maxSnapshotBytes`
      );
    }
    const lists: string[] = [];
    try {
      lists.push(await this.upload('list', nulList(kept.map((entry) => entry.key)), 'snapshot'));
      lists.push(
        await this.upload(
          'list',
          nulList(kept.filter((entry) => entry.type === 'directory').map((entry) => entry.key)),
          'snapshot'
        )
      );
      const { code } = await this.script(
        scripts.SNAPSHOT_CREATE,
        [record.id, JSON.stringify(record), ...lists],
        'snapshot'
      );
      this.check(code, 'snapshot');
    } catch (error) {
      await this.discard(lists, 'snapshot');
      await this.script(scripts.SNAPSHOT_DISCARD, [record.id], 'snapshot').catch(() => undefined);
      throw error;
    }
    return record;
  }

  /**
   * Brings the files back to a snapshot: entries made since are removed, changed ones rewritten
   * from the archive, the paths the snapshot excluded left alone.
   */
  async restore(snapshotId: string): Promise<void> {
    const record = await this.snapshotRecord(snapshotId);
    const saved = await this.savedPaths(record.id, 'list');
    const savedDirectories = await this.savedPaths(record.id, 'dirs');
    const excluded = excludedBy(record.exclude);
    const files: string[] = [];
    const dirs: string[] = [];
    for (const entry of await this.tree(record.exclude)) {
      if (excluded(entry.name)) continue;
      if (entry.type === 'directory') {
        if (!savedDirectories.has(entry.key)) dirs.push(entry.key);
      } else if (!saved.has(entry.key) || savedDirectories.has(entry.key)) {
        files.push(entry.key);
      }
    }
    dirs.sort((a, b) => depth(b) - depth(a));
    const lists: string[] = [];
    let code: number;
    try {
      lists.push(await this.upload('list', nulList(files), 'restore'));
      lists.push(await this.upload('list', nulList(dirs), 'restore'));
      ({ code } = await this.script(scripts.SNAPSHOT_RESTORE, [record.id, ...lists], 'restore'));
    } finally {
      await this.discard(lists, 'restore');
    }
    if (code === SCRIPT_EXIT.notFound) throw snapshotMissing(snapshotId);
    this.check(code, 'restore');
  }

  /** The snapshots kept in the sandbox, oldest first. */
  async listSnapshots(): Promise<WorkspaceSnapshot[]> {
    const { code, stdout } = await this.script(
      scripts.SNAPSHOT_RECORDS,
      [integer(LISTING_CAP)],
      'snapshots'
    );
    this.check(code, 'snapshots');
    if (Buffer.byteLength(stdout, 'utf8') > LISTING_CAP) {
      throw new WorkspaceError('TOO_LARGE', `The snapshot records are over ${LISTING_CAP} bytes`);
    }
    const records: WorkspaceSnapshot[] = [];
    for (const text of stdout.split('\0')) {
      if (!text) continue;
      const parsed = snapshotRecordSchema.safeParse(safeJson(text));
      if (parsed.success) records.push(parsed.data);
    }
    return records.sort(
      (a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id)
    );
  }

  async deleteSnapshot(snapshotId: string): Promise<void> {
    if (!SNAPSHOT_ID.test(snapshotId)) throw snapshotMissing(snapshotId);
    const { code } = await this.script(scripts.SNAPSHOT_DELETE, [snapshotId], 'snapshots');
    if (code === SCRIPT_EXIT.notFound) throw snapshotMissing(snapshotId);
    this.check(code, 'snapshots');
  }

  private async snapshotRecord(snapshotId: string): Promise<WorkspaceSnapshot> {
    if (!SNAPSHOT_ID.test(snapshotId)) throw snapshotMissing(snapshotId);
    const record = (await this.listSnapshots()).find((snapshot) => snapshot.id === snapshotId);
    if (!record) throw snapshotMissing(snapshotId);
    return record;
  }

  /**
   * The paths (`list`) or the directories (`dirs`) a snapshot holds, each as its bytes in a
   * `latin1` string, so names that are not UTF-8 compare as they are.
   */
  private async savedPaths(id: string, kind: 'list' | 'dirs'): Promise<Set<string>> {
    const { code, stdout } = await this.script(
      scripts.SNAPSHOT_SAVED,
      [id, kind, integer(LISTING_CAP)],
      'restore'
    );
    if (code === SCRIPT_EXIT.notFound) throw snapshotMissing(id);
    this.check(code, 'restore');
    const hex = stdout.trim();
    if (hex.length / 2 > LISTING_CAP) {
      throw new WorkspaceError(
        'TOO_LARGE',
        `The paths of snapshot ${id} are over ${LISTING_CAP} bytes`
      );
    }
    const paths = new Set<string>();
    for (const name of Buffer.from(hex, 'hex').toString('latin1').split('\0')) {
      if (name.startsWith('./')) paths.add(name.slice(2));
    }
    return paths;
  }

  /**
   * Everything under the root but `.cogitator` and the plainly excluded directories, parents first:
   * `key` is the path's bytes as a `latin1` string, `name` the path read as UTF-8 (for globs).
   */
  private async tree(exclude: readonly string[]): Promise<TreeEntry[]> {
    const { code, stdout } = await this.script(
      scripts.SNAPSHOT_TREE,
      [integer(LISTING_CAP), ...pruneTests(exclude)],
      'snapshot'
    );
    this.check(code, 'snapshot');
    const hex = stdout.trim();
    if (hex.length / 2 > LISTING_CAP) {
      throw new WorkspaceError(
        'TOO_LARGE',
        `The file tree to snapshot is over ${LISTING_CAP} bytes of names: exclude what can be rebuilt (node_modules/**, build output)`
      );
    }
    const fields = Buffer.from(hex, 'hex').toString('latin1').split('\0');
    const entries: TreeEntry[] = [];
    for (let i = 0; i + 2 < fields.length; i += 3) {
      const key = fields[i + 2];
      entries.push({
        type: entryType(fields[i]),
        size: Number(fields[i + 1]),
        key,
        name: Buffer.from(key, 'latin1').toString('utf8'),
      });
    }
    return entries;
  }

  private async run(
    connection: RemoteShellConnection,
    command: string,
    options: {
      cwd: string;
      cwdPath: string;
      env: Record<string, string>;
      timeout: number;
      maxOutput: number;
      background: 'kill' | 'keep';
      signal?: AbortSignal;
      onStdout?: (chunk: string) => void;
      onStderr?: (chunk: string) => void;
    }
  ): Promise<WorkspaceExecResult> {
    const started = Date.now();
    const token = randomUUID().replace(/-/g, '');
    const stdout = new StreamText(options.maxOutput, options.onStdout);
    const stderr = new StreamText(options.maxOutput, options.onStderr);
    let group: number | undefined;
    let exitCode: number | undefined;
    let cwdCode: number | undefined;
    let stopReason: 'timeout' | 'abort' | 'overflow' | undefined;
    let child: RemoteProcess | undefined;
    let streamed = 0;
    let releaseRead: () => void = () => undefined;
    const readReleased = new Promise<void>((resolve) => {
      releaseRead = resolve;
    });

    const signalGroup = (signal: 'TERM' | 'KILL', target: number) =>
      connection
        .run(['sh', '-c', scripts.SIGNAL_GROUPS, 'cogitator', signal, String(target)], {
          cwd: '/',
          timeout: 30_000,
        })
        .then(
          () => undefined,
          () => undefined
        );
    const stopGroup = () => {
      if (group === undefined) return;
      const target = group;
      void signalGroup('TERM', target).then(() => {
        setTimeout(() => {
          void signalGroup('KILL', target).then(() => this.state.groups.delete(target));
        }, this.killGrace).unref();
      });
    };
    const markers = new MarkerScanner(
      token,
      (text) => stderr.pushText(text),
      (kind, value) => {
        if (kind === 'pgid') {
          group = value > 1 ? value : undefined;
          if (group !== undefined) this.state.groups.add(group);
          if (stopReason) stopGroup();
          return;
        }
        if (kind === 'cwd') {
          cwdCode = value;
          return;
        }
        exitCode = value;
        if (options.background === 'kill') stopGroup();
        setTimeout(releaseRead, STDIO_GRACE).unref();
      }
    );
    const stop = (reason: 'timeout' | 'abort' | 'overflow') => {
      if (stopReason) return;
      stopReason = reason;
      if (reason === 'overflow') child?.detach?.();
      if (group === undefined) void child?.kill().catch(() => undefined);
      stopGroup();
      setTimeout(() => void child?.kill().catch(() => undefined), this.killGrace).unref();
      setTimeout(releaseRead, this.killGrace + 1_000).unref();
    };
    const take = (chunk: string | Uint8Array, into: (data: Buffer) => void) => {
      if (stopReason === 'overflow') return;
      const data = toBuffer(chunk);
      streamed += data.length;
      into(data);
      if (streamed > this.maxStreamBytes) stop('overflow');
    };
    const onAbort = () => stop('abort');
    options.signal?.addEventListener('abort', onAbort, { once: true });
    const timer = setTimeout(() => stop('timeout'), options.timeout);

    try {
      const spawning = connection
        .spawn(
          [
            'setsid',
            '-w',
            'sh',
            '-c',
            scripts.EXEC_WRAPPER,
            'cogitator-exec',
            String(started + options.timeout),
            this.root,
            options.cwd,
            command,
          ],
          {
            cwd: this.root,
            env: options.env,
            stdin: `${token}\n`,
            timeout: options.timeout + this.killGrace + PROVIDER_TIMEOUT_MARGIN,
            background: options.background,
            onStdout: (chunk) => take(chunk, (data) => stdout.push(data)),
            onStderr: (chunk) => take(chunk, (data) => markers.push(data)),
          }
        )
        .catch((error: unknown) => {
          throw ioError('Could not start the command in the sandbox', error);
        });
      if (options.signal?.aborted) stop('abort');
      child = await Promise.race([spawning, readReleased.then(() => undefined)]);
      let waited: number | undefined;
      let waitError: unknown;
      if (!child) {
        void spawning.then(
          (late) => late.kill().catch(() => undefined),
          () => undefined
        );
      } else {
        if (stopReason === 'overflow') child.detach?.();
        if (stopReason && group === undefined) void child.kill().catch(() => undefined);
        const active = child;
        const finished = active.wait().then(
          (code) => {
            waited = code;
          },
          (error: unknown) => {
            waitError = error;
          }
        );
        await Promise.race([finished, readReleased]);
        active.detach?.();
      }
      markers.end();
      if (stopReason === 'abort' && options.signal) throw aborted(options.signal);
      if (cwdCode !== undefined) throw cwdError(cwdCode, options.cwdPath);
      const timedOut = stopReason === 'timeout';
      if (!stopReason && exitCode === undefined && waited === undefined) {
        throw ioError('The command output stream failed', waitError);
      }
      let err = stderr.text();
      if (stopReason) err = err.replace(SETSID_NOTE, '');
      if (timedOut && !err) err = `Command timed out after ${options.timeout}ms`;
      if (stopReason === 'overflow') {
        err += `${err && !err.endsWith('\n') ? '\n' : ''}Command stopped: its output passed ${this.maxStreamBytes} bytes`;
      }
      return {
        stdout: stdout.text(),
        stderr: err,
        exitCode: timedOut
          ? 124
          : stopReason === 'overflow'
            ? (exitCode ?? STOPPED_EXIT_CODE)
            : (exitCode ?? waited ?? 1),
        timedOut,
        truncated: stdout.truncated || stderr.truncated || stopReason === 'overflow',
        durationMs: Date.now() - started,
      };
    } finally {
      clearTimeout(timer);
      options.signal?.removeEventListener('abort', onAbort);
    }
  }

  private ready(): Promise<RemoteShellConnection> {
    if (this.state.disposed) {
      const disposed: Error = new WorkspaceError('DISPOSED', `Workspace ${this.id} is disposed`);
      return Promise.reject(disposed);
    }
    this.state.starting ??= this.launch().catch((error: unknown) => {
      this.state.starting = undefined;
      throw error;
    });
    return this.state.starting;
  }

  private async launch(): Promise<RemoteShellConnection> {
    const connection = await this.driver.connect();
    try {
      const root = this.rootFrom(connection.home);
      const result = await connection
        .run(['sh', '-c', scripts.START, 'cogitator', root, this.createRoot ? '1' : '0'], {
          cwd: '/',
          timeout: INTERNAL_TIMEOUT,
        })
        .catch((error: unknown) => {
          throw new WorkspaceError(
            'UNAVAILABLE',
            `Could not run commands in the ${this.driver.provider} sandbox: ${message(error)}`,
            { cause: error }
          );
        });
      if (result.exitCode === SCRIPT_EXIT.missingTools) {
        throw new WorkspaceError(
          'UNAVAILABLE',
          `The ${this.driver.provider} sandbox lacks what the workspace needs:${result.stderr}. Use an image with sh, GNU coreutils, findutils and tar, and util-linux`
        );
      }
      if (result.exitCode === SCRIPT_EXIT.notFound) {
        throw new WorkspaceError('NOT_FOUND', `The root ${root} does not exist`, { path: root });
      }
      if (result.exitCode === SCRIPT_EXIT.notADirectory) {
        throw new WorkspaceError('NOT_A_DIRECTORY', `The root ${root} is not a directory`, {
          path: root,
        });
      }
      if (result.exitCode !== 0) {
        throw new WorkspaceError(
          'IO',
          `Could not prepare the root ${root}: ${lastLine(result.stderr) || `exit code ${result.exitCode}`}`,
          { path: root }
        );
      }
      const [realRoot = '', temp = ''] = result.stdout.split('\0');
      if (!realRoot.startsWith('/') || !temp.startsWith('/')) {
        throw new WorkspaceError(
          'IO',
          `Could not resolve the root ${root}: got ${JSON.stringify(result.stdout)}`,
          { path: root }
        );
      }
      if (realRoot === '/') {
        throw new WorkspaceError('INVALID_PATH', 'The root of a workspace cannot be /', {
          path: root,
        });
      }
      if (this.state.disposed) {
        throw new WorkspaceError('DISPOSED', `Workspace ${this.id} was disposed while starting`);
      }
      this.state.realRoot = realRoot;
      this.state.temp = trimTrailingSlashes(temp) || '/';
      this.state.connection = connection;
      return connection;
    } catch (error) {
      await connection.close().catch(() => undefined);
      throw error;
    }
  }

  private rootFrom(home: string | undefined): string {
    const base = home ?? this.driver.defaultRoot;
    return trimTrailingSlashes(posix.resolve(base, this.givenRoot ?? '.')) || '/';
  }

  /**
   * `path` as an absolute path in the sandbox, normalized without touching it: relative paths
   * are taken from the root, and a path that climbs out of it is refused.
   */
  private async lexical(path: string): Promise<string> {
    const rel = await this.lexicalRel(path);
    return rel === '.' ? this.root : `${this.root}/${rel}`;
  }

  private async lexicalRel(path: string): Promise<string> {
    if (typeof path !== 'string' || path.length === 0 || path.includes('\0')) {
      throw new WorkspaceError('INVALID_PATH', `Invalid path: ${JSON.stringify(path)}`, { path });
    }
    await this.ready();
    let rel: string;
    if (path.startsWith('/')) {
      const normalized = posix.resolve(path);
      const base = [this.root, this.rootFrom(this.state.connection?.home)].find(
        (root) => normalized === root || normalized.startsWith(`${root}/`)
      );
      if (!base) throw scriptError(SCRIPT_EXIT.outside, path);
      rel = normalized === base ? '.' : normalized.slice(base.length + 1);
    } else {
      rel = trimTrailingSlashes(posix.normalize(path)) || '.';
    }
    if (rel === '..' || rel.startsWith('../')) throw scriptError(SCRIPT_EXIT.outside, path);
    return rel;
  }

  /** Runs one of the workspace's scripts, its exit code and stdout the answer. */
  private async script(body: string, args: string[], path: string): Promise<ScriptResult> {
    const connection = await this.ready();
    void connection.keepAlive?.().catch(() => undefined);
    const result = await connection
      .run(['sh', '-c', body, 'cogitator', this.root, ...args], {
        cwd: this.root,
        timeout: INTERNAL_TIMEOUT,
      })
      .catch((error: unknown) => {
        throw ioError(path, error);
      });
    if (result.exitCode !== 0 && EXIT_ERRORS[result.exitCode] === undefined) {
      throw new WorkspaceError(
        'IO',
        `${path}: ${lastLine(result.stderr) || `failed with exit code ${result.exitCode}`}`,
        { path }
      );
    }
    return { code: result.exitCode, stdout: result.stdout };
  }

  /** Throws the error an exit code of a script stands for. */
  private check(code: number, path: string): void {
    if (code !== 0) throw scriptError(code, path);
  }

  private refuseWhileRunning(path: string): void {
    if (this.state.running > 0) throw busy(path);
  }

  private forget(groups: number[]): void {
    for (const group of groups) this.state.groups.delete(group);
  }

  /** Removes files of the temporary directory an operation named, best effort. */
  private async discard(names: string[], path: string): Promise<void> {
    if (names.length === 0) return;
    await this.script(scripts.DISCARD, names, path).catch(() => undefined);
  }

  /**
   * Uploads bytes to a fresh file of the sandbox's temporary directory, never through the
   * workspace's own directories, which a command can swap for a symlink: the scripts that use
   * the file check those directories as they go. Answers the file's name.
   */
  private async upload(kind: 'upload' | 'list', bytes: Uint8Array, path: string): Promise<string> {
    const connection = await this.ready();
    const name = `cogitator-${kind}-${token()}`;
    await connection
      .writeFile(`${this.state.temp ?? '/tmp'}/${name}`, bytes)
      .catch((error: unknown) => {
        throw ioError(path, error);
      });
    return name;
  }
}

/** The error each exit code of a script stands for, given the path it is about. */
const EXIT_ERRORS: Partial<Record<number, [WorkspaceErrorCode, (path: string) => string]>> = {
  [SCRIPT_EXIT.outside]: ['OUTSIDE_ROOT', (path) => `${path} is outside the workspace`],
  [SCRIPT_EXIT.outsideTarget]: ['OUTSIDE_ROOT', (path) => `${path} is outside the workspace`],
  [SCRIPT_EXIT.symlinkLoop]: ['INVALID_PATH', (path) => `Too many symlinks in ${path}`],
  [SCRIPT_EXIT.notFound]: ['NOT_FOUND', (path) => `${path} does not exist`],
  [SCRIPT_EXIT.notEmpty]: ['NOT_EMPTY', (path) => `${path} is a directory with entries`],
  [SCRIPT_EXIT.exists]: ['EXISTS', (path) => `${path} already exists`],
  [SCRIPT_EXIT.isDirectory]: ['NOT_A_FILE', (path) => `${path} is a directory`],
  [SCRIPT_EXIT.notADirectory]: [
    'NOT_A_DIRECTORY',
    (path) => `${path} or one of its parents is not a directory`,
  ],
  [SCRIPT_EXIT.tooLarge]: ['TOO_LARGE', (path) => `${path} is over the size limit`],
  [SCRIPT_EXIT.readOnly]: ['DENIED', (path) => `${path} is read-only, pass force to replace it`],
  [SCRIPT_EXIT.internal]: ['INVALID_PATH', (path) => `${path} is the workspace's own directory`],
  [SCRIPT_EXIT.insideItself]: ['INVALID_PATH', (path) => `${path} is inside itself`],
  [SCRIPT_EXIT.busy]: ['BUSY', (path) => busy(path).message],
  [SCRIPT_EXIT.rootPath]: ['INVALID_PATH', () => 'The root cannot be moved or removed'],
  [SCRIPT_EXIT.internalTarget]: [
    'INVALID_PATH',
    (path) => `${path} is the workspace's own directory`,
  ],
  [SCRIPT_EXIT.notRegular]: ['NOT_A_FILE', (path) => `${path} is not a regular file`],
};

function scriptError(exit: number, path: string): WorkspaceError {
  const known = EXIT_ERRORS[exit];
  return known
    ? new WorkspaceError(known[0], known[1](path), { path })
    : new WorkspaceError('IO', `${path}: failed with exit code ${exit}`, { path });
}

function busy(path: string): WorkspaceError {
  return new WorkspaceError(
    'BUSY',
    `${path} cannot be moved or removed while a command started in the workspace is still running (or left processes in the background): wait for it, or remove it with a command`,
    { path }
  );
}

function cwdError(code: number, path: string): WorkspaceError {
  if (code === SCRIPT_EXIT.notADirectory) {
    return new WorkspaceError('NOT_A_DIRECTORY', `${path} is not a directory`, { path });
  }
  return scriptError(code, path);
}

function tooLarge(path: string, size: number, limit: number): WorkspaceError {
  return new WorkspaceError(
    'TOO_LARGE',
    `${path} is ${size} bytes or more, over the limit of ${limit} bytes`,
    { path }
  );
}

function snapshotMissing(snapshotId: string): WorkspaceError {
  return new WorkspaceError('NOT_FOUND', `Snapshot ${snapshotId} does not exist`, {
    path: snapshotId,
  });
}

/**
 * The `find` expression that prints a listing's entries in the format of `mode` (see
 * `scripts.LIST`): hidden entries left out unless asked, `skipDirs` listed but not entered, and,
 * when the glob's last segment can be told to `find`, only entries whose name matches it.
 */
function findExpression(options: WorkspaceListOptions, mode: 'sorted' | 'raw'): string[] {
  const format =
    mode === 'raw' ? '%y\\0%s\\0%T@\\0%d\\0%P\\0' : '%P\\001%y\\001%s\\001%T@\\001%d\\0';
  const names = options.glob ? globNames(options.glob) : undefined;
  const print = names
    ? [
        '(',
        ...names.flatMap((name, i) => [...(i > 0 ? ['-o'] : []), '-name', name]),
        ')',
        '-printf',
        format,
      ]
    : ['-printf', format];
  const expression: string[] = options.recursive ? [] : ['-maxdepth', '1'];
  if (!options.includeHidden) expression.push('(', '-name', '.*', '-prune', ')', '-o');
  const skip = options.skipDirs ?? [];
  if (options.recursive && skip.length > 0) {
    const skipped = skip.flatMap((name, i) => [
      ...(i > 0 ? ['-o'] : []),
      '-name',
      globLiteral(name),
    ]);
    expression.push('(', '-type', 'd', '(', ...skipped, ')', '-prune', ...print, ')', '-o');
  }
  expression.push(...print);
  return expression;
}

/**
 * The `find -name` patterns an entry's name must match for `glob` to match its path: the glob's
 * last segment, its `{a,b}` alternatives spelled out. `undefined` when that segment spans
 * directories (`**`) or its braces cannot be spelled out, and every entry is sent.
 */
function globNames(glob: string): string[] | undefined {
  let braces = 0;
  let slash = -1;
  for (let i = 0; i < glob.length; i++) {
    const char = glob[i];
    if (char === '\\') i++;
    else if (char === '{') braces++;
    else if (char === '}' && braces > 0) braces--;
    else if (char === '/' && braces === 0) slash = i;
  }
  if (braces !== 0) return undefined;
  const last = glob.slice(slash + 1);
  if (last === '' || last.includes('**')) return undefined;
  const open = last.indexOf('{');
  if (open === -1) return last.includes('}') ? undefined : [last];
  const close = last.indexOf('}', open);
  const rest = last.slice(close + 1);
  const inner = last.slice(open + 1, close);
  if (close === -1 || inner.includes('{') || rest.includes('{') || rest.includes('}')) {
    return undefined;
  }
  if (last.slice(0, open).includes('\\') || inner.includes('\\')) return undefined;
  return inner.split(',').map((choice) => `${last.slice(0, open)}${choice}${rest}`);
}

/**
 * The `find` tests that leave out, with everything in them, the directories `exclude` names
 * plainly: `dir/**` and `dir` as `-path ./dir`, `**\/name/**` as a directory named `name`
 * anywhere. Other globs are applied to the entries the sandbox sends.
 */
function pruneTests(exclude: readonly string[]): string[] {
  const tests: string[] = [];
  for (const glob of exclude) {
    const deep = glob.startsWith('**/') && glob.endsWith('/**') ? glob.slice(3, -3) : undefined;
    if (deep !== undefined && deep !== '' && isLiteral(deep) && !deep.includes('/')) {
      tests.push('-o', '(', '-type', 'd', '-name', deep, ')');
      continue;
    }
    const dir = glob.endsWith('/**') ? glob.slice(0, -3) : glob;
    if (dir !== '' && isLiteral(dir) && !dir.startsWith('/') && !dir.split('/').includes('..')) {
      tests.push('-o', '-path', `./${trimTrailingSlashes(dir)}`);
    }
  }
  return tests;
}

/** Whether `text` has none of the characters globs and `find` patterns treat specially. */
function isLiteral(text: string): boolean {
  for (const char of text) if ('*?[]{}\\'.includes(char)) return false;
  return true;
}

function count(text: string, char: string): number {
  let found = 0;
  for (const each of text) if (each === char) found++;
  return found;
}

/** `name` as a `find -name` pattern that matches only itself. */
function globLiteral(name: string): string {
  let pattern = '';
  for (const char of name) pattern += '\\*?['.includes(char) ? `\\${char}` : char;
  return pattern;
}

/** Whether a path is left out by `exclude`: it or one of its parents matches a glob. */
function excludedBy(exclude: readonly string[]): (path: string) => boolean {
  const matchers = [...exclude, '.cogitator/pending/**', '.cogitator/snapshots/**'].map(
    workspaceGlobMatcher
  );
  return (path) => {
    let prefix = path;
    for (;;) {
      if (matchers.some((matches) => matches(prefix))) return true;
      const slash = prefix.lastIndexOf('/');
      if (slash === -1) return false;
      prefix = prefix.slice(0, slash);
    }
  };
}

/** A fresh random token for a file name nobody can guess. */
function token(): string {
  return randomUUID().replace(/-/g, '');
}

function depth(path: string): number {
  let count = 0;
  for (const char of path) if (char === '/') count++;
  return count;
}

/** Paths given as `latin1` strings of their bytes, as a NUL-separated list of `./path`. */
function nulList(keys: readonly string[]): Buffer {
  return Buffer.from(keys.map((key) => `./${key}\0`).join(''), 'latin1');
}

/** A byte limit as the integer a shell compares, never in exponent notation. */
function integer(value: number): string {
  return String(Math.min(Math.floor(value), Number.MAX_SAFE_INTEGER));
}

function compareSegments(a: readonly string[], b: readonly string[]): number {
  const length = Math.min(a.length, b.length);
  for (let i = 0; i < length; i++) {
    if (a[i] !== b[i]) return a[i] < b[i] ? -1 : 1;
  }
  return a.length - b.length;
}

function entryType(letter: string | undefined): WorkspaceEntryType {
  if (letter === 'f') return 'file';
  if (letter === 'd') return 'directory';
  if (letter === 'l') return 'symlink';
  return 'other';
}

function toBuffer(chunk: string | Uint8Array): Buffer {
  return typeof chunk === 'string'
    ? Buffer.from(chunk, 'utf8')
    : Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength);
}

function lastLine(text: string): string {
  return text.trim().split('\n').pop() ?? '';
}

function safeJson(text: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return undefined;
  }
}

function positive(value: number | undefined, fallback: number, field: string): number {
  if (value === undefined) return fallback;
  if (!Number.isFinite(value) || value <= 0) {
    throw new RangeError(`${field} must be a positive number, got ${value}`);
  }
  return value;
}
