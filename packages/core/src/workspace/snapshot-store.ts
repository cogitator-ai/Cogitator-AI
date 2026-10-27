import { createHash, type Hash } from 'node:crypto';
import { constants, type Stats } from 'node:fs';
import {
  access,
  lstat,
  mkdir,
  open,
  readdir,
  readFile,
  readlink,
  realpath,
  rename,
  unlink,
  type FileHandle,
} from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { nanoid } from 'nanoid';
import { z } from 'zod';
import {
  WORKSPACE_SNAPSHOT_DEFAULT_EXCLUDE,
  WORKSPACE_SNAPSHOT_MAX_FILE_BYTES,
  WorkspaceError,
  workspaceGlobMatcher,
  type WorkspaceRestoreResult,
  type WorkspaceSnapshot,
  type WorkspaceSnapshotSkip,
  type WorkspaceSnapshotStats,
} from '@cogitator-ai/types';
import { getLogger } from '../logger';

/** Where a workspace keeps its snapshots, relative to the root. */
export const WORKSPACE_CHECKPOINTS_DIR = '.cogitator/checkpoints';

const MANIFEST_VERSION = 1;
const TREE_VERSION = 1;
const O_NOFOLLOW = constants.O_NOFOLLOW ?? 0;
const O_NONBLOCK = constants.O_NONBLOCK ?? 0;
const O_DIRECTORY = constants.O_DIRECTORY ?? 0;
/** The store's directories and files are the user's alone: they hold copies of every file */
const DIR_MODE = 0o700;
const FILE_MODE = 0o600;
/**
 * A file whose modification or change time is this close to the start of the snapshot that
 * recorded it may have changed again within the clock's granularity without either time moving:
 * the next snapshot reads it again instead of trusting its times (as git treats racy entries)
 */
const RACY_MARGIN_MS = 2_000;
/** Files read at once while a snapshot hashes them */
const READ_CONCURRENCY = 16;
/** Bytes read at a time: a file is hashed and stored as it is read, never held whole */
const CHUNK_BYTES = 64 * 1024;
/** Reads of a file that keeps changing while it is read, before it is skipped as `changing` */
const READ_ATTEMPTS = 5;
/** Age past which a lock or a work marker of a process that is gone no longer counts */
const STALE_LOCK_MS = 60 * 60 * 1000;
/** How often a snapshot looks again whether a collection of another process is done */
const LOCK_POLL_MS = 50;
const SNAPSHOT_ID = /^snap_[a-z0-9]+_[A-Za-z0-9]{8}$/;
const HASH = /^[0-9a-f]{64}$/;
const SHARD = /^[0-9a-f]{2}$/;
const BLOB_REST = /^[0-9a-f]{62}$/;
const TEMP_NAME = /^[A-Za-z0-9_-]{16}\.part$/;
const MARKER_NAME = /^[A-Za-z0-9_-]{16}\.active$/;
const GC_LOCK = 'gc.lock';

const fileEntrySchema = z.object({
  type: z.literal('file'),
  hash: z.string().regex(HASH),
  mode: z.number().int().min(0),
  size: z.number().int().min(0),
  mtimeMs: z.number(),
  ctimeMs: z.number(),
  ino: z.number(),
  racy: z.boolean().optional(),
});
const dirEntrySchema = z.object({
  type: z.literal('dir'),
  mode: z.number().int().min(0),
  tree: z.string().regex(HASH),
});
const linkEntrySchema = z.object({ type: z.literal('symlink'), target: z.string() });
const treeEntrySchema = z.discriminatedUnion('type', [
  fileEntrySchema,
  dirEntrySchema,
  linkEntrySchema,
]);
/**
 * A directory listing as stored: name and entry pairs, sorted by name. Pairs rather than an
 * object, so every name (`__proto__` included) is kept as it is
 */
const treeSchema = z.object({
  version: z.literal(TREE_VERSION),
  entries: z.array(z.tuple([z.string(), treeEntrySchema])),
});
const statsSchema = z.object({
  files: z.number(),
  others: z.number(),
  bytes: z.number(),
  hashed: z.number(),
  reused: z.number(),
  storedBytes: z.number(),
  durationMs: z.number(),
});
const manifestSchema = z.object({
  version: z.literal(MANIFEST_VERSION),
  id: z.string().regex(SNAPSHOT_ID),
  workspaceId: z.string(),
  createdAt: z.string(),
  startedAt: z.number(),
  label: z.string().optional(),
  metadata: z.record(z.string(), z.unknown()).optional(),
  exclude: z.array(z.string()),
  maxFileBytes: z.number().int().positive(),
  tree: z.string().regex(HASH),
  skipped: z.array(
    z.object({
      path: z.string(),
      reason: z.enum(['too-large', 'unreadable', 'changing']),
      size: z.number().optional(),
    })
  ),
  stats: statsSchema,
});

type FileEntry = z.infer<typeof fileEntrySchema>;
type TreeEntry = z.infer<typeof treeEntrySchema>;
type Manifest = z.infer<typeof manifestSchema>;
/** A directory listing read back: entries by name */
type Tree = ReadonlyMap<string, TreeEntry>;

/** A snapshot's entries by path, relative to the root, parents before their contents */
type FlatEntry = FileEntry | { type: 'dir'; mode: number } | { type: 'symlink'; target: string };

/** What a restore finds at a path now, without reading file contents */
type Present =
  | { type: 'file'; info: Stats }
  | { type: 'dir'; info: Stats; unreadable: boolean }
  | { type: 'symlink'; target: string }
  | { type: 'other' };

/**
 * How a restore changes the files, through the workspace's own safe placement: every operation
 * resolves its path inside the root, writes atomically, never follows a symlink in a final
 * component and refuses a parent swapped for a symlink.
 */
export interface SnapshotRestoreOps {
  /** Writes `bytes` to a file with `mode`, replacing a file or a symlink at the path */
  writeFile(path: string, bytes: Uint8Array, mode: number): Promise<void>;
  /** Makes a symlink pointing at `target`, replacing a file or a symlink at the path */
  symlink(path: string, target: string): Promise<void>;
  /** Creates a directory (its parents exist) */
  mkdir(path: string): Promise<void>;
  /** Removes a file, a symlink or a directory, with its contents when `recursive` */
  remove(path: string, recursive: boolean): Promise<void>;
  chmod(path: string, mode: number): Promise<void>;
}

export interface SnapshotTakeOptions {
  id?: string;
  workspaceId: string;
  label?: string;
  metadata?: Record<string, unknown>;
  exclude?: readonly string[];
  maxFileBytes?: number;
}

export interface SnapshotRetention {
  /** Keep at most this many snapshots, the newest ones */
  count?: number;
  /** Delete snapshots older than this many milliseconds */
  maxAgeMs?: number;
}

/** What a garbage collection found and freed */
export interface SnapshotGcReport {
  /** Snapshots kept */
  snapshots: number;
  /** Stored contents (files and directory trees) still used by a snapshot */
  kept: number;
  /** Stored contents no snapshot uses any more, deleted */
  deleted: number;
  /** Bytes they took */
  freedBytes: number;
  /**
   * The sweep was left for later, as another process was taking, restoring or copying a
   * snapshot of the same root (or collecting already): nothing was deleted
   */
  deferred: boolean;
  /** Manifests whose trees could not be read: what they reach was kept as far as it could be read */
  unreadable: string[];
}

