import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync } from 'node:fs';
import { formatDuration } from './guards.js';
import type { BridgeJob, JobCheck, JobCheckResult } from './types.js';

/** How much of what a check printed is kept: its end, where a failure says what went wrong. */
const OUTPUT_KEPT = 4_000;

/** How much of the output of a failed check a letter shows. */
const OUTPUT_SHOWN = 1_200;

/**
 * How long the output of a command that exited is still read, in ms. A command that leaves a
 * process of its own behind, holding the same pipes, would otherwise never be done.
 */
const DRAIN_MS = 250;

/** How long a check waits for what it killed to be gone, in ms. */
const KILL_WAIT_MS = 1_000;

/** How long a command that was told to stop gets before it is killed, in ms. */
const STOP_GRACE_MS = 2_000;

export interface RunCheckOptions {
  /** The folder the check runs in */
  cwd: string;
  timeoutMs: number;
  /** Aborting it ends the command, and the check counts as failed */
  signal?: AbortSignal;
  env?: NodeJS.ProcessEnv;
}

/** The name a check goes by: its own, else its command. */
export function checkName(check: Pick<JobCheck, 'name' | 'command'>): string {
  return check.name ?? check.command;
}

/** The end of `text`, with a mark where the start was cut off. */
function tail(text: string, max: number): string {
  const trimmed = text.trimEnd();
  return trimmed.length > max ? `...${trimmed.slice(trimmed.length - max)}` : trimmed;
}

/** A check the bridge did not run, and why. It does not confirm anything. */
export function skippedCheck(check: JobCheck, why: string): JobCheckResult {
  return { name: checkName(check), command: check.command, ok: false, skipped: why };
}

/**
 * Runs one check of a job: its command, through the shell, in `cwd`. It passes when the command
 * exits with 0. A command that runs longer than `timeoutMs`, or whose run is aborted, is ended
 * with everything it started, and the check fails only once all of it is gone. A process a
 * command that ended by itself left behind does not keep the check waiting. It never throws: a command that cannot be started is a failed check
 * that says why.
 */
