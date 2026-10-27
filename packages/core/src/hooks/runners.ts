/**
 * Running hook handlers: a command in its own process group, an HTTP POST to its one URL
 */

import { spawn, type ChildProcess } from 'node:child_process';
import type { CommandHookHandler, HooksConfig, HttpHookHandler } from '@cogitator-ai/types';

/** How a command hook ended */
export interface CommandOutcome {
  /** The exit code, null when it did not exit on its own (killed, or never started) */
  exitCode: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  aborted: boolean;
  /** Why it could not start */
  startError?: string;
  /** Whether stdout or stderr went past the byte limit and was cut */
  truncated: boolean;
  /**
   * Whether a process the hook left in the background held its output open after it exited: the
   * group was killed and what it printed is not trusted
   */
  heldOpen: boolean;
  durationMs: number;
}

/** A command hook running */
export interface CommandRun {
  readonly done: Promise<CommandOutcome>;
  /** Kills its process group */
  kill(): void;
}

export interface CommandOptions {
  /** The event's JSON, written to stdin */
  input: string;
  /** The project root: `CLAUDE_PROJECT_DIR` and `COGITATOR_PROJECT_DIR` */
  projectDir: string;
  /** Where it runs */
  cwd: string;
  timeoutMs: number;
  /** Bytes of stdout and of stderr kept */
  maxBytes: number;
  /** Kills it when aborted. Unset for a hook that outlives the step that started it */
  signal?: AbortSignal;
  /** The platform whose shell runs the shell form (default this process's) */
  platform?: NodeJS.Platform;
  /** Which variables of the process's environment it gets, see `HooksConfig.env` */
  env?: HooksConfig['env'];
  /** Variables it gets on top of them, such as a plugin's `CLAUDE_PLUGIN_ROOT` */
  extraEnv?: Readonly<Record<string, string>>;
}

const PLACEHOLDERS = ['CLAUDE_PROJECT_DIR', 'COGITATOR_PROJECT_DIR'] as const;

/**
 * Milliseconds a command's output is still read after it exits. A process it left in the
 * background with its output not redirected would hold the hook open: its group is killed then
 */
const CLOSE_GRACE_MS = 2000;

/** `${CLAUDE_PROJECT_DIR}` and `${COGITATOR_PROJECT_DIR}` in `text` replaced as plain text */
function substitute(text: string, projectDir: string): string {
  return PLACEHOLDERS.reduce((out, name) => out.split(`\${${name}}`).join(projectDir), text);
}

/**
 * The environment of a hook process: the process's own without the `OTEL_*` exporter variables
 * (as Claude Code removes them), or only the variables `policy` allows, and the project root
 * under its two names
 */
export function hookEnvironment(
  projectDir: string,
  policy: HooksConfig['env'] = 'inherit',
  extra: Readonly<Record<string, string>> = {}
): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  const allowed = policy === 'inherit' ? undefined : new Set(policy.allow);
  for (const [key, value] of Object.entries(process.env)) {
    if (value === undefined || key.startsWith('OTEL_')) continue;
    if (allowed && !allowed.has(key)) continue;
    env[key] = value;
  }
  Object.assign(env, extra);
  env.CLAUDE_PROJECT_DIR = projectDir;
  env.COGITATOR_PROJECT_DIR = projectDir;
  return env;
}

/** The program and arguments a command hook starts, without a shell for the exec form */
export function commandLine(
  handler: CommandHookHandler,
  projectDir: string,
  platform: NodeJS.Platform = process.platform
): { file: string; args: string[] } {
  if (handler.args !== undefined) {
    return {
      file: substitute(handler.command, projectDir),
      args: handler.args.map((arg) => substitute(arg, projectDir)),
    };
  }
  const powershell = handler.shell === 'powershell' || platform === 'win32';
  if (powershell) {
    const command = PLACEHOLDERS.reduce(
      (out, name) => out.split(`\${${name}}`).join(`\${env:${name}}`),
      handler.command
    );
    return {
      file: platform === 'win32' ? 'powershell.exe' : 'pwsh',
      args: ['-NoProfile', '-NonInteractive', '-Command', command],
    };
  }
  return { file: '/bin/sh', args: ['-c', handler.command] };
}

