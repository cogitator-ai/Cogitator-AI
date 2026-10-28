import { spawn, type ChildProcess } from 'node:child_process';
import { StringDecoder } from 'node:string_decoder';
import {
  WorkspaceError,
  type WorkspaceExecResult,
  type WorkspaceLaunch,
} from '@cogitator-ai/types';

export type { WorkspaceLaunch };

/** Milliseconds after a command exits that its output pipes may still deliver what it wrote. */
const STDIO_GRACE = 200;

/**
 * The process groups a workspace started and that may still have processes: a group is
 * forgotten as soon as it is found empty (when its command finishes, and before every new
 * command), so `dispose()` never signals a group id the system gave to someone else since.
 */
export class ProcessGroups {
  private readonly groups = new Set<number>();
  private readonly children = new Set<ChildProcess>();

  add(child: ChildProcess): void {
    this.children.add(child);
    if (child.pid !== undefined && process.platform !== 'win32') this.groups.add(child.pid);
  }

  /** The command finished: its group is kept only while processes are left in it. */
  settled(child: ChildProcess): void {
    this.children.delete(child);
    if (child.pid !== undefined && !groupAlive(child.pid)) this.groups.delete(child.pid);
  }

  /** Whether a command is running or a group the workspace started still has processes. */
  busy(): boolean {
    this.prune();
    return this.children.size > 0 || this.groups.size > 0;
  }

  /** Forgets groups that have no process left. */
  prune(): void {
    for (const group of this.groups) if (!groupAlive(group)) this.groups.delete(group);
  }

  /** Kills every group still alive, background processes the commands left behind included. */
  killAll(): void {
    this.prune();
    for (const group of this.groups) signalGroup(group, 'SIGKILL');
    for (const child of this.children) if (process.platform === 'win32') child.kill('SIGKILL');
    this.groups.clear();
    this.children.clear();
  }
}

export interface RunProcessOptions {
  launch: Pick<WorkspaceLaunch, 'file' | 'args' | 'cwd' | 'env'>;
  /** Bytes the command reads from descriptors 3, 4 and on, see `WorkspaceLaunchOverride` */
  extraInputs?: readonly Uint8Array[];
  timeout: number;
  maxOutput: number;
  /** Milliseconds between SIGTERM and SIGKILL when a command is stopped */
  killGrace: number;
  /** What happens to background processes when the command exits */
  background: 'kill' | 'keep';
  groups: ProcessGroups;
  signal?: AbortSignal;
  onStdout?: (chunk: string) => void;
  onStderr?: (chunk: string) => void;
}

/**
 * Runs `launch` in a process group of its own (outside Windows), its output streamed and capped.
 * The call returns when the command exits (its output read for a moment more), not when every
 * process it started closed its output: with `background: 'kill'` the rest of the group is then
 * stopped, with `keep` it runs on. A timeout or an abort sends SIGTERM to the whole group,
 * SIGKILL after `killGrace`, also when the shell already exited and only processes it started
 * in the background are left.
 */
