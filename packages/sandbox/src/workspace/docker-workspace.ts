import { randomUUID } from 'node:crypto';
import { readFile, readlink } from 'node:fs/promises';
import { hostname, uptime } from 'node:os';
import { posix } from 'node:path';
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
  type WorkspaceRestoreOptions,
  type WorkspaceRestoreResult,
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
import {
  aborted,
  ioError,
  MarkerScanner,
  message,
  normalizeCwd,
  StreamText,
  trimTrailingSlashes,
} from './exec-stream';

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
const STDIO_GRACE = 200;
/**
 * Runs a command as the leader of its process group, reporting the group and the exit code on
 * stderr with marker lines. The token that makes them unforgeable comes on stdin, which the
 * wrapper reads before the command starts: it is in no argv or environment the command can read.
 */
const EXEC_WRAPPER =
  'IFS= read -r t; printf "__cogitator_%s_pgid:%s\\n" "$t" "$$" >&2; sh -c "$1" </dev/null; c=$?; printf "__cogitator_%s_exit:%s\\n" "$t" "$c" >&2; exit $c';
const REMOVE_SCRIPT = [
  '[ -e "$1" ] || [ -L "$1" ] || exit 44',
  'case "$2" in',
  '  trash) mkdir -p -- "$(dirname -- "$3")" && mv -T -- "$1" "$3" ;;',
  '  recursive) rm -rf -- "$1" ;;',
  '  *) if [ -d "$1" ] && [ ! -L "$1" ]; then rmdir -- "$1" 2>/dev/null || exit 45; else rm -f -- "$1"; fi ;;',
  'esac',
].join('\n');
const RENAME_SCRIPT = [
  '[ -e "$1" ] || [ -L "$1" ] || exit 44',
  'if [ -e "$2" ] || [ -L "$2" ]; then [ "$3" = 1 ] || exit 46; fi',
  'mkdir -p -- "$(dirname -- "$2")" || exit 1',
  'if [ "$3" = 1 ]; then mv -f -T -- "$1" "$2"; else mv -n -T -- "$1" "$2" && [ ! -e "$1" ] && [ ! -L "$1" ] || exit 46; fi',
].join('\n');
const INTERNAL_DIRS = ['.cogitator', '.cogitator/pending'];

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
  /** Commands running in the container now */
  running: number;
  /**
   * Process groups of the commands, kept until they are found gone: a group a command left in
   * the background, or one still stopping after SIGTERM (`background: 'kill'`, a timeout, an
   * abort) until SIGKILL, may still write
   */
  kept: Set<number>;
  /** Restores changing the files now: commands are refused meanwhile */
  restoring: number;
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
  readonly restore?: (
    snapshotId: string,
    options?: WorkspaceRestoreOptions
  ) => Promise<WorkspaceRestoreResult>;
  readonly listSnapshots?: () => Promise<WorkspaceSnapshot[]>;
  readonly deleteSnapshot?: (snapshotId: string) => Promise<void>;
  readonly copySnapshot?: (snapshotId: string, target: Workspace) => Promise<WorkspaceSnapshot>;
  /**
   * The workspace on the host whose root is mounted: files are read and written, and snapshots
   * taken and restored, through it
   */
  readonly host: Workspace;
  private readonly options: DockerWorkspaceOptions;
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
    this.state = { disposed: false, running: 0, kept: new Set(), restoring: 0 };
    const host = options.host;
    if (host.snapshot && host.restore) {
      this.snapshot = (snapshotOptions) => host.snapshot!(snapshotOptions);
      this.restore = (snapshotId, restoreOptions) =>
        this.restoreInContainer(snapshotId, restoreOptions ?? {});
    }
    if (host.listSnapshots) this.listSnapshots = () => host.listSnapshots!();
    if (host.deleteSnapshot) this.deleteSnapshot = (snapshotId) => host.deleteSnapshot!(snapshotId);
    if (host.copySnapshot) {
      this.copySnapshot = (snapshotId, target) => host.copySnapshot!(snapshotId, target);
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

  /**
   * Removes in the container, where a symlink cannot reach outside the mounted root, so a
   * command that swaps directories while the removal runs cannot make it delete host files.
   */
  async remove(path: string, options: WorkspaceRemoveOptions = {}): Promise<WorkspaceRemoveResult> {
    const rel = this.inside(path);
    if (rel === '.')
      throw new WorkspaceError('INVALID_PATH', 'The root cannot be removed', { path });
    let trashedTo: string | undefined;
    if (options.trash) {
      trashedTo = `.cogitator/trash/${new Date().toISOString().replace(/[:.]/g, '-')}-${randomUUID().slice(0, 6)}/${rel}`;
      if (!(await this.host.exists('.cogitator/.gitignore'))) {
        await this.host.write('.cogitator/.gitignore', '*\n');
      }
    }
    const mode = options.trash ? 'trash' : options.recursive ? 'recursive' : 'single';
    const code = await this.internal(
      [REMOVE_SCRIPT, this.inContainer(rel), mode, trashedTo ? this.inContainer(trashedTo) : ''],
      path
    );
    if (code === 44) throw new WorkspaceError('NOT_FOUND', `${path} does not exist`, { path });
    if (code === 45) {
      throw new WorkspaceError(
        'NOT_EMPTY',
        `${path} is a directory with entries, pass recursive to remove it`,
        { path }
      );
    }
    return { path: rel, ...(trashedTo && { trashedTo }) };
  }

  /** Moves in the container, for the same reason as `remove`. */
  async rename(from: string, to: string, options: WorkspaceRenameOptions = {}): Promise<void> {
    const source = this.inside(from);
    const target = this.inside(to);
    if (source === '.' || target === '.') {
      throw new WorkspaceError('INVALID_PATH', 'The root cannot be moved', { path: from });
    }
    if (source === target) return;
    if (target.startsWith(`${source}/`)) {
      throw new WorkspaceError('INVALID_PATH', `${to} is inside ${from}`, { path: to });
    }
    const code = await this.internal(
      [
        RENAME_SCRIPT,
        this.inContainer(source),
        this.inContainer(target),
        options.overwrite ? '1' : '0',
      ],
      from
    );
    if (code === 44)
      throw new WorkspaceError('NOT_FOUND', `${from} does not exist`, { path: from });
    if (code === 46) throw new WorkspaceError('EXISTS', `${to} already exists`, { path: to });
  }

  /**
   * `path` relative to the root, normalized without touching the file system: refused when it
   * climbs out or names the workspace's own bookkeeping.
   */
  private inside(path: string): string {
    const mapped = this.toHost(path);
    if (typeof mapped !== 'string' || mapped.length === 0 || mapped.includes('\0')) {
      throw new WorkspaceError('INVALID_PATH', `Invalid path: ${JSON.stringify(path)}`, { path });
    }
    let rel: string;
    if (mapped.startsWith('/')) {
      const root = this.host.root;
      const normalized = posix.resolve(mapped);
      if (normalized !== root && !normalized.startsWith(`${root}/`)) {
        throw new WorkspaceError('OUTSIDE_ROOT', `${path} is outside the workspace`, { path });
      }
      rel = normalized === root ? '.' : normalized.slice(root.length + 1);
    } else {
      rel = trimTrailingSlashes(posix.normalize(mapped)) || '.';
    }
    if (rel === '..' || rel.startsWith('../')) {
      throw new WorkspaceError('OUTSIDE_ROOT', `${path} is outside the workspace`, { path });
    }
    if (INTERNAL_DIRS.includes(rel) || rel.startsWith('.cogitator/pending/')) {
      throw new WorkspaceError('INVALID_PATH', `${path} is the workspace's own directory`, {
        path,
      });
    }
    return rel;
  }

  private inContainer(rel: string): string {
    return rel === '.' ? this.workdir : posix.join(this.workdir, rel);
  }

  /** Runs one of the workspace's own scripts in the container, its exit code the answer. */
  private async internal(args: string[], path: string): Promise<number> {
    const container = await this.ready();
    const [script, ...rest] = args;
    try {
      const exec = await container.exec({
        Cmd: ['sh', '-c', script, 'cogitator', ...rest],
        AttachStdout: true,
        AttachStderr: true,
      });
      const stream = await exec.start({ hijack: true, stdin: false });
      const errors: Buffer[] = [];
      const demuxer = new DockerStreamDemuxer(
        () => undefined,
        (data) => errors.push(data)
      );
      await new Promise<void>((resolve, reject) => {
        stream.on('data', (chunk: Buffer) => demuxer.push(chunk));
        stream.on('end', () => resolve());
        stream.on('close', () => resolve());
        stream.on('error', (error: unknown) =>
          reject(error instanceof Error ? error : new Error(String(error)))
        );
      });
      const code = (await exec.inspect()).ExitCode ?? 1;
      if (code !== 0 && code !== 44 && code !== 45 && code !== 46) {
        const detail = Buffer.concat(errors).toString('utf8').trim().split('\n').pop() ?? '';
        throw new WorkspaceError('IO', `${path}: ${detail || `failed with exit code ${code}`}`, {
          path,
        });
      }
      return code;
    } catch (error) {
      throw ioError(`${path}`, error);
    }
  }

  async exec(command: string, options: WorkspaceExecOptions = {}): Promise<WorkspaceExecResult> {
    if (options.signal?.aborted) throw aborted(options.signal);
    if (this.state.restoring > 0) {
      throw new WorkspaceError(
        'BUSY',
        'A snapshot is being restored in the workspace: run the command once it is done'
      );
    }
    this.state.running++;
    try {
      return await this.execNow(command, options);
    } finally {
      this.state.running--;
    }
  }

  /**
   * Brings the files back to a snapshot of the host workspace. What goes is removed in the
   * container, where no symlink reaches the host, as `remove` does: the host's dry run says what,
   * and each removed tree goes at once. The host then writes what changed, through its own
   * placement, and the result lists both, as the dry run does. Refused with `BUSY` before
   * anything goes while a command runs in the container or on the host workspace, or left
   * processes in the background, which could race the changes, and a dry run says so in `busy`
   */
  private async restoreInContainer(
    snapshotId: string,
    options: WorkspaceRestoreOptions
  ): Promise<WorkspaceRestoreResult> {
    const restore = this.host.restore!.bind(this.host);
    const plan = await restore(snapshotId, { dryRun: true });
    const busy = (plan.busy ?? false) || this.state.running > 0 || (await this.keptAlive());
    if (options.dryRun) return { ...plan, busy };
    if (busy || this.state.running > 0) {
      throw new WorkspaceError(
        'BUSY',
        'The workspace cannot be restored while a command runs in its container (or left processes in the background): wait for it or dispose the workspace',
        { path: snapshotId }
      );
    }
    const releaseHost = this.host.holdForRestore?.();
    this.state.restoring++;
    try {
      return await this.restoreNow(snapshotId, plan, restore);
    } finally {
      this.state.restoring--;
      releaseHost?.();
    }
  }

  /** The removals in the container and the host's writes of a restore no command can race */
  private async restoreNow(
    snapshotId: string,
    plan: WorkspaceRestoreResult,
    restore: (
      snapshotId: string,
      options?: WorkspaceRestoreOptions
    ) => Promise<WorkspaceRestoreResult>
  ): Promise<WorkspaceRestoreResult> {
    const deleted = new Set(plan.deleted);
    const tops = plan.deleted.filter((path) => !ancestorsOf(path).some((dir) => deleted.has(dir)));
    for (const path of tops) {
      await this.remove(path, { recursive: true }).catch((error: unknown) => {
        if (!WorkspaceError.is(error, 'NOT_FOUND')) throw error;
      });
    }
    const done = await restore(snapshotId);
    return {
      ...done,
      deleted: [...new Set([...plan.deleted, ...done.deleted])].sort(),
    };
  }

  /** Whether a process group a command left in the background is still alive in the container */
  private async keptAlive(): Promise<boolean> {
    if (this.state.kept.size === 0 || !this.state.container) return false;
    const alive: number[] = [];
    for (const group of this.state.kept) {
      const code = await this.internal([GROUP_ALIVE_SCRIPT, String(group)], '.').catch(() => 0);
      if (code === 46) alive.push(group);
    }
    this.state.kept = new Set(alive);
    return alive.length > 0;
  }

  private async execNow(
    command: string,
    options: WorkspaceExecOptions
  ): Promise<WorkspaceExecResult> {
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
      background: options.background ?? 'kill',
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
      const disposed: Error = new WorkspaceError('DISPOSED', `Workspace ${this.id} is disposed`);
      return Promise.reject(disposed);
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
          [WORKSPACE_OWNER_LABEL]: await ownerLabel(),
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
      background: 'kill' | 'keep';
      signal?: AbortSignal;
      onStdout?: (chunk: string) => void;
      onStderr?: (chunk: string) => void;
    }
  ): Promise<WorkspaceExecResult> {
    const started = Date.now();
    const token = randomUUID().replace(/-/g, '');
    const stdout = new StreamText(options.maxOutput, options.onStdout);
    const stderr = new StreamText(options.maxOutput, options.onStderr);
    let group: number | undefined;
    let exitCode: number | undefined;
    let stopReason: 'timeout' | 'abort' | undefined;
    let stream: DockerStream | undefined;
    let releaseRead: () => void = () => undefined;
    const readReleased = new Promise<void>((resolve) => {
      releaseRead = resolve;
    });

    const stopGroup = (signals: 'TERM' | 'KILL') => {
      if (group === undefined) return;
      const target = group;
      const kill = () =>
        void signalGroup(container, target, 'KILL').then(() => this.state.kept.delete(target));
      if (signals === 'KILL') {
        kill();
        return;
      }
      void signalGroup(container, target, 'TERM').then(() => {
        setTimeout(kill, options.killGrace).unref();
      });
    };
    const markers = new MarkerScanner(
      token,
      (text) => stderr.pushText(text),
      (kind, value) => {
        if (kind === 'pgid') {
          group = value > 1 ? value : undefined;
          if (group !== undefined) this.state.kept.add(group);
          if (stopReason) stopGroup('TERM');
          return;
        }
        if (kind !== 'exit') return;
        exitCode = value;
        if (options.background === 'kill') stopGroup('TERM');
        setTimeout(releaseRead, STDIO_GRACE).unref();
      }
    );
    const demuxer = new DockerStreamDemuxer(
      (data) => stdout.push(data),
      (data) => markers.push(data)
    );
    const stop = (reason: 'timeout' | 'abort') => {
      if (stopReason) return;
      stopReason = reason;
      stopGroup('TERM');
      setTimeout(releaseRead, options.killGrace + 1_000).unref();
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
          AttachStdin: true,
        })
        .catch((error: unknown) => {
          throw ioError('Could not run the command in the container', error);
        });
      stream = await exec.start({ hijack: true, stdin: true }).catch((error: unknown) => {
        throw ioError('Could not start the command in the container', error);
      });
      const active = stream;
      active.write(`${token}\n`);
      active.end();
      const finished = new Promise<void>((resolve, reject) => {
        active.on('end', () => resolve());
        active.on('close', () => resolve());
        active.on('error', (error: unknown) => {
          const failure: Error = ioError('The command output stream failed', error);
          reject(failure);
        });
      });
      active.on('data', (chunk: Buffer) => demuxer.push(chunk));
      if (options.signal?.aborted) stop('abort');

      await Promise.race([finished, readReleased]);
      markers.end();
      active.end();
      active.destroy?.();
      if (stopReason === 'abort' && options.signal) throw aborted(options.signal);
      const timedOut = stopReason === 'timeout';
      const code = timedOut
        ? 124
        : (exitCode ??
          (await exec.inspect().then(
            (inspection) => inspection.ExitCode ?? 1,
            (error: unknown) => {
              throw ioError('Could not read the exit code of the command', error);
            }
          )));
      const err = stderr.text();
      return {
        stdout: stdout.text(),
        stderr: timedOut ? err || `Command timed out after ${options.timeout}ms` : err,
        exitCode: code,
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
 * Who created a container: host name, boot, PID namespace and process id. Two processes are
 * only compared by pid when the rest matches, so containers sharing a host name, a Docker socket
 * and a root (each in its own PID namespace) never remove each other's containers.
 */
export async function ownerLabel(pid = process.pid): Promise<string> {
  const boot = await readFile('/proc/sys/kernel/random/boot_id', 'utf8').then(
    (id) => id.trim(),
    () => `boot-${Math.round((Date.now() - uptime() * 1000) / 60_000)}`
  );
  const namespace = await readlink('/proc/self/ns/pid').catch(() => 'host');
  return [hostname(), boot, namespace, String(pid)].join('|');
}

/**
 * Removes workspace containers of `root` that a process of this machine (same host name, boot
 * and PID namespace) created and that outlived it (a crash, a kill), so they do not keep the root
 * mounted.
 */
async function removeOrphans(docker: Docker, root: string): Promise<void> {
  if (!docker.listContainers || !docker.getContainer) return;
  const containers = await docker
    .listContainers({ all: true, filters: { label: [`${WORKSPACE_ROOT_LABEL}=${root}`] } })
    .catch(() => []);
  const ours = (await ownerLabel(0)).split('|').slice(0, 3).join('|');
  for (const summary of containers) {
    const owner = summary.Labels?.[WORKSPACE_OWNER_LABEL] ?? '';
    const parts = owner.split('|');
    if (parts.length !== 4 || parts.slice(0, 3).join('|') !== ours) continue;
    if (processAlive(Number(parts[3]))) continue;
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

function defaultUser(): string | undefined {
  if (process.platform !== 'linux' || !process.getuid || !process.getgid) return undefined;
  return `${process.getuid()}:${process.getgid()}`;
}

/** `$1` a process group: exits 46 when a process of it is alive */
const GROUP_ALIVE_SCRIPT = 'kill -0 "-$1" 2>/dev/null && exit 46; exit 0';

/** The directories `path` is in, nearest first, the root left out */
function ancestorsOf(path: string): string[] {
  const dirs: string[] = [];
  for (let at = path.lastIndexOf('/'); at > 0; at = path.lastIndexOf('/', at - 1)) {
    dirs.push(path.slice(0, at));
  }
  return dirs;
}