/** What a restore will change, planned before anything changes */
interface RestorePlan {
  result: Omit<WorkspaceRestoreResult, 'snapshotId' | 'dryRun'>;
  /** Files and symlinks to remove, then directories to remove (deepest first) */
  removals: { path: string; recursive: boolean }[];
  /** Directories to create, parents first */
  mkdirs: string[];
  /** Files and symlinks to write */
  writes: { path: string; entry: FileEntry | { type: 'symlink'; target: string } }[];
  /** Modes to set, files first, then directories deepest first */
  chmods: { path: string; mode: number }[];
}

/**
 * The snapshots of a workspace root, kept content-addressed in `.cogitator/checkpoints`: every
 * file content and every directory listing (a tree, as git keeps them) is a blob named by its
 * sha256, so unchanged files and directories cost nothing in a new snapshot, and a manifest per
 * snapshot names its root tree. A file whose size, times, inode and mode did not change since
 * the snapshot before is not read again, and a file is hashed and stored as it is read, never
 * held whole. Blobs and manifests are synced to disk before a manifest names them, and the store
 * is readable by its owner only.
 *
 * One store serves every workspace over the same root in the process, and its operations run one
 * at a time. Across processes, a snapshot, a restore or a copy leaves a marker in `locks/` for
 * as long as it works, and a collection, which takes `locks/gc.lock`, leaves its sweep for later
 * while one is there, so it never deletes a blob a snapshot of another process has just reused.
 */
export class SnapshotStore {
  private readonly dir: string;
  private queue: Promise<unknown> = Promise.resolve();
  private pending = 0;
  private latest: Manifest | undefined;
  private readonly trees = new Map<string, Tree>();

  private static readonly stores = new Map<string, { store: SnapshotStore; holders: number }>();

  private constructor(readonly root: string) {
    this.dir = join(root, ...WORKSPACE_CHECKPOINTS_DIR.split('/'));
  }

  /**
   * The store of `root`, a real path (symlinks resolved), shared within the process, held until
   * {@link release}: a workspace takes it on first use and lets it go when disposed
   */
  static acquire(root: string): SnapshotStore {
    const held = SnapshotStore.stores.get(root);
    if (held) {
      held.holders++;
      return held.store;
    }
    const store = new SnapshotStore(root);
    SnapshotStore.stores.set(root, { store, holders: 1 });
    return store;
  }

  /** Lets go of a store {@link acquire} gave, forgotten once nobody holds it and it is idle */
  static release(store: SnapshotStore): void {
    const held = SnapshotStore.stores.get(store.root);
    if (held?.store !== store) return;
    held.holders--;
    if (held.holders > 0) return;
    if (store.pending === 0) SnapshotStore.stores.delete(store.root);
    else void store.queue.then(() => SnapshotStore.forget(store));
  }

  /** How many stores the process holds, one per root in use */
  static get held(): number {
    return SnapshotStore.stores.size;
  }

  /**
   * A store of `root` that shares nothing with the stores of the process, as another process
   * holds one: its operations do not wait for theirs, only the markers in `locks/` order them
   */
  static detached(root: string): SnapshotStore {
    return new SnapshotStore(root);
  }

  private static forget(store: SnapshotStore): void {
    const held = SnapshotStore.stores.get(store.root);
    if (held?.store === store && held.holders <= 0 && store.pending === 0) {
      SnapshotStore.stores.delete(store.root);
    }
  }

  /** Records the files of the root, see {@link SnapshotStore} */
  take(options: SnapshotTakeOptions): Promise<WorkspaceSnapshot> {
    return this.exclusive(() => this.working(() => this.takeNow(options)));
  }

  /** The snapshots kept, oldest first */
  list(): Promise<WorkspaceSnapshot[]> {
    return this.exclusive(async () => (await this.manifests()).map(recordOf));
  }

  /** The snapshot `id`, `NOT_FOUND` when the store does not keep it */
  get(id: string): Promise<WorkspaceSnapshot> {
    return this.exclusive(async () => recordOf(await this.manifest(id)));
  }

  /** Brings the files back to snapshot `id`, or says what that would change with `dryRun` */
  restore(id: string, ops: SnapshotRestoreOps, dryRun: boolean): Promise<WorkspaceRestoreResult> {
    return this.exclusive(async () => {
      await this.manifest(id);
      return this.working(() => this.restoreNow(id, ops, dryRun));
    });
  }

  /** Forgets snapshot `id` and frees the contents only it used */
  delete(id: string, graceMs: number): Promise<SnapshotGcReport> {
    return this.exclusive(async () => {
      if (!SNAPSHOT_ID.test(id)) throw missing(id);
      if (!(await this.exists())) throw missing(id);
      await this.verifyDir(this.dir);
      await this.verifyDir(join(this.dir, 'manifests'));
      await unlink(this.manifestPath(id)).catch((error: unknown) => {
        if (errnoOf(error) === 'ENOENT') throw missing(id);
        throw ioError(error, id);
      });
      if (this.latest?.id === id) this.latest = undefined;
      return this.collect(graceMs);
    });
  }

  /**
   * Deletes the snapshots `retention` does not keep, never one of `protect` (which still count
   * toward it), then frees what no snapshot uses
   */
  prune(
    retention: SnapshotRetention,
    graceMs: number,
    protect: readonly string[] = []
  ): Promise<{ deleted: string[]; gc: SnapshotGcReport }> {
    return this.exclusive(async () => {
      const kept = new Set(protect);
      const manifests = await this.manifests();
      const now = Date.now();
      const doomed = manifests.filter((manifest, index) => {
        const tooMany =
          retention.count !== undefined && index < manifests.length - Math.max(0, retention.count);
        const tooOld =
          retention.maxAgeMs !== undefined &&
          now - Date.parse(manifest.createdAt) > retention.maxAgeMs;
        return (tooMany || tooOld) && !kept.has(manifest.id);
      });
      if (doomed.length > 0) await this.verifyDir(join(this.dir, 'manifests'));
      for (const manifest of doomed) {
        await unlink(this.manifestPath(manifest.id)).catch(() => undefined);
        if (this.latest?.id === manifest.id) this.latest = undefined;
      }
      return { deleted: doomed.map((manifest) => manifest.id), gc: await this.collect(graceMs) };
    });
  }

  /**
   * Mark and sweep: every blob a manifest reaches (its trees and their files) is kept, every other
   * one older than `graceMs` deleted. The grace keeps the blobs a snapshot of another process
   * stored and has not named in its manifest yet
   */
  gc(graceMs: number): Promise<SnapshotGcReport> {
    return this.exclusive(() => this.collect(graceMs));
  }

  /**
   * Copies snapshot `id`, its manifest and every blob it uses, into `target`, with a working
   * marker in both stores, so a collection of another process sweeps neither meanwhile
   */
  copyTo(id: string, target: SnapshotStore): Promise<WorkspaceSnapshot> {
    if (target === this) return this.get(id);
    const [first, second] = this.root < target.root ? [this, target] : [target, this];
    return first.exclusive(() =>
      second.exclusive(() =>
        this.working(() =>
          target.working(async () => {
            const manifest = await this.manifest(id);
            const hashes = await this.reachable(manifest);
            await target.prepare();
            const shards = new Set<string>();
            for (const hash of hashes) {
              const bytes = await this.readBlob(hash);
              if (await target.blobSized(hash, bytes.byteLength)) continue;
              await target.putBlob(hash, bytes, shards);
            }
            await target.syncShards(shards);
            await target.writeManifest(manifest);
            return recordOf(manifest);
          })
        )
      )
    );
  }