export function runProcess(options: RunProcessOptions): Promise<WorkspaceExecResult> {
  const started = Date.now();
  const windows = process.platform === 'win32';
  const stdout = new CappedText(options.maxOutput, options.onStdout);
  const stderr = new CappedText(options.maxOutput, options.onStderr);
  const { file, args, cwd, env } = options.launch;
  const extraInputs = options.extraInputs ?? [];

  return new Promise<WorkspaceExecResult>((resolvePromise, reject) => {
    const child = spawn(file, args, {
      cwd,
      env,
      detached: !windows,
      windowsHide: true,
      windowsVerbatimArguments: windows,
      stdio: ['ignore', 'pipe', 'pipe', ...extraInputs.map(() => 'pipe' as const)],
    });
    writeExtraInputs(child, extraInputs);
    options.groups.add(child);
    let timedOut = false;
    let abortedBy: AbortSignal | undefined;
    let settled = false;
    let exitCode: number | undefined;
    let drain: ReturnType<typeof setTimeout> | undefined;

    const stopGroup = () => {
      if (windows || child.pid === undefined) {
        child.kill('SIGKILL');
        return;
      }
      const group = child.pid;
      signalGroup(group, 'SIGTERM');
      setTimeout(() => {
        if (groupAlive(group)) signalGroup(group, 'SIGKILL');
      }, options.killGrace).unref();
    };
    const stop = () => {
      stopGroup();
      child.stdout?.destroy();
      child.stderr?.destroy();
    };
    const timer = setTimeout(() => {
      timedOut = true;
      stop();
    }, options.timeout);
    const onAbort = () => {
      abortedBy = options.signal;
      stop();
    };
    options.signal?.addEventListener('abort', onAbort, { once: true });
    if (options.signal?.aborted) onAbort();

    const finish = (code: number, extraStderr?: string) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (drain) clearTimeout(drain);
      options.signal?.removeEventListener('abort', onAbort);
      child.stdout?.destroy();
      child.stderr?.destroy();
      if (!timedOut && !abortedBy && options.background === 'kill') stopGroup();
      options.groups.settled(child);
      if (abortedBy) {
        const error: Error = abortError(abortedBy);
        reject(error);
        return;
      }
      if (extraStderr) stderr.push(extraStderr);
      resolvePromise({
        stdout: stdout.text(),
        stderr: timedOut
          ? stderr.text() || `Command timed out after ${options.timeout}ms`
          : stderr.text(),
        exitCode: timedOut ? 124 : code,
        timedOut,
        truncated: stdout.truncated || stderr.truncated,
        durationMs: Date.now() - started,
      });
    };

    child.stdout?.on('data', (chunk: Buffer) => stdout.push(chunk));
    child.stderr?.on('data', (chunk: Buffer) => stderr.push(chunk));
    child.on('error', (error: NodeJS.ErrnoException) => {
      const code = error.code === 'ENOENT' ? 127 : error.code === 'EACCES' ? 126 : 1;
      finish(code, error.message);
    });
    child.on('exit', (code: number | null, signal: NodeJS.Signals | null) => {
      exitCode = code ?? (signal ? 128 + signalNumber(signal) : 1);
      drain = setTimeout(() => finish(exitCode!), STDIO_GRACE);
    });
    child.on('close', (code: number | null, signal: NodeJS.Signals | null) => {
      finish(exitCode ?? code ?? (signal ? 128 + signalNumber(signal) : 1));
    });
  });
}

/** Sends `signal` to process group `group`. A group that is gone (ESRCH) or not ours (EPERM, its id reused) is left alone. */
function signalGroup(group: number, signal: NodeJS.Signals): void {
  try {
    process.kill(-group, signal);
  } catch {
    return;
  }
}

function groupAlive(group: number | undefined): boolean {
  if (group === undefined || process.platform === 'win32') return false;
  try {
    process.kill(-group, 0);
    return true;
  } catch (error) {
    return error instanceof Error && 'code' in error && error.code === 'EPERM';
  }
}

export function abortError(signal: AbortSignal): WorkspaceError {
  const reason: unknown = signal.reason;
  const detail =
    reason instanceof Error ? reason.message : reason === undefined ? '' : String(reason);
  return new WorkspaceError('ABORTED', detail ? `Command aborted: ${detail}` : 'Command aborted', {
    cause: reason,
  });
}

/** Text of a stream up to a byte limit, decoded without splitting a character, every piece reported. */
class CappedText {
  private readonly decoder = new StringDecoder('utf8');
  private readonly chunks: Buffer[] = [];
  private size = 0;
  truncated = false;

  constructor(
    private readonly limit: number,
    private readonly listener?: (chunk: string) => void
  ) {}

  push(chunk: Buffer | string): void {
    const buffer = typeof chunk === 'string' ? Buffer.from(chunk) : chunk;
    if (this.listener) {
      const text = this.decoder.write(buffer);
      if (text) this.listener(text);
    }
    const room = this.limit - this.size;
    if (buffer.length > room) this.truncated = true;
    if (room <= 0) return;
    const kept = buffer.length > room ? buffer.subarray(0, room) : buffer;
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

function signalNumber(signal: NodeJS.Signals): number {
  const numbers: Partial<Record<NodeJS.Signals, number>> = {
    SIGHUP: 1,
    SIGINT: 2,
    SIGQUIT: 3,
    SIGABRT: 6,
    SIGKILL: 9,
    SIGSEGV: 11,
    SIGPIPE: 13,
    SIGTERM: 15,
  };
  return numbers[signal] ?? 0;
}

/** Writes each of `inputs` to the pipe of descriptor 3 and on of `child`, and closes it */
export function writeExtraInputs(child: ChildProcess, inputs: readonly Uint8Array[]): void {
  inputs.forEach((bytes, index) => {
    const pipe = child.stdio[3 + index];
    if (!pipe || !('write' in pipe)) return;
    pipe.on('error', () => undefined);
    pipe.end(Buffer.from(bytes));
  });
}
