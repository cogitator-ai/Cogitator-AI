import { createHash } from 'node:crypto';
import { constants, type Stats } from 'node:fs';
import {
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

/** Where a workspace keeps its snapshots, relative to the root. */
export const WORKSPACE_CHECKPOINTS_DIR = '.cogitator/checkpoints';

const MANIFEST_VERSION = 1;
const TREE_VERSION = 1;
const O_NOFOLLOW = constants.O_NOFOLLOW ?? 0;
const O_NONBLOCK = constants.O_NONBLOCK ?? 0;
/**
 * A file whose modification or change time is this close to the start of the snapshot that
 * recorded it may have changed again within the clock's granularity without either time moving:
 * the next snapshot reads it again instead of trusting its times (as git treats racy entries)
 */
const RACY_MARGIN_MS = 2_000;
/** Files read at once while a snapshot hashes them */
const READ_CONCURRENCY = 16;
/** Reads of a file that keeps changing while it is read, before the last one is kept */
const READ_ATTEMPTS = 3;
const SNAPSHOT_ID = /^snap_[a-z0-9]+_[A-Za-z0-9]{8}$/;
const HASH = /^[0-9a-f]{64}$/;

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
const treeSchema = z.object({
  version: z.literal(TREE_VERSION),
  entries: z.record(z.string(), treeEntrySchema),
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
      reason: z.enum(['too-large', 'unreadable']),
      size: z.number().optional(),
    })
  ),
  stats: statsSchema,
});

type FileEntry = z.infer<typeof fileEntrySchema>;
type TreeEntry = z.infer<typeof treeEntrySchema>;
type Tree = z.infer<typeof treeSchema>;
type Manifest = z.infer<typeof manifestSchema>;

/** A snapshot's entries by path, relative to the root, parents before their contents */
type FlatEntry = FileEntry | { type: 'dir'; mode: number } | { type: 'symlink'; target: string };

/** What a restore finds at a path now, without reading file contents */
type Present =
  | { type: 'file'; info: Stats }
  | { type: 'dir'; info: Stats }
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
}

/**
 * The snapshots of a workspace root, kept content-addressed in `.cogitator/checkpoints`: every
 * file content and every directory listing (a tree, as git keeps them) is a blob named by its
 * sha256, so unchanged files and directories cost nothing in a new snapshot, and a manifest per
 * snapshot names its root tree. A file whose size, times, inode and mode did not change since
 * the snapshot before is not read again. One store serves every workspace over the same root in
 * the process, and its operations run one at a time.
 */
export class SnapshotStore {
  private readonly dir: string;
  private queue: Promise<unknown> = Promise.resolve();
  private latest: Manifest | undefined;
  private readonly trees = new Map<string, Tree>();

  private constructor(private readonly root: string) {
    this.dir = join(root, ...WORKSPACE_CHECKPOINTS_DIR.split('/'));
  }

  private static readonly stores = new Map<string, SnapshotStore>();

  /** The store of `root`, a real path (symlinks resolved), shared within the process */
  static of(root: string): SnapshotStore {
    let store = SnapshotStore.stores.get(root);
    if (!store) {
      store = new SnapshotStore(root);
      SnapshotStore.stores.set(root, store);
    }
    return store;
  }

  /** Records the files of the root, see {@link SnapshotStore} */
  take(options: SnapshotTakeOptions): Promise<WorkspaceSnapshot> {
    return this.exclusive(() => this.takeNow(options));
  }

  /** The snapshots kept, oldest first */
  list(): Promise<WorkspaceSnapshot[]> {
    return this.exclusive(async () => (await this.manifests()).map(recordOf));
  }

  /** Brings the files back to snapshot `id`, or says what that would change with `dryRun` */
  restore(id: string, ops: SnapshotRestoreOps, dryRun: boolean): Promise<WorkspaceRestoreResult> {
    return this.exclusive(() => this.restoreNow(id, ops, dryRun));
  }

  /** Forgets snapshot `id` and frees the contents only it used */
  delete(id: string, graceMs: number): Promise<void> {
    return this.exclusive(async () => {
      const path = this.manifestPath(id);
      await this.verifyDir();
      await unlink(path).catch((error: unknown) => {
        if (errnoOf(error) === 'ENOENT') throw missing(id);
        throw ioError(error, id);
      });
      if (this.latest?.id === id) this.latest = undefined;
      await this.collect(graceMs);
    });
  }

