import { hostname } from 'node:os';
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
const DEFAULT_KILL_GRACE = 2_000;
const DEFAULT_RESOURCES: Required<Pick<SandboxResourceLimits, 'memory' | 'cpus' | 'pidsLimit'>> = {
  memory: '2GB',
  cpus: 2,
  pidsLimit: 512,
};
const EXEC_WRAPPER = 'printf "%s\\n" "$$" >&2; exec sh -c "$1"';

/** The label every workspace container carries, with the workspace id as its value. */
export const WORKSPACE_CONTAINER_LABEL = 'ai.cogitator.workspace';
/** The label naming the host root a workspace container mounts. */
export const WORKSPACE_ROOT_LABEL = 'ai.cogitator.workspace.root';
/** The label naming the process that created a workspace container, as `<hostname>:<pid>`. */
export const WORKSPACE_OWNER_LABEL = 'ai.cogitator.workspace.owner';

export interface DockerWorkspaceOptions {
  /**
   * The workspace on this machine whose root is mounted into the container: files are read and
   * written through it, with its path guard, and commands run in the container on the same
   * files. Usually a `LocalWorkspace` from `@cogitator-ai/core`. The Docker workspace owns it:
   * `dispose()` disposes it
   */
  host: Workspace;
  /** Id of the workspace (default: the host's) */
  id?: string;
  /** The current directory, relative to the root (default: the host's) */
  cwd?: string;
  /** Image of the container (default: `alpine:3.19`), pulled when missing. It needs `sh` */
  image?: string;
  /** Where the root is mounted in the container (default: `/workspace`) */
  workdir?: string;
  /** Memory, CPU and process limits of the container (default: 2 GB, 2 CPUs, 512 processes) */
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
  /** Milliseconds between SIGTERM and SIGKILL when a command is stopped (default: 2000) */
  killGrace?: number;
}

/** What a workspace and its `withCwd()` views share. */
interface DockerWorkspaceState {
  container?: DockerContainer;
  starting?: Promise<DockerContainer>;
  disposed: boolean;
}