/**
 * Starts a command hook: the event's JSON on stdin, stdout and stderr read up to `maxBytes` each,
 * in a process group of its own that is killed whole at the timeout or when `signal` aborts. The
 * tool call's arguments never reach the command line, only stdin
 */
export function startCommand(handler: CommandHookHandler, options: CommandOptions): CommandRun {
  const started = Date.now();
  const platform = options.platform ?? process.platform;
  const { file, args } = commandLine(handler, options.projectDir, platform);
  const group = platform !== 'win32';
  let child: ChildProcess | undefined;
  const stdout = new Capped(options.maxBytes);
  const stderr = new Capped(options.maxBytes);
  let timedOut = false;
  let aborted = false;
  /**
   * Kills the hook's process group, also once its leader exited: a process it left in the
   * background is in the group still. A group that is gone already is no error
   */
  const kill = () => {
    if (!child) return;
    if (group && child.pid !== undefined) {
      try {
        process.kill(-child.pid, 'SIGKILL');
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ESRCH') child.kill('SIGKILL');
      }
      return;
    }
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
  };
  let heldOpen = false;
  let closing: ReturnType<typeof setTimeout> | undefined;
  const done = new Promise<CommandOutcome>((resolve) => {
    const finish = (exitCode: number | null, startError?: string) => {
      clearTimeout(timer);
      clearTimeout(closing);
      options.signal?.removeEventListener('abort', onAbort);
      resolve({
        exitCode,
        stdout: stdout.text(),
        stderr: stderr.text(),
        timedOut,
        aborted,
        ...(startError !== undefined && { startError }),
        truncated: stdout.cut || stderr.cut,
        heldOpen,
        durationMs: Date.now() - started,
      });
    };
    const onAbort = () => {
      aborted = true;
      kill();
    };
    const timer = setTimeout(() => {
      timedOut = true;
      kill();
    }, options.timeoutMs);
    try {
      child = spawn(file, args, {
        cwd: options.cwd,
        env: hookEnvironment(options.projectDir, options.env, options.extraEnv),
        stdio: ['pipe', 'pipe', 'pipe'],
        detached: group,
        windowsHide: true,
      });
    } catch (error) {
      finish(null, error instanceof Error ? error.message : String(error));
      return;
    }
    if (options.signal?.aborted) onAbort();
    else options.signal?.addEventListener('abort', onAbort, { once: true });
    let settled = false;
    const running = child;
    running.on('error', (error) => {
      if (settled) return;
      settled = true;
      finish(null, error.message);
    });
    running.stdout?.on('data', (chunk: Buffer) => stdout.add(chunk));
    running.stderr?.on('data', (chunk: Buffer) => stderr.add(chunk));
    running.on('exit', () => {
      closing = setTimeout(() => {
        heldOpen = true;
        kill();
        running.stdout?.destroy();
        running.stderr?.destroy();
      }, CLOSE_GRACE_MS);
    });
    running.on('close', (code) => {
      if (settled) return;
      settled = true;
      finish(timedOut || aborted ? null : code);
    });
    running.stdin?.on('error', () => undefined);
    running.stdin?.end(options.input);
  });
  return { done, kill };
}

/** Bytes kept up to a limit, the rest counted and dropped */
class Capped {
  private readonly chunks: Buffer[] = [];
  private size = 0;
  cut = false;

  constructor(private readonly limit: number) {}

  add(chunk: Buffer): void {
    const room = this.limit - this.size;
    if (room <= 0) {
      this.cut = true;
      return;
    }
    const kept = chunk.length > room ? chunk.subarray(0, room) : chunk;
    if (kept.length < chunk.length) this.cut = true;
    this.chunks.push(kept);
    this.size += kept.length;
  }

  text(): string {
    return Buffer.concat(this.chunks).toString('utf8');
  }
}

