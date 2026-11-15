/**
 * cogitator bridge - the agent bridge of this machine: run its dispatcher, read its journal
 */

import { Command, InvalidArgumentError } from 'commander';
import chalk from 'chalk';
import { existsSync } from 'node:fs';
import {
  BridgeClient,
  SqliteBridgeStore,
  bridgePaths,
  hostBridge,
  isBridgeError,
  type AgentRecord,
  type BridgeHost,
  type BridgeJob,
  type BridgePaths,
  type BridgeStatus,
  type JournalEntry,
  type Lease,
} from '@cogitator-ai/bridge';
import { CommandError, examplesHelp, printJson, reportFailure } from '../utils/cli.js';

/** Where the commands print */
export interface BridgeIo {
  print(line: string): void;
  warn(line: string): void;
}

/** What the commands work with: how to print, the environment, when to stop */
export interface BridgeContext {
  io: BridgeIo;
  env: NodeJS.ProcessEnv;
  /** Ends `serve` and `log --follow`: Ctrl-C by default */
  signal?: AbortSignal;
  /** How often `log --follow` looks for new entries, in ms */
  pollMs?: number;
}

const defaultContext = (): BridgeContext => ({
  io: { print: (line) => console.log(line), warn: (line) => console.error(line) },
  env: process.env,
});

interface HomeFlags {
  home?: string;
}

const DEFAULT_LOG_LINES = 50;
const FOLLOW_POLL_MS = 300;
const PREVIEW_LENGTH = 100;

function pathsOf(flags: HomeFlags, context: BridgeContext): BridgePaths {
  return bridgePaths({ ...(flags.home && { home: flags.home }), env: context.env });
}

/** Resolves when the command should stop: the context's signal, or Ctrl-C and SIGTERM */
function stopRequested(context: BridgeContext): { stopped: Promise<void>; dispose: () => void } {
  if (context.signal) {
    const signal = context.signal;
    if (signal.aborted) return { stopped: Promise.resolve(), dispose: () => undefined };
    let onAbort: () => void = () => undefined;
    const stopped = new Promise<void>((resolve) => {
      onAbort = resolve;
      signal.addEventListener('abort', onAbort, { once: true });
    });
    return { stopped, dispose: () => signal.removeEventListener('abort', onAbort) };
  }
  let onSignal: () => void = () => undefined;
  const stopped = new Promise<void>((resolve) => {
    onSignal = resolve;
    process.once('SIGINT', onSignal);
    process.once('SIGTERM', onSignal);
  });
  return {
    stopped,
    dispose: () => {
      process.off('SIGINT', onSignal);
      process.off('SIGTERM', onSignal);
    },
  };
}

/**
 * Text that agents wrote, safe to print: on one line and without control characters, so a
 * letter cannot draw a second journal line or send escape sequences to the terminal.
 */
function plain(value: string): string {
  return value.replace(/[\s\p{Cc}\p{Cf}]+/gu, ' ').trim();
}

function preview(value: string): string {
  const line = plain(value);
  return line.length > PREVIEW_LENGTH ? `${line.slice(0, PREVIEW_LENGTH - 3)}...` : line;
}

function text(value: unknown): string {
  return typeof value === 'string' ? plain(value) : '';
}