/**
 * A workspace whose commands run in a Docker container: one long-lived container per workspace,
 * created on first use (or in `start()`) and removed in `dispose()`, with the host workspace's
 * root mounted at `workdir`. Files are read and written on the host through the host workspace
 * (so its path guard applies, and a symlink a command creates to a path outside the root is
 * refused like any other), and a path under `workdir`, as commands print them, is taken as the
 * same path under the root. Commands run with `docker exec` in the matching directory, without
 * network unless `network` allows it, with no capabilities, an init process and default limits.
 *
 * Each command runs in a process group of its own, and a timeout or an abort sends SIGTERM to
 * that group, SIGKILL after `killGrace`: background processes and processes with a cleared
 * environment go too. A process that deliberately starts a new session (`setsid`) escapes the
 * group and lives on until `dispose()` removes the container. The image needs `sh` (distroless
 * images without a shell cannot run commands). When the container starts, containers of the same
 * root left behind by a process of this machine that is gone are removed.
 *
 * @example
 * ```ts
 * const workspace = new DockerWorkspace({
 *   host: new LocalWorkspace({ root: './project' }),
 *   image: 'node:24-alpine',
 *   resources: { memory: '4GB', cpus: 2 },
 * });
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
  private readonly state: DockerWorkspaceState;

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
    this.workdir = posix.resolve('/', options.workdir ?? DEFAULT_WORKDIR);
    this.cwd = normalizeCwd(options.cwd ?? options.host.cwd);
    this.state = { disposed: false };
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
    return this.state.container?.id;
  }

  async start(): Promise<void> {
    await this.ready();
  }

  async dispose(): Promise<void> {
    if (this.state.disposed) return;
    this.state.disposed = true;
    const container = await this.state.starting?.catch(() => undefined);
    this.state.container = undefined;
    if (container) await container.remove({ force: true }).catch(() => undefined);
    await this.host.dispose();
  }

  withCwd(cwd: string): DockerWorkspace {
    const view: DockerWorkspace = Object.create(DockerWorkspace.prototype);
    return Object.assign(view, this, { cwd: normalizeCwd(cwd) });
  }

  contains(path: string): Promise<boolean> {
    return this.host.contains(this.toHost(path));
  }

  read(path: string, options?: WorkspaceReadOptions): Promise<string> {
    return this.host.read(this.toHost(path), options);
  }

  readBytes(path: string, options?: WorkspaceReadOptions): Promise<Uint8Array> {
    return this.host.readBytes(this.toHost(path), options);
  }

  write(
    path: string,
    content: string | Uint8Array,
    options?: WorkspaceWriteOptions
  ): Promise<void> {
    return this.host.write(this.toHost(path), content, options);
  }

  list(path?: string, options?: WorkspaceListOptions): Promise<WorkspaceEntry[]> {
    return this.host.list(path === undefined ? undefined : this.toHost(path), options);
  }

  stat(path: string): Promise<WorkspaceStat> {
    return this.host.stat(this.toHost(path));
  }

  exists(path: string): Promise<boolean> {
    return this.host.exists(this.toHost(path));
  }

  mkdir(path: string): Promise<void> {
    return this.host.mkdir(this.toHost(path));
  }

  remove(path: string, options?: WorkspaceRemoveOptions): Promise<WorkspaceRemoveResult> {
    return this.host.remove(this.toHost(path), options);
  }

  rename(from: string, to: string, options?: WorkspaceRenameOptions): Promise<void> {
    return this.host.rename(this.toHost(from), this.toHost(to), options);
  }

  async exec(command: string, options: WorkspaceExecOptions = {}): Promise<WorkspaceExecResult> {
    if (options.signal?.aborted) throw aborted(options.signal);
    const container = await this.ready();
    const cwdPath = this.toHost(options.cwd ?? this.cwd);
    const cwd = await this.host.stat(cwdPath);
    if (cwd.type !== 'directory') {
      throw new WorkspaceError('NOT_A_DIRECTORY', `${cwdPath} is not a directory`, {
        path: cwdPath,
      });
    }
    return this.run(container, command, {
      workingDir: cwd.path === '.' ? this.workdir : posix.join(this.workdir, cwd.path),
      env: { ...this.options.env, ...options.env },
      timeout: options.timeout ?? this.options.timeout ?? DEFAULT_EXEC_TIMEOUT,
      maxOutput: options.maxOutputBytes ?? this.options.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES,
      killGrace: this.options.killGrace ?? DEFAULT_KILL_GRACE,
      signal: options.signal,
      onStdout: options.onStdout,
      onStderr: options.onStderr,
    });
  }

  /** A path as the host workspace takes it: one under `workdir` (a container path) is mapped to the root. */
  private toHost(path: string): string {
    if (typeof path !== 'string' || !path.startsWith('/')) return path;
    const normalized = posix.resolve(path);
    if (normalized === this.workdir) return '.';
    if (normalized.startsWith(`${this.workdir}/`)) return normalized.slice(this.workdir.length + 1);
    return path;
  }

  private ready(): Promise<DockerContainer> {
    if (this.state.disposed) {
      return Promise.reject(new WorkspaceError('DISPOSED', `Workspace ${this.id} is disposed`));
    }
    this.state.starting ??= this.launch().catch((error: unknown) => {
      this.state.starting = undefined;
      throw error;
    });
    return this.state.starting;
  }

  private async launch(): Promise<DockerContainer> {
    await this.host.start();
    const docker = await connect(this.options.docker);
    await removeOrphans(docker, this.host.root);
    const resources = { ...DEFAULT_RESOURCES, ...this.options.resources };
    const container = await createSandboxContainer(
      docker,
      this.options.image ?? DEFAULT_IMAGE,
      {
        memory: parseMemory(resources.memory),
        cpus: resources.cpus,
        cpuShares: resources.cpuShares,
        pidsLimit: resources.pidsLimit,
        networkMode: this.options.network?.mode ?? 'none',
        dns: this.options.network?.dns,
        mounts: [{ source: this.host.root, target: this.workdir }, ...(this.options.mounts ?? [])],
        user: this.options.user ?? defaultUser(),
      },
      {
        labels: {
          [WORKSPACE_CONTAINER_LABEL]: this.id,
          [WORKSPACE_ROOT_LABEL]: this.host.root,
          [WORKSPACE_OWNER_LABEL]: `${hostname()}:${process.pid}`,
        },
        workingDir: this.workdir,
        init: true,
      }
    ).catch((error: unknown) => {
      throw new WorkspaceError(
        'UNAVAILABLE',
        `Could not create the workspace container: ${message(error)}`,
        { cause: error }
      );
    });
    try {
      await container.start();
    } catch (error) {
      await container.remove({ force: true }).catch(() => undefined);
      throw new WorkspaceError(
        'UNAVAILABLE',
        `Could not start the workspace container: ${message(error)}`,
        { cause: error }
      );
    }
    if (this.state.disposed) {
      await container.remove({ force: true }).catch(() => undefined);
      throw new WorkspaceError('DISPOSED', `Workspace ${this.id} was disposed while starting`);
    }
    this.state.container = container;
    return container;
  }

  private async run(
    container: DockerContainer,
    command: string,
    options: {
      workingDir: string;
      env: Record<string, string>;
      timeout: number;
      maxOutput: number;
      killGrace: number;
      signal?: AbortSignal;
      onStdout?: (chunk: string) => void;
      onStderr?: (chunk: string) => void;
    }
  ): Promise<WorkspaceExecResult> {
    const started = Date.now();
    const stdout = new StreamText(options.maxOutput, options.onStdout);
    const stderr = new StreamText(options.maxOutput, options.onStderr);
    let group: number | undefined;
    let header = Buffer.alloc(0);
    const demuxer = new DockerStreamDemuxer(
      (data) => stdout.push(data),
      (data) => {
        if (group !== undefined) {
          stderr.push(data);
          return;
        }
        header = Buffer.concat([header, data]);
        const end = header.indexOf(0x0a);
        if (end === -1) return;
        group = Number(header.subarray(0, end).toString('utf8').trim());
        const rest = header.subarray(end + 1);
        if (rest.length > 0) stderr.push(rest);
        if (stopReason) void stopGroup();
      }
    );

    let stopReason: 'timeout' | 'abort' | undefined;
    let stream: DockerStream | undefined;
    let releaseRead: () => void = () => undefined;
    const readReleased = new Promise<void>((resolve) => {
      releaseRead = resolve;
    });
    const stopGroup = async () => {
      if (group !== undefined && Number.isInteger(group) && group > 1) {
        await signalGroup(container, group, 'TERM');
        const kill = setTimeout(
          () => void signalGroup(container, group!, 'KILL'),
          options.killGrace
        );
        kill.unref();
      }
      const bound = setTimeout(() => {
        stream?.end();
        releaseRead();
      }, options.killGrace + 1_000);
      bound.unref();
    };
    const stop = (reason: 'timeout' | 'abort') => {
      if (stopReason) return;
      stopReason = reason;
      void stopGroup();
    };
    const onAbort = () => stop('abort');
    options.signal?.addEventListener('abort', onAbort, { once: true });
    const timer = setTimeout(() => stop('timeout'), options.timeout);

    try {
      if (options.signal?.aborted) throw aborted(options.signal);
      const exec: DockerExec = await container
        .exec({
          Cmd: ['sh', '-c', EXEC_WRAPPER, 'cogitator-exec', command],
          Env: Object.entries(options.env).map(([key, value]) => `${key}=${value}`),
          WorkingDir: options.workingDir,
          AttachStdout: true,
          AttachStderr: true,
        })
        .catch((error: unknown) => {
          throw ioError('Could not run the command in the container', error);
        });
      stream = await exec.start({ hijack: true, stdin: false }).catch((error: unknown) => {
        throw ioError('Could not start the command in the container', error);
      });
      const active = stream;
      const finished = new Promise<void>((resolve, reject) => {
        active.on('end', () => resolve());
        active.on('close', () => resolve());
        active.on('error', (error: unknown) =>
          reject(ioError('The command output stream failed', error))
        );
      });
      active.on('data', (chunk: Buffer) => demuxer.push(chunk));
      if (options.signal?.aborted) stop('abort');

      await Promise.race([finished, readReleased]);
      if (stopReason === 'abort' && options.signal) throw aborted(options.signal);
      const timedOut = stopReason === 'timeout';
      const exitCode = timedOut
        ? 124
        : await exec.inspect().then(
            (inspection) => inspection.ExitCode ?? 1,
            (error: unknown) => {
              throw ioError('Could not read the exit code of the command', error);
            }
          );
      const err = stderr.text();
      return {
        stdout: stdout.text(),
        stderr: timedOut ? err || `Command timed out after ${options.timeout}ms` : err,
        exitCode,
        timedOut,
        truncated: stdout.truncated || stderr.truncated,
        durationMs: Date.now() - started,
      };
    } finally {
      clearTimeout(timer);
      options.signal?.removeEventListener('abort', onAbort);
    }
  }
}

