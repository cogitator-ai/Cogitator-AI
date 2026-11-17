import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { formatDuration } from './guards.js';
import type { JobCheck, JobCheckResult } from './types.js';

/** How much of what a check printed is kept: its end, where a failure says what went wrong. */
const OUTPUT_KEPT = 4_000;

/** How much of the output of a failed check a letter shows. */
const OUTPUT_SHOWN = 1_200;

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
 * with everything it started, and the check fails. It never throws: a command that cannot be
 * started is a failed check that says why.
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
    const child = spawn(check.command, {
      cwd: options.cwd,
      env: options.env ?? process.env,
      shell: true,
      detached: group,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let output = '';
    let timedOut = false;
    let stopped = false;
    let killer: NodeJS.Timeout | undefined;

    const signalAll = (signal: NodeJS.Signals): void => {
      try {
        if (group && child.pid !== undefined) process.kill(-child.pid, signal);
        else child.kill(signal);
      } catch {
        child.kill(signal);
      }
    };
    const stop = (): void => {
      signalAll('SIGTERM');
      killer = setTimeout(() => signalAll('SIGKILL'), STOP_GRACE_MS);
    };
    const timer = setTimeout(() => {
      timedOut = true;
      stop();
    }, options.timeoutMs);
    const onAbort = (): void => {
      stopped = true;
      stop();
    };
    options.signal?.addEventListener('abort', onAbort, { once: true });

    const keep = (chunk: string): void => {
      output = (output + chunk).slice(-2 * OUTPUT_KEPT);
    };
    child.stdout.setEncoding('utf8').on('data', keep);
    child.stderr.setEncoding('utf8').on('data', keep);

    let done = false;
    const finish = (result: Pick<JobCheckResult, 'ok' | 'code' | 'skipped'>): void => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      clearTimeout(killer);
      options.signal?.removeEventListener('abort', onAbort);
      const said = tail(output, OUTPUT_KEPT);
      resolve({
        ...base,
        ...result,
        ...(timedOut && { timedOut: true }),
        durationMs: Date.now() - started,
        ...(said && { output: said }),
      });
    };
    child.once('error', (error) => {
      finish({ ok: false, skipped: `it could not be started: ${error.message}` });
    });
    child.once('close', (code) => {
      if (stopped) finish({ ok: false, code, skipped: 'the checks were stopped' });
      else finish({ ok: code === 0 && !timedOut, code });
    });
  });
}

function lineOf(result: JobCheckResult): string {
  const took = result.durationMs === undefined ? '' : ` (${formatDuration(result.durationMs)})`;
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