export function runCheck(check: JobCheck, options: RunCheckOptions): Promise<JobCheckResult> {
  const base = { name: checkName(check), command: check.command };
  if (!existsSync(options.cwd)) {
    return Promise.resolve({
      ...base,
      ok: false,
      skipped: `the folder ${options.cwd} is not there`,
    });
  }
  if (options.signal?.aborted) {
    return Promise.resolve({ ...base, ok: false, skipped: 'the checks were stopped' });
  }
  const started = Date.now();
  return new Promise<JobCheckResult>((resolve) => {
    const group = process.platform !== 'win32';
    let output = '';
    let timedOut = false;
    let stopped = false;
    let stopping = false;
    let done = false;
    let child: ChildProcess | undefined;
    const timers: NodeJS.Timeout[] = [];
    const finish = (result: Pick<JobCheckResult, 'ok' | 'code' | 'skipped'>): void => {
      if (done) return;
      done = true;
      for (const timer of timers) clearTimeout(timer);
      options.signal?.removeEventListener('abort', onAbort);
      child?.stdout?.destroy();
      child?.stderr?.destroy();
      const said = tail(output, OUTPUT_KEPT);
      resolve({
        ...base,
        ...result,
        ...(timedOut && { timedOut: true }),
        durationMs: Date.now() - started,
        ...(said && { output: said }),
      });
    };
    const ended = (code: number | null): void => {
      if (stopped) finish({ ok: false, code, skipped: 'the checks were stopped' });
      else finish({ ok: code === 0 && !timedOut, code });
    };

    try {
      child = spawn(check.command, {
        cwd: options.cwd,
        env: options.env ?? process.env,
        shell: true,
        detached: group,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
    } catch (error) {
      finish({
        ok: false,
        skipped: `it could not be started: ${error instanceof Error ? error.message : String(error)}`,
      });
      return;
    }
    const running = child;

    const signalAll = (signal: NodeJS.Signals | 0): boolean => {
      try {
        if (group && running.pid !== undefined) return process.kill(-running.pid, signal);
        return signal === 0 ? running.exitCode === null : running.kill(signal);
      } catch {
        return false;
      }
    };
    /** Whether anything the command started is still there */
    const alive = (): boolean => signalAll(0);
    const stop = (): void => {
      stopping = true;
      signalAll('SIGTERM');
      timers.push(
        setTimeout(() => {
          signalAll('SIGKILL');
          const until = Date.now() + KILL_WAIT_MS;
          const gone = (): void => {
            if (!alive() || Date.now() >= until) ended(null);
            else timers.push(setTimeout(gone, 20));
          };
          gone();
        }, STOP_GRACE_MS)
      );
    };
    function onAbort(): void {
      stopped = true;
      stop();
    }
    timers.push(
      setTimeout(() => {
        timedOut = true;
        stop();
      }, options.timeoutMs)
    );
    options.signal?.addEventListener('abort', onAbort, { once: true });

    const keep = (chunk: string): void => {
      output = (output + chunk).slice(-2 * OUTPUT_KEPT);
    };
    running.stdout?.setEncoding('utf8').on('data', keep);
    running.stderr?.setEncoding('utf8').on('data', keep);
    running.once('error', (error) => {
      finish({ ok: false, skipped: `it could not be started: ${error.message}` });
    });
    /**
     * A command that ended by itself is done once its output is read, whatever it left running.
     * One that was told to stop is done when nothing it started is left: what ignores the
     * request is killed when the grace is over, and the check waits for that.
     */
    const exited = (code: number | null): void => {
      if (stopping && alive()) return;
      ended(code);
    };
    running.once('exit', (code) => {
      timers.push(setTimeout(() => exited(code), DRAIN_MS));
    });
    running.once('close', (code) => exited(code));
  });
}

/** How long a check ran, to the tenth of a second while that says something. */
function tookOf(ms: number): string {
  if (ms < 10_000) return `${(ms / 1000).toFixed(1)} s`;
  if (ms < 120_000) return `${Math.round(ms / 1000)} s`;
  return formatDuration(ms);
}

function lineOf(result: JobCheckResult): string {
  const took = result.durationMs === undefined ? '' : ` (${tookOf(result.durationMs)})`;
  if (result.skipped) return `- not run: ${result.name}: ${result.skipped}`;
  if (result.ok) return `- passed: ${result.name}${took}`;
  const how = result.timedOut
    ? `did not end in time${took}`
    : result.code === null || result.code === undefined
      ? `was ended by a signal${took}`
      : `exit code ${result.code}${took}`;
  return `- failed: ${result.name}: ${how}`;
}

/**
 * What the checks of a job showed, for its record and for the letter that carries its report:
 * the result is verified only when every check ran and passed. A failed check comes with the
 * end of what it printed.
 */
export function summarizeChecks(results: readonly JobCheckResult[]): {
  verified: boolean;
  summary: string;
} {
  const verified = results.length > 0 && results.every((result) => result.ok);
  const passed = results.filter((result) => result.ok).length;
  const lines = [
    verified
      ? `Verified: ${passed === 1 ? 'the check' : `all ${passed} checks`} passed.`
      : `Not verified: ${passed} of ${results.length} ${results.length === 1 ? 'check' : 'checks'} passed.`,
    ...results.map(lineOf),
  ];
  for (const result of results) {
    if (result.ok || result.skipped || !result.output) continue;
    lines.push(`The end of what "${result.name}" printed:`, tail(result.output, OUTPUT_SHOWN));
  }
  return { verified, summary: lines.join('\n') };
}

/** What the checks of a job showed. */
export interface Checked {
  /** Every check ran and passed */
  verified: boolean;
  /** A check ran and did not pass. A check the bridge left out is no failure of the work */
  failed: boolean;
  summary?: string;
}

export function checkedOf(job: Pick<BridgeJob, 'verification'>): Checked | undefined {
  const verification = job.verification;
  if (!verification) return undefined;
  return {
    verified: verification.verified,
    failed: verification.checks
      ? verification.checks.some((check) => !check.ok && check.skipped === undefined)
      : !verification.verified,
    ...(verification.summary && { summary: verification.summary }),
  };
}
