/**
 * cogitator bridge delegate | send | inbox | wait | doctor - the bridge as a session and a
 * person at a terminal use it
 */

import chalk from 'chalk';
import { resolve } from 'node:path';
import {
  BridgeClient,
  bridgePaths,
  callerFromEnv,
  isBridgeError,
  mailText,
  waitForMail,
  type BridgeAdapter,
  type BridgePaths,
  type CallerIdentity,
  type HealthCheck,
  type LetterKind,
} from '@cogitator-ai/bridge';
import { CommandError, printJson, reportFailure } from '../utils/cli.js';
import { bridgeAdapters } from '../utils/bridge-adapters.js';

/** What the session commands work with */
export interface BridgeSessionContext {
  print(line: string): void;
  /** Where a waiter writes the mail: its harness reads it from the hook's stderr */
  wake(text: string): void;
  env: NodeJS.ProcessEnv;
  cwd: string;
  /** What is piped into the command, undefined at a terminal */
  stdin(): Promise<string | undefined>;
  /** The adapters that tell sessions apart and check their harnesses */
  adapters?: readonly BridgeAdapter[];
  signal?: AbortSignal;
}

async function pipedInput(): Promise<string | undefined> {
  if (process.stdin.isTTY) return undefined;
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString('utf8');
}

const defaultContext = (): BridgeSessionContext => ({
  print: (line) => console.log(line),
  wake: (text) => process.stderr.write(`${text}\n`),
  env: process.env,
  cwd: process.cwd(),
  stdin: pipedInput,
});

interface HomeFlags {
  home?: string;
}

function pathsOf(flags: HomeFlags, context: BridgeSessionContext): BridgePaths {
  return bridgePaths({ ...(flags.home && { home: flags.home }), env: context.env });
}

function adaptersOf(context: BridgeSessionContext): readonly BridgeAdapter[] {
  return context.adapters ?? bridgeAdapters(context.env);
}

const NO_SESSION = new CommandError('This command runs inside a session of an agent', {
  hints: [
    'Run it from Claude Code or Codex: the session is known by CLAUDE_CODE_SESSION_ID or CODEX_THREAD_ID',
    'See what goes on from a terminal: cogitator bridge status, cogitator bridge log',
  ],
});

async function connect(
  flags: HomeFlags,
  context: BridgeSessionContext,
  caller: CallerIdentity
): Promise<BridgeClient> {
  try {
    return await BridgeClient.connect({ socketPath: pathsOf(flags, context).socket, caller });
  } catch (error) {
    if (isBridgeError(error) && error.code === 'not_running') {
      throw new CommandError('No bridge dispatcher is running', {
        hints: ['Start one: cogitator bridge serve'],
      });
    }
    throw error;
  }
}

async function asSession<T>(
  flags: HomeFlags,
  context: BridgeSessionContext,
  work: (client: BridgeClient) => Promise<T>
): Promise<T> {
  const caller = callerFromEnv(context.env, context.cwd);
  if (!caller) throw NO_SESSION;
  const client = await connect(flags, context, caller);
  try {
    return await work(client);
  } finally {
    await client.close();
  }
}

/** The text of a command: its words, or what is piped in when there are none or they are `-` */
async function bodyOf(words: readonly string[], context: BridgeSessionContext): Promise<string> {
  const typed = words.join(' ');
  if (typed.trim() && typed.trim() !== '-') return typed;
  const piped = await context.stdin();
  if (piped?.trim()) return piped;
  throw new CommandError('Nothing to send: give the text as arguments or pipe it in');
}

export interface BridgeDelegateFlags extends HomeFlags {
  title?: string;
  cwd?: string;
  check?: string[];
  parent?: number;
  json?: boolean;
}