/** How an HTTP hook ended */
export interface HttpOutcome {
  /** The response status, unset when no response came */
  status?: number;
  body: string;
  /** Why no response came (a connection failure) */
  error?: string;
  timedOut: boolean;
  aborted: boolean;
  /** Whether the body went past the byte limit and was cut */
  truncated: boolean;
  durationMs: number;
}

export interface HttpOptions {
  input: string;
  timeoutMs: number;
  maxBytes: number;
  signal: AbortSignal;
  /**
   * The environment variables a header may name: the handler's `allowedEnvVars`, narrowed by the
   * settings' `httpHookAllowedEnvVars` when they set one
   */
  allowedEnv: ReadonlySet<string>;
  /**
   * Variables of the hook's scope over the process's own, such as a plugin's
   * `CLAUDE_PLUGIN_OPTION_<KEY>`: a header still names only the allowed ones
   */
  extraEnv?: Readonly<Record<string, string>>;
}

/**
 * `$VAR` and `${VAR}` in a header value replaced by the allowed environment variables (from
 * `extraEnv`, else the process's), others empty
 */
export function interpolateHeader(
  value: string,
  allowed: ReadonlySet<string>,
  extraEnv: Readonly<Record<string, string>> = {}
): string {
  return value.replace(
    /\$\{([A-Za-z_][A-Za-z0-9_]*)\}|\$([A-Za-z_][A-Za-z0-9_]*)/g,
    (_match, braced?: string, bare?: string) => {
      const name = braced ?? bare ?? '';
      if (!allowed.has(name)) return '';
      return Object.hasOwn(extraEnv, name) ? (extraEnv[name] ?? '') : (process.env[name] ?? '');
    }
  );
}

/**
 * Posts the event's JSON to the hook's URL: a redirect is not followed (the request goes nowhere
 * else), the body is read up to `maxBytes`, the request stops at the timeout
 */
export async function postHook(
  handler: HttpHookHandler,
  options: HttpOptions
): Promise<HttpOutcome> {
  const started = Date.now();
  const timeout = AbortSignal.timeout(options.timeoutMs);
  const signal = AbortSignal.any([timeout, options.signal]);
  const headers: Record<string, string> = {};
  for (const [name, value] of Object.entries(handler.headers ?? {})) {
    headers[name] = interpolateHeader(value, options.allowedEnv, options.extraEnv);
  }
  headers['content-type'] = 'application/json';
  const ended = (fields: Partial<HttpOutcome>): HttpOutcome => ({
    body: '',
    timedOut: timeout.aborted,
    aborted: options.signal.aborted,
    truncated: false,
    durationMs: Date.now() - started,
    ...fields,
  });
  let response: Response;
  try {
    response = await fetch(handler.url, {
      method: 'POST',
      headers,
      body: options.input,
      redirect: 'manual',
      signal,
    });
  } catch (error) {
    return ended({ error: error instanceof Error ? error.message : String(error) });
  }
  try {
    const { text, truncated } = await readCapped(response, options.maxBytes);
    return ended({ status: response.status, body: text, truncated });
  } catch (error) {
    return ended({
      status: response.status,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

async function readCapped(
  response: Response,
  maxBytes: number
): Promise<{ text: string; truncated: boolean }> {
  if (!response.body) return { text: '', truncated: false };
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  let truncated = false;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    const room = maxBytes - size;
    if (value.length > room) {
      chunks.push(value.subarray(0, Math.max(room, 0)));
      truncated = true;
      await reader.cancel();
      break;
    }
    chunks.push(value);
    size += value.length;
  }
  return { text: Buffer.concat(chunks).toString('utf8'), truncated };
}

/** Whether `url` matches a pattern of an allowlist, `*` standing for any text */
export function urlAllowed(url: string, patterns: readonly string[]): boolean {
  return patterns.some((pattern) => {
    const source = pattern
      .split('*')
      .map((part) => part.replace(/[.+?^${}()|[\]\\/]/g, '\\$&'))
      .join('.*');
    return new RegExp(`^${source}$`).test(url);
  });
}
