import { spawn, spawnSync } from 'node:child_process';
import { readFile, writeFile } from 'node:fs/promises';
import type {
  RemoteProcess,
  RemoteRunOptions,
  RemoteRunResult,
  RemoteShellConnection,
  RemoteShellDriver,
  RemoteSpawnOptions,
} from '../../workspace/remote/driver';

const IMAGE = 'debian:stable-slim';

/**
 * Where the shell a {@link LocalShellDriver} runs lives: this machine when it has the GNU tools
 * the remote workspace needs (Linux), else a Debian container with `base` mounted at the same
 * path (macOS with Docker), else nowhere and the tests skip.
 */
export type ShellHost = { kind: 'native' } | { kind: 'docker'; container: string };

function works(file: string, args: string[], timeout = 30_000): boolean {
  const result = spawnSync(file, args, { stdio: 'ignore', timeout });
  return result.status === 0;
}

function skipped(reason: string): undefined {
  console.warn(`\n  The remote workspace shell tests are skipped: ${reason}\n`);
  return undefined;
}

/** The shell host for `base`, starting a container when this machine lacks the tools. */
export function shellHost(base: string): ShellHost | undefined {
  const gnu =
    works('setsid', ['-w', 'true']) &&
    works('realpath', ['-m', '/']) &&
    works('find', ['/', '-maxdepth', '0', '-printf', '']);
  if (gnu) return { kind: 'native' };
  if (!works('docker', ['info'])) {
    return skipped('this machine lacks GNU find, realpath and setsid, and Docker is not running');
  }
  if (!works('docker', ['image', 'inspect', IMAGE]) && !works('docker', ['pull', IMAGE], 300_000)) {
    return skipped(`could not pull ${IMAGE}, run: docker pull ${IMAGE}`);
  }
  const user = `${process.getuid?.() ?? 0}:${process.getgid?.() ?? 0}`;
  const started = spawnSync(
    'docker',
    [
      'run',
      '-d',
      '--rm',
      '--init',
      '--user',
      user,
      '-v',
      `${base}:${base}`,
      IMAGE,
      'sleep',
      'infinity',
    ],
    { encoding: 'utf8', timeout: 60_000 }
  );
  if (started.status !== 0) return skipped(`could not start ${IMAGE}: ${started.stderr.trim()}`);
  return { kind: 'docker', container: started.stdout.trim() };
}

export function stopShellHost(host: ShellHost | undefined): void {
  if (host?.kind === 'docker')
    spawnSync('docker', ['rm', '-f', host.container], { stdio: 'ignore' });
}

/**
 * A driver whose sandbox is a directory of this machine: programs run with a real shell and
 * files are read and written directly, so the workspace's shell scripts are tested for real.
 */
export class LocalShellDriver implements RemoteShellDriver {
  readonly provider = 'local shell';
  readonly connections: LocalShellConnection[] = [];

  constructor(
    readonly defaultRoot: string,
    private readonly host: ShellHost
  ) {}

  connect(): Promise<RemoteShellConnection> {
    const connection = new LocalShellConnection(this.host);
    this.connections.push(connection);
    return Promise.resolve(connection);
  }
}

export class LocalShellConnection implements RemoteShellConnection {
  readonly sandboxId = 'local';
  closed = false;
  runs = 0;

  constructor(private readonly host: ShellHost) {}

  readFile(path: string): Promise<Uint8Array> {
    return readFile(path);
  }

  writeFile(path: string, content: Uint8Array): Promise<void> {
    return writeFile(path, content);
  }

  run(argv: readonly string[], options: RemoteRunOptions): Promise<RemoteRunResult> {
    this.runs++;
    const child = this.start(argv, options.cwd, {}, false);
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

  spawn(argv: readonly string[], options: RemoteSpawnOptions): Promise<RemoteProcess> {
    const child = this.start(argv, options.cwd, options.env, true);
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

  close(): Promise<void> {
    this.closed = true;
    return Promise.resolve();
  }

  private start(
    argv: readonly string[],
    cwd: string,
    env: Record<string, string>,
    stdin: boolean
  ): ReturnType<typeof spawn> {
    const stdio: ['pipe' | 'ignore', 'pipe', 'pipe'] = [stdin ? 'pipe' : 'ignore', 'pipe', 'pipe'];
    if (this.host.kind === 'native') {
      return spawn(argv[0], argv.slice(1), {
        cwd,
        env: { PATH: process.env.PATH ?? '/usr/bin:/bin', LANG: 'C.UTF-8', ...env },
        stdio,
      });
    }
    const flags = Object.entries(env).flatMap(([name, value]) => ['-e', `${name}=${value}`]);
    return spawn(
      'docker',
      ['exec', ...(stdin ? ['-i'] : []), '-w', cwd, ...flags, this.host.container, ...argv],
      { stdio }
    );
  }
}
