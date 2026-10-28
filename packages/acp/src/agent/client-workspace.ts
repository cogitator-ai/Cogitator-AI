import { dirname, isAbsolute, relative, resolve } from 'node:path';
import type { AgentContext, ClientCapabilities, TerminalHandle } from '@agentclientprotocol/sdk';
import {
  WorkspaceError,
  type Workspace,
  type WorkspaceEmptyTrashOptions,
  type WorkspaceEmptyTrashResult,
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
  type WorkspaceSandbox,
  type WorkspaceSnapshot,
  type WorkspaceSnapshotOptions,
  type WorkspaceStat,
  type WorkspaceTrashEntry,
  type WorkspaceTrashRestoreOptions,
  type WorkspaceTrashRestoreResult,
  type WorkspaceWriteOptions,
} from '@cogitator-ai/types';

/** Milliseconds a command runs in a terminal of the client when the call sets none */
export const DEFAULT_TERMINAL_TIMEOUT = 120_000;
/** Bytes of a command's output a terminal of the client keeps when the call sets none */
export const DEFAULT_TERMINAL_OUTPUT_BYTES = 1024 * 1024;

export interface AcpClientWorkspaceOptions {
  /**
   * The workspace on this machine at the session's directory: what the client does not do
   * (listings, removals, renames, the trash, snapshots) goes to it, and so does what the client
   * did not offer
   */
  base: Workspace;
  /** The client of the ACP connection */
  client: AgentContext;
  sessionId: string;
  /** What the client said it does in `initialize` */
  capabilities: ClientCapabilities | undefined;
  /** Hears each terminal of the client a command runs in, once it started */
  onTerminal?: (terminalId: string, command: string) => void | Promise<void>;
  /** Milliseconds a command may run when the call sets none (default 120 000) */
  timeout?: number;
}

/**
 * A `Workspace` over an ACP client: files are read and written through the editor
 * (`fs/read_text_file`, `fs/write_text_file`), so the agent sees unsaved changes and the editor
 * tracks its edits, and commands run in the editor's terminals (`terminal/*`), each as it
 * advertised. Everything else goes to the workspace on this machine it wraps, which also keeps
 * every path inside the session's directory.
 *
 * A terminal of the client gives one stream of output, which a command's result holds as its
 * `stdout`, and its commands do not run in this machine's OS sandbox.
 */
export class AcpClientWorkspace implements Workspace {
  readonly sandbox?: WorkspaceSandbox;
  readonly listTrash?: () => Promise<WorkspaceTrashEntry[]>;
  readonly restoreFromTrash?: (
    id: string,
    options?: WorkspaceTrashRestoreOptions
  ) => Promise<WorkspaceTrashRestoreResult>;
  readonly emptyTrash?: (
    options?: WorkspaceEmptyTrashOptions
  ) => Promise<WorkspaceEmptyTrashResult>;
  readonly snapshot?: (options?: WorkspaceSnapshotOptions) => Promise<WorkspaceSnapshot>;
  readonly restore?: (
    snapshotId: string,
    options?: WorkspaceRestoreOptions
  ) => Promise<WorkspaceRestoreResult>;
  readonly holdForRestore?: () => () => void;
  readonly listSnapshots?: () => Promise<WorkspaceSnapshot[]>;
  readonly deleteSnapshot?: (snapshotId: string) => Promise<void>;
  readonly copySnapshot?: (snapshotId: string, target: Workspace) => Promise<WorkspaceSnapshot>;

  private readonly base: Workspace;
  private readonly reads: boolean;
  private readonly writes: boolean;
  private readonly terminals: boolean;

  constructor(private readonly options: AcpClientWorkspaceOptions) {
    const base = options.base;
    this.base = base;
    this.reads = options.capabilities?.fs?.readTextFile === true;
    this.writes = options.capabilities?.fs?.writeTextFile === true;
    this.terminals = options.capabilities?.terminal === true;
    if (!this.terminals && base.sandbox) this.sandbox = base.sandbox;
    if (base.listTrash) this.listTrash = () => base.listTrash!();
    if (base.restoreFromTrash) {
      this.restoreFromTrash = (id, restoreOptions) => base.restoreFromTrash!(id, restoreOptions);
    }
    if (base.emptyTrash) this.emptyTrash = (emptyOptions) => base.emptyTrash!(emptyOptions);
    if (base.snapshot) this.snapshot = (snapshotOptions) => base.snapshot!(snapshotOptions);
    if (base.restore) this.restore = (id, restoreOptions) => base.restore!(id, restoreOptions);
    if (base.holdForRestore) this.holdForRestore = () => base.holdForRestore!();
    if (base.listSnapshots) this.listSnapshots = () => base.listSnapshots!();
    if (base.deleteSnapshot) this.deleteSnapshot = (id) => base.deleteSnapshot!(id);
    if (base.copySnapshot) this.copySnapshot = (id, target) => base.copySnapshot!(id, target);
  }