  private exclusive<T>(work: () => Promise<T>): Promise<T> {
    this.pending++;
    const run = this.queue.then(work, work).finally(() => {
      this.pending--;
    });
    this.queue = run.catch(() => undefined);
    return run;
  }

  /**
   * Runs `work` with a marker in `locks/`, which keeps collections of other processes from
   * sweeping meanwhile, once a collection that is sweeping already is done
   */
  private async working<T>(work: () => Promise<T>): Promise<T> {
    await this.prepare();
    const locks = join(this.dir, 'locks');
    const marker = join(locks, `${token()}.active`);
    await this.verifyDir(locks);
    const handle = await open(
      marker,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | O_NOFOLLOW,
      FILE_MODE
    ).catch((error: unknown) => {
      throw ioError(error, WORKSPACE_CHECKPOINTS_DIR);
    });
    await handle.close();
    try {
      await this.waitForCollection();
      return await work();
    } finally {
      await unlink(marker).catch(() => undefined);
    }
  }

  /** Resolves once no collection of another process holds `locks/gc.lock` (or it went stale) */
  private async waitForCollection(): Promise<void> {
    const lock = join(this.dir, 'locks', GC_LOCK);
    for (;;) {
      const info = await lstat(lock).catch(() => undefined);
      if (!info || Date.now() - info.mtimeMs > STALE_LOCK_MS) return;
      await new Promise((resolve) => setTimeout(resolve, LOCK_POLL_MS));
    }
  }

