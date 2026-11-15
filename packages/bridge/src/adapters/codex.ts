import { spawn } from 'node:child_process';
import { closeSync, mkdirSync, openSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import type {
  BridgeAdapter,
  CreatedSession,
  DeliveryReceipt,
  HealthCheck,
  IdentifyContext,
  LetterDelivery,
  SessionRequest,
} from '../adapter.js';
import { bridgePaths, findProjectRoot } from '../paths.js';
import { HARNESSES, type CallerIdentity } from '../types.js';
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
}

const DEFAULT_THREAD_STARTED_MS = 60_000;
const LOG_INTERVAL_MS = 100;
const NO_OWNER = /could not resume thread/i;
const DAEMON_START = 'codex app-server daemon start';

/** What the journal says of a letter Codex queued for a thread nothing will wake. */
export const CODEX_ASLEEP_NOTE =
  'Codex queued the letter, but nothing wakes the thread: it is open in no Codex app and no ' +
  `local daemon runs. It is read when the thread is opened, or at once with: ${DAEMON_START}`;

/** The id of the thread `codex exec --json` says it started, when its output has it already. */
export function codexThreadId(output: string): string | undefined {
  for (const line of output.split('\n')) {
    if (!line.trim().startsWith('{')) continue;
    let event: unknown;
    try {
      event = JSON.parse(line);
    } catch {
      continue;
    }
    if (typeof event !== 'object' || event === null) continue;
    const id = (event as { thread_id?: unknown }).thread_id;
    if (typeof id === 'string' && id.trim()) return id.trim();
  }
  return undefined;
}

/**
 * Reaches Codex threads in their own windows. A letter goes into the thread's message queue
 * (`codex queue --resume`): a thread open in the Codex app takes it by itself within seconds,
 * one that is open nowhere needs the local daemon (`codex app-server daemon start`), which the
 * bridge never starts on its own. A session for a job is a thread of `codex exec`, started with
 * the job's first letter and left to finish its turn by itself.
 */
export function codexAdapter(options: CodexAdapterOptions = {}): BridgeAdapter {
  const command = options.command ?? 'codex';
  const env = options.env ?? process.env;
  const logDir = options.logDir ?? join(bridgePaths({ env }).home, 'sessions');

  async function deliver({ agent, letter }: LetterDelivery): Promise<DeliveryReceipt | void> {
    const result = await runCommand(
      command,
      [
        'queue',
        '--thread',
        agent.sessionId,
        '--message',
        fitsArgument(letter.text) ? letter.text : tooLongNotice(letter),
        '--resume',
        '--cd',
        agent.cwd,
      ],
      { cwd: agent.cwd, env }
    );
    if (result.code !== 0) throw new Error(`codex queue failed: ${failureOf(result)}`);
    return NO_OWNER.test(result.stderr) ? { note: CODEX_ASLEEP_NOTE } : undefined;
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
      child.once('error', (error: NodeJS.ErrnoException) => {
        missing = error.code === 'ENOENT';
        exited = { code: null };
      });
      child.once('exit', (code) => {
        exited = { code };
      });
      child.stdin?.on('error', () => undefined);
      child.stdin?.end(request.firstLetter.text);
      child.unref();
    } finally {
      closeSync(log);
    }

    const deadline = Date.now() + (options.threadStartedMs ?? DEFAULT_THREAD_STARTED_MS);
    for (;;) {
      const output = readFileSync(logPath, 'utf8');
      const sessionId = codexThreadId(output);
      if (sessionId) return { sessionId, deliveredFirstLetter: true };
      if (missing) throw new CommandMissingError(command);
      if (exited) {
        throw new Error(
          `codex exec ended before it started a thread: ${failureOf({ code: exited.code, stdout: output, stderr: '' })}`
        );
      }
      if (Date.now() >= deadline) {
        throw new Error(
          `codex exec did not say which thread it started, its output is in ${logPath}`
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
    deliver,
    createSession,
    identify,
    health,
  };
}