/** cogitator bridge delegate <to> <text>: hands a job over and prints its number at once. */
export async function runBridgeDelegate(
  to: string,
  words: readonly string[],
  flags: BridgeDelegateFlags,
  context: BridgeSessionContext = defaultContext()
): Promise<number> {
  try {
    const body = await bodyOf(words, context);
    const { job } = await asSession(flags, context, (client) =>
      client.createJob({
        to,
        body,
        ...(flags.title && { title: flags.title }),
        ...(flags.cwd && { cwd: flags.cwd }),
        ...(flags.check?.length && { checks: flags.check.map((command) => ({ command })) }),
        ...(flags.parent !== undefined && { parent: flags.parent }),
      })
    );
    if (flags.json) printJson(job);
    else {
      context.print(
        `Job #${job.number} is with ${job.to} (${job.state}). Its answer arrives as a letter: nothing to wait for here`
      );
    }
    return 0;
  } catch (error) {
    return reportFailure(error, { json: flags.json ?? false });
  }
}

export const SENDABLE_KINDS = ['question', 'answer', 'report', 'note', 'permission'] as const;

export interface BridgeSendFlags extends HomeFlags {
  job: number;
  kind: Exclude<LetterKind, 'task'>;
  failed?: boolean;
  replyTo?: string;
  json?: boolean;
}

/** cogitator bridge send --job N --kind K <text>: a letter on a job that exists. */
export async function runBridgeSend(
  words: readonly string[],
  flags: BridgeSendFlags,
  context: BridgeSessionContext = defaultContext()
): Promise<number> {
  try {
    if (flags.failed && flags.kind !== 'report') {
      throw new CommandError('--failed goes with --kind report');
    }
    const body = await bodyOf(words, context);
    const sent = await asSession(flags, context, (client) =>
      client.send({
        job: flags.job,
        kind: flags.kind,
        body,
        ...(flags.replyTo && { inReplyTo: flags.replyTo }),
        ...(flags.failed && { outcome: 'failed' as const }),
      })
    );
    if (flags.json) printJson(sent);
    else {
      context.print(
        `Sent the ${sent.letter.kind} ${sent.letter.id} to ${sent.letter.to}. Job #${sent.job.number} is ${sent.job.state}`
      );
    }
    return 0;
  } catch (error) {
    return reportFailure(error, { json: flags.json ?? false });
  }
}

export interface BridgeInboxFlags extends HomeFlags {
  job?: number;
  peek?: boolean;
  unhandled?: boolean;
  json?: boolean;
}

/** cogitator bridge inbox: the letters waiting for the session, each under its signature. */
export async function runBridgeInbox(
  flags: BridgeInboxFlags,
  context: BridgeSessionContext = defaultContext()
): Promise<number> {
  try {
    const letters = await asSession(flags, context, (client) =>
      client.inbox({
        ...(flags.job !== undefined && { job: flags.job }),
        ...(flags.peek && { peek: true }),
        ...(flags.unhandled && { unhandled: true }),
      })
    );
    if (flags.json) printJson(letters);
    else if (letters.length === 0) context.print('No letters wait for this session');
    else context.print(mailText(letters));
    return 0;
  } catch (error) {
    return reportFailure(error, { json: flags.json ?? false });
  }
}

/** How a session without the bridge's tools answers a letter it was woken with. */
export const REPLY_HINT =
  '(The agent bridge woke this session with the mail above. Answer through it, not in this chat: ' +
  'cogitator bridge send --job <number> --kind <answer|question|report|note> "<text>")';

export interface BridgeWaitFlags extends HomeFlags {
  /** The harness whose hook runs the command: its stdin tells the session */
  hook?: string;
  /** Seconds to wait */
  timeout?: number;
  /** The name the bridge gave the session, for one it started */
  agent?: string;
}

/** What `wait` exits with when it has mail: the code that makes a harness wake its session. */
export const WAKE_EXIT_CODE = 2;

const DEFAULT_WAIT_S = 600;

/**
 * cogitator bridge wait: waits for the session's mail and exits. With mail it writes the letters
 * to stderr and exits with code 2, which is what wakes a Claude Code session whose background
 * hook ran it. Without, it exits with 0 and says nothing.
 */
