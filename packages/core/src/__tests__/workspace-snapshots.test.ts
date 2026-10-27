import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { WorkspaceError, type WorkspaceErrorCode } from '@cogitator-ai/types';
import { LocalWorkspace } from '../workspace/local-workspace';
import { WORKSPACE_CHECKPOINTS_DIR } from '../workspace/snapshot-store';

let base: string;
let root: string;
let workspace: LocalWorkspace;

beforeEach(async () => {
  base = realpathSync(mkdtempSync(join(tmpdir(), 'workspace-snapshots-')));
  root = join(base, 'root');
  workspace = new LocalWorkspace({ root, snapshots: { gcGraceMs: 0 } });
  await workspace.start();
});

afterEach(async () => {
  vi.restoreAllMocks();
  await workspace.dispose();
  rmSync(base, { recursive: true, force: true });
});

function put(path: string, content: string | Buffer): void {
  const full = join(root, path);
  mkdirSync(join(full, '..'), { recursive: true });
  writeFileSync(full, content);
}

function text(path: string): string {
  return readFileSync(join(root, path), 'utf8');
}

function blobs(dir = root): string[] {
  const store = join(dir, ...WORKSPACE_CHECKPOINTS_DIR.split('/'), 'blobs');
  if (!existsSync(store)) return [];
  return readdirSync(store).flatMap((shard) =>
    readdirSync(join(store, shard)).map((rest) => `${shard}${rest}`)
  );
}

/** Moves the clock the snapshots read ahead, so files written by the test are not racy */
function later(ms = 60_000): void {
  const now = Date.now();
  vi.spyOn(Date, 'now').mockReturnValue(now + ms);
}

async function expectCode(promise: Promise<unknown>, code: WorkspaceErrorCode): Promise<void> {
  const error = await promise.then(
    () => undefined,
    (thrown: unknown) => thrown
  );
  expect(WorkspaceError.is(error, code), `expected ${code}, got ${String(error)}`).toBe(true);
}

