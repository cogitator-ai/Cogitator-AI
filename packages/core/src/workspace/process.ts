import { spawn, type ChildProcess } from 'node:child_process';
import { StringDecoder } from 'node:string_decoder';
import { WorkspaceError, type WorkspaceExecResult } from '@cogitator-ai/types';

/** What a workspace would spawn for a command, see `LocalWorkspaceExecConfig.launch`. */
export interface WorkspaceLaunch {
  /** The program, e.g. `/bin/sh` */
  file: string;
  /** Its arguments, e.g. `['-c', command]` */
  args: string[];
  /** The directory it runs in, inside the root */
  cwd: string;
  /** Its whole environment */
  env: Record<string, string>;
}

/** The process groups a workspace started, kept until they are gone, so `dispose()` can end them. */
export class ProcessGroups {
  private readonly groups = new Set<number>();
  private readonly children = new Set<ChildProcess>();

  add(child: ChildProcess): void {
    this.children.add(child);
    if (child.pid !== undefined && process.platform !== 'win32') this.groups.add(child.pid);
  }

  settled(child: ChildProcess): void {
    this.children.delete(child);
  }

  /** Forgets groups that have no process left. */
  prune(): void {
    for (const group of this.groups) if (!groupAlive(group)) this.groups.delete(group);
  }

  /** Kills every group still alive, background processes the commands left behind included. */
  killAll(): void {
    for (const group of this.groups) signalGroup(group, 'SIGKILL');
    for (const child of this.children) if (process.platform === 'win32') child.kill('SIGKILL');
    this.groups.clear();
    this.children.clear();
  }
}

export interface RunProcessOptions {
  launch: WorkspaceLaunch;
  timeout: number;
  maxOutput: number;
  /** Milliseconds between SIGTERM and SIGKILL when a command is stopped */
  killGrace: number;
  groups: ProcessGroups;
  signal?: AbortSignal;
  onStdout?: (chunk: string) => void;
  onStderr?: (chunk: string) => void;
}

/**
 * Runs `launch` in a process group of its own (outside Windows), its output streamed and capped.
 * A timeout or an abort sends SIGTERM to the whole group, SIGKILL after `killGrace`, also when
 * the shell already exited and only processes it started in the background are left.
 */
export function runProcess(options: RunProcessOptions): Promise<WorkspaceExecResult> {
  const started = Date.now();
  const windows = process.platform === 'win32';
  const stdout = new CappedText(options.maxOutput, options.onStdout);
  const stderr = new CappedText(options.maxOutput, options.onStderr);
  const { file, args, cwd, env } = options.launch;

  return new Promise<WorkspaceExecResult>((resolvePromise, reject) => {
    const child = spawn(file, args, {
      cwd,
      env,
      detached: !windows,
      windowsHide: true,
      windowsVerbatimArguments: windows,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    options.groups.add(child);
    let timedOut = false;
    let abortedBy: AbortSignal | undefined;
    let settled = false;
    let escalation: ReturnType<typeof setTimeout> | undefined;

    const stop = () => {
      if (windows || child.pid === undefined) {
        child.kill('SIGKILL');
      } else {
        const group = child.pid;
        signalGroup(group, 'SIGTERM');
        escalation = setTimeout(() => signalGroup(group, 'SIGKILL'), options.killGrace);
        escalation.unref();
      }
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

    const finish = (exitCode: number, extraStderr?: string) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      options.signal?.removeEventListener('abort', onAbort);
      options.groups.settled(child);
      if (abortedBy) {
        reject(abortError(abortedBy));
        return;
      }
      if (extraStderr) stderr.push(extraStderr);
      resolvePromise({
        stdout: stdout.text(),
        stderr: timedOut
          ? stderr.text() || `Command timed out after ${options.timeout}ms`
          : stderr.text(),
        exitCode: timedOut ? 124 : exitCode,
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
    child.on('close', (code: number | null, signal: NodeJS.Signals | null) => {
      if (escalation && !groupAlive(child.pid)) clearTimeout(escalation);
      finish(code ?? (signal ? 128 + signalNumber(signal) : 1));
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