  get id(): string {
    return this.base.id;
  }

  get root(): string {
    return this.base.root;
  }

  get cwd(): string {
    return this.base.cwd;
  }

  /** Whether the client reads files, writes them and runs commands, as it advertised */
  get uses(): { read: boolean; write: boolean; terminal: boolean } {
    return { read: this.reads, write: this.writes, terminal: this.terminals };
  }

  start(): Promise<void> {
    return this.base.start();
  }

  dispose(): Promise<void> {
    return this.base.dispose();
  }

  withCwd(cwd: string): Workspace {
    return new AcpClientWorkspace({ ...this.options, base: this.base.withCwd(cwd) });
  }

  contains(path: string): Promise<boolean> {
    return this.base.contains(path);
  }

  async read(path: string, options?: WorkspaceReadOptions): Promise<string> {
    if (!this.reads) return this.base.read(path, options);
    const absolute = await this.inside(path);
    const content = await this.clientRead(absolute, path);
    if (options?.maxBytes !== undefined && Buffer.byteLength(content) > options.maxBytes) {
      throw new WorkspaceError('TOO_LARGE', `${path} is larger than ${options.maxBytes} bytes`, {
        path,
      });
    }
    return content;
  }

  /**
   * The bytes of a file: a binary file's from this machine, a text file's through the editor, so
   * an edit reads what the editor holds
   */
  async readBytes(path: string, options?: WorkspaceReadOptions): Promise<Uint8Array> {
    if (!this.reads) return this.base.readBytes(path, options);
    let local: Uint8Array | undefined;
    try {
      local = await this.base.readBytes(path, options);
    } catch (error) {
      if (!WorkspaceError.is(error, 'NOT_FOUND')) throw error;
    }
    if (local && looksBinary(local)) return local;
    try {
      return new TextEncoder().encode(await this.read(path, options));
    } catch (error) {
      if (local) return local;
      throw error;
    }
  }

  async write(
    path: string,
    content: string | Uint8Array,
    options?: WorkspaceWriteOptions
  ): Promise<void> {
    const text = typeof content === 'string' ? content : utf8(content);
    if (!this.writes || text === undefined) return this.base.write(path, content, options);
    const absolute = await this.inside(path);
    if (options?.maxBytes !== undefined && Buffer.byteLength(text) > options.maxBytes) {
      throw new WorkspaceError(
        'TOO_LARGE',
        `The content is larger than ${options.maxBytes} bytes`,
        {
          path,
        }
      );
    }
    const parent = relative(this.base.root, dirname(absolute));
    if (options?.createParents !== false && parent !== '') await this.base.mkdir(parent);
    try {
      await this.options.client.request('fs/write_text_file', {
        sessionId: this.options.sessionId,
        path: absolute,
        content: text,
      });
    } catch (error) {
      throw new WorkspaceError('IO', `The editor could not write ${path}: ${messageOf(error)}`, {
        path,
        cause: error,
      });
    }
  }

  list(path?: string, options?: WorkspaceListOptions): Promise<WorkspaceEntry[]> {
    return this.base.list(path, options);
  }

  stat(path: string): Promise<WorkspaceStat> {
    return this.base.stat(path);
  }

  exists(path: string): Promise<boolean> {
    return this.base.exists(path);
  }

  mkdir(path: string): Promise<void> {
    return this.base.mkdir(path);
  }

  remove(path: string, options?: WorkspaceRemoveOptions): Promise<WorkspaceRemoveResult> {
    return this.base.remove(path, options);
  }

  rename(from: string, to: string, options?: WorkspaceRenameOptions): Promise<void> {
    return this.base.rename(from, to, options);
  }

