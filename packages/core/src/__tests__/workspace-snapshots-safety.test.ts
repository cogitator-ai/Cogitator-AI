import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  symlinkSync,
  truncateSync,
  unlinkSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { WorkspaceError, type WorkspaceErrorCode } from '@cogitator-ai/types';
import { LocalWorkspace } from '../workspace/local-workspace';
import { SnapshotStore, WORKSPACE_CHECKPOINTS_DIR } from '../workspace/snapshot-store';

const asRoot = process.getuid?.() === 0;

let base: string;
let root: string;
let store: string;
let workspace: LocalWorkspace;

beforeEach(async () => {
  base = realpathSync(mkdtempSync(join(tmpdir(), 'snapshot-safety-')));
  root = join(base, 'root');
  store = join(root, ...WORKSPACE_CHECKPOINTS_DIR.split('/'));
  workspace = new LocalWorkspace({ root, snapshots: { gcGraceMs: 0 } });
  await workspace.start();
});

afterEach(async () => {
  vi.restoreAllMocks();
  await workspace.dispose();
  for (const dir of walkDirs(base)) chmodSync(dir, 0o755);
  rmSync(base, { recursive: true, force: true });
});

function walkDirs(dir: string): string[] {
  const found: string[] = [dir];
  let names: string[];
  try {
    chmodSync(dir, 0o755);
    names = readdirSync(dir);
  } catch {
    return found;
  }
  for (const name of names) {
    const full = join(dir, name);
    const info = lstatSync(full);
    if (info.isDirectory()) found.push(...walkDirs(full));
    else if (info.isFile()) chmodSync(full, 0o644);
  }
  return found;
}

function put(path: string, content: string | Buffer): void {
  const full = join(root, path);
  mkdirSync(join(full, '..'), { recursive: true });
  writeFileSync(full, content);
}

function text(path: string): string {
  return readFileSync(join(root, path), 'utf8');
}

function blobFiles(): string[] {
  const blobs = join(store, 'blobs');
  return readdirSync(blobs).flatMap((shard) =>
    readdirSync(join(blobs, shard)).map((rest) => join(blobs, shard, rest))
  );
}

/** Every path under the root but the store, with what it holds */
function tree(at = root): Map<string, string> {
  const found = new Map<string, string>();
  const walk = (dir: string): void => {
    for (const name of readdirSync(dir).sort()) {
      const full = join(dir, name);
      const path = relative(at, full).split('\\').join('/');
      if (path === '.cogitator' || path.startsWith('.cogitator/')) continue;
      const info = lstatSync(full);
      if (info.isDirectory()) {
        found.set(path, 'dir');
        walk(full);
      } else if (info.isSymbolicLink()) {
        found.set(path, 'link');
      } else {
        found.set(path, readFileSync(full, 'utf8'));
      }
    }
  };
  walk(at);
  return found;
}

async function expectCode(promise: Promise<unknown>, code: WorkspaceErrorCode): Promise<void> {
  const error = await promise.then(
    () => undefined,
    (thrown: unknown) => thrown
  );
  expect(WorkspaceError.is(error, code), `expected ${code}, got ${String(error)}`).toBe(true);
}