  private async takeNow(options: SnapshotTakeOptions): Promise<WorkspaceSnapshot> {
    const startedAt = Date.now();
    const id = options.id ?? snapshotId();
    const exclude = [
      ...new Set([...WORKSPACE_SNAPSHOT_DEFAULT_EXCLUDE, ...(options.exclude ?? [])]),
    ];
    const maxFileBytes = options.maxFileBytes ?? WORKSPACE_SNAPSHOT_MAX_FILE_BYTES;
    if (!Number.isInteger(maxFileBytes) || maxFileBytes <= 0) {
      throw new RangeError(`maxFileBytes must be a positive integer, got ${maxFileBytes}`);
    }
    const previous = await this.newest();
    const excluded = excluderOf(exclude);
    const skipped: WorkspaceSnapshotSkip[] = [];
    const stats: Omit<WorkspaceSnapshotStats, 'durationMs'> = {
      files: 0,
      others: 0,
      bytes: 0,
      hashed: 0,
      reused: 0,
      storedBytes: 0,
    };
    const limiter = new Limiter(READ_CONCURRENCY);
    const shards = new Set<string>();
    /** The first read that failed: no read starts after it, and the walk stops at it */
    const failure: { error?: { cause: unknown } } = {};

    const fileTask = async (
      path: string,
      full: string,
      info: Stats,
      prior: TreeEntry | undefined,
      entries: Map<string, TreeEntry>,
      name: string
    ): Promise<void> => {
      if (
        prior?.type === 'file' &&
        unchanged(prior, info) &&
        (await this.blobSized(prior.hash, prior.size))
      ) {
        entries.set(name, prior);
        stats.files++;
        stats.bytes += info.size;
        stats.reused++;
        return;
      }
      const stored = await this.storeFile(full, info, maxFileBytes, shards);
      if (typeof stored === 'string') {
        skipped.push({ path, reason: stored, size: info.size });
        return;
      }
      const racy = stored.racy || isRacy(stored.info, startedAt);
      entries.set(name, {
        type: 'file',
        hash: stored.hash,
        mode: stored.info.mode & 0o7777,
        size: stored.size,
        mtimeMs: stored.info.mtimeMs,
        ctimeMs: stored.info.ctimeMs,
        ino: stored.info.ino,
        ...(racy && { racy: true }),
      });
      stats.files++;
      stats.bytes += stored.size;
      stats.hashed++;
      stats.storedBytes += stored.storedBytes;
    };

    const walk = async (rel: string, before: Tree | undefined): Promise<string> => {
      const absolute = this.absolute(rel);
      const listing = await this.readDirectory(absolute, rel);
      const entries = new Map<string, TreeEntry>();
      if (listing === 'unreadable') {
        skipped.push({ path: rel, reason: 'unreadable' });
      } else {
        const pending: Promise<void>[] = [];
        try {
          for (const name of listing) {
            if (failure.error) break;
            const path = rel === '' ? name : `${rel}/${name}`;
            if (excluded(path)) continue;
            const full = join(absolute, name);
            const info = await lstat(full).catch(() => undefined);
            if (!info) continue;
            const prior = before?.get(name);
            if (info.isDirectory()) {
              const priorTree =
                prior?.type === 'dir'
                  ? await this.tree(prior.tree).catch(() => undefined)
                  : undefined;
              entries.set(name, {
                type: 'dir',
                mode: info.mode & 0o7777,
                tree: await walk(path, priorTree),
              });
              stats.others++;
            } else if (info.isSymbolicLink()) {
              const target = await readlink(full).catch(() => undefined);
              if (target === undefined) continue;
              entries.set(name, { type: 'symlink', target });
              stats.others++;
            } else if (info.isFile()) {
              if (info.size > maxFileBytes) {
                skipped.push({ path, reason: 'too-large', size: info.size });
                continue;
              }
              pending.push(
                limiter
                  .run(() =>
                    failure.error
                      ? Promise.resolve()
                      : fileTask(path, full, info, prior, entries, name)
                  )
                  .catch((error: unknown) => {
                    failure.error ??= { cause: error };
                  })
              );
            }
          }
        } finally {
          await Promise.all(pending);
        }
        if (failure.error) throw failure.error.cause;
      }
      const pairs = [...entries.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
      const bytes = Buffer.from(JSON.stringify({ version: TREE_VERSION, entries: pairs }), 'utf8');
      const hash = sha256(bytes);
      if (!(await this.blobSized(hash, bytes.byteLength))) {
        await this.putBlob(hash, bytes, shards);
        stats.storedBytes += bytes.byteLength;
      }
      this.remember(hash, new Map(pairs));
      return hash;
    };

    const priorRoot = previous ? await this.tree(previous.tree).catch(() => undefined) : undefined;
    const tree = await walk('', priorRoot);
    if (skipped.some((skip) => skip.path === '')) {
      throw new WorkspaceError('DENIED', `The root ${this.root} cannot be read`);
    }
    skipped.sort((a, b) => compare(a.path, b.path));
    const manifest: Manifest = {
      version: MANIFEST_VERSION,
      id,
      workspaceId: options.workspaceId,
      createdAt: new Date(startedAt).toISOString(),
      startedAt,
      ...(options.label !== undefined && { label: options.label }),
      ...(options.metadata !== undefined && { metadata: options.metadata }),
      exclude,
      maxFileBytes,
      tree,
      skipped,
      stats: { ...stats, durationMs: Date.now() - startedAt },
    };
    await this.syncShards(shards);
    await this.writeManifest(manifest);
    this.latest = manifest;
    return recordOf(manifest);
  }

  private async restoreNow(
    id: string,
    ops: SnapshotRestoreOps,
    dryRun: boolean
  ): Promise<WorkspaceRestoreResult> {
    const manifest = await this.manifest(id);
    const wanted = await this.flatten(manifest.tree);
    for (const entry of wanted.values()) {
      if (entry.type === 'file' && !(await this.blobSized(entry.hash, entry.size))) {
        throw new WorkspaceError(
          'IO',
          `Snapshot ${id} is incomplete: the content of a file it holds is missing from ${WORKSPACE_CHECKPOINTS_DIR}`,
          { path: id }
        );
      }
    }
    const plan = await this.plan(manifest, wanted);
    for (const { entry } of plan.writes) {
      if (entry.type === 'file') await this.verifyBlob(entry.hash);
    }
    const result: WorkspaceRestoreResult = { snapshotId: id, dryRun, ...plan.result };
    if (dryRun) return result;
    for (const removal of plan.removals) await ops.remove(removal.path, removal.recursive);
    for (const path of plan.mkdirs) await ops.mkdir(path);
    for (const { path, entry } of plan.writes) {
      if (entry.type === 'file') {
        await ops.writeFile(path, await this.readBlob(entry.hash), entry.mode);
      } else {
        await ops.symlink(path, entry.target);
      }
    }
    for (const { path, mode } of plan.chmods) await ops.chmod(path, mode);
    return result;
  }

  /**
   * What a restore to `manifest` changes, decided before anything changes, so a dry run reports
   * exactly what a real restore does. Left alone (`kept`), with everything under them: paths the
   * snapshot skipped, paths it excludes, special files, directories that cannot be read, and
   * files the snapshot could not have kept (over its size limit, unreadable). A directory that
   * holds such a path is never removed. Refused before anything changes when a path to write
   * lies in a directory that cannot be read
   */
  private async plan(manifest: Manifest, wanted: Map<string, FlatEntry>): Promise<RestorePlan> {
    const excluded = excluderOf([...WORKSPACE_SNAPSHOT_DEFAULT_EXCLUDE, ...manifest.exclude]);
    const { present, excludedUnder } = await this.scan(excluded);
    const skippedPaths = new Set(manifest.skipped.map((skip) => skip.path));

    const protectedRoots = new Set<string>();
    const blocked = new Set<string>();
    const block = (path: string): void => {
      for (const dir of ancestorsOf(path)) blocked.add(dir);
    };
    for (const path of excludedUnder) block(path);
    for (const path of skippedPaths) {
      if (present.has(path)) protectedRoots.add(path);
    }
    for (const [path, now] of present) {
      if (now.type === 'other') protectedRoots.add(path);
      else if (now.type === 'dir' && now.unreadable) protectedRoots.add(path);
      else if (now.type === 'file' && !wanted.has(path) && !underAny(path, skippedPaths)) {
        if (now.info.size > manifest.maxFileBytes || !(await readable(this.absolute(path)))) {
          protectedRoots.add(path);
        }
      }
    }
    for (const path of protectedRoots) block(path);
    const isProtected = (path: string): boolean =>
      protectedRoots.has(path) || underAny(path, protectedRoots) || underAny(path, skippedPaths);

    for (const [path, now] of present) {
      if (now.type !== 'dir' || !now.unreadable) continue;
      const inside = [...wanted.keys()].find((each) => each.startsWith(`${path}/`));
      if (inside !== undefined) {
        throw new WorkspaceError(
          'DENIED',
          `${path} cannot be read, so ${inside} cannot be restored: fix its permissions and restore again`,
          { path }
        );
      }
    }

    const restored: string[] = [];
    const deleted: string[] = [];
    const kept = new Set<string>([...protectedRoots]);
    let unchangedCount = 0;
    const removals: { path: string; recursive: boolean }[] = [];
    const mkdirs: string[] = [];
    const writes: RestorePlan['writes'] = [];
    const fileModes: { path: string; mode: number }[] = [];
    const dirModes: { path: string; mode: number }[] = [];
    const replaced = new Set<string>();
    const unreachable = new Set<string>();

    const contentsOf = (dir: string): string[] =>
      [...present.keys()].filter((path) => path.startsWith(`${dir}/`));

    for (const [path, entry] of wanted) {
      if (isProtected(path) || underAny(path, unreachable)) continue;
      const now = present.get(path);
      if (entry.type === 'dir') {
        if (now?.type === 'dir') {
          if ((now.info.mode & 0o7777) !== entry.mode) {
            dirModes.push({ path, mode: entry.mode });
            restored.push(path);
          } else {
            unchangedCount++;
          }
          continue;
        }
        if (now) {
          removals.push({ path, recursive: false });
          replaced.add(path);
        }
        mkdirs.push(path);
        dirModes.push({ path, mode: entry.mode });
        restored.push(path);
        continue;
      }
      if (now?.type === 'dir') {
        if (blocked.has(path)) {
          kept.add(path);
          unreachable.add(path);
          continue;
        }
        removals.push({ path, recursive: true });
        replaced.add(path);
        deleted.push(...contentsOf(path));
        writes.push({ path, entry });
        restored.push(path);
        continue;
      }
      if (entry.type === 'symlink') {
        if (now?.type === 'symlink' && now.target === entry.target) {
          unchangedCount++;
          continue;
        }
        writes.push({ path, entry });
        restored.push(path);
        continue;
      }
      if (now?.type === 'file') {
        const same =
          (unchanged(entry, now.info) && !entry.racy) ||
          (now.info.size === entry.size &&
            (await this.hashOf(this.absolute(path), now.info)) === entry.hash);
        if (same) {
          if ((now.info.mode & 0o7777) !== entry.mode) {
            fileModes.push({ path, mode: entry.mode });
            restored.push(path);
          } else {
            unchangedCount++;
          }
          continue;
        }
      }
      writes.push({ path, entry });
      restored.push(path);
    }

    const extraDirs: string[] = [];
    for (const [path, now] of present) {
      if (wanted.has(path) || isProtected(path) || underAny(path, replaced)) continue;
      if (now.type === 'dir') {
        extraDirs.push(path);
        continue;
      }
      if (now.type === 'other') continue;
      removals.push({ path, recursive: false });
      deleted.push(path);
    }
    extraDirs.sort((a, b) => depth(b) - depth(a) || compare(b, a));
    for (const path of extraDirs) {
      if (blocked.has(path)) {
        kept.add(path);
        block(path);
        continue;
      }
      removals.push({ path, recursive: false });
      deleted.push(path);
    }

    const files = removals.filter((removal) => present.get(removal.path)?.type !== 'dir');
    const dirs = removals
      .filter((removal) => present.get(removal.path)?.type === 'dir')
      .sort((a, b) => depth(b.path) - depth(a.path) || compare(b.path, a.path));
    dirModes.sort((a, b) => depth(b.path) - depth(a.path));
    return {
      result: {
        restored: restored.sort(compare),
        deleted: [...new Set(deleted)].sort(compare),
        unchanged: unchangedCount,
        kept: [...kept].sort(compare),
      },
      removals: [...files, ...dirs],
      mkdirs: mkdirs.sort((a, b) => depth(a) - depth(b)),
      writes,
      chmods: [...fileModes, ...dirModes],
    };
  }

  /**
   * Everything under the root a restore may touch, by path: what `excluded` leaves out is not
   * listed, only named in `excludedUnder`, and a directory that cannot be read is listed as such
   */
  private async scan(
    excluded: (path: string) => boolean
  ): Promise<{ present: Map<string, Present>; excludedUnder: Set<string> }> {
    const present = new Map<string, Present>();
    const excludedUnder = new Set<string>();
    const walk = async (rel: string): Promise<boolean> => {
      const absolute = this.absolute(rel);
      const listing = await this.readDirectory(absolute, rel);
      if (listing === 'unreadable') return false;
      for (const name of listing) {
        const path = rel === '' ? name : `${rel}/${name}`;
        if (excluded(path)) {
          excludedUnder.add(path);
          continue;
        }
        const info = await lstat(join(absolute, name)).catch(() => undefined);
        if (!info) continue;
        if (info.isDirectory()) {
          const entry: Present = { type: 'dir', info, unreadable: false };
          present.set(path, entry);
          entry.unreadable = !(await walk(path));
        } else if (info.isSymbolicLink()) {
          const target = await readlink(join(absolute, name)).catch(() => undefined);
          if (target !== undefined) present.set(path, { type: 'symlink', target });
        } else if (info.isFile()) {
          present.set(path, { type: 'file', info });
        } else {
          present.set(path, { type: 'other' });
        }
      }
      return true;
    };
    if (!(await walk(''))) {
      throw new WorkspaceError('DENIED', `The root ${this.root} cannot be read`);
    }
    return { present, excludedUnder };
  }

  /** The entries of the tree `hash` and the trees under it, by path, parents first */
  private async flatten(hash: string): Promise<Map<string, FlatEntry>> {
    const flat = new Map<string, FlatEntry>();
    const walk = async (treeHash: string, rel: string): Promise<void> => {
      for (const [name, entry] of await this.tree(treeHash)) {
        const path = rel === '' ? name : `${rel}/${name}`;
        if (entry.type === 'dir') {
          flat.set(path, { type: 'dir', mode: entry.mode });
          await walk(entry.tree, path);
        } else {
          flat.set(path, entry);
        }
      }
    };
    await walk(hash, '');
    return flat;
  }

  /**
   * Every blob `manifest` uses: its trees and the contents of its files. A tree that cannot be
   * read is named in `unreadable` (when given) and what it would reach is left out, else it throws
   */
  private async reachable(manifest: Manifest, unreadable?: string[]): Promise<Set<string>> {
    const hashes = new Set<string>();
    const walk = async (hash: string): Promise<void> => {
      if (hashes.has(hash)) return;
      hashes.add(hash);
      let tree: Tree;
      try {
        tree = await this.tree(hash);
      } catch (error) {
        if (!unreadable) throw error;
        unreadable.push(manifest.id);
        return;
      }
      for (const entry of tree.values()) {
        if (entry.type === 'dir') await walk(entry.tree);
        else if (entry.type === 'file') hashes.add(entry.hash);
      }
    };
    await walk(manifest.tree);
    return hashes;
  }

  /**
   * Mark and sweep under `locks/gc.lock`, deferred while another process works on the store.
   * Only names the store gives are swept (`blobs/<shard>/<hash>`, `tmp/*.part`), in directories
   * checked to be the store's own, never through a symlink
   */
  private async collect(graceMs: number): Promise<SnapshotGcReport> {
    const report: SnapshotGcReport = {
      snapshots: 0,
      kept: 0,
      deleted: 0,
      freedBytes: 0,
      deferred: false,
      unreadable: [],
    };
    if (!(await this.exists())) return report;
    await this.prepare();
    const release = await this.lockCollection();
    if (!release) return { ...report, deferred: true };
    try {
      const manifests = await this.manifests();
      report.snapshots = manifests.length;
      const marked = new Set<string>();
      for (const manifest of manifests) {
        for (const hash of await this.reachable(manifest, report.unreadable)) marked.add(hash);
      }
      if (report.unreadable.length > 0) {
        getLogger().warn('Snapshots whose trees cannot be read keep what they still reach', {
          snapshots: report.unreadable,
        });
      }
      report.kept = marked.size;
      const cutoff = Date.now() - graceMs;
      const blobs = join(this.dir, 'blobs');
      await this.verifyDir(blobs);
      for (const shard of await readdir(blobs).catch(() => [])) {
        if (!SHARD.test(shard)) continue;
        const shardDir = join(blobs, shard);
        if (!(await this.isOwnDir(shardDir))) continue;
        for (const rest of await readdir(shardDir).catch(() => [])) {
          if (!BLOB_REST.test(rest) || marked.has(`${shard}${rest}`)) continue;
          const freed = await this.sweep(shardDir, rest, cutoff);
          if (freed === undefined) continue;
          report.deleted++;
          report.freedBytes += freed;
          this.trees.delete(`${shard}${rest}`);
        }
      }
      const tmp = join(this.dir, 'tmp');
      if (await this.isOwnDir(tmp)) {
        for (const name of await readdir(tmp).catch(() => [])) {
          if (TEMP_NAME.test(name)) await this.sweep(tmp, name, cutoff);
        }
      }
      return report;
    } finally {
      await release();
    }
  }

  /**
   * Deletes `name` of the store directory `dir` when it is a file (or a stray symlink, never
   * followed) untouched since `cutoff`, once `dir` is checked again to be the store's own. The
   * bytes it took, undefined when it was left
   */
  private async sweep(dir: string, name: string, cutoff: number): Promise<number | undefined> {
    const path = join(dir, name);
    const info = await lstat(path).catch(() => undefined);
    if (!info || !(info.isFile() || info.isSymbolicLink()) || info.mtimeMs > cutoff) {
      return undefined;
    }
    if (!(await this.isOwnDir(dir))) return undefined;
    return unlink(path).then(
      () => info.size,
      () => undefined
    );
  }

  /**
   * Takes `locks/gc.lock` for a collection, undefined (nothing to sweep now) when another
   * collection holds it or a process works on the store. Gives back its release
   */
  private async lockCollection(): Promise<(() => Promise<void>) | undefined> {
    const locks = join(this.dir, 'locks');
    await this.verifyDir(locks);
    const lock = join(locks, GC_LOCK);
    const create = () =>
      open(lock, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | O_NOFOLLOW, FILE_MODE);
    let handle: FileHandle | undefined = await create().catch(() => undefined);
    if (!handle) {
      const info = await lstat(lock).catch(() => undefined);
      if (info && Date.now() - info.mtimeMs <= STALE_LOCK_MS) return undefined;
      await unlink(lock).catch(() => undefined);
      handle = await create().catch(() => undefined);
      if (!handle) return undefined;
    }
    await handle.close();
    const release = async () => {
      await unlink(lock).catch(() => undefined);
    };
    for (const name of await readdir(locks).catch(() => [])) {
      if (!MARKER_NAME.test(name)) continue;
      const info = await lstat(join(locks, name)).catch(() => undefined);
      if (info && Date.now() - info.mtimeMs <= STALE_LOCK_MS) {
        await release();
        return undefined;
      }
      if (info) await unlink(join(locks, name)).catch(() => undefined);
    }
    return release;
  }

  /** The manifests kept, oldest first; a manifest that cannot be read is logged and left out */
  private async manifests(): Promise<Manifest[]> {
    const dir = join(this.dir, 'manifests');
    if (!(await this.exists())) return [];
    await this.verifyDir(this.dir);
    if (!(await lstat(dir).catch(() => undefined))) return [];
    await this.verifyDir(dir);
    const found: Manifest[] = [];
    const broken: string[] = [];
    for (const name of await readdir(dir).catch(() => [])) {
      if (!name.endsWith('.json')) continue;
      const id = name.slice(0, -5);
      if (!SNAPSHOT_ID.test(id)) continue;
      const manifest = await this.manifest(id).catch(() => undefined);
      if (manifest) found.push(manifest);
      else broken.push(id);
    }
    if (broken.length > 0) {
      getLogger().warn('Snapshot manifests that cannot be read are left out', {
        snapshots: broken,
      });
    }
    return found.sort((a, b) => a.startedAt - b.startedAt || compare(a.id, b.id));
  }

  /**
   * The newest manifest, which a new snapshot compares its files with: the one this store wrote
   * last while it is still kept (another process may have deleted it), else the newest on disk
   */
  private async newest(): Promise<Manifest | undefined> {
    if (this.latest && (await lstat(this.manifestPath(this.latest.id)).catch(() => undefined))) {
      return this.latest;
    }
    this.latest = (await this.manifests()).at(-1);
    return this.latest;
  }

  private async manifest(id: string): Promise<Manifest> {
    if (!SNAPSHOT_ID.test(id)) throw missing(id);
    if (!(await this.exists())) throw missing(id);
    await this.verifyDir(this.dir);
    const path = this.manifestPath(id);
    const text = await readVerified(path).catch((error: unknown) => {
      if (errnoOf(error) === 'ENOENT') throw missing(id);
      throw ioError(error, id);
    });
    const parsed = manifestSchema.safeParse(safeJson(text.toString('utf8')));
    if (!parsed.success || parsed.data.id !== id) {
      throw new WorkspaceError('IO', `The manifest of snapshot ${id} cannot be read`, { path: id });
    }
    return parsed.data;
  }

  /** Writes a manifest atomically and durably: synced, renamed into place, its directory synced */
  private async writeManifest(manifest: Manifest): Promise<void> {
    const bytes = Buffer.from(JSON.stringify(manifest), 'utf8');
    const dir = join(this.dir, 'manifests');
    await this.writeAtomic(this.manifestPath(manifest.id), bytes);
    await syncDirectory(dir);
  }

  private manifestPath(id: string): string {
    return join(this.dir, 'manifests', `${id}.json`);
  }

  private async tree(hash: string): Promise<Tree> {
    const cached = this.trees.get(hash);
    if (cached) return cached;
    const parsed = treeSchema.safeParse(safeJson((await this.readBlob(hash)).toString('utf8')));
    if (!parsed.success) {
      throw new WorkspaceError('IO', `A directory tree of the snapshots (${hash}) cannot be read`);
    }
    const tree = new Map<string, TreeEntry>();
    for (const [name, entry] of parsed.data.entries) {
      if (!validName(name) || tree.has(name)) {
        throw new WorkspaceError(
          'IO',
          `A directory tree of the snapshots (${hash}) names an invalid entry ${JSON.stringify(name)}`
        );
      }
      tree.set(name, entry);
    }
    this.remember(hash, tree);
    return tree;
  }

  private remember(hash: string, tree: Tree): void {
    if (this.trees.size > 20_000) this.trees.clear();
    this.trees.set(hash, tree);
  }

  private blobPath(hash: string): string {
    return join(this.dir, 'blobs', hash.slice(0, 2), hash.slice(2));
  }

  /** Whether blob `hash` is kept whole: a regular file of `size` bytes */
  private async blobSized(hash: string, size: number): Promise<boolean> {
    const info = await lstat(this.blobPath(hash)).catch(() => undefined);
    return info !== undefined && info.isFile() && info.size === size;
  }

  /** The content of blob `hash`, checked against its hash */
  private async readBlob(hash: string): Promise<Buffer> {
    const bytes = await readVerified(this.blobPath(hash)).catch((error: unknown) => {
      throw new WorkspaceError('IO', `Stored content ${hash} of the snapshots is missing`, {
        cause: error,
      });
    });
    if (sha256(bytes) !== hash) {
      throw new WorkspaceError('IO', `Stored content ${hash} of the snapshots is corrupt`);
    }
    return bytes;
  }

  /** Checks blob `hash` against its hash, reading it a chunk at a time */
  private async verifyBlob(hash: string): Promise<void> {
    const handle = await open(
      this.blobPath(hash),
      constants.O_RDONLY | O_NOFOLLOW | O_NONBLOCK
    ).catch((error: unknown) => {
      throw new WorkspaceError('IO', `Stored content ${hash} of the snapshots is missing`, {
        cause: error,
      });
    });
    try {
      const digest = createHash('sha256');
      await readChunks(handle, Number.MAX_SAFE_INTEGER, (chunk) => {
        digest.update(chunk);
      });
      if (digest.digest('hex') !== hash) {
        throw new WorkspaceError('IO', `Stored content ${hash} of the snapshots is corrupt`);
      }
    } finally {
      await handle.close();
    }
  }

  /** Stores `bytes` as blob `hash`, synced, noting its shard for {@link syncShards} */
  private async putBlob(hash: string, bytes: Uint8Array, shards: Set<string>): Promise<void> {
    const shard = join(this.dir, 'blobs', hash.slice(0, 2));
    await this.ensureDir(shard);
    await this.writeAtomic(this.blobPath(hash), bytes);
    shards.add(shard);
  }

  /** Syncs the directories new blobs went into, before a manifest names them */
  private async syncShards(shards: ReadonlySet<string>): Promise<void> {
    for (const shard of shards) await syncDirectory(shard);
    if (shards.size > 0) await syncDirectory(join(this.dir, 'blobs'));
  }

  /**
   * Reads a regular file without following a symlink in its place, checked to be the entry `seen`
   * and to sit in its own directory still, hashing it and writing it to a temporary file as it
   * reads, then keeps it as a blob. A file that changes while it is read is read again, the last
   * read is kept with `racy` when it never held still
   */
  private async storeFile(
    absolute: string,
    seen: Stats,
    maxBytes: number,
    shards: Set<string>
  ): Promise<
    | { hash: string; size: number; info: Stats; racy: boolean; storedBytes: number }
    | 'too-large'
    | 'unreadable'
    | 'changing'
  > {
    await this.ensureDir(join(this.dir, 'tmp'));
    let last: { temp: string; hash: string; size: number; info: Stats; still: boolean } | undefined;
    try {
      for (let attempt = 0; attempt < READ_ATTEMPTS; attempt++) {
        if (attempt > 0) await new Promise((resolve) => setTimeout(resolve, 10 * attempt));
        const read = await this.readToTemp(absolute, seen, maxBytes);
        if (typeof read === 'string') return read;
        if (last) await unlink(last.temp).catch(() => undefined);
        last = read;
        if (read.still) break;
      }
      if (!last?.still) return 'changing';
      const { temp, hash, size, info, still } = last;
      last = undefined;
      const racy = !still || !(await this.stillSame(absolute, info));
      if (await this.blobSized(hash, size)) {
        await unlink(temp).catch(() => undefined);
        return { hash, size, info, racy, storedBytes: 0 };
      }
      const shard = join(this.dir, 'blobs', hash.slice(0, 2));
      await this.ensureDir(shard);
      await this.verifyDir(join(this.dir, 'tmp'));
      await rename(temp, this.blobPath(hash)).catch(async (error: unknown) => {
        await unlink(temp).catch(() => undefined);
        throw ioError(error, WORKSPACE_CHECKPOINTS_DIR);
      });
      shards.add(shard);
      return { hash, size, info, racy, storedBytes: size };
    } finally {
      if (last) await unlink(last.temp).catch(() => undefined);
    }
  }

  /** Whether a file still has the size and times `info` recorded */
  private async stillSame(absolute: string, info: Stats): Promise<boolean> {
    const now = await lstat(absolute).catch(() => undefined);
    return now?.size === info.size && now.mtimeMs === info.mtimeMs && now.ctimeMs === info.ctimeMs;
  }

  /** One read of a file into a synced temporary file of the store, see {@link storeFile} */
  private async readToTemp(
    absolute: string,
    seen: Stats,
    maxBytes: number
  ): Promise<
    | { temp: string; hash: string; size: number; info: Stats; still: boolean }
    | 'too-large'
    | 'unreadable'
  > {
    const source = await open(absolute, constants.O_RDONLY | O_NOFOLLOW | O_NONBLOCK).catch(
      () => undefined
    );
    if (!source) return 'unreadable';
    try {
      const before = await source.stat();
      if (!before.isFile() || before.dev !== seen.dev || before.ino !== seen.ino)
        return 'unreadable';
      const parent = dirname(absolute);
      if ((await realpath(parent).catch(() => undefined)) !== parent) return 'unreadable';
      if (before.size > maxBytes) return 'too-large';
      const temp = join(this.dir, 'tmp', `${token()}.part`);
      const target = await open(
        temp,
        constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | O_NOFOLLOW,
        FILE_MODE
      ).catch((error: unknown) => {
        throw ioError(error, WORKSPACE_CHECKPOINTS_DIR);
      });
      let kept = false;
      try {
        const digest = createHash('sha256');
        let written = 0;
        const size = await readChunks(source, maxBytes, async (chunk) => {
          digest.update(chunk);
          let offset = 0;
          while (offset < chunk.byteLength) {
            const { bytesWritten } = await target.write(
              chunk,
              offset,
              chunk.byteLength - offset,
              written + offset
            );
            offset += bytesWritten;
          }
          written += chunk.byteLength;
        });
        if (size === 'too-large') return 'too-large';
        await target.sync();
        const after = await source.stat();
        kept = true;
        return {
          temp,
          hash: digestHex(digest),
          size,
          info: before,
          still:
            after.size === before.size &&
            after.mtimeMs === before.mtimeMs &&
            after.ctimeMs === before.ctimeMs &&
            size === before.size,
        };
      } finally {
        await target.close().catch(() => undefined);
        if (!kept) await unlink(temp).catch(() => undefined);
      }
    } finally {
      await source.close().catch(() => undefined);
    }
  }

  /** Writes through a fresh, synced file in `tmp/` (owner only), renamed into place */
  private async writeAtomic(path: string, bytes: Uint8Array): Promise<void> {
    const tmp = join(this.dir, 'tmp');
    await this.ensureDir(tmp);
    const temp = join(tmp, `${token()}.part`);
    let handle: FileHandle | undefined = await open(
      temp,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | O_NOFOLLOW,
      FILE_MODE
    ).catch((error: unknown) => {
      throw ioError(error, WORKSPACE_CHECKPOINTS_DIR);
    });
    try {
      let written = 0;
      while (written < bytes.byteLength) {
        const { bytesWritten } = await handle.write(
          bytes,
          written,
          bytes.byteLength - written,
          written
        );
        written += bytesWritten;
      }
      await handle.sync();
      await handle.close();
      handle = undefined;
      await this.verifyDir(tmp);
      await this.verifyDir(dirname(path));
      await rename(temp, path);
    } catch (error) {
      await handle?.close().catch(() => undefined);
      await unlink(temp).catch(() => undefined);
      throw ioError(error, WORKSPACE_CHECKPOINTS_DIR);
    }
  }

  private async exists(): Promise<boolean> {
    return (await lstat(this.dir).catch(() => undefined)) !== undefined;
  }

  /** Creates the store's directories, owner only, refusing any that resolves outside the root */
  private async prepare(): Promise<void> {
    await this.ensureDir(this.dir);
    for (const name of ['manifests', 'blobs', 'tmp', 'locks']) {
      await this.ensureDir(join(this.dir, name));
    }
  }

  /**
   * Makes `dir` (a directory of the store) when it is missing, owner only, and checks it is a
   * real directory where it should be. A directory of the store a looser umask left open is
   * closed to the owner
   */
  private async ensureDir(dir: string): Promise<void> {
    await mkdir(dir, { recursive: true, mode: DIR_MODE }).catch((error: unknown) => {
      throw ioError(error, WORKSPACE_CHECKPOINTS_DIR);
    });
    await this.verifyDir(dir);
    const info = await lstat(dir);
    if ((info.mode & 0o777) !== DIR_MODE) {
      const handle = await open(dir, constants.O_RDONLY | O_DIRECTORY | O_NOFOLLOW);
      try {
        await handle.chmod(DIR_MODE);
      } finally {
        await handle.close();
      }
    }
  }

  /** Throws when `dir` is not itself: a real directory where the store expects it */
  private async verifyDir(dir: string): Promise<void> {
    if (await this.isOwnDir(dir)) return;
    const there = await lstat(dir).catch(() => undefined);
    if (!there) {
      throw new WorkspaceError('NOT_FOUND', `${WORKSPACE_CHECKPOINTS_DIR} is missing a directory`, {
        path: WORKSPACE_CHECKPOINTS_DIR,
      });
    }
    throw new WorkspaceError(
      'OUTSIDE_ROOT',
      `${WORKSPACE_CHECKPOINTS_DIR} resolves outside the workspace: a symlink was put in its place`,
      { path: WORKSPACE_CHECKPOINTS_DIR }
    );
  }

  /** Whether `dir` is a real directory (not a symlink) that resolves to itself */
  private async isOwnDir(dir: string): Promise<boolean> {
    const info = await lstat(dir).catch(() => undefined);
    if (!info?.isDirectory()) return false;
    return (await realpath(dir).catch(() => undefined)) === dir;
  }

  private absolute(rel: string): string {
    return rel === '' ? this.root : join(this.root, ...rel.split('/'));
  }

  /**
   * The names in a directory, sorted, once it is checked to be itself inside the root, or
   * `unreadable` when it cannot be listed (permissions) or was swapped for a symlink meanwhile
   */
  private async readDirectory(absolute: string, rel: string): Promise<string[] | 'unreadable'> {
    const real = await realpath(absolute).catch(() => undefined);
    if (real !== absolute) {
      if (rel === '') throw new WorkspaceError('NOT_FOUND', `The root ${this.root} is gone`);
      return 'unreadable';
    }
    try {
      return (await readdir(absolute)).sort(compare);
    } catch {
      return 'unreadable';
    }
  }

  /** The sha256 of a file now, read a chunk at a time, undefined when it cannot be read */
  private async hashOf(absolute: string, seen: Stats): Promise<string | undefined> {
    const handle = await open(absolute, constants.O_RDONLY | O_NOFOLLOW | O_NONBLOCK).catch(
      () => undefined
    );
    if (!handle) return undefined;
    try {
      const info = await handle.stat();
      if (!info.isFile() || info.dev !== seen.dev || info.ino !== seen.ino) return undefined;
      const digest = createHash('sha256');
      await readChunks(handle, Number.MAX_SAFE_INTEGER, (chunk) => {
        digest.update(chunk);
      });
      return digestHex(digest);
    } finally {
      await handle.close();
    }
  }
}

/** Whether a file looks as `entry` recorded it: same size, times, inode and mode */
function unchanged(entry: FileEntry, info: Stats): boolean {
  return (
    !entry.racy &&
    entry.size === info.size &&
    entry.mtimeMs === info.mtimeMs &&
    entry.ctimeMs === info.ctimeMs &&
    entry.ino === info.ino &&
    entry.mode === (info.mode & 0o7777)
  );
}

function isRacy(info: Stats, startedAt: number): boolean {
  return Math.max(info.mtimeMs, info.ctimeMs) >= startedAt - RACY_MARGIN_MS;
}

/**
 * Whether a path is left out: a glob matches it, or a glob ending in `/**` matches it as the
 * directory whose contents it leaves out. The walk does not descend into what is left out, so
 * what is under it goes too
 */
export function excluderOf(globs: readonly string[]): (path: string) => boolean {
  const matchers = globs.map(workspaceGlobMatcher);
  const dirs = globs
    .filter((glob) => glob.endsWith('/**') && glob.length > 3)
    .map((glob) => workspaceGlobMatcher(glob.slice(0, -3)));
  return (path) =>
    matchers.some((matches) => matches(path)) || dirs.some((matches) => matches(path));
}

function recordOf(manifest: Manifest): WorkspaceSnapshot {
  return {
    id: manifest.id,
    workspaceId: manifest.workspaceId,
    createdAt: manifest.createdAt,
    ...(manifest.label !== undefined && { label: manifest.label }),
    ...(manifest.metadata !== undefined && { metadata: manifest.metadata }),
    exclude: manifest.exclude,
    skipped: manifest.skipped,
    maxFileBytes: manifest.maxFileBytes,
    stats: manifest.stats,
  };
}

/** A new snapshot id, ordered by time: `snap_<time>_<random>` */
export function snapshotId(): string {
  return `snap_${Date.now().toString(36)}_${nanoid(8).replace(/[^A-Za-z0-9]/g, 'x')}`;
}

/** A random name part the store's patterns accept: 16 letters, digits, `_` or `-` */
function token(): string {
  return nanoid(16);
}

/** Whether `path` lies under one of `dirs` (not one of them itself) */
function underAny(path: string, dirs: ReadonlySet<string>): boolean {
  for (const dir of ancestorsOf(path)) if (dirs.has(dir)) return true;
  return false;
}

/** The directories `path` is in, nearest first, the root left out */
function ancestorsOf(path: string): string[] {
  const dirs: string[] = [];
  for (let at = path.lastIndexOf('/'); at > 0; at = path.lastIndexOf('/', at - 1)) {
    dirs.push(path.slice(0, at));
  }
  return dirs;
}

function validName(name: string): boolean {
  return (
    name !== '' &&
    name !== '.' &&
    name !== '..' &&
    !name.includes('/') &&
    !name.includes('\\') &&
    !name.includes('\0')
  );
}

function depth(path: string): number {
  let count = 0;
  for (const char of path) if (char === '/') count++;
  return count;
}

/** Orders paths by their code units, the same everywhere */
function compare(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function sha256(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

function digestHex(digest: Hash): string {
  return digest.digest('hex');
}

/** Whether this process can read the file at `path` */
async function readable(path: string): Promise<boolean> {
  return access(path, constants.R_OK).then(
    () => true,
    () => false
  );
}

/**
 * Reads `handle` from its start a chunk at a time into `each`, the total bytes, or `too-large`
 * once more than `maxBytes` came
 */
async function readChunks(
  handle: FileHandle,
  maxBytes: number,
  each: (chunk: Buffer) => void | Promise<void>
): Promise<number | 'too-large'> {
  let total = 0;
  for (;;) {
    const buffer = Buffer.allocUnsafe(CHUNK_BYTES);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, total);
    if (bytesRead === 0) return total;
    total += bytesRead;
    if (total > maxBytes) return 'too-large';
    await each(buffer.subarray(0, bytesRead));
  }
}

/** A file of the store, read without following a symlink in its place */
async function readVerified(path: string): Promise<Buffer> {
  const handle = await open(path, constants.O_RDONLY | O_NOFOLLOW | O_NONBLOCK);
  try {
    const info = await handle.stat();
    if (!info.isFile()) throw Object.assign(new Error(`${path} is not a file`), { code: 'EINVAL' });
    return await readFile(handle);
  } finally {
    await handle.close();
  }
}

/** Flushes a directory's entries to disk, where the platform allows it */
async function syncDirectory(dir: string): Promise<void> {
  try {
    const handle = await open(dir, constants.O_RDONLY | O_DIRECTORY | O_NOFOLLOW);
    try {
      await handle.sync();
    } finally {
      await handle.close();
    }
  } catch {
    return;
  }
}

function safeJson(text: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return undefined;
  }
}

function missing(id: string): WorkspaceError {
  return new WorkspaceError('NOT_FOUND', `Snapshot ${id} does not exist`, { path: id });
}

function errnoOf(error: unknown): string | undefined {
  return error instanceof Error && 'code' in error && typeof error.code === 'string'
    ? error.code
    : undefined;
}

function ioError(error: unknown, path: string): WorkspaceError {
  if (error instanceof WorkspaceError) return error;
  const code = errnoOf(error);
  if (code === 'ENOENT') {
    return new WorkspaceError('NOT_FOUND', `${path} does not exist`, { path, cause: error });
  }
  if (code === 'EACCES' || code === 'EPERM') {
    return new WorkspaceError('DENIED', `${path}: permission denied`, { path, cause: error });
  }
  if (code === 'ELOOP') {
    return new WorkspaceError('OUTSIDE_ROOT', `${path} became a symlink`, { path, cause: error });
  }
  const message = error instanceof Error ? error.message : String(error);
  return new WorkspaceError('IO', `${path}: ${code ?? message}`, { path, cause: error });
}

/** Runs at most `limit` tasks at once */
class Limiter {
  private running = 0;
  private readonly waiting: (() => void)[] = [];

  constructor(private readonly limit: number) {}

  async run<T>(task: () => Promise<T>): Promise<T> {
    if (this.running >= this.limit) {
      await new Promise<void>((resolve) => this.waiting.push(resolve));
    }
    this.running++;
    try {
      return await task();
    } finally {
      this.running--;
      this.waiting.shift()?.();
    }
  }
}