  /** Deletes the snapshots `retention` does not keep, then frees what no snapshot uses */
  prune(
    retention: SnapshotRetention,
    graceMs: number
  ): Promise<{ deleted: string[]; gc: SnapshotGcReport }> {
    return this.exclusive(async () => {
      const manifests = await this.manifests();
      const now = Date.now();
      const doomed = manifests.filter((manifest, index) => {
        const tooMany =
          retention.count !== undefined && index < manifests.length - Math.max(0, retention.count);
        const tooOld =
          retention.maxAgeMs !== undefined &&
          now - Date.parse(manifest.createdAt) > retention.maxAgeMs;
        return tooMany || tooOld;
      });
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

  /** Copies snapshot `id`, its manifest and every blob it uses, into `target` */
  copyTo(id: string, target: SnapshotStore): Promise<WorkspaceSnapshot> {
    if (target === this) {
      return this.exclusive(async () => recordOf(await this.manifest(id)));
    }
    return this.exclusive(() =>
      target.exclusive(async () => {
        const manifest = await this.manifest(id);
        const hashes = await this.reachable(manifest);
        await target.prepare();
        for (const hash of hashes) {
          if (await target.hasBlob(hash)) continue;
          await target.putBlob(hash, await this.readBlob(hash));
        }
        await target.writeManifest(manifest);
        return recordOf(manifest);
      })
    );
  }

  private exclusive<T>(work: () => Promise<T>): Promise<T> {
    const run = this.queue.then(work, work);
    this.queue = run.catch(() => undefined);
    return run;
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
    await this.prepare();
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

    const walk = async (rel: string, before: Tree | undefined): Promise<string> => {
      const absolute = this.absolute(rel);
      const names = await this.readDirectory(absolute, rel);
      const entries: Record<string, TreeEntry> = {};
      const pending: Promise<void>[] = [];
      for (const name of names) {
        const path = rel === '' ? name : `${rel}/${name}`;
        if (excluded(path)) continue;
        const full = join(absolute, name);
        const info = await lstat(full).catch(() => undefined);
        if (!info) continue;
        const prior = before?.entries[name];
        if (info.isDirectory()) {
          const priorTree =
            prior?.type === 'dir' ? await this.tree(prior.tree).catch(() => undefined) : undefined;
          entries[name] = {
            type: 'dir',
            mode: info.mode & 0o7777,
            tree: await walk(path, priorTree),
          };
          stats.others++;
        } else if (info.isSymbolicLink()) {
          const target = await readlink(full).catch(() => undefined);
          if (target === undefined) continue;
          entries[name] = { type: 'symlink', target };
          stats.others++;
        } else if (info.isFile()) {
          if (info.size > maxFileBytes) {
            skipped.push({ path, reason: 'too-large', size: info.size });
            continue;
          }
          pending.push(
            limiter.run(async () => {
              if (
                prior?.type === 'file' &&
                unchanged(prior, info) &&
                (await this.hasBlob(prior.hash))
              ) {
                entries[name] = prior;
                stats.files++;
                stats.bytes += info.size;
                stats.reused++;
                return;
              }
              const read = await this.readFileAt(full, info, maxFileBytes);
              if (read === 'too-large') {
                skipped.push({ path, reason: 'too-large', size: info.size });
                return;
              }
              if (!read) {
                skipped.push({ path, reason: 'unreadable', size: info.size });
                return;
              }
              const hash = sha256(read.bytes);
              if (!(await this.hasBlob(hash))) {
                await this.putBlob(hash, read.bytes);
                stats.storedBytes += read.bytes.byteLength;
              }
              const racy = read.racy || isRacy(read.info, startedAt);
              entries[name] = {
                type: 'file',
                hash,
                mode: read.info.mode & 0o7777,
                size: read.bytes.byteLength,
                mtimeMs: read.info.mtimeMs,
                ctimeMs: read.info.ctimeMs,
                ino: read.info.ino,
                ...(racy && { racy: true }),
              };
              stats.files++;
              stats.bytes += read.bytes.byteLength;
              stats.hashed++;
            })
          );
        }
      }
      await Promise.all(pending);
      const sorted: Record<string, TreeEntry> = {};
      for (const name of Object.keys(entries).sort()) sorted[name] = entries[name];
      const tree: Tree = { version: TREE_VERSION, entries: sorted };
      const bytes = Buffer.from(JSON.stringify(tree), 'utf8');
      const hash = sha256(bytes);
      if (!(await this.hasBlob(hash))) {
        await this.putBlob(hash, bytes);
        stats.storedBytes += bytes.byteLength;
      }
      this.remember(hash, tree);
      return hash;
    };

    const priorRoot = previous ? await this.tree(previous.tree).catch(() => undefined) : undefined;
    const tree = await walk('', priorRoot);
    skipped.sort((a, b) => a.path.localeCompare(b.path));
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
      if (entry.type === 'file' && !(await this.hasBlob(entry.hash))) {
        throw new WorkspaceError(
          'IO',
          `Snapshot ${id} is incomplete: the content of a file it holds is missing from ${WORKSPACE_CHECKPOINTS_DIR}`,
          { path: id }
        );
      }
    }
    const excluded = excluderOf(manifest.exclude);
    const skippedPaths = new Set(manifest.skipped.map((skip) => skip.path));
    const { present, excludedUnder } = await this.scan(excluded);

    const restored: string[] = [];
    const deleted: string[] = [];
    const kept: string[] = [];
    let unchangedCount = 0;
    const toWrite: { path: string; entry: FlatEntry }[] = [];
    const toRemove: { path: string; recursive: boolean }[] = [];
    const toChmodDirs: { path: string; mode: number }[] = [];
    const toChmodFiles: { path: string; mode: number }[] = [];
    const removedDirs = new Set<string>();

    const blocked = new Set<string>();
    const block = (path: string): void => {
      for (const dir of ancestorsOf(path)) blocked.add(dir);
    };
    for (const path of excludedUnder) block(path);
    for (const [path, now] of present) if (now.type === 'other') block(path);
    for (const path of skippedPaths) {
      if (!present.has(path)) continue;
      kept.push(path);
      block(path);
    }
    const holdsExcluded = (dir: string): boolean => blocked.has(dir);

    for (const [path, entry] of wanted) {
      if (underAny(path, removedDirs)) continue;
      const now = present.get(path);
      if (entry.type === 'dir') {
        if (now?.type === 'dir') {
          if ((now.info.mode & 0o7777) !== entry.mode) {
            toChmodDirs.push({ path, mode: entry.mode });
            restored.push(path);
          } else {
            unchangedCount++;
          }
          continue;
        }
        if (now && now.type !== 'other') toRemove.push({ path, recursive: false });
        if (now?.type === 'other') {
          kept.push(path);
          removedDirs.add(path);
          continue;
        }
        toWrite.push({ path, entry });
        toChmodDirs.push({ path, mode: entry.mode });
        restored.push(path);
        continue;
      }
      if (now?.type === 'dir') {
        if (holdsExcluded(path)) {
          kept.push(path);
          continue;
        }
        toRemove.push({ path, recursive: true });
        removedDirs.add(path);
        toWrite.push({ path, entry });
        restored.push(path);
        continue;
      }
      if (now?.type === 'other') {
        kept.push(path);
        continue;
      }
      if (entry.type === 'symlink') {
        if (now?.type === 'symlink' && now.target === entry.target) {
          unchangedCount++;
          continue;
        }
        toWrite.push({ path, entry });
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
            toChmodFiles.push({ path, mode: entry.mode });
            restored.push(path);
          } else {
            unchangedCount++;
          }
          continue;
        }
      }
      toWrite.push({ path, entry });
      restored.push(path);
    }

    const extraDirs: string[] = [];
    for (const [path, now] of present) {
      if (wanted.has(path) || skippedPaths.has(path) || underAny(path, removedDirs)) continue;
      if (now.type === 'other') continue;
      if (now.type === 'dir') {
        extraDirs.push(path);
        continue;
      }
      toRemove.push({ path, recursive: false });
      deleted.push(path);
    }
    extraDirs.sort((a, b) => depth(b) - depth(a) || b.localeCompare(a));
    for (const path of extraDirs) {
      if (blocked.has(path)) {
        kept.push(path);
        block(path);
        continue;
      }
      toRemove.push({ path, recursive: false });
      deleted.push(path);
    }

    const result: WorkspaceRestoreResult = {
      snapshotId: id,
      dryRun,
      restored: restored.sort(),
      deleted: deleted.sort(),
      unchanged: unchangedCount,
      kept: [...new Set(kept)].sort(),
    };
    for (const { entry } of toWrite) if (entry.type === 'file') await this.readBlob(entry.hash);
    if (dryRun) return result;

    const files = toRemove.filter(
      (item) => !item.recursive && present.get(item.path)?.type !== 'dir'
    );
    const dirs = toRemove.filter(
      (item) => item.recursive || present.get(item.path)?.type === 'dir'
    );
    for (const item of files) await ops.remove(item.path, false);
    dirs.sort((a, b) => depth(b.path) - depth(a.path) || b.path.localeCompare(a.path));
    for (const item of dirs) await ops.remove(item.path, item.recursive);
    const order = [...toWrite].sort((a, b) => depth(a.path) - depth(b.path));
    for (const { path, entry } of order) {
      if (entry.type === 'dir') await ops.mkdir(path);
    }
    for (const { path, entry } of order) {
      if (entry.type === 'file')
        await ops.writeFile(path, await this.readBlob(entry.hash), entry.mode);
      else if (entry.type === 'symlink') await ops.symlink(path, entry.target);
    }
    for (const { path, mode } of toChmodFiles) await ops.chmod(path, mode);
    toChmodDirs.sort((a, b) => depth(b.path) - depth(a.path));
    for (const { path, mode } of toChmodDirs) await ops.chmod(path, mode);
    return result;
  }

