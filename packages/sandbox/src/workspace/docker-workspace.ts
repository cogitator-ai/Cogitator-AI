import { randomUUID } from 'node:crypto';
import { posix } from 'node:path';
import { StringDecoder } from 'node:string_decoder';
import {
  WorkspaceError,
  type SandboxDockerConfig,
  type SandboxMount,
  type SandboxNetworkConfig,
  type SandboxResourceLimits,
  type Workspace,
  type WorkspaceEntry,
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
import type { Docker, DockerContainer, DockerExec, DockerStream } from '../docker-types';
import { DockerStreamDemuxer } from '../executors/docker';
import { createSandboxContainer } from '../pool/container-pool';
import { dockerConnectionCandidates } from '../utils/docker-connection';
import { parseMemory } from '../utils/parse-resources';

const DEFAULT_IMAGE = 'alpine:3.19';
const DEFAULT_WORKDIR = '/workspace';
const DEFAULT_EXEC_TIMEOUT = 120_000;
const DEFAULT_MAX_OUTPUT_BYTES = 1024 * 1024;
const EXEC_MARKER = 'COGITATOR_WORKSPACE_EXEC';

/** The label every workspace container carries, with the workspace id as its value. */
export const WORKSPACE_CONTAINER_LABEL = 'ai.cogitator.workspace';

export interface DockerWorkspaceOptions {
  /**
   * The workspace on this machine whose root is mounted into the container: files are read and
   * written through it, with its path guard, and commands run in the container on the same
   * files. Usually a `LocalWorkspace` from `@cogitator-ai/core`. The Docker workspace owns it:
   * `start()` starts it and `dispose()` disposes it
   */
  host: Workspace;
  /** Id of the workspace (default: the host's) */
  id?: string;
  /** The current directory, relative to the root (default: the host's) */
  cwd?: string;
  /** Image of the container (default: `alpine:3.19`), pulled when missing */
  image?: string;
  /** Where the root is mounted in the container (default: `/workspace`) */
  workdir?: string;
  /** Memory, CPU and process limits of the container */
  resources?: SandboxResourceLimits;
  /** Network of the container (default: `{ mode: 'none' }`, no network). `allowedHosts` is not supported */
  network?: SandboxNetworkConfig;
  /** More mounts, e.g. a read-only cache */
  mounts?: SandboxMount[];
  /** Environment variables every command gets */
  env?: Record<string, string>;
  /**
   * User commands run as (default: this process's uid and gid on Linux, so files the container
   * writes stay yours, else the image's user)
   */
  user?: string;
  /** How to reach the Docker daemon (default: the socket the Docker CLI uses) */
  docker?: SandboxDockerConfig;
  /** Milliseconds before a command is killed (default: 120000) */
  timeout?: number;
  /** Bytes of stdout and of stderr a result keeps (default: 1 MiB each) */
  maxOutputBytes?: number;
}

/**
 * A workspace whose commands run in a Docker container: one long-lived container per workspace,
 * created in `start()` and removed in `dispose()`, with the host workspace's root mounted at
 * `workdir`. Files are read and written on the host through the host workspace (so its path
 * guard applies, and a symlink a command creates to a path outside the root is refused like any
 * other), commands run with `docker exec` in the matching directory of the container, without
 * network unless `network` allows it and with no capabilities. A timeout or an abort kills the
 * command and every process it started, the container keeps running.
 *
 * @example
 * ```ts
 * const workspace = new DockerWorkspace({
 *   host: new LocalWorkspace({ root: './project' }),
 *   image: 'node:24-alpine',
 *   resources: { memory: '1GB', cpus: 2 },
 * });
 * await workspace.start();
 * try {
 *   await cog.run(agent, { input: 'Run the tests and fix what fails', workspace });
 * } finally {
 *   await workspace.dispose();
 * }
 * ```
 */
export class DockerWorkspace implements Workspace {
  readonly id: string;
  readonly cwd: string;
  /** Where the root is mounted in the container */
  readonly workdir: string;
  readonly snapshot?: (options?: WorkspaceSnapshotOptions) => Promise<WorkspaceSnapshot>;
  readonly restore?: (snapshotId: string) => Promise<void>;
  private readonly options: DockerWorkspaceOptions;
  private readonly host: Workspace;
  private container?: DockerContainer;
  private starting?: Promise<void>;
  private disposed = false;

  constructor(options: DockerWorkspaceOptions) {
    if (options.network?.allowedHosts?.length) {
      throw new WorkspaceError(
        'UNSUPPORTED',
        'network.allowedHosts is not supported by DockerWorkspace, use network.mode'
      );
    }
    this.options = options;
    this.host = options.host;
    this.id = options.id ?? options.host.id;
    this.cwd = options.cwd ?? options.host.cwd;
    this.workdir = options.workdir ?? DEFAULT_WORKDIR;
    const host = options.host;
    if (host.snapshot && host.restore) {
      this.snapshot = (snapshotOptions) => host.snapshot!(snapshotOptions);
      this.restore = (snapshotId) => host.restore!(snapshotId);
    }
  }

  get root(): string {
    return this.host.root;
  }

  /** Id of the container, once started */
  get containerId(): string | undefined {
    return this.container?.id;
  }

  start(): Promise<void> {
    if (this.disposed) {
      return Promise.reject(new WorkspaceError('DISPOSED', `Workspace ${this.id} is disposed`));
    }
    this.starting ??= this.launch().catch((error: unknown) => {
      this.starting = undefined;
      throw error;
    });
    return this.starting;
  }

  async dispose(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    await this.starting?.catch(() => undefined);
    const container = this.container;
    this.container = undefined;
    if (container) await container.remove({ force: true }).catch(() => undefined);
    await this.host.dispose();
  }

  contains(path: string): Promise<boolean> {
    return this.host.contains(path);
  }

  read(path: string, options?: WorkspaceReadOptions): Promise<string> {
    return this.host.read(path, options);
  }

  readBytes(path: string, options?: WorkspaceReadOptions): Promise<Uint8Array> {
    return this.host.readBytes(path, options);
  }

  write(
    path: string,
    content: string | Uint8Array,
    options?: WorkspaceWriteOptions
  ): Promise<void> {
    return this.host.write(path, content, options);
  }

  list(path?: string, options?: WorkspaceListOptions): Promise<WorkspaceEntry[]> {
    return this.host.list(path, options);
  }

  stat(path: string): Promise<WorkspaceStat> {
    return this.host.stat(path);
  }

  exists(path: string): Promise<boolean> {
    return this.host.exists(path);
  }

  mkdir(path: string): Promise<void> {
    return this.host.mkdir(path);
  }

  remove(path: string, options?: WorkspaceRemoveOptions): Promise<WorkspaceRemoveResult> {
    return this.host.remove(path, options);
  }

  rename(from: string, to: string, options?: WorkspaceRenameOptions): Promise<void> {
    return this.host.rename(from, to, options);
  }

  async exec(command: string, options: WorkspaceExecOptions = {}): Promise<WorkspaceExecResult> {
    if (this.disposed) throw new WorkspaceError('DISPOSED', `Workspace ${this.id} is disposed`);
    const container = this.container;
    if (!container) {
      throw new WorkspaceError(
        'NOT_STARTED',
        `Workspace ${this.id} is not started, call start() first`
      );
    }
    const cwdPath = options.cwd ?? this.cwd;
    const cwd = await this.host.stat(cwdPath);
    if (cwd.type !== 'directory') {
      throw new WorkspaceError('NOT_A_DIRECTORY', `${cwdPath} is not a directory`, {
        path: cwdPath,
      });
    }
    if (options.signal?.aborted) throw aborted(options.signal);

    const timeout = options.timeout ?? this.options.timeout ?? DEFAULT_EXEC_TIMEOUT;
    const maxOutput =
      options.maxOutputBytes ?? this.options.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES;
    const marker = randomUUID();
    const env = { ...this.options.env, ...options.env, [EXEC_MARKER]: marker };
    const exec = await container.exec({
      Cmd: ['sh', '-c', command],
      Env: Object.entries(env).map(([key, value]) => `${key}=${value}`),
      WorkingDir: cwd.path === '.' ? this.workdir : posix.join(this.workdir, cwd.path),
      AttachStdout: true,
      AttachStderr: true,
    });
    return this.run(container, exec, marker, {
      timeout,
      maxOutput,
      signal: options.signal,
      onStdout: options.onStdout,
      onStderr: options.onStderr,
    });
  }

  private async launch(): Promise<void> {
    await this.host.start();
    const docker = await connect(this.options.docker);
    const memory = this.options.resources?.memory
      ? parseMemory(this.options.resources.memory)
      : undefined;
    const container = await createSandboxContainer(
      docker,
      this.options.image ?? DEFAULT_IMAGE,
      {
        memory,
        cpus: this.options.resources?.cpus,
        cpuShares: this.options.resources?.cpuShares,
        pidsLimit: this.options.resources?.pidsLimit,
        networkMode: this.options.network?.mode ?? 'none',
        dns: this.options.network?.dns,
        mounts: [{ source: this.host.root, target: this.workdir }, ...(this.options.mounts ?? [])],
        user: this.options.user ?? defaultUser(),
      },
      { labels: { [WORKSPACE_CONTAINER_LABEL]: this.id }, workingDir: this.workdir }
    ).catch((error: unknown) => {
      throw new WorkspaceError(
        'UNAVAILABLE',
        `Could not create the workspace container: ${message(error)}`,
        {
          cause: error,
        }
      );
    });
    try {
      await container.start();
    } catch (error) {
      await container.remove({ force: true }).catch(() => undefined);
      throw new WorkspaceError(
        'UNAVAILABLE',
        `Could not start the workspace container: ${message(error)}`,
        {
          cause: error,
        }
      );
    }
    if (this.disposed) {
      await container.remove({ force: true }).catch(() => undefined);
      throw new WorkspaceError('DISPOSED', `Workspace ${this.id} was disposed while starting`);
    }
    this.container = container;
  }

  private async run(
    container: DockerContainer,
    exec: DockerExec,
    marker: string,
    options: {
      timeout: number;
      maxOutput: number;
      signal?: AbortSignal;
      onStdout?: (chunk: string) => void;
      onStderr?: (chunk: string) => void;
    }
  ): Promise<WorkspaceExecResult> {
    const started = Date.now();
    const stdout = new StreamText(options.maxOutput, options.onStdout);
    const stderr = new StreamText(options.maxOutput, options.onStderr);
    const demuxer = new DockerStreamDemuxer(
      (data) => stdout.push(data),
      (data) => stderr.push(data)
    );
    const stream: DockerStream = await exec.start({ hijack: true, stdin: false });
    const finished = new Promise<void>((resolve, reject) => {
      stream.on('end', () => resolve());
      stream.on('close', () => resolve());
      stream.on('error', (error: unknown) =>
        reject(error instanceof Error ? error : new Error(String(error)))
      );
    });
    stream.on('data', (chunk: Buffer) => demuxer.push(chunk));

    let stopReason: 'timeout' | 'abort' | undefined;
    const stop = (reason: 'timeout' | 'abort') => {
      if (stopReason) return;
      stopReason = reason;
      void killMarked(container, marker).finally(() => stream.end());
    };
    const timer = setTimeout(() => stop('timeout'), options.timeout);
    const onAbort = () => stop('abort');
    options.signal?.addEventListener('abort', onAbort, { once: true });

    try {
      await finished;
    } finally {
      clearTimeout(timer);
      options.signal?.removeEventListener('abort', onAbort);
    }
    if (stopReason === 'abort' && options.signal) throw aborted(options.signal);
    const timedOut = stopReason === 'timeout';
    const exitCode = timedOut ? 124 : ((await exec.inspect()).ExitCode ?? 1);
    const err = stderr.text();
    return {
      stdout: stdout.text(),
      stderr: timedOut ? err || `Command timed out after ${options.timeout}ms` : err,
      exitCode,
      timedOut,
      truncated: stdout.truncated || stderr.truncated,
      durationMs: Date.now() - started,
    };
  }
}

/**
 * Kills, in the container, every process whose environment carries the marker of one command:
 * the command and whatever it started, even in the background, and nothing else.
 */
async function killMarked(container: DockerContainer, marker: string): Promise<void> {
  const script = `for p in /proc/[0-9]*; do if tr '\\0' '\\n' < "$p/environ" 2>/dev/null | grep -qx "${EXEC_MARKER}=${marker}"; then kill -9 "\${p#/proc/}" 2>/dev/null; fi; done`;
  try {
    const exec = await container.exec({
      Cmd: ['sh', '-c', script],
      AttachStdout: true,
      AttachStderr: true,
    });
    const stream = await exec.start({ hijack: true, stdin: false });
    await new Promise<void>((resolve) => {
      stream.on('end', () => resolve());
      stream.on('close', () => resolve());
      stream.on('error', () => resolve());
      stream.on('data', () => undefined);
    });
  } catch {
    return;
  }
}

async function connect(config: SandboxDockerConfig | undefined): Promise<Docker> {
  let Dockerode: new (options?: object) => unknown;
  try {
    Dockerode = (await import('dockerode')).default as unknown as new (options?: object) => unknown;
  } catch (error) {
    throw new WorkspaceError(
      'UNAVAILABLE',
      'DockerWorkspace needs the dockerode package: install it next to @cogitator-ai/sandbox',
      { cause: error }
    );
  }
  let lastError: unknown;
  for (const options of dockerConnectionCandidates(config)) {
    const docker = new Dockerode(options) as Docker;
    try {
      await docker.ping();
      return docker;
    } catch (error) {
      lastError = error;
    }
  }
  throw new WorkspaceError(
    'UNAVAILABLE',
    `Docker is not reachable (${message(lastError)}): start Docker, or use a LocalWorkspace`,
    { cause: lastError }
  );
}

function defaultUser(): string | undefined {
  if (process.platform !== 'linux' || !process.getuid || !process.getgid) return undefined;
  return `${process.getuid()}:${process.getgid()}`;
}

function aborted(signal: AbortSignal): WorkspaceError {
  const reason: unknown = signal.reason;
  const detail =
    reason instanceof Error ? reason.message : reason === undefined ? '' : String(reason);
  return new WorkspaceError('ABORTED', detail ? `Command aborted: ${detail}` : 'Command aborted', {
    cause: reason,
  });
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Text of a stream up to a byte limit, every piece reported as it arrives. */
class StreamText {
  private readonly decoder = new StringDecoder('utf8');
  private readonly chunks: Buffer[] = [];
  private size = 0;
  truncated = false;

  constructor(
    private readonly limit: number,
    private readonly listener?: (chunk: string) => void
  ) {}

  push(chunk: Buffer): void {
    if (this.listener) {
      const text = this.decoder.write(chunk);
      if (text) this.listener(text);
    }
    const room = this.limit - this.size;
    if (chunk.length > room) this.truncated = true;
    if (room <= 0) return;
    const kept = chunk.length > room ? chunk.subarray(0, room) : chunk;
    this.chunks.push(kept);
    this.size += kept.length;
  }

  text(): string {
    if (this.listener) {
      const rest = this.decoder.end();
      if (rest) this.listener(rest);
    }
    return new StringDecoder('utf8').end(Buffer.concat(this.chunks));
  }
}
