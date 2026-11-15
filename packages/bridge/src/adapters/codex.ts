import { spawn } from 'node:child_process';
import { closeSync, existsSync, mkdirSync, openSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import type {
  BridgeAdapter,
  BridgeCalls,
  CreatedSession,
  DeliveryReceipt,
  HealthCheck,
  IdentifyContext,
  LetterDelivery,
  SessionRequest,
} from '../adapter.js';
import { isBridgeError } from '../errors.js';
import { bridgePaths, findProjectRoot } from '../paths.js';
import { HARNESSES, type CallerIdentity, type JobState } from '../types.js';
import {
  CommandMissingError,
  failureOf,
  fitsArgument,
  pause,
  runCommand,
  sessionEnv,
  tooLongNotice,
} from './exec.js';

/** How letters reach a Codex thread: the thread's own message queue. */
export const CODEX_DELIVERY = 'queue';

export type CodexSandbox = 'read-only' | 'workspace-write' | 'danger-full-access';

export interface CodexAdapterOptions {
  /** The Codex executable, `codex` on `PATH` by default */
  command?: string;
  /** The environment of the commands and of the sessions it starts, `process.env` by default */
  env?: NodeJS.ProcessEnv;
  /** How a session runs the bridge's command line, `cogitator bridge` by default */
  bridgeCommand?: string;
  /** The sandbox of the sessions it starts, `workspace-write` by default */
  sandbox?: CodexSandbox;
  /** More arguments for `codex exec`, such as `['--model', 'gpt-5']` */
  sessionArgs?: readonly string[];
  /**
   * Where the output of the sessions it starts goes, one file a session, `sessions` in the
   * bridge's folder by default. A session writes there and not to the dispatcher, so it works on
   * when the dispatcher stops
   */
  logDir?: string;
  /** How long a started session may take to say its thread id, 60 s by default */
  threadStartedMs?: number;
  /** Hears what went wrong outside a call of the bridge: a report that could not be sent */
  onError?: (error: Error) => void;
}

const DEFAULT_THREAD_STARTED_MS = 60_000;
const LOG_INTERVAL_MS = 100;
const NOT_RESUMED = /could not resume thread/i;
const DAEMON_START = 'codex app-server daemon start';

/**
 * What the journal says of a letter Codex queued with no local daemon to resume the thread.
 * `codex queue --resume` warns the same whether the Codex app has the thread open or nobody
 * does, so the note names both cases.
 */
export const CODEX_NOT_RESUMED_NOTE =
  'Codex queued the letter, and no local daemon runs to resume the thread. A thread open in the ' +
  'Codex app reads it at once, one open nowhere when it is opened, or at once with: ' +
  DAEMON_START;

const FINISHED: readonly JobState[] = ['completed', 'failed', 'canceled'];

/** One line of what `codex exec --json` wrote: an event, or text that is none. */
type ExecLine = { event: Record<string, unknown> } | { text: string };

function execLines(output: string): ExecLine[] {
  const lines: ExecLine[] = [];
  for (const raw of output.split('\n')) {
    const line = raw.trim();
    if (!line) continue;
    let event: unknown;
    if (line.startsWith('{')) {
      try {
        event = JSON.parse(line);
      } catch {
        event = undefined;
      }
    }
    lines.push(
      typeof event === 'object' && event !== null
        ? { event: event as Record<string, unknown> }
        : { text: line }
    );
  }
  return lines;
}

function textOf(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

/** The id of the thread `codex exec --json` says it started, when its output has it already. */
export function codexThreadId(output: string): string | undefined {
  for (const line of execLines(output)) {
    const id = 'event' in line ? textOf(line.event.thread_id) : undefined;
    if (id) return id;
  }
  return undefined;
}

/**
 * What a thread the bridge starts reads under its first letter. Such a thread often cannot reach
 * the bridge from its sandbox, so the bridge reports for it.
 */
export function codexReportNotice(job: number): string {
  return `[agent bridge] Your final answer of this turn is taken as the report on job #${job}, unless you send a report yourself.`;
}

/**
 * What a `codex exec` that ended leaves to report: the last message of the thread, or why the
 * turn failed. `output` is what it wrote with `--json`, `code` its exit code, null after a signal.
 */
export function codexTurnReport(
  output: string,
  code: number | null
): { body: string; failed: boolean } {
  let message: string | undefined;
  let turnFailed = false;
  let reason: string | undefined;
  const said: string[] = [];
  for (const line of execLines(output)) {
    if ('text' in line) {
      said.push(line.text);
      continue;
    }
    const { type, item, error } = line.event;
    if (type === 'item.completed' && typeof item === 'object' && item !== null) {
      const { type: kind, text } = item as { type?: unknown; text?: unknown };
      if (kind === 'agent_message') message = textOf(text) ?? message;
    } else if (type === 'turn.failed') {
      turnFailed = true;
      const told =
        typeof error === 'object' && error !== null
          ? textOf((error as { message?: unknown }).message)
          : undefined;
      reason = told ?? reason;
    } else if (type === 'error') {
      reason = textOf(line.event.message) ?? reason;
    }
  }
  if (code === 0 && !turnFailed) return { body: message ?? 'Done', failed: false };
  const why = reason ?? failureOf({ code, stdout: '', stderr: said.join('\n') });
  return {
    body:
      `codex exec failed before the thread finished its turn: ${why}` +
      (message ? `\nIts last message: ${message}` : ''),
    failed: true,
  };
}

/**
 * Reaches Codex threads in their own windows. A letter goes into the thread's message queue
 * (`codex queue --resume`): a thread open in the Codex app takes it by itself within seconds,
 * one that is open nowhere needs the local daemon (`codex app-server daemon start`), which the
 * bridge never starts on its own. A session for a job is a thread of `codex exec`, started with
 * the job's first letter and left to finish its turn by itself. Such a thread works in a sandbox
 * that usually keeps it from the bridge, so when its turn ends and it wrote nothing on the job
 * itself, the adapter sends its final answer as the report, or what failed when the turn failed.
 */
export function codexAdapter(options: CodexAdapterOptions = {}): BridgeAdapter {
  const command = options.command ?? 'codex';
  const env = options.env ?? process.env;
  const logDir = options.logDir ?? join(bridgePaths({ env }).home, 'sessions');
  const bridgeHome = env.COGITATOR_BRIDGE_HOME?.trim() || undefined;
  const onError = options.onError ?? (() => undefined);
  let bridge: BridgeCalls | undefined;
  let closed = false;

  /**
   * Reports for a thread whose `codex exec` ended, unless the job is over or the thread wrote on
   * it itself: a thread that reaches the bridge speaks for itself.
   */
  async function reportFor(
    request: SessionRequest,
    sessionId: string,
    logPath: string,
    code: number | null
  ): Promise<void> {
    if (closed || !bridge) return;
    const job = request.job.number;
    if (FINISHED.includes((await bridge.job(job)).state)) return;
    const agent = await bridge.register({
      harness: HARNESSES.codex,
      sessionId,
      cwd: request.cwd,
      project: request.project,
      agentName: request.agentName,
    });
    const own = await bridge.letters({ job, from: agent.name, limit: 1 });
    if (own.length > 0 || closed) return;
    const { body, failed } = codexTurnReport(readFileSync(logPath, 'utf8'), code);
    await bridge.send(agent.name, {
      job,
      kind: 'report',
      body: body.replaceAll('\0', ''),
      ...(failed && { outcome: 'failed' as const }),
    });
  }

  async function deliver({ agent, letter }: LetterDelivery): Promise<DeliveryReceipt | void> {
    const result = await runCommand(
      command,
      [
        'queue',
        '--thread',
        agent.sessionId,
        '--message',
        fitsArgument(letter.text)
          ? letter.text
          : tooLongNotice(letter, options.bridgeCommand, bridgeHome),
        '--resume',
        '--cd',
        agent.cwd,
      ],
      { cwd: agent.cwd, env }
    );
    if (result.code !== 0) throw new Error(`codex queue failed: ${failureOf(result)}`);
    return NOT_RESUMED.test(result.stderr) ? { note: CODEX_NOT_RESUMED_NOTE } : undefined;
  }

  async function createSession(request: SessionRequest): Promise<CreatedSession> {
    mkdirSync(logDir, { recursive: true, mode: 0o700 });
    const logPath = join(
      logDir,
      `codex-${request.agentName.replace(/[^\w.-]+/g, '_')}-${Date.now()}.log`
    );
    const log = openSync(logPath, 'a', 0o600);
    let exited: { code: number | null } | undefined;
    let missing = false;
    let pid: number | undefined;
    let ended: Promise<number | null>;
    try {
      const child = spawn(
        command,
        [
          'exec',
          '--json',
          '--skip-git-repo-check',
          '--cd',
          request.cwd,
          '--sandbox',
          options.sandbox ?? 'workspace-write',
          ...(options.sessionArgs ?? []),
          '-',
        ],
        {
          cwd: request.cwd,
          env: sessionEnv(env, {
            harness: HARNESSES.codex,
            agentName: request.agentName,
            ...(request.sessionName && { sessionName: request.sessionName }),
          }),
          detached: true,
          stdio: ['pipe', log, log],
        }
      );
      ended = new Promise((settle) => {
        child.once('error', (error: NodeJS.ErrnoException) => {
          missing = error.code === 'ENOENT';
          exited = { code: null };
          settle(null);
        });
        child.once('exit', (code) => {
          exited = { code };
          settle(code);
        });
      });
      child.stdin?.on('error', () => undefined);
      child.stdin?.end(`${request.firstLetter.text}\n\n${codexReportNotice(request.job.number)}`);
      child.unref();
      pid = child.pid;
    } finally {
      closeSync(log);
    }

    /** The thread was never learned, so nothing could reach it: it must not work on unseen */
    const abandon = (error: Error): Error => {
      if (pid !== undefined && !exited) {
        try {
          process.kill(-pid, 'SIGTERM');
        } catch {
          exited = { code: null };
        }
      }
      return error;
    };

    const deadline = Date.now() + (options.threadStartedMs ?? DEFAULT_THREAD_STARTED_MS);
    for (;;) {
      const output = readFileSync(logPath, 'utf8');
      const sessionId = codexThreadId(output);
      if (sessionId) {
        void ended
          .then((code) => reportFor(request, sessionId, logPath, code))
          .catch((error: unknown) => {
            if (isBridgeError(error) && error.code === 'job_finished') return;
            onError(error instanceof Error ? error : new Error(String(error)));
          });
        return { sessionId, deliveredFirstLetter: true };
      }
      if (missing) {
        throw existsSync(request.cwd)
          ? new CommandMissingError(command)
          : new Error(`The folder ${request.cwd} does not exist`);
      }
      if (exited) {
        throw new Error(
          `codex exec ended before it started a thread: ${failureOf({ code: exited.code, stdout: output, stderr: '' })}`
        );
      }
      if (Date.now() >= deadline) {
        throw abandon(
          new Error(`codex exec did not say which thread it started, its output is in ${logPath}`)
        );
      }
      await pause(LOG_INTERVAL_MS);
    }
  }

  function identify(context: IdentifyContext): CallerIdentity | undefined {
    const sessionId = context.env.CODEX_THREAD_ID?.trim();
    if (!sessionId) return undefined;
    const folder = resolve(context.cwd);
    return { harness: HARNESSES.codex, sessionId, cwd: folder, project: findProjectRoot(folder) };
  }

  async function health(): Promise<HealthCheck[]> {
    const checks: HealthCheck[] = [];
    try {
      const version = await runCommand(command, ['--version'], { env });
      if (version.code !== 0) throw new Error(failureOf(version));
      checks.push({ id: 'version', title: 'Codex', status: 'ok', detail: version.stdout.trim() });
    } catch (error) {
      checks.push({
        id: 'version',
        title: 'Codex',
        status: 'fail',
        detail: error instanceof CommandMissingError ? error.message : String(error),
        fix: 'Install Codex: https://developers.openai.com/codex/cli',
      });
      return checks;
    }

    const queue = await runCommand(command, ['queue', '--help'], { env });
    const queues = queue.code === 0 && /--resume\b/.test(queue.stdout);
    checks.push({
      id: 'queue',
      title: 'Message queue',
      status: queues ? 'ok' : 'fail',
      detail: queues
        ? 'codex queue --resume is there'
        : 'this version has no codex queue --resume: the bridge cannot hand letters to threads',
      ...(!queues && { fix: 'Update Codex: codex update' }),
    });

    const exec = await runCommand(command, ['exec', '--help'], { env });
    const starts = exec.code === 0 && /--json\b/.test(exec.stdout);
    checks.push({
      id: 'exec',
      title: 'Starting threads',
      status: starts ? 'ok' : 'fail',
      detail: starts
        ? 'codex exec --json is there'
        : 'this version has no codex exec --json: the bridge cannot start threads',
      ...(!starts && { fix: 'Update Codex: codex update' }),
    });

    const daemon = await runCommand(command, ['app-server', 'daemon', 'version'], { env });
    const runs = daemon.code === 0;
    checks.push({
      id: 'daemon',
      title: 'Local daemon',
      status: runs ? 'ok' : 'warn',
      detail: runs
        ? 'runs: threads open in no app wake for their mail too'
        : 'does not run: a thread open in the Codex app still wakes, one open nowhere (such as a thread the bridge started) reads its mail only when opened',
      ...(!runs && { fix: DAEMON_START }),
    });
    return checks;
  }

  return {
    harness: HARNESSES.codex,
    delivery: CODEX_DELIVERY,
    capabilities: { createSession: true, push: true, steer: false, nativeWindow: true },
    attach(calls: BridgeCalls): void {
      bridge = calls;
    },
    deliver,
    createSession,
    identify,
    health,
    async close(): Promise<void> {
      closed = true;
    },
  };
}
