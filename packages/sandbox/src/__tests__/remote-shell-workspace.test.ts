import { execFileSync } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest';
import { WorkspaceError } from '@cogitator-ai/types';
import type {
  RemoteProcess,
  RemoteRunResult,
  RemoteShellConnection,
  RemoteShellDriver,
  RemoteSpawnOptions,
} from '../workspace/remote/driver';
import { RemoteShellWorkspace } from '../workspace/remote/remote-shell-workspace';
import { isEnvName, shellCommand, shellQuote } from '../workspace/remote/shell-quote';
import {
  LocalShellDriver,
  shellHost,
  stopShellHost,
  type LocalShellConnection,
  type ShellHost,
} from './helpers/shell-driver';

const HOSTILE = [
  "it's",
  'say "hi"',
  'two\nlines',
  'ends with newline\n',
  '-rf',
  '--',
  '*.txt',
  '[ab]?',
  '$(touch pwned)',
  '`touch pwned`',
  '$HOME',
  'back\\slash',
  'tab\there',
  'ünïcødé ✓',
  ' leading space',
];

describe('shellQuote', () => {
  it.each(['sh', 'bash'])('passes hostile words through %s unchanged', (shell) => {
    const dir = mkdtempSync(join(tmpdir(), 'quote-'));
    try {
      const output = execFileSync(shell, ['-c', `printf '%s\\0' ${shellCommand(HOSTILE)}`], {
        cwd: dir,
        encoding: 'utf8',
      });
      expect(output.split('\0').slice(0, -1)).toEqual(HOSTILE);
      expect(existsSync(join(dir, 'pwned'))).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('refuses a NUL byte and quotes the empty word', () => {
    expect(() => shellQuote('a\0b')).toThrow(WorkspaceError);
    expect(shellQuote('')).toBe("''");
  });

  it('accepts only shell variable names', () => {
    expect(isEnvName('PATH')).toBe(true);
    expect(isEnvName('_a1')).toBe(true);
    expect(isEnvName('1A')).toBe(false);
    expect(isEnvName('A=B')).toBe(false);
    expect(isEnvName('A B')).toBe(false);
    expect(isEnvName('')).toBe(false);
  });
});

/** A driver that answers from a script, for what a real shell cannot show. */
function scriptedDriver(
  answer: (argv: readonly string[]) => RemoteRunResult,
  calls: string[][] = []
): RemoteShellDriver & { closed: number } {
  const driver = {
    provider: 'scripted',
    defaultRoot: '/home/user',
    closed: 0,
    connect(): Promise<RemoteShellConnection> {
      return Promise.resolve({
        sandboxId: 'scripted',
        readFile: () => Promise.reject(new Error('not here')),
        writeFile: () => Promise.reject(new Error('not here')),
        run: (argv: readonly string[]) => {
          calls.push([...argv]);
          return Promise.resolve(answer(argv));
        },
        spawn: () => Promise.reject(new Error('not here')),
        close: () => {
          driver.closed++;
          return Promise.resolve();
        },
      });
    },
  };
  return driver;
}

describe('RemoteShellWorkspace without a shell', () => {
  it('names the tools the sandbox lacks', async () => {
    const driver = scriptedDriver(() => ({
      exitCode: 60,
      stdout: '',
      stderr: ' setsid find-printf(GNU-findutils)',
    }));
    const workspace = new RemoteShellWorkspace({ driver });
    const error = await workspace.start().catch((caught: unknown) => caught);
    expect(error).toMatchObject({ code: 'UNAVAILABLE' });
    expect((error as Error).message).toContain('setsid find-printf(GNU-findutils)');
    expect(driver.closed).toBe(1);
  });

  it('resolves a relative root against the provider directory and refuses /', async () => {
    const calls: string[][] = [];
    const ok = new RemoteShellWorkspace({
      root: 'project/',
      driver: scriptedDriver(
        () => ({ exitCode: 0, stdout: '/home/user/project', stderr: '' }),
        calls
      ),
    });
    expect(ok.root).toBe('/home/user/project');
    await ok.start();
    expect(calls[0]).toContain('/home/user/project');
    const slash = new RemoteShellWorkspace({
      driver: scriptedDriver(() => ({ exitCode: 0, stdout: '/', stderr: '' })),
    });
    await expect(slash.start()).rejects.toMatchObject({ code: 'INVALID_PATH' });
  });

  it('refuses paths that climb out before reaching the sandbox', async () => {
    const calls: string[][] = [];
    const workspace = new RemoteShellWorkspace({
      driver: scriptedDriver(() => ({ exitCode: 0, stdout: '/home/user', stderr: '' }), calls),
    });
    await workspace.start();
    const before = calls.length;
    await expect(workspace.read('../etc/passwd')).rejects.toMatchObject({ code: 'OUTSIDE_ROOT' });
    await expect(workspace.stat('/etc/passwd')).rejects.toMatchObject({ code: 'OUTSIDE_ROOT' });
    await expect(workspace.read('')).rejects.toMatchObject({ code: 'INVALID_PATH' });
    await expect(workspace.read('a\0b')).rejects.toMatchObject({ code: 'INVALID_PATH' });
    expect(await workspace.contains('../x')).toBe(false);
    expect(calls.length).toBe(before);
    expect(() => workspace.withCwd('/abs')).toThrow(WorkspaceError);
    expect(() => workspace.withCwd('../up')).toThrow(WorkspaceError);
  });

  it('does not connect when disposed before use, and is unusable afterwards', async () => {
    let connects = 0;
    const driver = scriptedDriver(() => ({ exitCode: 0, stdout: '/home/user', stderr: '' }));
    const counting: RemoteShellDriver = {
      ...driver,
      connect: () => {
        connects++;
        return driver.connect();
      },
    };
    const workspace = new RemoteShellWorkspace({ driver: counting });
    await workspace.dispose();
    await workspace.dispose();
    expect(connects).toBe(0);
    await expect(workspace.exec('true')).rejects.toMatchObject({ code: 'DISPOSED' });
  });

  it('can start again after a failed connect', async () => {
    let attempts = 0;
    const driver = scriptedDriver(() => ({ exitCode: 0, stdout: '/home/user', stderr: '' }));
    const flaky: RemoteShellDriver = {
      ...driver,
      connect: () => {
        attempts++;
        return attempts === 1
          ? Promise.reject(new WorkspaceError('UNAVAILABLE', 'no sandbox'))
          : driver.connect();
      },
    };
    const workspace = new RemoteShellWorkspace({ driver: flaky });
    await expect(workspace.start()).rejects.toMatchObject({ code: 'UNAVAILABLE' });
    await workspace.start();
    expect(workspace.sandboxId).toBe('scripted');
  });
});

const base = realpathSync(mkdtempSync(join(tmpdir(), 'remote-workspace-')));
const host: ShellHost | undefined = process.platform === 'win32' ? undefined : shellHost(base);
afterAll(() => {
  stopShellHost(host);
  rmSync(base, { recursive: true, force: true });
});

describe.skipIf(!host)('RemoteShellWorkspace on a real shell', () => {
  const open: RemoteShellWorkspace[] = [];
  let count = 0;

  function fresh(options: Partial<ConstructorParameters<typeof RemoteShellWorkspace>[0]> = {}): {
    workspace: RemoteShellWorkspace;
    root: string;
    driver: LocalShellDriver;
  } {
    if (!host) throw new Error('no shell host');
    const root = join(base, `ws-${++count}`);
    const driver = new LocalShellDriver(root, host);
    const workspace = new RemoteShellWorkspace({ killGrace: 500, ...options, driver });
    open.push(workspace);
    return { workspace, root, driver };
  }

  afterEach(async () => {
    await Promise.all(open.splice(0).map((workspace) => workspace.dispose()));
  }, 60_000);

  const alive = async (workspace: RemoteShellWorkspace, pidFile: string) =>
    (
      await workspace.exec(`kill -0 "$(cat ${pidFile})" 2>/dev/null && echo alive || echo dead`)
    ).stdout.trim();

  it('starts on first use, creating the root', async () => {
    const { workspace, root, driver } = fresh();
    expect(driver.connections).toHaveLength(0);
    expect(workspace.sandboxId).toBeUndefined();
    await workspace.write('a.txt', 'hello');
    expect(driver.connections).toHaveLength(1);
    expect(workspace.root).toBe(root);
    expect(readFileSync(join(root, 'a.txt'), 'utf8')).toBe('hello');
    expect(await workspace.read(join(root, 'a.txt'))).toBe('hello');
  });

  it('refuses a missing root without createRoot, and a file as the root', async () => {
    const { workspace } = fresh({ createRoot: false });
    await expect(workspace.start()).rejects.toMatchObject({ code: 'NOT_FOUND' });
    const file = join(base, 'root-file');
    writeFileSync(file, 'x');
    const onFile = new RemoteShellWorkspace({ driver: new LocalShellDriver(file, host!) });
    await expect(onFile.start()).rejects.toMatchObject({ code: 'NOT_A_DIRECTORY' });
  });

  it('keeps file operations inside the root through symlinks made by commands', async () => {
    const { workspace, root } = fresh();
    const outside = join(base, `outside-${count}`);
    mkdirSync(outside);
    writeFileSync(join(outside, 'secret.txt'), 'secret');
    await workspace.exec(
      `mkdir -p inner && echo in > inner/f.txt && ln -s ${shellQuote(outside)} out && ln -s inner link && ln -s missing-target dangling && ln -s loop1 loop2 && ln -s loop2 loop1`
    );
    await expect(workspace.read('out/secret.txt')).rejects.toMatchObject({ code: 'OUTSIDE_ROOT' });
    await expect(workspace.write('out/new.txt', 'x')).rejects.toMatchObject({
      code: 'OUTSIDE_ROOT',
    });
    await expect(workspace.mkdir('out/dir')).rejects.toMatchObject({ code: 'OUTSIDE_ROOT' });
    await expect(workspace.list('out')).rejects.toMatchObject({ code: 'OUTSIDE_ROOT' });
    await expect(workspace.exec('pwd', { cwd: 'out' })).rejects.toMatchObject({
      code: 'OUTSIDE_ROOT',
    });
    expect(await workspace.contains('out')).toBe(false);
    expect(await workspace.contains('link/f.txt')).toBe(true);
    expect(existsSync(join(outside, 'new.txt'))).toBe(false);

    expect(await workspace.stat('link/f.txt')).toMatchObject({ path: 'inner/f.txt', type: 'file' });
    expect(await workspace.read('link/f.txt')).toBe('in\n');
    await expect(workspace.stat('loop1')).rejects.toMatchObject({ code: 'INVALID_PATH' });

    await workspace.write('dangling', 'through');
    expect(readFileSync(join(root, 'missing-target'), 'utf8')).toBe('through');

    await workspace.remove('out');
    expect(existsSync(join(outside, 'secret.txt'))).toBe(true);
    expect(await workspace.exists('out')).toBe(false);
    await workspace.remove('link');
    expect(await workspace.exists('inner/f.txt')).toBe(true);
  });

  it('stats, checks existence and creates directories', async () => {
    const { workspace } = fresh();
    await workspace.mkdir('a/b/c');
    expect(await workspace.stat('a/b')).toMatchObject({ path: 'a/b', type: 'directory' });
    expect(await workspace.stat('.')).toMatchObject({ path: '.', type: 'directory' });
    expect(await workspace.exists('a/b/c')).toBe(true);
    expect(await workspace.exists('a/nope')).toBe(false);
    await expect(workspace.stat('a/nope')).rejects.toMatchObject({ code: 'NOT_FOUND' });
    await workspace.write('file.txt', '12345');
    const info = await workspace.stat('file.txt');
    expect(info.size).toBe(5);
    expect(Math.abs(info.modifiedAt - Date.now())).toBeLessThan(10 * 60_000);
    await expect(workspace.mkdir('file.txt/sub')).rejects.toMatchObject({
      code: 'NOT_A_DIRECTORY',
    });
    expect(await workspace.exists('file.txt/sub')).toBe(false);
  });

  it('writes atomically with the size limit, the mode kept and parents created', async () => {
    const { workspace, root } = fresh({ maxFileBytes: 64 });
    const bytes = Uint8Array.from({ length: 64 }, (_, i) => (i * 37) % 256);
    await workspace.write('bin/data', bytes);
    expect(Buffer.from(await workspace.readBytes('bin/data')).equals(Buffer.from(bytes))).toBe(
      true
    );
    await expect(workspace.write('big', 'x'.repeat(65))).rejects.toMatchObject({
      code: 'TOO_LARGE',
    });
    await workspace.exec('head -c 100 /dev/zero > large.bin');
    await expect(workspace.read('large.bin')).rejects.toMatchObject({ code: 'TOO_LARGE' });
    expect((await workspace.readBytes('large.bin', { maxBytes: 100 })).byteLength).toBe(100);

    await workspace.write('script.sh', 'echo one');
    chmodSync(join(root, 'script.sh'), 0o755);
    await workspace.write('script.sh', 'echo two');
    expect(statSync(join(root, 'script.sh')).mode & 0o777).toBe(0o755);
    expect((await workspace.exec('./script.sh')).stdout).toBe('two\n');

    await expect(
      workspace.write('missing/parent.txt', 'x', { createParents: false })
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
    await expect(workspace.write('script.sh/x', 'x')).rejects.toMatchObject({
      code: 'NOT_A_DIRECTORY',
    });
    await expect(workspace.write('bin', 'x')).rejects.toMatchObject({ code: 'NOT_A_FILE' });
    await expect(workspace.write('.', 'x')).rejects.toMatchObject({ code: 'NOT_A_FILE' });
    await expect(workspace.read('bin')).rejects.toMatchObject({ code: 'NOT_A_FILE' });
    await expect(workspace.read('nothing')).rejects.toMatchObject({ code: 'NOT_FOUND' });

    const pending = (await workspace.list('.cogitator/pending', { includeHidden: true })).length;
    expect(pending).toBe(0);
  });

  it.skipIf(process.getuid?.() === 0)(
    'refuses to replace a read-only file without force',
    async () => {
      const { workspace, root } = fresh();
      await workspace.write('locked.txt', 'one');
      chmodSync(join(root, 'locked.txt'), 0o444);
      await expect(workspace.write('locked.txt', 'two')).rejects.toMatchObject({ code: 'DENIED' });
      await workspace.write('locked.txt', 'two', { force: true });
      expect(readFileSync(join(root, 'locked.txt'), 'utf8')).toBe('two');
    }
  );

  it("writes the workspace's service files like tool results do, not its bookkeeping", async () => {
    const { workspace, root } = fresh();
    await workspace.write('.cogitator/tool-results/run/call.txt', 'long result');
    expect(readFileSync(join(root, '.cogitator/.gitignore'), 'utf8')).toBe('*\n');
    const runs = await workspace.list('.cogitator/tool-results', { includeHidden: true });
    expect(runs.map((entry) => entry.path)).toEqual(['.cogitator/tool-results/run']);
    await workspace.remove('.cogitator/tool-results/run', { recursive: true });
    await expect(workspace.write('.cogitator/pending/x', 'x')).rejects.toMatchObject({
      code: 'INVALID_PATH',
    });
    await expect(workspace.remove('.cogitator', { recursive: true })).rejects.toMatchObject({
      code: 'INVALID_PATH',
    });
    await expect(
      workspace.remove('.cogitator/snapshots', { recursive: true })
    ).rejects.toMatchObject({ code: 'INVALID_PATH' });
  });

  it('lists like a local workspace: sorted, hidden, skipped, globbed and limited', async () => {
    const { workspace } = fresh();
    await workspace.exec(
      'mkdir -p src/lib node_modules/pkg .git b && touch src/a.ts src/lib/b.ts src/lib/c.md node_modules/pkg/i.js .git/HEAD .env top.ts b/z && ln -s src linked'
    );
    const top = await workspace.list();
    expect(top.map((entry) => entry.name)).toEqual([
      'b',
      'linked',
      'node_modules',
      'src',
      'top.ts',
    ]);
    expect(top.find((entry) => entry.name === 'linked')?.type).toBe('symlink');

    const all = await workspace.list('.', { recursive: true, skipDirs: ['node_modules'] });
    expect(all.map((entry) => entry.path)).toEqual([
      'b',
      'b/z',
      'linked',
      'node_modules',
      'src',
      'src/a.ts',
      'src/lib',
      'src/lib/b.ts',
      'src/lib/c.md',
      'top.ts',
    ]);
    const hidden = await workspace.list('.', { includeHidden: true });
    expect(hidden.map((entry) => entry.name)).toContain('.env');
    expect((await workspace.list('src', { glob: '*.ts' })).map((entry) => entry.path)).toEqual([
      'src/a.ts',
    ]);
    expect(
      (await workspace.list('src', { recursive: true, glob: '**/*.ts' })).map((entry) => entry.path)
    ).toEqual(['src/a.ts', 'src/lib/b.ts']);
    expect(await workspace.list('.', { recursive: true, limit: 3 })).toHaveLength(3);
    expect((await workspace.list('linked')).map((entry) => entry.path)).toEqual([
      'src/a.ts',
      'src/lib',
    ]);
    await expect(workspace.list('top.ts')).rejects.toMatchObject({ code: 'NOT_A_DIRECTORY' });
    await expect(workspace.list('nope')).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });

  it('takes skipDirs names literally, not as find patterns', async () => {
    const { workspace } = fresh();
    await workspace.exec('mkdir -p "a*" ab && touch "a*/in" ab/in');
    const entries = await workspace.list('.', { recursive: true, skipDirs: ['a*'] });
    expect(entries.map((entry) => entry.path)).toEqual(['a*', 'ab', 'ab/in']);
  });

  it('removes into the trash and deletes, with the local rules', async () => {
    const { workspace, root } = fresh();
    await workspace.exec('mkdir -p tree/sub empty && echo a > tree/sub/a.txt && echo b > b.txt');
    await expect(workspace.remove('tree')).rejects.toMatchObject({ code: 'NOT_EMPTY' });
    await expect(workspace.remove('tree', { trash: true })).rejects.toMatchObject({
      code: 'NOT_EMPTY',
    });
    const trashed = await workspace.remove('tree', { trash: true, recursive: true });
    expect(trashed.path).toBe('tree');
    expect(trashed.trashedTo).toMatch(/^\.cogitator\/trash\/[^/]+\/tree$/);
    expect(readFileSync(join(root, trashed.trashedTo!, 'sub', 'a.txt'), 'utf8')).toBe('a\n');
    expect(readFileSync(join(root, '.cogitator', '.gitignore'), 'utf8')).toBe('*\n');
    await workspace.remove(trashed.trashedTo!, { recursive: true });
    await workspace.remove('empty');
    expect(await workspace.remove('b.txt')).toEqual({ path: 'b.txt' });
    await expect(workspace.remove('missing')).rejects.toMatchObject({ code: 'NOT_FOUND' });
    await expect(workspace.remove('.')).rejects.toMatchObject({ code: 'INVALID_PATH' });
    await expect(workspace.remove('../up')).rejects.toMatchObject({ code: 'OUTSIDE_ROOT' });
  });

  it('renames with the local rules for overwrite, kinds and nesting', async () => {
    const { workspace, root } = fresh();
    await workspace.exec(
      'mkdir -p dir full/x empty && echo a > a.txt && echo b > b.txt && touch full/x/f'
    );
    await expect(workspace.rename('a.txt', 'b.txt')).rejects.toMatchObject({ code: 'EXISTS' });
    await workspace.rename('a.txt', 'b.txt', { overwrite: true });
    expect(readFileSync(join(root, 'b.txt'), 'utf8')).toBe('a\n');
    expect(existsSync(join(root, 'a.txt'))).toBe(false);
    await expect(workspace.rename('b.txt', 'dir', { overwrite: true })).rejects.toMatchObject({
      code: 'NOT_A_FILE',
    });
    await expect(workspace.rename('dir', 'b.txt', { overwrite: true })).rejects.toMatchObject({
      code: 'NOT_A_DIRECTORY',
    });
    await expect(workspace.rename('dir', 'full', { overwrite: true })).rejects.toMatchObject({
      code: 'NOT_EMPTY',
    });
    await workspace.rename('dir', 'empty', { overwrite: true });
    await expect(workspace.rename('full', 'full/x/inside')).rejects.toMatchObject({
      code: 'INVALID_PATH',
    });
    await workspace.rename('b.txt', 'deep/er/b.txt');
    expect(readFileSync(join(root, 'deep/er/b.txt'), 'utf8')).toBe('a\n');
    await workspace.rename('deep/er/b.txt', 'deep/er/b.txt');
    await expect(workspace.rename('nope', 'x')).rejects.toMatchObject({ code: 'NOT_FOUND' });
    await expect(workspace.rename('.', 'x')).rejects.toMatchObject({ code: 'INVALID_PATH' });
    await expect(workspace.rename('full', '../out')).rejects.toMatchObject({
      code: 'OUTSIDE_ROOT',
    });
    await expect(workspace.rename('full', '.cogitator/pending/x')).rejects.toMatchObject({
      code: 'INVALID_PATH',
    });
  });

  it('handles hostile file names in every operation', async () => {
    const { workspace, root } = fresh();
    for (const [i, name] of HOSTILE.entries()) {
      await workspace.write(`dir/${name}`, `content ${i}`);
      expect(await workspace.read(`dir/${name}`)).toBe(`content ${i}`);
      expect((await workspace.stat(`dir/${name}`)).path).toBe(`dir/${name}`);
    }
    const listed = await workspace.list('dir', { includeHidden: true });
    expect(listed.map((entry) => entry.name).sort()).toEqual([...HOSTILE].sort());
    for (const name of HOSTILE) {
      await workspace.rename(`dir/${name}`, `moved/${name}`);
      expect(await workspace.exists(`moved/${name}`)).toBe(true);
    }
    const snapshot = await workspace.snapshot();
    for (const name of HOSTILE) await workspace.remove(`moved/${name}`, { trash: true });
    expect((await workspace.list('moved')).length).toBe(0);
    await workspace.restore(snapshot.id);
    for (const [i, name] of HOSTILE.entries()) {
      expect(await workspace.read(`moved/${name}`)).toBe(`content ${i}`);
    }
    expect(existsSync(join(root, 'pwned'))).toBe(false);
    expect(existsSync(join(root, 'dir', 'pwned'))).toBe(false);
  }, 120_000);

  it('streams output, reports the exit code and keeps stderr free of markers', async () => {
    const { workspace } = fresh();
    const out: string[] = [];
    const err: string[] = [];
    const result = await workspace.exec("printf 'a'; printf 'b' >&2; exit 7", {
      onStdout: (chunk) => out.push(chunk),
      onStderr: (chunk) => err.push(chunk),
    });
    expect(result).toMatchObject({ stdout: 'a', stderr: 'b', exitCode: 7, timedOut: false });
    expect(out.join('')).toBe('a');
    expect(err.join('')).toBe('b');
    expect((await workspace.exec('kill -9 $$')).exitCode).toBe(137);
  });

  it('runs in the current directory, a withCwd view and with env', async () => {
    const { workspace, root } = fresh({ env: { FROM_WORKSPACE: 'w' } });
    await workspace.mkdir('pkg/sub');
    await workspace.write('file', 'x');
    expect((await workspace.exec('pwd')).stdout.trim()).toBe(root);
    expect((await workspace.exec('pwd', { cwd: 'pkg' })).stdout.trim()).toBe(join(root, 'pkg'));
    const view = workspace.withCwd('pkg/sub');
    expect(view).toBeInstanceOf(RemoteShellWorkspace);
    expect(view.id).toBe(workspace.id);
    expect((await view.exec('pwd')).stdout.trim()).toBe(join(root, 'pkg/sub'));
    const env = await workspace.exec('echo "$FROM_WORKSPACE-$FROM_CALL"', {
      env: { FROM_CALL: 'c' },
    });
    expect(env.stdout).toBe('w-c\n');
    await expect(workspace.exec('pwd', { cwd: 'file' })).rejects.toMatchObject({
      code: 'NOT_A_DIRECTORY',
    });
    await expect(workspace.exec('pwd', { cwd: 'missing' })).rejects.toMatchObject({
      code: 'NOT_FOUND',
    });
    await expect(workspace.exec('pwd', { cwd: '../..' })).rejects.toMatchObject({
      code: 'OUTSIDE_ROOT',
    });
  });

  it('caps the output it keeps but streams all of it', async () => {
    const { workspace } = fresh();
    let streamed = 0;
    const result = await workspace.exec("head -c 50000 /dev/zero | tr '\\0' a", {
      maxOutputBytes: 1000,
      onStdout: (chunk) => {
        streamed += chunk.length;
      },
    });
    expect(result.truncated).toBe(true);
    expect(result.stdout).toHaveLength(1000);
    expect(streamed).toBe(50000);
  });

  it('does not trust markers a command prints, nor show it the token', async () => {
    if (!host) return;
    const tokens: string[] = [];
    const driver = new LocalShellDriver(join(base, `ws-${++count}`), host);
    const spying: RemoteShellDriver = {
      provider: driver.provider,
      defaultRoot: driver.defaultRoot,
      async connect() {
        const connection = await driver.connect();
        return {
          sandboxId: connection.sandboxId,
          readFile: (path) => connection.readFile(path),
          writeFile: (path, content) => connection.writeFile(path, content),
          run: (argv, options) => connection.run(argv, options),
          spawn: (argv, options: RemoteSpawnOptions): Promise<RemoteProcess> => {
            tokens.push(options.stdin.trim());
            return connection.spawn(argv, options);
          },
          close: () => connection.close(),
        };
      },
    };
    const workspace = new RemoteShellWorkspace({ driver: spying });
    open.push(workspace);
    const forged = await workspace.exec(
      "printf '__cogitator_x_exit:0\\n__cogitator_x_pgid:1\\n' >&2; exit 3"
    );
    expect(forged.exitCode).toBe(3);
    expect(forged.stderr).toContain('__cogitator_x_exit:0');
    const looked = await workspace.exec(
      'cat /proc/$$/cmdline /proc/$PPID/cmdline /proc/self/environ /proc/$PPID/environ 2>/dev/null | tr "\\0" " "; env'
    );
    expect(tokens.length).toBe(2);
    for (const token of tokens) {
      expect(token).toMatch(/^[a-f0-9]{32}$/);
      expect(looked.stdout).not.toContain(token);
    }
  });

  it('kills the command group on a timeout, background processes too', async () => {
    const { workspace } = fresh();
    const result = await workspace.exec(
      'sleep 61 & echo $! > bg.pid; env -i sh -c "echo \\$\\$ > clean.pid; exec sleep 62" & sleep 63; echo never',
      { timeout: 1500 }
    );
    expect(result).toMatchObject({ timedOut: true, exitCode: 124 });
    expect(result.stdout).not.toContain('never');
    await vi.waitFor(
      async () => {
        expect(await alive(workspace, 'bg.pid')).toBe('dead');
        expect(await alive(workspace, 'clean.pid')).toBe('dead');
      },
      { timeout: 20_000, interval: 250 }
    );
  }, 60_000);

  it('rejects with ABORTED and kills the command when the signal aborts', async () => {
    const { workspace } = fresh();
    const controller = new AbortController();
    const running = workspace.exec('echo $$ > self.pid; echo ready; sleep 64', {
      signal: controller.signal,
      onStdout: (chunk) => {
        if (chunk.includes('ready')) controller.abort(new Error('stop'));
      },
    });
    await expect(running).rejects.toMatchObject({ code: 'ABORTED' });
    await vi.waitFor(async () => expect(await alive(workspace, 'self.pid')).toBe('dead'), {
      timeout: 20_000,
      interval: 250,
    });
    const early = new AbortController();
    early.abort();
    await expect(workspace.exec('true', { signal: early.signal })).rejects.toMatchObject({
      code: 'ABORTED',
    });
  }, 60_000);

  it('returns when the command exits, killing or keeping what it left running', async () => {
    const { workspace } = fresh();
    const quick = await workspace.exec('sleep 71 & echo $! > k.pid; echo started');
    expect(quick).toMatchObject({ stdout: 'started\n', exitCode: 0, timedOut: false });
    await vi.waitFor(async () => expect(await alive(workspace, 'k.pid')).toBe('dead'), {
      timeout: 20_000,
      interval: 250,
    });

    const kept = await workspace.exec('sleep 72 > /dev/null 2>&1 & echo $! > keep.pid', {
      background: 'keep',
    });
    expect(kept.exitCode).toBe(0);
    expect(await alive(workspace, 'keep.pid')).toBe('alive');
    await workspace.write('victim.txt', 'x');
    await expect(workspace.remove('victim.txt')).rejects.toMatchObject({ code: 'BUSY' });
    await expect(workspace.rename('victim.txt', 'other.txt')).rejects.toMatchObject({
      code: 'BUSY',
    });
    await workspace.exec('kill "$(cat keep.pid)"');
    await vi.waitFor(() => workspace.remove('victim.txt'), { timeout: 20_000, interval: 250 });
  }, 60_000);

  it('refuses to remove while a command runs', async () => {
    const { workspace } = fresh();
    await workspace.write('f.txt', 'x');
    const controller = new AbortController();
    let started: () => void = () => undefined;
    const ready = new Promise<void>((resolve) => {
      started = resolve;
    });
    const running = workspace.exec('echo go; sleep 65', {
      signal: controller.signal,
      onStdout: () => started(),
    });
    await ready;
    await expect(workspace.remove('f.txt')).rejects.toMatchObject({ code: 'BUSY' });
    controller.abort();
    await expect(running).rejects.toMatchObject({ code: 'ABORTED' });
  }, 60_000);

  it('kills kept processes and releases the sandbox on dispose', async () => {
    const { workspace, driver } = fresh();
    await workspace.exec('sleep 73 > /dev/null 2>&1 & echo $! > d.pid', { background: 'keep' });
    const pid = (await workspace.read('d.pid')).trim();
    await workspace.dispose();
    const connection = driver.connections[0] as LocalShellConnection;
    expect(connection.closed).toBe(true);
    const checker = fresh();
    await vi.waitFor(
      async () => {
        const left = await checker.workspace.exec(
          `kill -0 ${pid} 2>/dev/null && echo alive || echo dead`
        );
        expect(left.stdout.trim()).toBe('dead');
      },
      { timeout: 20_000, interval: 250 }
    );
    await expect(workspace.read('d.pid')).rejects.toMatchObject({ code: 'DISPOSED' });
    await expect(workspace.withCwd('.').exec('true')).rejects.toMatchObject({ code: 'DISPOSED' });
  }, 60_000);

  it('snapshots and restores, leaving excluded paths alone', async () => {
    const { workspace, root } = fresh();
    await workspace.exec(
      'mkdir -p src/old build empty && echo v1 > src/a.txt && echo keep > src/old/k.txt && echo b1 > build/out.txt && ln -s src/a.txt alink'
    );
    await workspace.write('.cogitator/tool-results/r/1.txt', 'result');
    const exclude = ['build/**', '.cogitator/**'];
    const first = await workspace.snapshot({ label: 'before', exclude, metadata: { turn: 1 } });
    expect(first).toMatchObject({ label: 'before', exclude, workspaceId: workspace.id });

    const outside = join(base, `victim-${count}`);
    writeFileSync(outside, 'untouched');
    await workspace.exec(
      `echo v2 > src/a.txt && rm -r src/old empty && mkdir -p newdir/deep && echo n > newdir/deep/n.txt && echo b2 > build/out.txt && echo b3 > build/new.txt && rm alink && ln -s ${shellQuote(outside)} alink && touch .cogitator/tool-results/r/2.txt`
    );
    await workspace.restore(first.id);
    expect(readFileSync(join(root, 'src/a.txt'), 'utf8')).toBe('v1\n');
    expect(readFileSync(join(root, 'src/old/k.txt'), 'utf8')).toBe('keep\n');
    expect(statSync(join(root, 'empty')).isDirectory()).toBe(true);
    expect(existsSync(join(root, 'newdir'))).toBe(false);
    expect(readFileSync(join(root, 'build/out.txt'), 'utf8')).toBe('b2\n');
    expect(readFileSync(join(root, 'build/new.txt'), 'utf8')).toBe('b3\n');
    expect((await workspace.stat('alink')).path).toBe('src/a.txt');
    expect(readFileSync(outside, 'utf8')).toBe('untouched');
    expect(existsSync(join(root, '.cogitator/tool-results/r/2.txt'))).toBe(true);

    const second = await workspace.snapshot();
    const listed = await workspace.listSnapshots();
    expect(listed.map((snapshot) => snapshot.id)).toEqual([first.id, second.id]);
    expect(listed[0]).toEqual(first);
    expect(second.exclude).toEqual(['.cogitator/**']);
    await workspace.deleteSnapshot(first.id);
    expect((await workspace.listSnapshots()).map((snapshot) => snapshot.id)).toEqual([second.id]);
    await expect(workspace.restore(first.id)).rejects.toMatchObject({ code: 'NOT_FOUND' });
    await expect(workspace.restore('../../etc')).rejects.toMatchObject({ code: 'NOT_FOUND' });
    await expect(workspace.deleteSnapshot(first.id)).rejects.toMatchObject({ code: 'NOT_FOUND' });
  }, 60_000);
});