function clock(at: string): string {
  const date = new Date(at);
  const pad = (value: number) => String(value).padStart(2, '0');
  return `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
}

function day(at: string): string {
  const date = new Date(at);
  const pad = (value: number) => String(value).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

/** What a journal entry says, without the time and the job number. */
export function describeJournalEntry(raw: JournalEntry): string {
  const data = raw.data ?? {};
  const entry = { ...raw, agent: text(raw.agent), letter: text(raw.letter) };
  switch (entry.type) {
    case 'agent.registered':
      return `${entry.agent} joined (${text(data.harness)}${data.started ? ', started by the bridge' : ''})`;
    case 'agent.gone':
      return `${entry.agent} is gone${data.error ? `: ${text(data.error)}` : ''}`;
    case 'job.created':
      return `job "${text(data.title)}" from ${text(data.from)} to ${text(data.to)}`;
    case 'job.state':
      return `job is ${text(data.to)} (was ${text(data.from)})`;
    case 'job.verified':
      return `checks ${data.verified ? 'confirmed the result' : 'did not confirm the result'}${data.summary ? `: ${preview(text(data.summary))}` : ''}`;
    case 'letter.queued':
      return `${text(data.kind)} from ${text(data.from)} to ${text(data.to)}: ${preview(text(data.body))}`;
    case 'letter.delivered':
      return `delivered to ${entry.agent} (${entry.letter})`;
    case 'letter.read':
      return `read by ${entry.agent} (${entry.letter})`;
    case 'letter.handled':
      return `done with by ${entry.agent} (${entry.letter})`;
    case 'letter.rejected':
      return `refused a ${text(data.kind) || 'job'} of ${entry.agent}: ${text(data.reason)}`;
    case 'letter.undelivered':
      return `could not deliver ${entry.letter} to ${entry.agent} after ${String(data.attempts)} attempts: ${text(data.error)}`;
    case 'letter.reminded':
      return `reminded ${entry.agent} of ${entry.letter}`;
  }
}

/** A journal entry as one line of `cogitator bridge log`. */
export function formatJournalEntry(entry: JournalEntry): string {
  const job = entry.job !== undefined ? `#${entry.job}` : '';
  return `${chalk.dim(clock(entry.at))}  ${job.padEnd(5)} ${describeJournalEntry(entry)}`;
}

export interface BridgeLogFlags extends HomeFlags {
  job?: number;
  follow?: boolean;
  lines?: number;
  all?: boolean;
  json?: boolean;
}

/**
 * cogitator bridge log: the journal, read straight from the store, so it works whether a
 * dispatcher runs or not.
 */
export async function runBridgeLog(
  flags: BridgeLogFlags,
  context: BridgeContext = defaultContext()
): Promise<number> {
  let store: SqliteBridgeStore | undefined;
  try {
    const paths = pathsOf(flags, context);
    if (!existsSync(paths.database)) {
      throw new CommandError('The bridge has no journal yet: no dispatcher ran on this machine', {
        hints: ['Start one: cogitator bridge serve'],
      });
    }
    store = await SqliteBridgeStore.open(paths.database, { readonly: true });
    const reader = store;

    let lastSeq = 0;
    let lastDay = '';
    const show = (entries: JournalEntry[]) => {
      for (const entry of entries) {
        lastSeq = entry.seq;
        if (flags.json) {
          context.io.print(JSON.stringify(entry));
          continue;
        }
        const entryDay = day(entry.at);
        if (entryDay !== lastDay) {
          context.io.print(chalk.dim(`-- ${entryDay} --`));
          lastDay = entryDay;
        }
        context.io.print(formatJournalEntry(entry));
      }
    };

    const filter = flags.job !== undefined ? { job: flags.job } : {};
    const whole = flags.all ?? (flags.job !== undefined && flags.lines === undefined);
    const first = reader.readJournal({
      ...filter,
      ...(whole ? {} : { tail: flags.lines ?? DEFAULT_LOG_LINES }),
    });
    show(first);
    if (first.length === 0 && !flags.follow && !flags.json) {
      context.io.print(
        chalk.dim(
          flags.job !== undefined ? `Nothing about job ${flags.job}` : 'The journal is empty'
        )
      );
    }
    if (!flags.follow) return 0;

    const { stopped, dispose } = stopRequested(context);
    let running = true;
    void stopped.then(() => (running = false));
    try {
      while (running) {
        show(reader.readJournal({ ...filter, afterSeq: lastSeq }));
        await Promise.race([
          stopped,
          new Promise((resolve) => setTimeout(resolve, context.pollMs ?? FOLLOW_POLL_MS)),
        ]);
      }
    } finally {
      dispose();
    }
    return 0;
  } catch (error) {
    return reportFailure(error, { json: flags.json ?? false });
  } finally {
    store?.close();
  }
}