/** Sends a signal to the process group of one command, with the container's own `kill`. */
async function signalGroup(
  container: DockerContainer,
  group: number,
  signal: 'TERM' | 'KILL'
): Promise<void> {
  try {
    const exec = await container.exec({
      Cmd: ['sh', '-c', `kill -${signal} -${group} 2>/dev/null; true`],
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

/**
 * Removes workspace containers of `root` that a process of this machine created and that
 * outlived it (a crash, a kill), so they do not keep the root mounted.
 */
async function removeOrphans(docker: Docker, root: string): Promise<void> {
  if (!docker.listContainers || !docker.getContainer) return;
  const containers = await docker
    .listContainers({ all: true, filters: { label: [`${WORKSPACE_ROOT_LABEL}=${root}`] } })
    .catch(() => []);
  const here = hostname();
  for (const summary of containers) {
    const [owner, pid] = (summary.Labels?.[WORKSPACE_OWNER_LABEL] ?? '').split(/:(?=\d+$)/);
    if (owner !== here || !pid || processAlive(Number(pid))) continue;
    await docker
      .getContainer(summary.Id)
      .remove({ force: true })
      .catch(() => undefined);
  }
}

function processAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error instanceof Error && 'code' in error && error.code === 'EPERM';
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

function normalizeCwd(cwd: string): string {
  if (cwd === '' || cwd === '.') return '.';
  if (cwd.startsWith('/')) {
    throw new WorkspaceError('INVALID_PATH', 'cwd must be relative to the root', { path: cwd });
  }
  const normalized = posix.normalize(cwd).replace(/\/+$/, '');
  if (normalized === '..' || normalized.startsWith('../')) {
    throw new WorkspaceError('OUTSIDE_ROOT', `${cwd} is outside the workspace`, { path: cwd });
  }
  return normalized === '' || normalized === '.' ? '.' : normalized;
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

function ioError(what: string, error: unknown): WorkspaceError {
  if (error instanceof WorkspaceError) return error;
  return new WorkspaceError('IO', `${what}: ${message(error)}`, { cause: error });
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
