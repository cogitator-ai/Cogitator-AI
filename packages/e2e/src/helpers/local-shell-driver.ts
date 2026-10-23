import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { readFile, writeFile } from 'node:fs/promises';
import type {
  RemoteProcess,
  RemoteRunOptions,
  RemoteRunResult,
  RemoteShellConnection,
  RemoteShellDriver,
  RemoteSpawnOptions,
} from '@cogitator-ai/sandbox';

/** Whether this machine has the GNU tools a `RemoteShellWorkspace` needs (Linux does). */
export function hasRemoteShellTools(): boolean {
  const works = (file: string, args: string[]) =>
    spawnSync(file, args, { stdio: 'ignore', timeout: 30_000 }).status === 0;
  return (
    process.platform !== 'win32' &&
    works('setsid', ['-w', 'true']) &&
    works('realpath', ['-m', '/']) &&
    works('find', ['/', '-maxdepth', '0', '-printf', ''])
  );
}

/**
 * A `RemoteShellDriver` whose sandbox is this machine: the remote workspace's own shell scripts
 * run for real, without a provider account.
 */
export class LocalShellDriver implements RemoteShellDriver {
  readonly provider = 'local shell';
  constructor(readonly defaultRoot: string) {}

  connect(): Promise<RemoteShellConnection> {
    const scripts = join(dirname(this.defaultRoot), '.scripts');
    return Promise.resolve({
      sandboxId: 'local',
      readFile: (path: string) => readFile(path),
      writeFile: (path: string, content: Uint8Array) => writeFile(path, content),
      run: (argv, options) => run(fromFile(argv, scripts), options),
      spawn: (argv, options) => start(fromFile(argv, scripts), options),
      close: () => Promise.resolve(),
    });
  }
}

/**
 * `argv` with its `sh -c <script> <name> <args...>` turned into `sh <file> <args...>`, the script
 * kept in a file of `dir`: the arguments stay positional parameters, and this machine never runs
 * a command line built from them.
 */
function fromFile(argv: readonly string[], dir: string): string[] {
  const at = argv.findIndex((word, i) => word === 'sh' && argv[i + 1] === '-c');
  if (at === -1) return [...argv];
  const script = argv[at + 2] ?? '';
  const file = join(dir, `${createHash('sha256').update(script).digest('hex')}.sh`);
  if (!existsSync(file)) {
    mkdirSync(dir, { recursive: true });
    writeFileSync(file, script);
  }
  return [...argv.slice(0, at), 'sh', file, ...argv.slice(at + 4)];
}

function launch(argv: readonly string[], cwd: string, env: Record<string, string>, stdin: boolean) {
  return spawn(argv[0], argv.slice(1), {
    cwd,
    env: { PATH: process.env.PATH ?? '/usr/bin:/bin', LANG: 'C.UTF-8', ...env },
    stdio: [stdin ? 'pipe' : 'ignore', 'pipe', 'pipe'],
  });
}

function run(argv: readonly string[], options: RemoteRunOptions): Promise<RemoteRunResult> {
  const child = launch(argv, options.cwd, {}, false);
  const stdout: Buffer[] = [];
  const stderr: Buffer[] = [];
  child.stdout?.on('data', (chunk: Buffer) => stdout.push(chunk));
  child.stderr?.on('data', (chunk: Buffer) => stderr.push(chunk));
  const timer = setTimeout(() => child.kill('SIGKILL'), options.timeout);
  return new Promise((resolve, reject) => {
    child.on('error', reject);
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({
        exitCode: code ?? 1,
        stdout: Buffer.concat(stdout).toString('utf8'),
        stderr: Buffer.concat(stderr).toString('utf8'),
      });
    });
  });
}

function start(argv: readonly string[], options: RemoteSpawnOptions): Promise<RemoteProcess> {
  const child = launch(argv, options.cwd, options.env, true);
  child.stdout?.on('data', (chunk: Buffer) => options.onStdout(chunk));
  child.stderr?.on('data', (chunk: Buffer) => options.onStderr(chunk));
  child.stdin?.end(options.stdin);
  const exited = new Promise<number>((resolve, reject) => {
    child.on('error', reject);
    child.on('close', (code, signal) => resolve(code ?? (signal ? 137 : 1)));
  });
  return Promise.resolve({
    wait: () => exited,
    kill: () => {
      child.kill('SIGKILL');
      return Promise.resolve();
    },
    detach: () => {
      child.stdout?.destroy();
      child.stderr?.destroy();
    },
  });
}