function age(since: string): string {
  const seconds = Math.max(0, Math.round((Date.now() - Date.parse(since)) / 1000));
  if (seconds < 90) return `${seconds}s`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 90) return `${minutes} min`;
  const hours = Math.round(minutes / 60);
  return hours < 48 ? `${hours} h` : `${Math.round(hours / 24)} d`;
}

function agentLine(agent: AgentRecord): string {
  const session = agent.sessionName ? ` "${plain(agent.sessionName)}"` : '';
  const state = agent.status === 'active' ? '' : chalk.yellow(` ${agent.status}`);
  return `  ${agent.name.padEnd(28)} ${agent.harness}${session}, ${agent.delivery}${state}`;
}

function jobLine(job: BridgeJob): string {
  return `  #${String(job.number).padEnd(4)} ${job.state.padEnd(14)} ${job.from} -> ${job.to}  ${preview(job.title)}`;
}

async function lastLease(paths: BridgePaths): Promise<Lease | undefined> {
  if (!existsSync(paths.database)) return undefined;
  const store = await SqliteBridgeStore.open(paths.database, { readonly: true });
  try {
    return store.readLease();
  } finally {
    store.close();
  }
}

/** cogitator bridge status: exits 0 when a dispatcher runs, 1 when none does. */
export async function runBridgeStatus(
  flags: HomeFlags & { json?: boolean },
  context: BridgeContext = defaultContext()
): Promise<number> {
  try {
    const paths = pathsOf(flags, context);
    let client: BridgeClient | undefined;
    try {
      client = await BridgeClient.connect({ socketPath: paths.socket, timeoutMs: 5_000 });
    } catch (error) {
      if (!isBridgeError(error) || error.code !== 'not_running') throw error;
    }

    if (!client) {
      const lease = await lastLease(paths).catch(() => undefined);
      if (flags.json) {
        printJson({ running: false, home: paths.home, ...(lease && { lastDispatcher: lease }) });
        return 1;
      }
      context.io.print(`${chalk.red('●')} No bridge dispatcher is running`);
      if (lease) context.io.print(chalk.dim(`  The last one was pid ${lease.pid}`));
      context.io.print(chalk.dim(`  Home: ${paths.home}`));
      context.io.print(chalk.dim('  Start one: cogitator bridge serve'));
      return 1;
    }

    try {
      const status: BridgeStatus = await client.status();
      const agents = await client.agents({ statuses: ['active', 'starting'] });
      const jobs = await client.jobs({ states: ['submitted', 'working', 'input-required'] });
      if (flags.json) {
        printJson({ running: true, home: paths.home, ...status, agentList: agents, jobList: jobs });
        return 0;
      }
      const { dispatcher } = status;
      context.io.print(
        `${chalk.green('●')} Bridge dispatcher running (pid ${dispatcher.pid}, v${dispatcher.version}, up ${age(dispatcher.startedAt)})`
      );
      context.io.print(chalk.dim(`  Socket:   ${dispatcher.socket}`));
      context.io.print(chalk.dim(`  Database: ${dispatcher.database}`));
      context.io.print(
        chalk.dim(
          `  Adapters: ${status.adapters.length > 0 ? status.adapters.join(', ') : 'none, sessions read their inbox themselves'}`
        )
      );
      context.io.print('');
      context.io.print(`Agents (${agents.length})`);
      for (const agent of agents) context.io.print(agentLine(agent));
      context.io.print('');
      context.io.print(
        `Jobs in progress (${jobs.length}), letters in the queue: ${status.queuedLetters}`
      );
      for (const job of jobs) context.io.print(jobLine(job));
      return 0;
    } finally {
      await client.close();
    }
  } catch (error) {
    return reportFailure(error, { json: flags.json ?? false });
  }
}

