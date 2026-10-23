import {
  linkSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
  existsSync,
} from 'node:fs';
import { execSync } from 'node:child_process';
import { chmodSync, readdirSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { WorkspaceError, type WorkspaceErrorCode } from '@cogitator-ai/types';
import { LocalWorkspace, WORKSPACE_TRASH_DIR } from '../workspace/local-workspace';

let base: string;
let root: string;
let outside: string;
let workspace: LocalWorkspace;

beforeEach(async () => {
  base = realpathSync(mkdtempSync(join(tmpdir(), 'local-workspace-')));
  root = join(base, 'root');
  outside = join(base, 'outside');
  mkdirSync(outside);
  writeFileSync(join(outside, 'secret.txt'), 'top secret');
  workspace = new LocalWorkspace({ root });
  await workspace.start();
});

afterEach(async () => {
  await workspace.dispose();
  rmSync(base, { recursive: true, force: true });
});

async function expectCode(promise: Promise<unknown>, code: WorkspaceErrorCode): Promise<void> {
  const error = await promise.then(
    () => undefined,
    (reason: unknown) => reason
  );
  expect(error, `expected ${code}`).toBeInstanceOf(WorkspaceError);
  expect((error as WorkspaceError).code).toBe(code);
}

describe('LocalWorkspace paths', () => {
  it('creates the root on start and reports it resolved', () => {
    expect(existsSync(root)).toBe(true);
    expect(workspace.root).toBe(realpathSync(root));
    expect(workspace.cwd).toBe('.');
  });

  it('reads and writes relative paths and absolute paths inside the root', async () => {
    await workspace.write('notes/today.md', 'hello');
    expect(readFileSync(join(root, 'notes/today.md'), 'utf8')).toBe('hello');
    expect(await workspace.read(join(root, 'notes/today.md'))).toBe('hello');
    expect(await workspace.read('./notes/../notes/today.md')).toBe('hello');
  });

  it('refuses .. that climbs out of the root', async () => {
    await expectCode(workspace.read('../outside/secret.txt'), 'OUTSIDE_ROOT');
    await expectCode(workspace.write('a/../../escape.txt', 'x'), 'OUTSIDE_ROOT');
    expect(existsSync(join(base, 'escape.txt'))).toBe(false);
  });

  it('refuses absolute paths elsewhere', async () => {
    await expectCode(workspace.read(join(outside, 'secret.txt')), 'OUTSIDE_ROOT');
    await expectCode(workspace.stat('/etc'), 'OUTSIDE_ROOT');
  });

  it('refuses a symlinked file that points out', async () => {
    symlinkSync(join(outside, 'secret.txt'), join(root, 'link.txt'));
    await expectCode(workspace.read('link.txt'), 'OUTSIDE_ROOT');
    await expectCode(workspace.write('link.txt', 'overwritten'), 'OUTSIDE_ROOT');
    expect(readFileSync(join(outside, 'secret.txt'), 'utf8')).toBe('top secret');
  });

  it('refuses a symlinked directory that points out', async () => {
    symlinkSync(outside, join(root, 'dir'));
    await expectCode(workspace.read('dir/secret.txt'), 'OUTSIDE_ROOT');
    await expectCode(workspace.write('dir/new.txt', 'x'), 'OUTSIDE_ROOT');
    await expectCode(workspace.list('dir'), 'OUTSIDE_ROOT');
    expect(existsSync(join(outside, 'new.txt'))).toBe(false);
  });

  it('refuses writing through a dangling symlink that points out', async () => {
    symlinkSync(join(outside, 'created.txt'), join(root, 'dangling.txt'));
    await expectCode(workspace.write('dangling.txt', 'x'), 'OUTSIDE_ROOT');
    expect(existsSync(join(outside, 'created.txt'))).toBe(false);
  });

  it('follows symlinks that stay inside the root', async () => {
    await workspace.write('real/file.txt', 'inside');
    symlinkSync(join(root, 'real'), join(root, 'alias'));
    expect(await workspace.read('alias/file.txt')).toBe('inside');
    expect((await workspace.stat('alias/file.txt')).path).toBe('real/file.txt');
  });

  it('refuses a symlink that a command created, when read through the file API', async () => {
    const result = await workspace.exec(`ln -s "${join(outside, 'secret.txt')}" leak.txt`);
    expect(result.exitCode).toBe(0);
    await expectCode(workspace.read('leak.txt'), 'OUTSIDE_ROOT');
  });

  it('answers contains without throwing', async () => {
    symlinkSync(outside, join(root, 'out'));
    expect(await workspace.contains('anything/new.txt')).toBe(true);
    expect(await workspace.contains('../outside')).toBe(false);
    expect(await workspace.contains('out/secret.txt')).toBe(false);
    expect(await workspace.contains('')).toBe(false);
  });

  it('rejects malformed paths', async () => {
    await expectCode(workspace.read(''), 'INVALID_PATH');
    await expectCode(workspace.read('a\0b'), 'INVALID_PATH');
  });

  it('reads a hard link to an outside file unless told to refuse, and never writes through it', async () => {
    try {
      linkSync(join(outside, 'secret.txt'), join(root, 'hard.txt'));
    } catch {
      return;
    }
    expect(await workspace.read('hard.txt')).toBe('top secret');
    const strict = new LocalWorkspace({ root, refuseHardLinks: true });
    await expectCode(strict.read('hard.txt'), 'DENIED');

    await workspace.write('hard.txt', 'replaced');
    expect(await workspace.read('hard.txt')).toBe('replaced');
    expect(readFileSync(join(outside, 'secret.txt'), 'utf8')).toBe('top secret');
  });

  it('refuses FIFOs and other non-regular files without blocking on them', async () => {
    execSync(`mkfifo "${join(root, 'pipe')}"`);
    await expectCode(workspace.read('pipe'), 'NOT_A_FILE');
    await expectCode(workspace.write('pipe', 'x'), 'NOT_A_FILE');
    expect((await workspace.stat('pipe')).type).toBe('other');
  });

  it('refuses a cwd that climbs out of the root', () => {
    expect(() => new LocalWorkspace({ root, cwd: '../up' })).toThrow(/outside/);
    expect(() => new LocalWorkspace({ root, cwd: 'a/../../up' })).toThrow(/outside/);
    expect(new LocalWorkspace({ root, cwd: 'a/./b/' }).cwd).toBe('a/b');
  });

  it('refuses to start a missing root when told not to create it', async () => {
    const missing = new LocalWorkspace({ root: join(base, 'missing'), create: false });
    await expectCode(missing.start(), 'NOT_FOUND');
  });

  it('refuses every operation once disposed', async () => {
    await workspace.dispose();
    await expectCode(workspace.read('x'), 'DISPOSED');
  });
});

describe('LocalWorkspace files', () => {
  it('keeps reads and writes within their size limits', async () => {
    const small = new LocalWorkspace({ root, maxFileBytes: 10 });
    await expectCode(small.write('big.txt', 'x'.repeat(11)), 'TOO_LARGE');
    writeFileSync(join(root, 'big.txt'), 'x'.repeat(11));
    await expectCode(small.read('big.txt'), 'TOO_LARGE');
    await expectCode(workspace.read('big.txt', { maxBytes: 5 }), 'TOO_LARGE');
    expect(await workspace.read('big.txt')).toBe('x'.repeat(11));
  });

  it('reads and writes bytes', async () => {
    await workspace.write('blob.bin', new Uint8Array([0, 1, 2, 255]));
    expect([...(await workspace.readBytes('blob.bin'))]).toEqual([0, 1, 2, 255]);
  });

  it('replaces the whole content on write, keeping the mode and leaving no temporary file', async () => {
    await workspace.write('run.sh', 'a long first version');
    chmodSync(join(root, 'run.sh'), 0o750);
    await workspace.write('run.sh', 'short');
    expect(await workspace.read('run.sh')).toBe('short');
    expect(statSync(join(root, 'run.sh')).mode & 0o777).toBe(0o750);
    expect(readdirSync(root)).toEqual(['run.sh']);
  });

  it('answers DENIED when the system refuses access', async () => {
    if (process.getuid?.() === 0) return;
    await workspace.write('locked.txt', 'x');
    chmodSync(join(root, 'locked.txt'), 0);
    try {
      await expectCode(workspace.read('locked.txt'), 'DENIED');
    } finally {
      chmodSync(join(root, 'locked.txt'), 0o644);
    }
  });

  it('gives a view with another cwd that shares the workspace', async () => {
    await workspace.mkdir('pkg');
    const view = workspace.withCwd('pkg');
    expect(view.id).toBe(workspace.id);
    expect(view.cwd).toBe('pkg');
    expect((await view.exec('pwd')).stdout.trim()).toBe(join(workspace.root, 'pkg'));
    await view.dispose();
    await expectCode(workspace.read('x'), 'DISPOSED');
  });

  it('tells files and directories apart', async () => {
    await workspace.mkdir('dir/sub');
    await expectCode(workspace.read('dir'), 'NOT_A_FILE');
    await expectCode(workspace.write('dir', 'x'), 'NOT_A_FILE');
    await expectCode(workspace.read('missing.txt'), 'NOT_FOUND');
    expect(await workspace.exists('dir/sub')).toBe(true);
    expect(await workspace.exists('nope')).toBe(false);
    expect((await workspace.stat('dir')).type).toBe('directory');
  });

  it('lists entries, recursively, with a glob and without hidden ones', async () => {
    await workspace.write('src/index.ts', '');
    await workspace.write('src/util/math.ts', '');
    await workspace.write('src/readme.md', '');
    await workspace.write('.env', 'SECRET=1');
    await workspace.write('node_modules/pkg/index.js', '');

    const top = await workspace.list();
    expect(top.map((e) => e.path)).toEqual(['node_modules', 'src']);

    const ts = await workspace.list('.', {
      recursive: true,
      glob: '**/*.ts',
      skipDirs: ['node_modules'],
    });
    expect(ts.map((e) => e.path)).toEqual(['src/index.ts', 'src/util/math.ts']);

    const inSrc = await workspace.list('src', { glob: '*.{ts,md}' });
    expect(inSrc.map((e) => e.name)).toEqual(['index.ts', 'readme.md']);

    const hidden = await workspace.list('.', { includeHidden: true });
    expect(hidden.map((e) => e.name)).toContain('.env');

    expect(await workspace.list('.', { recursive: true, limit: 2 })).toHaveLength(2);
  });

  it('lists a symlinked directory without entering it', async () => {
    symlinkSync(outside, join(root, 'out'));
    const entries = await workspace.list('.', { recursive: true });
    expect(entries).toEqual([expect.objectContaining({ path: 'out', type: 'symlink' })]);
  });

  it('moves removed entries to the trash, or deletes them', async () => {
    await workspace.write('old/notes.md', 'keep me');
    await expectCode(workspace.remove('old'), 'NOT_EMPTY');

    const trashed = await workspace.remove('old', { recursive: true, trash: true });
    expect(trashed.path).toBe('old');
    expect(trashed.trashedTo?.startsWith(`${WORKSPACE_TRASH_DIR}/`)).toBe(true);
    expect(await workspace.exists('old')).toBe(false);
    expect(await workspace.read(`${trashed.trashedTo}/notes.md`)).toBe('keep me');
    expect(await workspace.read('.cogitator/.gitignore')).toBe('*\n');

    await workspace.write('gone.txt', 'bye');
    expect(await workspace.remove('gone.txt')).toEqual({ path: 'gone.txt' });
    expect(await workspace.exists('gone.txt')).toBe(false);
  });

  it('removes a symlink, never what it points to', async () => {
    symlinkSync(join(outside, 'secret.txt'), join(root, 'link.txt'));
    await workspace.remove('link.txt');
    expect(readFileSync(join(outside, 'secret.txt'), 'utf8')).toBe('top secret');
  });

  it('refuses to remove or move the root', async () => {
    await expectCode(workspace.remove('.', { recursive: true }), 'INVALID_PATH');
    await expectCode(workspace.rename('.', 'elsewhere'), 'INVALID_PATH');
  });

  it('renames inside the workspace and keeps existing targets unless asked', async () => {
    await workspace.write('a.txt', 'A');
    await workspace.write('b.txt', 'B');
    await expectCode(workspace.rename('a.txt', 'b.txt'), 'EXISTS');
    await workspace.rename('a.txt', 'moved/a.txt');
    expect(await workspace.read('moved/a.txt')).toBe('A');
    await workspace.rename('moved/a.txt', 'b.txt', { overwrite: true });
    expect(await workspace.read('b.txt')).toBe('A');
    await expectCode(workspace.rename('b.txt', '../outside/b.txt'), 'OUTSIDE_ROOT');
  });
});

describe('LocalWorkspace housekeeping', () => {
  it('protects its own directory and answers without host paths', async () => {
    await workspace.remove(await workspace.write('x.txt', 'x').then(() => 'x.txt'), {
      trash: true,
    });
    for (const attempt of [
      () => workspace.remove('.cogitator', { recursive: true }),
      () => workspace.remove('.cogitator/pending', { recursive: true }),
      () => workspace.rename('.cogitator', 'elsewhere'),
      () => workspace.write('.cogitator/pending/x', 'x'),
    ]) {
      const error = await attempt().then(
        () => undefined,
        (reason: unknown) => reason
      );
      expect(WorkspaceError.is(error, 'INVALID_PATH')).toBe(true);
      expect((error as Error).message).not.toContain(base);
    }
  });

  it('refuses to replace a read-only file unless forced', async () => {
    await workspace.write('locked.txt', 'v1');
    chmodSync(join(root, 'locked.txt'), 0o444);
    if (process.getuid?.() !== 0) await expectCode(workspace.write('locked.txt', 'v2'), 'DENIED');
    await workspace.write('locked.txt', 'v3', { force: true });
    expect(await workspace.read('locked.txt')).toBe('v3');
    expect(statSync(join(root, 'locked.txt')).mode & 0o777).toBe(0o444);
  });

  it('overwrites a file on rename only when asked, and refuses a non-empty directory target', async () => {
    await workspace.write('a.txt', 'A');
    await workspace.write('b.txt', 'B');
    await workspace.rename('a.txt', 'b.txt', { overwrite: true });
    expect(await workspace.read('b.txt')).toBe('A');
    expect(await workspace.exists('a.txt')).toBe(false);
    await workspace.write('dir/inner.txt', 'x');
    await workspace.mkdir('src');
    await expectCode(workspace.rename('src', 'dir', { overwrite: true }), 'NOT_EMPTY');
    await expectCode(workspace.rename('b.txt', 'dir', { overwrite: true }), 'NOT_A_FILE');
    expect(readdirSync(join(root, '.cogitator', 'pending'))).toEqual([]);
  });

  it('sweeps temporary write files, recovers staged entries and never deletes them', async () => {
    const temp = join(root, 'src', '.cogitator-tmp-leftover');
    const linked = join(root, 'src', '.cogitator-tmp-linked');
    const staged = join(root, 'src', '.cogitator-place-AbCdEfGhIjKl');
    mkdirSync(join(root, 'src'));
    writeFileSync(temp, 'half');
    writeFileSync(join(root, 'src', 'kept.txt'), 'kept');
    linkSync(join(root, 'src', 'kept.txt'), linked);
    writeFileSync(staged, 'only copy of src/report.md');

    const young = new LocalWorkspace({ root, leftoverAge: 60 * 60 * 1000 });
    await young.start();
    await young.list('.');
    expect(existsSync(staged)).toBe(true);
    expect(existsSync(temp)).toBe(true);
    await young.dispose();

    const again = new LocalWorkspace({ root, leftoverAge: 0 });
    await again.start();
    expect(existsSync(staged)).toBe(false);
    expect(existsSync(temp)).toBe(false);
    expect(existsSync(linked)).toBe(true);
    const pending = join(root, '.cogitator', 'pending');
    const [holder] = readdirSync(pending).filter((name) => name.startsWith('recovered-'));
    expect(readFileSync(join(pending, holder, '.cogitator-place-AbCdEfGhIjKl'), 'utf8')).toBe(
      'only copy of src/report.md'
    );
    await again.dispose();
  });
});

describe('LocalWorkspace exec', () => {
  it('runs in the current directory or the given one, inside the root', async () => {
    await workspace.mkdir('pkg');
    const inRoot = await workspace.exec('pwd');
    expect(inRoot.stdout.trim()).toBe(workspace.root);
    const inPkg = await workspace.exec('pwd', { cwd: 'pkg' });
    expect(inPkg.stdout.trim()).toBe(join(workspace.root, 'pkg'));
    await expectCode(workspace.exec('pwd', { cwd: '..' }), 'OUTSIDE_ROOT');

    const nested = new LocalWorkspace({ root, cwd: 'pkg' });
    expect((await nested.exec('pwd')).stdout.trim()).toBe(join(workspace.root, 'pkg'));
    await nested.dispose();
  });

  it('reports the exit code and streams output as it comes', async () => {
    const out: string[] = [];
    const err: string[] = [];
    const result = await workspace.exec("printf 'one\\n'; printf 'oops' >&2; exit 3", {
      onStdout: (chunk) => out.push(chunk),
      onStderr: (chunk) => err.push(chunk),
    });
    expect(result).toMatchObject({ stdout: 'one\n', stderr: 'oops', exitCode: 3, timedOut: false });
    expect(out.join('')).toBe('one\n');
    expect(err.join('')).toBe('oops');
  });

  it('keeps the environment small and adds what it is given', async () => {
    vi.stubEnv('COGITATOR_TEST_SECRET', 'leak');
    try {
      const result = await workspace.exec('echo "[$COGITATOR_TEST_SECRET][$EXTRA]"', {
        env: { EXTRA: 'given' },
      });
      expect(result.stdout.trim()).toBe('[][given]');
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it('caps the output it keeps and says so', async () => {
    const result = await workspace.exec("head -c 5000 /dev/zero | tr '\\0' x", {
      maxOutputBytes: 100,
    });
    expect(result.stdout).toBe('x'.repeat(100));
    expect(result.truncated).toBe(true);
  });

  it('returns when the command exits and stops what it left in the background', async () => {
    const result = await workspace.exec('sleep 66 & echo $! > bg.pid; echo started', {
      timeout: 60_000,
    });
    expect(result).toMatchObject({ stdout: 'started\n', exitCode: 0, timedOut: false });
    const pid = Number((await workspace.read('bg.pid')).trim());
    await vi.waitFor(() => expect(isAlive(pid)).toBe(false), { timeout: 10_000 });
  });

  it('keeps background processes when asked, until dispose', async () => {
    const result = await workspace.exec('sleep 67 > /dev/null 2>&1 & echo $! > bg.pid', {
      background: 'keep',
    });
    expect(result.exitCode).toBe(0);
    const pid = Number((await workspace.read('bg.pid')).trim());
    expect(isAlive(pid)).toBe(true);
    await workspace.dispose();
    await vi.waitFor(() => expect(isAlive(pid)).toBe(false), { timeout: 10_000 });
  });

  it('stops a command that holds its output open on a timeout, background included', async () => {
    const result = await workspace.exec('sleep 69 & echo $! > bg.pid; sleep 70', { timeout: 1000 });
    expect(result.timedOut).toBe(true);
    const pid = Number((await workspace.read('bg.pid')).trim());
    await vi.waitFor(() => expect(isAlive(pid)).toBe(false), { timeout: 10_000 });
  });

  it('runs commands through a launch wrapper, keeping the group kill', async () => {
    const wrapped = new LocalWorkspace({
      root,
      exec: {
        launch: ({ file, args }) => ({
          file: '/usr/bin/env',
          args: ['WRAPPED=yes', file, ...args],
        }),
      },
    });
    expect((await wrapped.exec('echo $WRAPPED')).stdout.trim()).toBe('yes');
    const result = await wrapped.exec('sleep 68', { timeout: 300 });
    expect(result.timedOut).toBe(true);
    await wrapped.dispose();
  });

  it('kills the whole process group on a timeout', async () => {
    const result = await workspace.exec('sleep 60 & echo $! > child.pid; wait', { timeout: 2000 });
    expect(result.timedOut).toBe(true);
    expect(result.exitCode).toBe(124);
    const pid = Number((await workspace.read('child.pid')).trim());
    await vi.waitFor(() => expect(isAlive(pid)).toBe(false), { timeout: 10_000 });
  });

  it('kills the command and rejects when aborted', async () => {
    const controller = new AbortController();
    const running = workspace.exec('echo ready; sleep 60 & echo $! > child.pid; wait', {
      signal: controller.signal,
      onStdout: (chunk) => {
        if (chunk.includes('ready')) {
          void vi
            .waitFor(() => expect(existsSync(join(root, 'child.pid'))).toBe(true))
            .then(() => controller.abort(new Error('user stopped it')));
        }
      },
    });
    await expectCode(running, 'ABORTED');
    const pid = Number((await workspace.read('child.pid')).trim());
    await vi.waitFor(() => expect(isAlive(pid)).toBe(false), { timeout: 10_000 });
  });

  it('does not start a command whose signal already aborted', async () => {
    const controller = new AbortController();
    controller.abort();
    await expectCode(workspace.exec('touch ran.txt', { signal: controller.signal }), 'ABORTED');
    expect(existsSync(join(root, 'ran.txt'))).toBe(false);
  });
});

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}