describe('LocalWorkspace snapshots', () => {
  it('brings back modified, deleted, new and renamed files', async () => {
    put('src/a.ts', 'export const a = 1;\n');
    put('src/b.ts', 'export const b = 2;\n');
    put('README.md', '# readme\n');
    const snapshot = await workspace.snapshot({ label: 'entry_1' });
    expect(snapshot).toMatchObject({ workspaceId: workspace.id, label: 'entry_1' });

    put('src/a.ts', 'export const a = 42;\n');
    unlinkSync(join(root, 'README.md'));
    put('src/c.ts', 'export const c = 3;\n');
    renameSync(join(root, 'src/b.ts'), join(root, 'src/renamed.ts'));
    put('new/deep/file.txt', 'deep');

    const result = await workspace.restore(snapshot.id);
    expect(result.dryRun).toBe(false);
    expect(result.restored).toEqual(['README.md', 'src/a.ts', 'src/b.ts']);
    expect(result.deleted).toEqual([
      'new',
      'new/deep',
      'new/deep/file.txt',
      'src/c.ts',
      'src/renamed.ts',
    ]);
    expect(text('src/a.ts')).toBe('export const a = 1;\n');
    expect(text('src/b.ts')).toBe('export const b = 2;\n');
    expect(text('README.md')).toBe('# readme\n');
    expect(existsSync(join(root, 'src/c.ts'))).toBe(false);
    expect(existsSync(join(root, 'src/renamed.ts'))).toBe(false);
    expect(existsSync(join(root, 'new'))).toBe(false);

    const again = await workspace.restore(snapshot.id);
    expect(again.restored).toEqual([]);
    expect(again.deleted).toEqual([]);
    expect(again.unchanged).toBeGreaterThan(0);
  });

  it('says what a restore would change without changing anything on a dry run', async () => {
    put('a.txt', 'one');
    const snapshot = await workspace.snapshot();
    put('a.txt', 'two');
    put('b.txt', 'new');
    const plan = await workspace.restore(snapshot.id, { dryRun: true });
    expect(plan).toMatchObject({ dryRun: true, restored: ['a.txt'], deleted: ['b.txt'] });
    expect(text('a.txt')).toBe('two');
    expect(text('b.txt')).toBe('new');
  });

  it('keeps file modes and directory modes', async () => {
    put('bin/run.sh', '#!/bin/sh\necho hi\n');
    chmodSync(join(root, 'bin/run.sh'), 0o755);
    put('secret.txt', 'x');
    chmodSync(join(root, 'secret.txt'), 0o600);
    mkdirSync(join(root, 'private'));
    chmodSync(join(root, 'private'), 0o700);
    const snapshot = await workspace.snapshot();

    chmodSync(join(root, 'bin/run.sh'), 0o644);
    rmSync(join(root, 'secret.txt'));
    chmodSync(join(root, 'private'), 0o755);
    const result = await workspace.restore(snapshot.id);
    expect(result.restored).toEqual(['bin/run.sh', 'private', 'secret.txt']);
    expect(statSync(join(root, 'bin/run.sh')).mode & 0o777).toBe(0o755);
    expect(statSync(join(root, 'secret.txt')).mode & 0o777).toBe(0o600);
    expect(statSync(join(root, 'private')).mode & 0o777).toBe(0o700);
  });

  it('records symlinks as links and never follows them out of the root', async () => {
    const outside = join(base, 'outside');
    mkdirSync(outside);
    writeFileSync(join(outside, 'secret.txt'), 'top secret');
    put('real.txt', 'real');
    symlinkSync('real.txt', join(root, 'inside-link'));
    symlinkSync(outside, join(root, 'outside-link'));
    const snapshot = await workspace.snapshot();
    expect(snapshot.stats?.files).toBe(1);

    unlinkSync(join(root, 'inside-link'));
    put('inside-link', 'now a file');
    unlinkSync(join(root, 'outside-link'));
    symlinkSync('real.txt', join(root, 'outside-link'));
    writeFileSync(join(outside, 'secret.txt'), 'changed outside');

    const result = await workspace.restore(snapshot.id);
    expect(result.restored).toEqual(['inside-link', 'outside-link']);
    expect(lstatSync(join(root, 'inside-link')).isSymbolicLink()).toBe(true);
    expect(readlinkSync(join(root, 'inside-link'))).toBe('real.txt');
    expect(readlinkSync(join(root, 'outside-link'))).toBe(outside);
    expect(readFileSync(join(outside, 'secret.txt'), 'utf8')).toBe('changed outside');
  });

  it('leaves the default excludes and its own excludes out and alone', async () => {
    put('src/index.ts', 'one');
    put('node_modules/dep/index.js', 'dep');
    put('packages/app/node_modules/dep/index.js', 'nested dep');
    put('.git/HEAD', 'ref: refs/heads/main');
    put('dist/out.js', 'built');
    const snapshot = await workspace.snapshot({ exclude: ['dist/**'] });
    expect(snapshot.exclude).toEqual(
      expect.arrayContaining(['.cogitator/**', '**/node_modules/**', '**/.git/**', 'dist/**'])
    );
    expect(snapshot.stats?.files).toBe(1);

    put('node_modules/dep/index.js', 'dep 2');
    put('node_modules/other/index.js', 'other');
    put('.git/HEAD', 'ref: refs/heads/feature');
    put('dist/out.js', 'built 2');
    put('dist/more.js', 'more');
    rmSync(join(root, 'packages/app/node_modules'), { recursive: true });
    put('fresh/node_modules/x.js', 'x');

    const result = await workspace.restore(snapshot.id);
    expect(result.deleted).toEqual([]);
    expect(result.kept).toEqual(['fresh']);
    expect(text('node_modules/dep/index.js')).toBe('dep 2');
    expect(text('.git/HEAD')).toBe('ref: refs/heads/feature');
    expect(text('dist/more.js')).toBe('more');
    expect(existsSync(join(root, 'packages/app/node_modules'))).toBe(false);
    expect(text('fresh/node_modules/x.js')).toBe('x');
  });

  it('takes excludes from its config', async () => {
    const configured = new LocalWorkspace({ root, snapshots: { exclude: ['*.log'] } });
    put('app.log', 'noise');
    put('app.ts', 'code');
    const snapshot = await configured.snapshot();
    expect(snapshot.exclude).toContain('*.log');
    put('app.log', 'more noise');
    unlinkSync(join(root, 'app.ts'));
    await configured.restore(snapshot.id);
    expect(text('app.log')).toBe('more noise');
    expect(text('app.ts')).toBe('code');
  });

  it('skips files over the size limit and leaves them alone on restore', async () => {
    put('big.bin', Buffer.alloc(2048, 1));
    put('small.txt', 'small');
    const snapshot = await workspace.snapshot({ maxFileBytes: 1024 });
    expect(snapshot.skipped).toEqual([{ path: 'big.bin', reason: 'too-large', size: 2048 }]);

    put('big.bin', Buffer.alloc(4096, 2));
    put('small.txt', 'changed');
    const result = await workspace.restore(snapshot.id);
    expect(result.kept).toEqual(['big.bin']);
    expect(readFileSync(join(root, 'big.bin')).byteLength).toBe(4096);
    expect(text('small.txt')).toBe('small');
  });

  it('turns a directory back into a file and a file back into a directory', async () => {
    put('was-file', 'file');
    put('was-dir/inner.txt', 'inner');
    const snapshot = await workspace.snapshot();
    rmSync(join(root, 'was-file'));
    put('was-file/now.txt', 'now a dir');
    rmSync(join(root, 'was-dir'), { recursive: true });
    put('was-dir', 'now a file');

    await workspace.restore(snapshot.id);
    expect(text('was-file')).toBe('file');
    expect(text('was-dir/inner.txt')).toBe('inner');
  });

  it('brings back empty directories and removes new ones', async () => {
    mkdirSync(join(root, 'empty'));
    const snapshot = await workspace.snapshot();
    rmSync(join(root, 'empty'), { recursive: true });
    mkdirSync(join(root, 'other/nested'), { recursive: true });
    const result = await workspace.restore(snapshot.id);
    expect(result.restored).toEqual(['empty']);
    expect(result.deleted).toEqual(['other', 'other/nested']);
    expect(statSync(join(root, 'empty')).isDirectory()).toBe(true);
    expect(existsSync(join(root, 'other'))).toBe(false);
  });

  it('stores a content once across snapshots and files', async () => {
    put('a.txt', 'same content');
    put('b.txt', 'same content');
    const first = await workspace.snapshot();
    const afterFirst = blobs().length;
    const second = await workspace.snapshot();
    expect(blobs().length).toBe(afterFirst);
    expect(second.stats?.storedBytes).toBe(0);
    expect(first.stats?.files).toBe(2);
    put('c.txt', 'same content');
    const third = await workspace.snapshot();
    expect(third.stats?.storedBytes).toBeGreaterThan(0);
    expect(blobs().length).toBe(afterFirst + 1);
  });

  it('does not read unchanged files again in a large tree', async () => {
    for (let dir = 0; dir < 40; dir++) {
      for (let file = 0; file < 50; file++)
        put(`pkg${dir}/file${file}.ts`, `export const v = ${dir * 100 + file};\n`);
    }
    later();
    const first = await workspace.snapshot();
    expect(first.stats).toMatchObject({ files: 2000, hashed: 2000, reused: 0 });

    put('pkg7/file3.ts', 'export const v = -1;\n');
    const second = await workspace.snapshot();
    expect(second.stats).toMatchObject({ files: 2000, hashed: 1, reused: 1999 });
    const third = await workspace.snapshot();
    expect(third.stats?.hashed).toBeLessThanOrEqual(1);
    expect(third.stats?.storedBytes).toBe(0);
  });

  it('reads files again when the snapshot before went away behind its back', async () => {
    put('a.txt', 'one');
    put('b.txt', 'two');
    later();
    await workspace.snapshot();
    rmSync(join(root, ...WORKSPACE_CHECKPOINTS_DIR.split('/'), 'manifests'), { recursive: true });
    rmSync(join(root, ...WORKSPACE_CHECKPOINTS_DIR.split('/'), 'blobs'), { recursive: true });
    const again = await workspace.snapshot();
    expect(again.stats).toMatchObject({ hashed: 2, reused: 0 });
    put('a.txt', 'changed');
    await workspace.restore(again.id);
    expect(text('a.txt')).toBe('one');
  });

  it('reads a file again when its times are too close to the snapshot to trust', async () => {
    put('hot.txt', 'v1');
    const first = await workspace.snapshot();
    expect(first.stats?.hashed).toBe(1);
    const second = await workspace.snapshot();
    expect(second.stats?.hashed).toBe(1);
  });

  it('records a whole version of a file that changes while it is read, or skips it as changing', async () => {
    put('busy.txt', 'a'.repeat(100_000));
    let writes = 0;
    const writer = setInterval(() => {
      writes++;
      writeFileSync(join(root, 'busy.txt'), (writes % 2 ? 'b' : 'c').repeat(100_000));
    }, 1);
    try {
      const snapshot = await workspace.snapshot();
      clearInterval(writer);
      writeFileSync(join(root, 'busy.txt'), 'final');
      const result = await workspace.restore(snapshot.id);
      const back = text('busy.txt');
      if (snapshot.skipped?.some((skip) => skip.path === 'busy.txt')) {
        expect(snapshot.skipped).toEqual([{ path: 'busy.txt', reason: 'changing', size: 100_000 }]);
        expect(result.kept).toEqual(['busy.txt']);
        expect(back).toBe('final');
      } else {
        expect(back.length).toBe(100_000);
        expect(new Set(back).size).toBe(1);
      }
    } finally {
      clearInterval(writer);
    }
  });

  it('runs snapshots and restores of one root one at a time', async () => {
    put('a.txt', 'one');
    const views = [workspace, workspace.withRoot(root), workspace.withCwd('.')];
    const snapshots = await Promise.all(views.map((view) => view.snapshot()));
    expect(new Set(snapshots.map((snapshot) => snapshot.id)).size).toBe(3);
    const listed = await workspace.listSnapshots();
    expect(listed.map((snapshot) => snapshot.id).sort()).toEqual(
      snapshots.map((snapshot) => snapshot.id).sort()
    );
    expect(listed.map((snapshot) => snapshot.stats?.files)).toEqual([1, 1, 1]);
  });

  it('lists snapshots oldest first and forgets deleted ones', async () => {
    put('a.txt', '1');
    const first = await workspace.snapshot();
    put('a.txt', '2');
    const second = await workspace.snapshot();
    expect((await workspace.listSnapshots()).map((snapshot) => snapshot.id)).toEqual([
      first.id,
      second.id,
    ]);
    await workspace.deleteSnapshot(first.id);
    expect((await workspace.listSnapshots()).map((snapshot) => snapshot.id)).toEqual([second.id]);
    await expectCode(workspace.restore(first.id), 'NOT_FOUND');
    await expectCode(workspace.deleteSnapshot(first.id), 'NOT_FOUND');
    await expectCode(workspace.restore('../../etc/passwd'), 'NOT_FOUND');
  });

  it('frees the contents only a deleted snapshot used and keeps shared ones', async () => {
    put('shared.txt', 'shared');
    put('a.txt', 'only in the first');
    const first = await workspace.snapshot();
    put('a.txt', 'only in the second');
    const second = await workspace.snapshot();
    const before = blobs().length;
    await workspace.deleteSnapshot(first.id);
    expect(blobs().length).toBeLessThan(before);
    put('a.txt', 'whatever');
    await workspace.restore(second.id);
    expect(text('a.txt')).toBe('only in the second');
    expect(text('shared.txt')).toBe('shared');
  });

  it('keeps contents younger than the grace a collection gives', async () => {
    const graceful = new LocalWorkspace({ root, snapshots: { gcGraceMs: 60 * 60 * 1000 } });
    put('a.txt', 'one');
    const first = await graceful.snapshot();
    put('a.txt', 'two');
    await graceful.snapshot();
    const before = blobs().length;
    await graceful.deleteSnapshot(first.id);
    expect(blobs().length).toBe(before);
  });

  it('prunes snapshots by count and age, by its retention or a call', async () => {
    const retained = new LocalWorkspace({
      root,
      snapshots: { retain: { count: 2 }, gcGraceMs: 0 },
    });
    const ids: string[] = [];
    for (let i = 0; i < 4; i++) {
      put('a.txt', String(i));
      ids.push((await retained.snapshot()).id);
    }
    expect((await retained.listSnapshots()).map((snapshot) => snapshot.id)).toEqual(ids.slice(2));
    const pruned = await retained.pruneSnapshots({ count: 1 });
    expect(pruned.deleted).toEqual([ids[2]]);
    expect(pruned.gc.snapshots).toBe(1);
    const aged = await retained.pruneSnapshots({ maxAgeMs: -1 });
    expect(aged.deleted).toEqual([ids[3]]);
    expect(blobs()).toEqual([]);
  });

  it('refuses a corrupt content before it changes anything', async () => {
    put('a.txt', 'original');
    const snapshot = await workspace.snapshot();
    put('a.txt', 'changed');
    put('b.txt', 'new');
    for (const hash of blobs()) {
      const path = join(
        root,
        ...WORKSPACE_CHECKPOINTS_DIR.split('/'),
        'blobs',
        hash.slice(0, 2),
        hash.slice(2)
      );
      if (readFileSync(path, 'utf8') === 'original') writeFileSync(path, 'tampered');
    }
    await expectCode(workspace.restore(snapshot.id), 'IO');
    expect(text('b.txt')).toBe('new');
  });

  it('refuses a store moved outside the root through a symlink', async () => {
    put('a.txt', 'one');
    await workspace.snapshot();
    const store = join(root, ...WORKSPACE_CHECKPOINTS_DIR.split('/'));
    const elsewhere = join(base, 'elsewhere');
    renameSync(store, elsewhere);
    symlinkSync(elsewhere, store);
    await expectCode(workspace.snapshot(), 'OUTSIDE_ROOT');
    await expectCode(workspace.listSnapshots(), 'OUTSIDE_ROOT');
  });

  it('refuses to restore while a command it started still runs', async () => {
    put('a.txt', 'one');
    const snapshot = await workspace.snapshot();
    const running = workspace.exec('sleep 0.3');
    await new Promise((resolve) => setTimeout(resolve, 50));
    await expectCode(workspace.restore(snapshot.id), 'BUSY');
    await expect(workspace.restore(snapshot.id, { dryRun: true })).resolves.toMatchObject({
      dryRun: true,
    });
    await running;
    await expect(workspace.restore(snapshot.id)).resolves.toMatchObject({ dryRun: false });
  });

  it('catches changes a shell command makes between snapshots', async () => {
    put('notes.txt', 'v1');
    const snapshot = await workspace.snapshot();
    const run = await workspace.exec(
      'echo v2 > notes.txt && mkdir -p gen && echo out > gen/out.txt && rm -f missing.txt'
    );
    expect(run.exitCode).toBe(0);
    const result = await workspace.restore(snapshot.id);
    expect(result).toMatchObject({ restored: ['notes.txt'], deleted: ['gen', 'gen/out.txt'] });
    expect(text('notes.txt')).toBe('v1');
  });

  it('copies a snapshot into another workspace to restore it there', async () => {
    put('src/app.ts', 'app');
    put('shared.txt', 'shared');
    const snapshot = await workspace.snapshot();
    const otherRoot = join(base, 'fork');
    const fork = new LocalWorkspace({ root: otherRoot });
    try {
      const copied = await workspace.copySnapshot(snapshot.id, fork);
      expect(copied.id).toBe(snapshot.id);
      expect((await fork.listSnapshots()).map((each) => each.id)).toEqual([snapshot.id]);
      const result = await fork.restore(snapshot.id);
      expect(result.restored).toEqual(['shared.txt', 'src', 'src/app.ts']);
      expect(readFileSync(join(otherRoot, 'src/app.ts'), 'utf8')).toBe('app');
      await expect(workspace.copySnapshot(snapshot.id, fork)).resolves.toMatchObject({
        id: snapshot.id,
      });
    } finally {
      await fork.dispose();
    }
  });
});