describe('snapshot store safety', () => {
  it('never sweeps through a symlink put in place of tmp or of a blob shard', async () => {
    const outside = join(base, 'outside');
    mkdirSync(outside);
    const old = new Date(Date.now() - 3 * 3600_000);
    for (const name of ['thesis.docx', 'aaaaaaaaaaaaaaaa.part', `${'b'.repeat(62)}`]) {
      writeFileSync(join(outside, name), 'not yours');
      utimesSync(join(outside, name), old, old);
    }
    put('a.txt', 'a');
    await workspace.snapshot();
    rmSync(join(store, 'tmp'), { recursive: true });
    symlinkSync(outside, join(store, 'tmp'));
    symlinkSync(outside, join(store, 'blobs', 'ff'));
    await workspace.pruneSnapshots({}).catch(() => undefined);
    await workspace.deleteSnapshot('snap_nope_12345678').catch(() => undefined);
    expect(readdirSync(outside).sort()).toEqual(
      ['aaaaaaaaaaaaaaaa.part', 'b'.repeat(62), 'thesis.docx'].sort()
    );
  });

  it('keeps a file named __proto__ and other names objects know', async () => {
    for (const name of ['__proto__', 'constructor', 'hasOwnProperty', 'toString']) {
      put(name, `precious ${name}`);
      put(`dir/${name}`, `nested ${name}`);
    }
    const snapshot = await workspace.snapshot();
    expect(snapshot.stats?.files).toBe(8);
    const plan = await workspace.restore(snapshot.id, { dryRun: true });
    expect(plan.deleted).toEqual([]);
    expect(plan.restored).toEqual([]);
    put('__proto__', 'changed');
    await workspace.restore(snapshot.id);
    expect(text('__proto__')).toBe('precious __proto__');
    expect(text('dir/__proto__')).toBe('nested __proto__');
  });

  it('leaves the sweep for later while another process works on the store', async () => {
    put('a.txt', 'one');
    const first = await workspace.snapshot();
    put('a.txt', 'two');
    await workspace.snapshot();
    const marker = join(store, 'locks', 'abcdefghijklmnop.active');
    writeFileSync(marker, '');
    const before = blobFiles().length;
    await workspace.deleteSnapshot(first.id);
    expect(blobFiles().length).toBe(before);
    const deferred = await workspace.pruneSnapshots({});
    expect(deferred.gc.deferred).toBe(true);
    unlinkSync(marker);
    const swept = await workspace.pruneSnapshots({});
    expect(swept.gc).toMatchObject({ deferred: false });
    expect(blobFiles().length).toBeLessThan(before);
  });

  it('keeps the blobs a snapshot of another process reuses while a collection runs', async () => {
    put('src/keep.ts', 'export const x = 1;\n');
    const old = new Date(Date.now() - 2 * 3600_000);
    utimesSync(join(root, 'src/keep.ts'), old, old);
    const a = SnapshotStore.detached(root);
    const b = SnapshotStore.detached(root);
    await a.take({ workspaceId: 'a' });
    for (const blob of blobFiles()) utimesSync(blob, old, old);
    const patched = b as unknown as { writeManifest(manifest: unknown): Promise<void> };
    const write = patched.writeManifest.bind(b);
    let pruned: { gc: { deferred: boolean } } | undefined;
    patched.writeManifest = async (manifest) => {
      pruned = await a.prune({ count: 0 }, 3600_000);
      return write(manifest);
    };
    const second = await b.take({ workspaceId: 'b' });
    expect(pruned?.gc.deferred).toBe(true);
    put('src/keep.ts', 'changed');
    await workspace.restore(second.id);
    expect(text('src/keep.ts')).toBe('export const x = 1;\n');
  });

  it('waits for a collection of another process before it takes a snapshot', async () => {
    put('a.txt', 'one');
    await workspace.snapshot();
    const lock = join(store, 'locks', 'gc.lock');
    writeFileSync(lock, '');
    let done = false;
    const taking = workspace.snapshot().then(() => {
      done = true;
    });
    await new Promise((resolve) => setTimeout(resolve, 150));
    expect(done).toBe(false);
    unlinkSync(lock);
    await taking;
    expect(done).toBe(true);
  });

  it('collects past a broken manifest, and a failed retention does not fail a snapshot', async () => {
    put('a.txt', 'one');
    const broken = await workspace.snapshot();
    put('a.txt', 'two');
    await workspace.snapshot();
    const manifest = JSON.parse(
      readFileSync(join(store, 'manifests', `${broken.id}.json`), 'utf8')
    ) as { tree: string };
    rmSync(join(store, 'blobs', manifest.tree.slice(0, 2), manifest.tree.slice(2)));
    const gc = await SnapshotStore.detached(root).gc(0);
    expect(gc.unreadable).toEqual([broken.id]);
    writeFileSync(join(store, 'manifests', 'snap_zz_brokenxx.json'), '{ not json');

    const retained = new LocalWorkspace({ root, snapshots: { retain: { count: 10 } } });
    const prune = vi.spyOn(retained, 'pruneSnapshots').mockRejectedValue(new Error('disk on fire'));
    put('new.txt', 'new');
    const kept = await retained.snapshot();
    expect(prune).toHaveBeenCalled();
    expect((await retained.listSnapshots()).map((each) => each.id)).toContain(kept.id);
    await retained.dispose();
  });

  it('settles every read of a snapshot that fails before it gives up', async () => {
    const unhandled: unknown[] = [];
    const listener = (reason: unknown) => unhandled.push(reason);
    process.on('unhandledRejection', listener);
    try {
      await workspace.snapshot();
      for (let i = 0; i < 20; i++) put(`a${i}.txt`, `content ${i} ${Math.random()}`);
      put('sub/b.txt', `b ${Math.random()}`);
      let running = 0;
      let finishedAfterFailure = 0;
      let failed = false;
      const failing = vi
        .spyOn(SnapshotStore.prototype as unknown as { storeFile(): Promise<never> }, 'storeFile')
        .mockImplementation(async () => {
          running++;
          await new Promise((resolve) => setTimeout(resolve, 5 + Math.random() * 30));
          running--;
          if (failed) finishedAfterFailure++;
          failed = true;
          throw new WorkspaceError('IO', 'the disk is full');
        });
      await expect(workspace.snapshot()).rejects.toThrow('the disk is full');
      expect(running).toBe(0);
      const settledAt = finishedAfterFailure;
      await new Promise((resolve) => setTimeout(resolve, 200));
      expect(unhandled).toEqual([]);
      expect(finishedAfterFailure).toBe(settledAt);
      failing.mockRestore();
      await expect(workspace.snapshot()).resolves.toMatchObject({ stats: { files: 21 } });
    } finally {
      process.off('unhandledRejection', listener);
    }
  });

  it('copies snapshots both ways at once without waiting for each other forever', async () => {
    const other = new LocalWorkspace({ root: join(base, 'other') });
    try {
      await other.start();
      put('a.txt', 'a');
      writeFileSync(join(base, 'other', 'b.txt'), 'b');
      const a = await workspace.snapshot();
      const b = await other.snapshot();
      const both = Promise.all([
        workspace.copySnapshot(a.id, other),
        other.copySnapshot(b.id, workspace),
      ]);
      const timeout = new Promise<'timeout'>((resolve) =>
        setTimeout(() => resolve('timeout'), 5000)
      );
      expect(await Promise.race([both.then(() => 'copied'), timeout])).toBe('copied');
      expect((await workspace.listSnapshots()).map((each) => each.id).sort()).toEqual(
        [a.id, b.id].sort()
      );
    } finally {
      await other.dispose();
    }
  });

  it('protects what an unreadable directory held, and refuses to write into one', async () => {
    if (asRoot) return;
    put('locked/secret.txt', 'secret');
    put('plain.txt', 'plain');
    chmodSync(join(root, 'locked'), 0o000);
    const snapshot = await workspace.snapshot();
    expect(snapshot.skipped).toEqual([{ path: 'locked', reason: 'unreadable' }]);
    chmodSync(join(root, 'locked'), 0o755);
    put('plain.txt', 'changed');
    const result = await workspace.restore(snapshot.id);
    expect(result.kept).toEqual(['locked']);
    expect(text('locked/secret.txt')).toBe('secret');
    expect(text('plain.txt')).toBe('plain');

    put('open/inside.txt', 'inside');
    const withOpen = await workspace.snapshot();
    chmodSync(join(root, 'open'), 0o000);
    put('plain.txt', 'again');
    await expectCode(workspace.restore(withOpen.id), 'DENIED');
    expect(text('plain.txt')).toBe('again');
    chmodSync(join(root, 'open'), 0o755);
    put('extra/stuff.txt', 'stuff');
    chmodSync(join(root, 'extra'), 0o000);
    const kept = await workspace.restore(withOpen.id);
    expect(kept.kept).toContain('extra');
    chmodSync(join(root, 'extra'), 0o755);
    expect(text('extra/stuff.txt')).toBe('stuff');
  });

  it('keeps the store for its owner only', async () => {
    put('.env', 'SECRET=1');
    chmodSync(join(root, '.env'), 0o600);
    await workspace.snapshot();
    for (const dir of ['', 'blobs', 'manifests', 'tmp', 'locks']) {
      expect(statSync(join(store, dir)).mode & 0o777, dir).toBe(0o700);
    }
    for (const blob of blobFiles()) expect(statSync(blob).mode & 0o777).toBe(0o600);
    for (const name of readdirSync(join(store, 'manifests'))) {
      expect(statSync(join(store, 'manifests', name)).mode & 0o777).toBe(0o600);
    }
  });

  it('keeps present files the snapshot could not have kept', async () => {
    const limited = new LocalWorkspace({ root, snapshots: { maxFileBytes: 1024 } });
    try {
      put('p', 'p was a file');
      const snapshot = await limited.snapshot();
      put('dataset.bin', Buffer.alloc(4096, 1));
      put('unreadable.txt', 'mine');
      if (!asRoot) chmodSync(join(root, 'unreadable.txt'), 0o000);
      const result = await limited.restore(snapshot.id);
      expect(result.kept).toEqual(asRoot ? ['dataset.bin'] : ['dataset.bin', 'unreadable.txt']);
      expect(existsSync(join(root, 'dataset.bin'))).toBe(true);
      expect(existsSync(join(root, 'unreadable.txt'))).toBe(asRoot ? false : true);
    } finally {
      await limited.dispose();
    }
  });

  it('reports on a dry run exactly what the restore then changes', async () => {
    const fixtures: Array<[before: () => void, after: () => void]> = [
      [
        () => put('p', 'file'),
        () => {
          rmSync(join(root, 'p'));
          put('p/notes.md', 'work');
          put('p/deep/more.md', 'more');
        },
      ],
      [
        () => put('d/inner.txt', 'inner'),
        () => {
          rmSync(join(root, 'd'), { recursive: true });
          put('d', 'now a file');
          put('new/a.txt', 'a');
          put('kept/node_modules/x.js', 'x');
          put('kept/y.txt', 'y');
        },
      ],
      [
        () => {
          put('link-target.txt', 't');
          symlinkSync('link-target.txt', join(root, 'link'));
        },
        () => {
          unlinkSync(join(root, 'link'));
          mkdirSync(join(root, 'link'));
          put('link/in.txt', 'in');
          put('link-target.txt', 'changed');
        },
      ],
    ];
    for (const [before, after] of fixtures) {
      rmSync(root, { recursive: true, force: true });
      mkdirSync(root, { recursive: true });
      await workspace.dispose();
      workspace = new LocalWorkspace({ root, snapshots: { gcGraceMs: 0 } });
      before();
      const snapshot = await workspace.snapshot();
      after();
      const was = tree();
      const plan = await workspace.restore(snapshot.id, { dryRun: true });
      const done = await workspace.restore(snapshot.id);
      expect({ ...done, dryRun: true, busy: false }).toEqual(plan);
      const now = tree();
      const gone = [...was.keys()].filter(
        (path) => !now.has(path) || (was.get(path) === 'dir') !== (now.get(path) === 'dir')
      );
      const goneNotRestored = gone.filter((path) => !done.restored.includes(path));
      expect(goneNotRestored.sort()).toEqual(
        done.deleted.filter((path) => !done.restored.includes(path)).sort()
      );
      for (const path of done.deleted) {
        expect(now.has(path) && !done.restored.includes(path), path).toBe(false);
      }
    }
  });

  it('reads a file again when its stored content was cut short, and refuses to restore from it', async () => {
    put('a.txt', 'a'.repeat(1000));
    const old = new Date(Date.now() - 3600_000);
    utimesSync(join(root, 'a.txt'), old, old);
    vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 60_000);
    const first = await workspace.snapshot();
    const blob = blobFiles().find((path) => statSync(path).size === 1000)!;
    truncateSync(blob, 10);
    await expectCode(workspace.restore(first.id), 'IO');
    const second = await workspace.snapshot();
    expect(second.stats).toMatchObject({ hashed: 1, reused: 0 });
    expect(statSync(blob).size).toBe(1000);
    put('a.txt', 'changed');
    await workspace.restore(second.id);
    expect(text('a.txt')).toBe('a'.repeat(1000));
  });

  it('lets go of a store once every workspace over its root is disposed', async () => {
    const held = SnapshotStore.held;
    const extra = new LocalWorkspace({ root: join(base, 'extra') });
    await extra.snapshot();
    expect(SnapshotStore.held).toBe(held + 1);
    const view = extra.withCwd('.');
    await view.listSnapshots();
    expect(SnapshotStore.held).toBe(held + 1);
    await extra.dispose();
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(SnapshotStore.held).toBe(held);
  });

  it('never gives up the default excludes for a manifest that leaves them out', async () => {
    put('a.txt', 'one');
    put('.cogitator/tool-results/r/1.txt', 'result');
    const snapshot = await workspace.snapshot();
    const path = join(store, 'manifests', `${snapshot.id}.json`);
    const manifest = JSON.parse(readFileSync(path, 'utf8')) as { exclude: string[] };
    manifest.exclude = [];
    chmodSync(path, 0o600);
    writeFileSync(path, JSON.stringify(manifest));
    put('a.txt', 'two');
    await workspace.restore(snapshot.id);
    expect(text('a.txt')).toBe('one');
    expect(text('.cogitator/tool-results/r/1.txt')).toBe('result');
    expect((await workspace.listSnapshots()).map((each) => each.id)).toEqual([snapshot.id]);
  });

  it('hashes a large file a chunk at a time', async () => {
    const big = Buffer.alloc(3 * 1024 * 1024 + 17);
    for (let i = 0; i < big.length; i++) big[i] = i % 251;
    put('big.bin', big);
    const snapshot = await workspace.snapshot();
    expect(snapshot.stats?.bytes).toBe(big.length);
    put('big.bin', 'small now');
    await workspace.restore(snapshot.id);
    expect(readFileSync(join(root, 'big.bin')).equals(big)).toBe(true);
    expect(readdirSync(join(store, 'tmp'))).toEqual([]);
  });

  it('refuses a store swapped for a symlink in every operation', async () => {
    put('a.txt', 'one');
    const snapshot = await workspace.snapshot();
    const elsewhere = join(base, 'elsewhere');
    renameSync(store, elsewhere);
    symlinkSync(elsewhere, store);
    await expectCode(workspace.restore(snapshot.id), 'OUTSIDE_ROOT');
    await expectCode(workspace.deleteSnapshot(snapshot.id), 'OUTSIDE_ROOT');
    await expectCode(workspace.pruneSnapshots({}), 'OUTSIDE_ROOT');
    expect(readdirSync(join(elsewhere, 'manifests'))).toHaveLength(1);
  });
});