  async exec(command: string, options: WorkspaceExecOptions = {}): Promise<WorkspaceExecResult> {
    if (!this.terminals) return this.base.exec(command, options);
    const started = Date.now();
    const cwd = resolve(this.base.root, options.cwd ?? this.base.cwd);
    if (!(await this.base.contains(cwd))) {
      throw new WorkspaceError('OUTSIDE_ROOT', `${options.cwd ?? cwd} is outside the workspace`, {
        path: options.cwd ?? cwd,
      });
    }
    if (options.signal?.aborted) throw aborted(command);
    const shell =
      process.platform === 'win32'
        ? { command: 'cmd.exe', args: ['/d', '/s', '/c', command] }
        : { command: '/bin/sh', args: ['-c', command] };
    let terminal: TerminalHandle;
    try {
      terminal = await this.options.client.createTerminal({
        sessionId: this.options.sessionId,
        ...shell,
        cwd,
        env: Object.entries(options.env ?? {}).map(([name, value]) => ({ name, value })),
        outputByteLimit: options.maxOutputBytes ?? DEFAULT_TERMINAL_OUTPUT_BYTES,
      });
    } catch (error) {
      throw new WorkspaceError(
        'UNAVAILABLE',
        `The editor could not open a terminal: ${messageOf(error)}`,
        { cause: error }
      );
    }
    try {
      await this.options.onTerminal?.(terminal.id, command);
      const outcome = await settle(
        terminal.waitForExit(),
        options.timeout ?? this.options.timeout ?? DEFAULT_TERMINAL_TIMEOUT,
        options.signal
      );
      if (outcome.kind !== 'exited') await terminal.kill().catch(() => undefined);
      if (outcome.kind === 'aborted') throw aborted(command);
      const output = await terminal.currentOutput();
      options.onStdout?.(output.output);
      const status = outcome.kind === 'exited' ? outcome.status : output.exitStatus;
      return {
        stdout: output.output,
        stderr: '',
        exitCode: outcome.kind === 'timedOut' ? 124 : exitCodeOf(status),
        timedOut: outcome.kind === 'timedOut',
        truncated: output.truncated,
        durationMs: Date.now() - started,
      };
    } finally {
      await terminal.release().catch(() => undefined);
    }
  }

  /** The absolute path of `path`, refused outside the root as the workspace on this machine does */
  private async inside(path: string): Promise<string> {
    if (path === '' || path.includes('\0')) {
      throw new WorkspaceError('INVALID_PATH', `Invalid path ${JSON.stringify(path)}`, { path });
    }
    const absolute = isAbsolute(path) ? resolve(path) : resolve(this.base.root, path);
    if (!(await this.base.contains(absolute))) {
      throw new WorkspaceError('OUTSIDE_ROOT', `${path} is outside the workspace`, { path });
    }
    return absolute;
  }

  private async clientRead(absolute: string, path: string): Promise<string> {
    try {
      const response = await this.options.client.request('fs/read_text_file', {
        sessionId: this.options.sessionId,
        path: absolute,
      });
      return response.content;
    } catch (error) {
      if (!(await this.base.exists(path).catch(() => false))) {
        throw new WorkspaceError('NOT_FOUND', `${path} does not exist`, { path, cause: error });
      }
      throw new WorkspaceError('IO', `The editor could not read ${path}: ${messageOf(error)}`, {
        path,
        cause: error,
      });
    }
  }
}

type Outcome =
  | { kind: 'exited'; status: { exitCode?: number | null; signal?: string | null } }
  | { kind: 'timedOut' }
  | { kind: 'aborted' };

function settle(
  exit: Promise<{ exitCode?: number | null; signal?: string | null }>,
  timeout: number,
  signal: AbortSignal | undefined
): Promise<Outcome> {
  return new Promise<Outcome>((done, fail) => {
    const timer = setTimeout(() => finish({ kind: 'timedOut' }), timeout);
    const onAbort = () => finish({ kind: 'aborted' });
    const finish = (outcome: Outcome) => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      done(outcome);
    };
    signal?.addEventListener('abort', onAbort, { once: true });
    exit.then(
      (status) => finish({ kind: 'exited', status }),
      (error: unknown) => {
        clearTimeout(timer);
        signal?.removeEventListener('abort', onAbort);
        fail(error instanceof Error ? error : new Error(String(error)));
      }
    );
  });
}

const SIGNALS: Readonly<Record<string, number>> = {
  SIGHUP: 1,
  SIGINT: 2,
  SIGQUIT: 3,
  SIGKILL: 9,
  SIGSEGV: 11,
  SIGPIPE: 13,
  SIGTERM: 15,
};

function exitCodeOf(
  status: { exitCode?: number | null; signal?: string | null } | null | undefined
): number {
  if (typeof status?.exitCode === 'number') return status.exitCode;
  if (status?.signal) return 128 + (SIGNALS[status.signal] ?? 15);
  return 1;
}

function aborted(command: string): WorkspaceError {
  return new WorkspaceError('ABORTED', `The command was aborted: ${command}`);
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function utf8(bytes: Uint8Array): string | undefined {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    return undefined;
  }
}

function looksBinary(bytes: Uint8Array): boolean {
  const sniff = bytes.subarray(0, 8192);
  if (sniff.includes(0)) return true;
  try {
    new TextDecoder('utf-8', { fatal: true }).decode(sniff, { stream: true });
    return false;
  } catch {
    return true;
  }
}