export async function runBridgeWait(
  flags: BridgeWaitFlags,
  context: BridgeSessionContext = defaultContext()
): Promise<number> {
  try {
    let caller: CallerIdentity | undefined;
    if (flags.hook) {
      const harness = flags.hook.trim().toLowerCase();
      const adapter = adaptersOf(context).find((candidate) => candidate.harness === harness);
      if (!adapter?.identify) {
        throw new CommandError(`No adapter tells the sessions of "${flags.hook}" apart`);
      }
      const hookInput = await context.stdin();
      caller = adapter.identify({
        env: context.env,
        cwd: context.cwd,
        ...(hookInput !== undefined && { hookInput }),
      });
    } else {
      caller = callerFromEnv(context.env, context.cwd);
    }
    if (!caller) throw NO_SESSION;

    const waited = await waitForMail({
      socketPath: pathsOf(flags, context).socket,
      caller: { ...caller, ...(flags.agent && { agentName: flags.agent }) },
      timeoutMs: (flags.timeout ?? DEFAULT_WAIT_S) * 1000,
      ...(context.signal && { signal: context.signal }),
    });
    if (waited.reason !== 'letters') return 0;
    context.wake(`${mailText(waited.letters)}\n\n${REPLY_HINT}`);
    await waited.confirm().catch(() => undefined);
    return WAKE_EXIT_CODE;
  } catch (error) {
    return reportFailure(error, { json: false });
  }
}

export interface BridgeDoctorFlags extends HomeFlags {
  cwd?: string;
  json?: boolean;
}

interface DoctorSection {
  harness: string;
  checks: HealthCheck[];
}

const MARKS: Record<HealthCheck['status'], string> = {
  ok: chalk.green('✓'),
  warn: chalk.yellow('!'),
  fail: chalk.red('✗'),
};

async function dispatcherCheck(paths: BridgePaths): Promise<HealthCheck> {
  let client: BridgeClient;
  try {
    client = await BridgeClient.connect({ socketPath: paths.socket, timeoutMs: 5_000 });
  } catch (error) {
    if (!isBridgeError(error) || error.code !== 'not_running') throw error;
    return {
      id: 'dispatcher',
      title: 'Dispatcher',
      status: 'fail',
      detail: 'no bridge dispatcher is running: letters go nowhere',
      fix: 'cogitator bridge serve',
    };
  }
  try {
    const status = await client.status();
    const waiting =
      status.waiting.length > 0
        ? `waiting for mail: ${status.waiting.join(', ')}`
        : 'no session waits for mail right now';
    return {
      id: 'dispatcher',
      title: 'Dispatcher',
      status: 'ok',
      detail: `runs (pid ${status.dispatcher.pid}, v${status.dispatcher.version}), adapters: ${status.adapters.join(', ') || 'none'}, ${waiting}`,
    };
  } finally {
    await client.close();
  }
}

/**
 * cogitator bridge doctor: whether the bridge can reach the harnesses of this machine. Exits 1
 * when something it needs is missing, 0 when at most warnings are left.
 */
export async function runBridgeDoctor(
  flags: BridgeDoctorFlags,
  context: BridgeSessionContext = defaultContext()
): Promise<number> {
  try {
    const cwd = resolve(context.cwd, flags.cwd ?? '.');
    const sections: DoctorSection[] = [
      { harness: 'bridge', checks: [await dispatcherCheck(pathsOf(flags, context))] },
    ];
    for (const adapter of adaptersOf(context)) {
      if (!adapter.health) continue;
      sections.push({ harness: adapter.harness, checks: await adapter.health({ cwd }) });
    }
    const failed = sections.some((section) =>
      section.checks.some((check) => check.status === 'fail')
    );

    if (flags.json) {
      printJson({ ok: !failed, cwd, sections });
      return failed ? 1 : 0;
    }
    for (const section of sections) {
      context.print(chalk.bold(section.harness));
      for (const check of section.checks) {
        context.print(
          `  ${MARKS[check.status]} ${check.title}${check.detail ? `: ${check.detail}` : ''}`
        );
        if (check.fix) context.print(chalk.dim(`    ${check.fix}`));
      }
    }
    return failed ? 1 : 0;
  } catch (error) {
    return reportFailure(error, { json: flags.json ?? false });
  }
}