  /**
   * Everything under the root a restore may touch, by path: what `excluded` leaves out is not
   * listed, only named in `excludedUnder`
   */
  private async scan(
    excluded: (path: string) => boolean
  ): Promise<{ present: Map<string, Present>; excludedUnder: Set<string> }> {
    const present = new Map<string, Present>();
    const excludedUnder = new Set<string>();
    const walk = async (rel: string): Promise<void> => {
      const absolute = this.absolute(rel);
      for (const name of await this.readDirectory(absolute, rel)) {
        const path = rel === '' ? name : `${rel}/${name}`;
        if (excluded(path)) {
          excludedUnder.add(path);
          continue;
        }
        const info = await lstat(join(absolute, name)).catch(() => undefined);
        if (!info) continue;
        if (info.isDirectory()) {
          present.set(path, { type: 'dir', info });
          await walk(path);
        } else if (info.isSymbolicLink()) {
          const target = await readlink(join(absolute, name)).catch(() => undefined);
          if (target !== undefined) present.set(path, { type: 'symlink', target });
        } else if (info.isFile()) {
          present.set(path, { type: 'file', info });
        } else {
          present.set(path, { type: 'other' });
        }
      }
    };
    await walk('');
    return { present, excludedUnder };
  }

  /** The entries of the tree `hash` and the trees under it, by path, parents first */
  private async flatten(hash: string): Promise<Map<string, FlatEntry>> {
    const flat = new Map<string, FlatEntry>();
    const walk = async (treeHash: string, rel: string): Promise<void> => {
      const tree = await this.tree(treeHash);
      for (const [name, entry] of Object.entries(tree.entries)) {
        if (!validName(name)) {
          throw new WorkspaceError(
            'IO',
            `A snapshot tree names an invalid entry ${JSON.stringify(name)}`
          );
        }
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

  /** Every blob `manifest` uses: its trees and the contents of its files */
  private async reachable(manifest: Manifest): Promise<Set<string>> {
    const hashes = new Set<string>();
    const walk = async (hash: string): Promise<void> => {
      if (hashes.has(hash)) return;
      hashes.add(hash);
      const tree = await this.tree(hash);
      for (const entry of Object.values(tree.entries)) {
        if (entry.type === 'dir') await walk(entry.tree);
        else if (entry.type === 'file') hashes.add(entry.hash);
      }
    };
    await walk(manifest.tree);
    return hashes;
  }

  private async collect(graceMs: number): Promise<SnapshotGcReport> {
    const manifests = await this.manifests();
    const marked = new Set<string>();
    for (const manifest of manifests) {
      for (const hash of await this.reachable(manifest)) marked.add(hash);
    }
    const blobs = join(this.dir, 'blobs');
    const cutoff = Date.now() - graceMs;
    let deleted = 0;
    let freedBytes = 0;
    for (const shard of await readdir(blobs).catch(() => [])) {
      if (!/^[0-9a-f]{2}$/.test(shard)) continue;
      for (const rest of await readdir(join(blobs, shard)).catch(() => [])) {
        const hash = `${shard}${rest}`;
        if (marked.has(hash) || !HASH.test(hash)) continue;
        const path = join(blobs, shard, rest);
        const info = await lstat(path).catch(() => undefined);
        if (!info?.isFile() || info.mtimeMs > cutoff) continue;
        await unlink(path).then(
          () => {
            deleted++;
            freedBytes += info.size;
            this.trees.delete(hash);
          },
          () => undefined
        );
      }
    }
    const tmp = join(this.dir, 'tmp');
    for (const name of await readdir(tmp).catch(() => [])) {
      const path = join(tmp, name);
      const info = await lstat(path).catch(() => undefined);
      if (info?.isFile() && info.mtimeMs <= cutoff) await unlink(path).catch(() => undefined);
    }
    return { snapshots: manifests.length, kept: marked.size, deleted, freedBytes };
  }

  /** The manifests kept, oldest first; a manifest that cannot be read is left out */
  private async manifests(): Promise<Manifest[]> {
    const dir = join(this.dir, 'manifests');
    if (!(await this.exists())) return [];
    await this.verifyDir();
    const found: Manifest[] = [];
    for (const name of await readdir(dir).catch(() => [])) {
      if (!name.endsWith('.json')) continue;
      const id = name.slice(0, -5);
      if (!SNAPSHOT_ID.test(id)) continue;
      const manifest = await this.manifest(id).catch(() => undefined);
      if (manifest) found.push(manifest);
    }
    return found.sort((a, b) => a.startedAt - b.startedAt || a.id.localeCompare(b.id));
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
    await this.verifyDir().catch((error: unknown) => {
      if (WorkspaceError.is(error, 'NOT_FOUND')) throw missing(id);
      throw error;
    });
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

  private async writeManifest(manifest: Manifest): Promise<void> {
    const bytes = Buffer.from(JSON.stringify(manifest), 'utf8');
    await this.writeAtomic(this.manifestPath(manifest.id), bytes, true);
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
    this.remember(hash, parsed.data);
    return parsed.data;
  }

  private remember(hash: string, tree: Tree): void {
    if (this.trees.size > 20_000) this.trees.clear();
    this.trees.set(hash, tree);
  }

  private blobPath(hash: string): string {
    return join(this.dir, 'blobs', hash.slice(0, 2), hash.slice(2));
  }

  private async hasBlob(hash: string): Promise<boolean> {
    const info = await lstat(this.blobPath(hash)).catch(() => undefined);
    return info?.isFile() ?? false;
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

  private async putBlob(hash: string, bytes: Uint8Array): Promise<void> {
    const path = this.blobPath(hash);
    await this.ensureDir(join(this.dir, 'blobs', hash.slice(0, 2)));
    await this.writeAtomic(path, bytes, false);
  }

  /** Writes through a fresh file in `tmp/`, renamed into place, inside the root only */
  private async writeAtomic(path: string, bytes: Uint8Array, sync: boolean): Promise<void> {
    const temp = join(this.dir, 'tmp', `${nanoid(16)}.part`);
    await this.ensureDir(join(this.dir, 'tmp'));
    let handle: FileHandle | undefined = await open(
      temp,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | O_NOFOLLOW,
      0o644
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
      if (sync) await handle.sync();
      await handle.close();
      handle = undefined;
      await this.verifyDir();
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

  /** Creates the store's directories, refusing any that resolves outside the root */
  private async prepare(): Promise<void> {
    await this.ensureDir(join(this.dir, 'manifests'));
    await this.ensureDir(join(this.dir, 'blobs'));
    await this.ensureDir(join(this.dir, 'tmp'));
  }

  private async ensureDir(dir: string): Promise<void> {
    await mkdir(dir, { recursive: true }).catch((error: unknown) => {
      throw ioError(error, WORKSPACE_CHECKPOINTS_DIR);
    });
    const real = await realpath(dir).catch((error: unknown) => {
      throw ioError(error, WORKSPACE_CHECKPOINTS_DIR);
    });
    if (real !== dir) {
      throw new WorkspaceError(
        'OUTSIDE_ROOT',
        `${WORKSPACE_CHECKPOINTS_DIR} resolves outside the workspace: a symlink was put in its place`,
        { path: WORKSPACE_CHECKPOINTS_DIR }
      );
    }
  }

  /** Throws when the store's directory is not itself, a real directory inside the root */
  private async verifyDir(): Promise<void> {
    const real = await realpath(this.dir).catch((error: unknown) => {
      throw ioError(error, WORKSPACE_CHECKPOINTS_DIR);
    });
    if (real !== this.dir) {
      throw new WorkspaceError(
        'OUTSIDE_ROOT',
        `${WORKSPACE_CHECKPOINTS_DIR} resolves outside the workspace: a symlink was put in its place`,
        { path: WORKSPACE_CHECKPOINTS_DIR }
      );
    }
  }

  private absolute(rel: string): string {
    return rel === '' ? this.root : join(this.root, ...rel.split('/'));
  }

  /** The names in a directory, sorted, once it is checked to be itself inside the root */
  private async readDirectory(absolute: string, rel: string): Promise<string[]> {
    const real = await realpath(absolute).catch(() => undefined);
    if (real !== absolute) {
      if (rel === '') throw new WorkspaceError('NOT_FOUND', `The root ${this.root} is gone`);
      return [];
    }
    const names = await readdir(absolute).catch(() => []);
    return names.sort();
  }

  /**
   * Reads a regular file without following a symlink in its place, checked to be the entry `seen`
   * and to sit in its own directory still. A file that changes while it is read is read again,
   * the last read is kept with `racy` when it never held still
   */
  private async readFileAt(
    absolute: string,
    seen: Stats,
    maxBytes: number
  ): Promise<{ bytes: Buffer; info: Stats; racy: boolean } | 'too-large' | undefined> {
    let last: { bytes: Buffer; info: Stats } | undefined;
    for (let attempt = 0; attempt < READ_ATTEMPTS; attempt++) {
      const handle = await open(absolute, constants.O_RDONLY | O_NOFOLLOW | O_NONBLOCK).catch(
        () => undefined
      );
      if (!handle) return undefined;
      try {
        const before = await handle.stat();
        if (!before.isFile() || before.dev !== seen.dev || before.ino !== seen.ino)
          return undefined;
        const parent = dirname(absolute);
        if ((await realpath(parent).catch(() => undefined)) !== parent) return undefined;
        if (before.size > maxBytes) return 'too-large';
        const bytes = await readAll(handle, maxBytes);
        if (bytes === 'too-large') return 'too-large';
        const after = await handle.stat();
        last = { bytes, info: before };
        if (
          after.size === before.size &&
          after.mtimeMs === before.mtimeMs &&
          after.ctimeMs === before.ctimeMs &&
          bytes.byteLength === before.size
        ) {
          return { bytes, info: before, racy: false };
        }
      } finally {
        await handle.close().catch(() => undefined);
      }
    }
    return last ? { ...last, racy: true } : undefined;
  }

  /** The sha256 of a file now, undefined when it cannot be read */
  private async hashOf(absolute: string, seen: Stats): Promise<string | undefined> {
    const read = await this.readFileAt(absolute, seen, Number.MAX_SAFE_INTEGER);
    return read && read !== 'too-large' ? sha256(read.bytes) : undefined;
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
    stats: manifest.stats,
  };
}

/** A new snapshot id, ordered by time: `snap_<time>_<random>` */
export function snapshotId(): string {
  return `snap_${Date.now().toString(36)}_${nanoid(8).replace(/[^A-Za-z0-9]/g, 'x')}`;
}

function underAny(path: string, dirs: ReadonlySet<string>): boolean {
  for (const dir of dirs) if (path.startsWith(`${dir}/`)) return true;
  return false;
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

/** The directories `path` is in, nearest first, the root left out */
function ancestorsOf(path: string): string[] {
  const dirs: string[] = [];
  for (let at = path.lastIndexOf('/'); at > 0; at = path.lastIndexOf('/', at - 1)) {
    dirs.push(path.slice(0, at));
  }
  return dirs;
}

function depth(path: string): number {
  let count = 0;
  for (const char of path) if (char === '/') count++;
  return count;
}

function sha256(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

async function readAll(handle: FileHandle, maxBytes: number): Promise<Buffer | 'too-large'> {
  const chunks: Buffer[] = [];
  let total = 0;
  for (;;) {
    const buffer = Buffer.allocUnsafe(64 * 1024);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, total);
    if (bytesRead === 0) break;
    chunks.push(buffer.subarray(0, bytesRead));
    total += bytesRead;
    if (total > maxBytes) return 'too-large';
  }
  return Buffer.concat(chunks, total);
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