/** cogitator bridge serve: the dispatcher in the foreground, until Ctrl-C. */
export async function runBridgeServe(
  flags: HomeFlags,
  context: BridgeContext = defaultContext()
): Promise<number> {
  let host: BridgeHost;
  try {
    host = await hostBridge({
      ...(flags.home && { home: flags.home }),
      env: context.env,
      onError: (error) => context.io.warn(`${chalk.yellow('!')} ${error.message}`),
    });
  } catch (error) {
    if (isBridgeError(error) && error.code === 'already_running') {
      return reportFailure(
        new CommandError(error.message, { hints: ['See it: cogitator bridge status'] }),
        { json: false }
      );
    }
    return reportFailure(error, { json: false });
  }

  context.io.print(`${chalk.green('●')} Bridge dispatcher running (pid ${host.info.pid})`);
  context.io.print(chalk.dim(`  Socket:   ${host.paths.socket}`));
  context.io.print(chalk.dim(`  Database: ${host.paths.database}`));
  context.io.print(chalk.dim('  Follow the letters: cogitator bridge log --follow'));
  context.io.print(chalk.dim('  Press Ctrl+C to stop'));

  const { stopped, dispose } = stopRequested(context);
  try {
    const reason = await Promise.race([stopped.then(() => 'asked' as const), host.stopped]);
    if (reason === 'asked') {
      await host.close();
      context.io.print('Bridge dispatcher stopped');
      return 0;
    }
    context.io.warn(
      reason === 'lost'
        ? 'Another bridge dispatcher took over, this one stopped'
        : 'The bridge dispatcher stopped: its store could not be written to'
    );
    return 1;
  } finally {
    dispose();
  }
}

function positiveInt(value: string): number {
  const number = Number(value);
  if (!Number.isInteger(number) || number <= 0) {
    throw new InvalidArgumentError('Expected a positive whole number.');
  }
  return number;
}

const homeOption = [
  '--home <dir>',
  'the folder of the bridge files (default: COGITATOR_BRIDGE_HOME, else ~/.cogitator/bridge)',
] as const;

export const bridgeCommand = new Command('bridge')
  .description(
    'The agent bridge (experimental): Claude Code, Codex and other agents hand each other jobs'
  )
  .addHelpText(
    'after',
    examplesHelp([
      ['cogitator bridge serve', 'run the dispatcher of this machine'],
      ['cogitator bridge status', 'who is connected and what is in progress'],
      ['cogitator bridge log --follow', 'watch the letters as they go'],
      ['cogitator bridge log --job 12', 'everything about one job'],
    ])
  );

bridgeCommand
  .command('serve')
  .description('Run the dispatcher in the foreground: one per machine, shared by every project')
  .option(...homeOption)
  .action(async (flags: HomeFlags) => {
    process.exitCode = await runBridgeServe(flags);
  });

bridgeCommand
  .command('status')
  .description('Show the dispatcher, the sessions it knows and the jobs in progress')
  .option(...homeOption)
  .option('--json', 'print one JSON object')
  .action(async (flags: HomeFlags & { json?: boolean }) => {
    process.exitCode = await runBridgeStatus(flags);
  });

bridgeCommand
  .command('log')
  .description('Read the journal: every letter, delivery and change of a job')
  .option('--job <number>', 'only one job', positiveInt)
  .option('-f, --follow', 'keep printing what comes in')
  .option(
    '-n, --lines <number>',
    `the last entries to print (default ${DEFAULT_LOG_LINES}, with --job all of them)`,
    positiveInt
  )
  .option('--all', 'the whole journal')
  .option(...homeOption)
  .option('--json', 'print each entry as one line of JSON, a failure as one JSON object')
  .action(async (flags: BridgeLogFlags) => {
    process.exitCode = await runBridgeLog(flags);
  });
