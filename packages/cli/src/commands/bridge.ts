/**
 * cogitator bridge - the agent bridge of this machine: run its dispatcher, read its journal
 */

import { Command, InvalidArgumentError, Option } from 'commander';
import chalk from 'chalk';
import { existsSync } from 'node:fs';
import {
  BridgeClient,
  SqliteBridgeStore,
  bridgePaths,
  hostBridge,
  isBridgeError,
  type AgentRecord,
  type BridgeAdapter,
  type BridgeHost,
  type FactBoard,
  type BridgeJob,
  type BridgePaths,
  type BridgeStatus,
  type JournalEntry,
  type Lease,
} from '@cogitator-ai/bridge';
import { CommandError, examplesHelp, printJson, reportFailure } from '../utils/cli.js';
import {
  bridgeAdapters,
  bridgeFallbackOf,
  CLAUDE_MODES,
  CODEX_SANDBOXES,
} from '../utils/bridge-adapters.js';
import type { BridgePerson } from '../utils/bridge-person.js';
import {
  INSTALL_CHOICES,
  runBridgeInstall,
  runBridgeUninstall,
  type BridgeInstallFlags,
  type BridgeUninstallFlags,
} from './bridge-install.js';
import {
  runBridgeCaller,
  runBridgeMcp,
  runBridgePermit,
  runBridgeLimited,
  runBridgeOffer,
  runBridgeStuck,
  type BridgePermitFlags,
  type BridgeLimitedFlags,
  type BridgeOfferFlags,
  type BridgeStuckFlags,
} from './bridge-tools.js';
import {
  DECISIONS,
  SENDABLE_KINDS,
  runBridgeAsks,
  runBridgeBuild,
  runBridgeDebate,
  runBridgeDecide,
  runBridgeDelegate,
  runBridgeDoctor,
  runBridgeAccept,
  runBridgeCancel,
  runBridgeDiff,
  runBridgeForget,
  runBridgeRace,
  limitLine,
  runBridgeLimits,
  runBridgeRecall,
  runBridgeResults,
  runBridgeSuggest,
  runBridgeRecipe,
  runBridgeReject,
  runBridgeRemember,
  runBridgeInbox,
  runBridgeReply,
  runBridgeReview,
  runBridgeSend,
  runBridgeWait,
  type BridgeBuildFlags,
  type BridgeDebateFlags,
  type BridgeDelegateFlags,
  type BridgeDoctorFlags,
  type BridgeAcceptFlags,
  type BridgeCancelFlags,
  type BridgeDiffFlags,
  type BridgeForgetFlags,
  type BridgeRaceFlags,
  type BridgeLimitsFlags,
  type BridgeRecallFlags,
  type BridgeResultsFlags,
  type BridgeSuggestFlags,
  type BridgeRecipeFlags,
  type BridgeRejectFlags,
  type BridgeReviewFlags,
  type BridgeRememberFlags,
  type BridgeInboxFlags,
  type BridgePersonFlags,
  type BridgeSendFlags,
  type BridgeWaitFlags,
} from './bridge-session.js';

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
  /** The adapters `serve` reaches sessions through, those of Claude Code and Codex by default */
  adapters?: readonly BridgeAdapter[];
  /** How `serve` reaches the person and reads rights, `bridgePerson` of the environment by default */
  person?: BridgePerson;
  /** The board of facts, for tests: the one in the folder of the bridge otherwise */
  board?: FactBoard;
}

const defaultContext = (): BridgeContext => ({
  io: { print: (line) => console.log(line), warn: (line) => console.error(line) },
  env: process.env,
});

interface HomeFlags {
  home?: string;
}

interface ServeFlags extends HomeFlags {
  codexSandbox?: string;
  claudeMode?: string;
  /** Agents of the runtime to host, each as `name=model` */
  agent?: string[];
  /** The config file their providers are read from */
  config?: string;
  /** The agents that take a job only when no other can */
  fallback?: string[];
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
    case 'fact.remembered':
      return `${entry.agent === 'person' ? 'the person' : entry.agent} put a ${text(data.kind)} on the board: ${preview(text(data.text))}`;
    case 'fact.forgotten':
      return `${entry.agent === 'person' ? 'the person' : entry.agent} took the note ${text(data.id)} off the board`;
    case 'job.worktree':
      return `works in a worktree of its own: ${text(data.path)} (branch ${text(data.branch)})`;
    case 'job.accepted':
      return data.how === 'branch'
        ? `work left as the branch ${text(data.branch)}`
        : data.into
          ? `work taken into ${text(data.into)}`
          : 'nothing to take, the worktree is removed';
    case 'job.rejected':
      return `work dropped${data.reason ? `: ${preview(text(data.reason))}` : ''}`;
    case 'job.discarded':
      return `worktree put away, nobody came for it${data.ref ? `: its work is kept under ${text(data.ref)}` : ''}`;
    case 'job.redirected':
      return `handed on from ${text(data.from)} to ${text(data.to)}: ${text(data.from)} ${preview(text(data.why))}`;
    case 'harness.limited':
      return `${text(data.harness)} is out of its limit until ${clock(text(data.until))}${data.told ? '' : ', when it is tried again'}${data.detail ? `: ${preview(text(data.detail))}` : ''}`;
    case 'harness.unlimited':
      return `${text(data.harness)} takes jobs again: ${text(data.why)}`;
    case 'letter.queued': {
      const verdict = data.verdict ? ` (${text(data.verdict)})` : '';
      const forPerson = data.needsPerson ? ', waits for the person' : '';
      return `${text(data.kind)}${verdict} from ${text(data.from)} to ${text(data.to)}${forPerson}: ${preview(text(data.body))}`;
    }
    case 'letter.delivered':
      return `delivered to ${entry.agent} (${entry.letter})${data.note ? `. ${text(data.note)}` : ''}`;
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
    case 'letter.escalated':
      return `${entry.agent} left ${entry.letter} to the person`;
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

function agentLine(agent: AgentRecord, waiting: boolean): string {
  const session = agent.sessionName ? ` "${plain(agent.sessionName)}"` : '';
  const state = agent.status === 'active' ? '' : chalk.yellow(` ${agent.status}`);
  const armed = waiting ? chalk.green(' waits for mail') : '';
  return `  ${agent.name.padEnd(28)} ${agent.harness}${session}, ${agent.delivery}${state}${armed}`;
}

function jobLine(job: BridgeJob): string {
  const recipe = job.recipe ? chalk.dim(` (recipe ${plain(job.recipe.name)})`) : '';
  return `  #${String(job.number).padEnd(4)} ${job.state.padEnd(14)} ${job.from} -> ${job.to}  ${preview(job.title)}${recipe}`;
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
      for (const agent of agents) {
        context.io.print(agentLine(agent, status.waiting.includes(agent.name)));
      }
      context.io.print('');
      context.io.print(
        `Jobs in progress (${jobs.length}), letters in the queue: ${status.queuedLetters}`
      );
      for (const job of jobs) context.io.print(jobLine(job));
      if (status.limited.length > 0) {
        context.io.print('');
        context.io.print('Out of their limit, no job goes to them');
        for (const limit of status.limited) context.io.print(`  ${limitLine(limit)}`);
      }
      return 0;
    } finally {
      await client.close();
    }
  } catch (error) {
    return reportFailure(error, { json: flags.json ?? false });
  }
}

/** cogitator bridge serve: the dispatcher in the foreground, until Ctrl-C. */
/** The adapters of the agents `serve` hosts itself, none when no flag or variable names any. */
async function hostedFor(
  env: NodeJS.ProcessEnv,
  flags: Pick<ServeFlags, 'agent' | 'config'>,
  onError: (error: Error) => void
): Promise<BridgeAdapter[]> {
  const agents = await import('../utils/bridge-agents.js');
  const specs = agents.bridgeAgentsOf(env, flags.agent);
  if (specs.length === 0) return [];
  return agents.hostedAgents(specs, {
    config: await agents.hostedAgentsConfig(flags.config),
    onError,
  });
}

export async function runBridgeServe(
  flags: ServeFlags,
  context: BridgeContext = defaultContext()
): Promise<number> {
  let host: BridgeHost;
  let reach: BridgePerson;
  let board: FactBoard | undefined;
  try {
    const onError = (error: Error): void =>
      context.io.warn(`${chalk.yellow('!')} ${error.message}`);
    const wiring = await import('../utils/bridge-person.js');
    reach =
      context.person ??
      wiring.bridgePerson(context.env, {
        ...(flags.home && { home: flags.home }),
        onError,
      });
    board =
      context.board ??
      (await wiring.bridgeBoard(context.env, { ...(flags.home && { home: flags.home }), onError }));
    const conductor = context.adapters
      ? undefined
      : wiring.bridgeConductor(context.env, { ...(flags.home && { home: flags.home }), onError });
    const fallback = bridgeFallbackOf(context.env, flags.fallback);
    const hosted = context.adapters ? [] : await hostedFor(context.env, flags, onError);
    host = await hostBridge({
      ...(flags.home && { home: flags.home }),
      env: context.env,
      adapters: context.adapters ?? [
        ...bridgeAdapters(context.env, {
          ...(flags.home && { home: flags.home }),
          ...(flags.codexSandbox && { codexSandbox: flags.codexSandbox }),
          ...(flags.claudeMode && { claudeMode: flags.claudeMode }),
          onError,
        }),
        ...hosted,
        ...(conductor ? [conductor] : []),
      ],
      rights: reach.rights,
      person: reach.person,
      ...(board && { board }),
      ...(fallback.length > 0 && { routing: { fallback } }),
      onError,
    });
    await reach.start().catch(async (error: unknown) => {
      await host.close();
      throw error;
    });
  } catch (error) {
    await board?.close?.().catch(() => undefined);
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
  context.io.print(chalk.dim(`  What needs you: ${reach.reachedBy.join(', ')}`));
  context.io.print(chalk.dim('  Follow the letters: cogitator bridge log --follow'));
  context.io.print(chalk.dim('  Press Ctrl+C to stop'));

  const { stopped, dispose } = stopRequested(context);
  try {
    const reason = await Promise.race([stopped.then(() => 'asked' as const), host.stopped]);
    await reach.stop().catch(() => undefined);
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
    await board?.close?.().catch(() => undefined);
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

function wholeNumber(value: string): number {
  const number = Number(value);
  if (!Number.isInteger(number) || number < 0) {
    throw new InvalidArgumentError('Expected a whole number, 0 or more.');
  }
  return number;
}

const DASH_HINT =
  '(A text that starts with a dash goes after "--", or is piped in with "-" in its place)';

/** An option that may be given several times: each value is added to those before it. */
const collect = (value: string, all: string[]): string[] => [...all, value];

const homeOption = [
  '--home <dir>',
  'the folder of the bridge files (default: COGITATOR_BRIDGE_HOME, else ~/.cogitator/bridge)',
] as const;

const typeOption = [
  '--type <word>',
  'the kind of work, one word such as code, fix, review, docs or research: the bridge keeps how each kind went with each agent',
] as const;

export const bridgeCommand = new Command('bridge')
  .description(
    'The agent bridge (experimental): Claude Code, Codex and other agents hand each other jobs'
  )
  .addHelpText(
    'after',
    examplesHelp([
      ['cogitator bridge install', 'give Claude Code and Codex the bridge in this project'],
      ['cogitator bridge serve', 'run the dispatcher of this machine'],
      ['cogitator bridge status', 'who is connected and what is in progress'],
      ['cogitator bridge log --follow', 'watch the letters as they go'],
      ['cogitator bridge log --job 12', 'everything about one job'],
      ['cogitator bridge doctor', 'whether Claude Code and Codex can be reached'],
      ['cogitator bridge delegate codex "Write the tests"', 'from a session: hand a job over'],
      ['cogitator bridge send --job 12 --kind report "Done"', 'from a session: report on a job'],
      ['cogitator bridge cancel 12 "Not needed any more"', 'from a session: take a job back'],
      ['cogitator bridge diff 12 --stat', 'from a session: what a job changed in its worktree'],
      ['cogitator bridge accept 12', 'from a session: take the work of a job into this checkout'],
      ['cogitator bridge remember "CI runs on Node 22"', 'put a note on the board of the project'],
      ['cogitator bridge recall deploy', 'the notes of the board that fit a word'],
    ])
  );

bridgeCommand
  .command('serve')
  .description('Run the dispatcher in the foreground: one per machine, shared by every project')
  .option(...homeOption)
  .option(
    '--agent <name=model>',
    'host an agent of the Cogitator runtime under a name of its own, such as qwen=ollama/qwen3-coder:30b, repeatable',
    collect,
    [] as string[]
  )
  .option('-c, --config <path>', 'the config file the providers of those agents are read from')
  .option(
    '--fallback <agent>',
    'an agent that takes a job only when no other can, such as one that costs money by the call, repeatable',
    collect,
    [] as string[]
  )
  .addOption(
    new Option(
      '--codex-sandbox <mode>',
      'the sandbox of the Codex threads it starts (default: workspace-write)'
    ).choices(CODEX_SANDBOXES)
  )
  .addOption(
    new Option(
      '--claude-mode <mode>',
      'the permission mode of the Claude Code sessions it starts (default: acceptEdits)'
    ).choices(CLAUDE_MODES)
  )
  .action(async (flags: ServeFlags) => {
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

bridgeCommand
  .command('doctor')
  .description('Check that the bridge can reach Claude Code and Codex on this machine')
  .option('--cwd <dir>', 'the project folder to check (default: the current one)')
  .option(...homeOption)
  .option('--json', 'print one JSON object')
  .action(async (flags: BridgeDoctorFlags) => {
    process.exitCode = await runBridgeDoctor(flags);
  });

bridgeCommand
  .command('delegate <to> [text...]')
  .description(
    'From a session: hand a job to an agent (codex, claude, an agent name, or auto for the one whose jobs held best) and get its number'
  )
  .option('--title <title>', 'a short name of the job (default: the first line of the text)')
  .option(...typeOption)
  .option('--review-of <job>', 'the job whose work this one reviews', positiveInt)
  .option('--cwd <dir>', 'the folder the job is done in (default: the current one)')
  .option(
    '--check <command>',
    'a command that shows the job is done, repeatable',
    collect,
    [] as string[]
  )
  .option(
    '--worktree',
    'give the job a git worktree of its own, off the last commit here, and a fresh session'
  )
  .option('--done <text>', 'what done looks like, repeatable', collect, [] as string[])
  .option('--constraint <text>', 'what must hold or stay untouched, repeatable', collect, [])
  .option('--decision <text>', 'what was decided already, repeatable', collect, [] as string[])
  .option(
    '--file <path[:lines][=why]>',
    'a file to start from, such as src/a.ts:120-180=the retry loop, repeatable',
    collect,
    [] as string[]
  )
  .option(
    '--context-tokens <number>',
    'how many tokens the context the bridge adds may take (default: 6000)',
    positiveInt
  )
  .option('--parent <number>', 'the job this one is part of', positiveInt)
  .option(...homeOption)
  .option('--json', 'print the job as JSON')
  .showHelpAfterError(DASH_HINT)
  .action(async (to: string, text: string[], flags: BridgeDelegateFlags) => {
    process.exitCode = await runBridgeDelegate(to, text, flags);
  });

const reviewOptions = (command: Command): Command =>
  command
    .option(
      '--by <agent>',
      'who reviews: an agent name, or codex or claude for a fresh session (default: a fresh session of another agent than the author)'
    )
    .option(
      '--rounds <number>',
      'how many times the author is sent back to fix what was found, 0 to only review (default: 2)',
      wholeNumber
    )
    .option(
      '--threshold <severity>',
      'the lightest finding the author is sent back for: blocker, major, minor or nit (default: major)'
    )
    .option('--focus <text>', 'what the reviewer looks at above all');

reviewOptions(
  bridgeCommand
    .command('build <to> [text...]')
    .description(
      'From a session: have a job done, checked and reviewed in one go, and the author fix what the review found'
    )
    .option('--title <title>', 'a short name of the job (default: the first line of the text)')
    .option(...typeOption)
    .option('--cwd <dir>', 'the folder the job is about (default: the current one)')
    .option(
      '--check <command>',
      'a command that shows the job is done, run after the work and after every round of fixes, repeatable',
      collect,
      [] as string[]
    )
    .option('--no-worktree', 'do the work in this folder instead of a git worktree of its own')
    .option('--done <text>', 'what done looks like, repeatable', collect, [] as string[])
    .option('--constraint <text>', 'what must hold or stay untouched, repeatable', collect, [])
    .option('--decision <text>', 'what was decided already, repeatable', collect, [] as string[])
    .option(
      '--file <path[:lines][=why]>',
      'a file to start from, such as src/a.ts:120-180=the retry loop, repeatable',
      collect,
      [] as string[]
    )
)
  .option(...homeOption)
  .option('--json', 'print the job as JSON')
  .showHelpAfterError(DASH_HINT)
  .action(async (to: string, text: string[], flags: BridgeBuildFlags) => {
    process.exitCode = await runBridgeBuild(to, text, flags);
  });

reviewOptions(
  bridgeCommand
    .command('review')
    .description(
      'From a session: have another agent review the work of a job that is done, and its author fix what was found'
    )
    .argument('<job>', 'the number of the job', positiveInt)
)
  .option(...homeOption)
  .option('--json', 'print the job as JSON')
  .action(async (job: number, flags: BridgeReviewFlags) => {
    process.exitCode = await runBridgeReview(job, flags);
  });

bridgeCommand
  .command('race [text...]')
  .description(
    'From a session: hand the same job to several agents at once, each in a worktree of its own, and get the results side by side'
  )
  .option('--to <agent>', 'who does the job, twice or more: codex, claude', collect, [] as string[])
  .option('--judge <agent>', 'who compares the attempts and says which to take')
  .option('--title <title>', 'a short name of the job (default: the first line of the text)')
  .option(...typeOption)
  .option('--cwd <dir>', 'the folder the job is about (default: the current one)')
  .option(
    '--check <command>',
    'a command that shows the job is done, run on every attempt, repeatable',
    collect,
    [] as string[]
  )
  .option('--done <text>', 'what done looks like, repeatable', collect, [] as string[])
  .option('--constraint <text>', 'what must hold or stay untouched, repeatable', collect, [])
  .option('--decision <text>', 'what was decided already, repeatable', collect, [] as string[])
  .option(
    '--file <path[:lines][=why]>',
    'a file to start from, such as src/a.ts:120-180=the retry loop, repeatable',
    collect,
    [] as string[]
  )
  .option(...homeOption)
  .option('--json', 'print the job as JSON')
  .showHelpAfterError(DASH_HINT)
  .action(async (text: string[], flags: BridgeRaceFlags) => {
    process.exitCode = await runBridgeRace(text, flags);
  });

bridgeCommand
  .command('debate [text...]')
  .description(
    'From a session: put a question to several agents, who answer each other until they agree or the rounds run out'
  )
  .option(
    '--with <agent[=role]>',
    'who debates, twice or more: codex, claude=critic, codex=advocate',
    collect,
    [] as string[]
  )
  .option('--rounds <number>', 'how many rounds at most (default: 3)', positiveInt)
  .option('--moderator <agent>', 'who sums the debate up at the end')
  .option('--title <title>', 'a short name of the debate')
  .option(...homeOption)
  .option('--json', 'print the job as JSON')
  .showHelpAfterError(DASH_HINT)
  .action(async (text: string[], flags: BridgeDebateFlags) => {
    process.exitCode = await runBridgeDebate(text, flags);
  });

bridgeCommand
  .command('recipe <name> [text...]')
  .description(
    'From a session: start a recipe the dispatcher knows by its name, with its input as JSON'
  )
  .option('--input <json>', `what the recipe is started with, such as '{"to":"codex"}'`)
  .option('--title <title>', 'a short name of the job (default: the first line of the text)')
  .option('--cwd <dir>', 'the folder the job is about (default: the current one)')
  .option(...homeOption)
  .option('--json', 'print the job as JSON')
  .showHelpAfterError(DASH_HINT)
  .action(async (name: string, text: string[], flags: BridgeRecipeFlags) => {
    process.exitCode = await runBridgeRecipe(name, text, flags);
  });

bridgeCommand
  .command('send [text...]')
  .description(
    'From a session: send a letter on a job, such as a question, an answer or the report'
  )
  .requiredOption('--job <number>', 'the job the letter is about', positiveInt)
  .addOption(
    new Option('--kind <kind>', 'what the letter is').choices(SENDABLE_KINDS).makeOptionMandatory()
  )
  .option('--failed', 'with --kind report: the job could not be done')
  .option(
    '--lesson <text>',
    'with --kind report: what the job taught, for the board of the project, repeatable',
    collect,
    [] as string[]
  )
  .option('--reply-to <letter>', 'the letter this one answers')
  .addOption(
    new Option(
      '--decision <decision>',
      'with --kind answer: allow or deny a permission request, or leave it to the person'
    ).choices(DECISIONS)
  )
  .option(...homeOption)
  .option('--json', 'print the letter and the job as JSON')
  .showHelpAfterError(DASH_HINT)
  .action(async (text: string[], flags: BridgeSendFlags) => {
    process.exitCode = await runBridgeSend(text, flags);
  });

bridgeCommand
  .command('asks')
  .description('What waits for your word: permission requests and questions agents left to you')
  .option(...homeOption)
  .option('--json', 'print the letters as JSON')
  .action(async (flags: BridgePersonFlags) => {
    process.exitCode = await runBridgeAsks(flags);
  });

for (const verdict of ['allow', 'deny'] as const) {
  bridgeCommand
    .command(verdict)
    .description(
      verdict === 'allow'
        ? 'Allow a call an agent asks your leave for'
        : 'Refuse a call an agent asks your leave for'
    )
    .argument('<job-or-letter>', 'the number of the job, or the id of the letter from `asks`')
    .argument('[reason...]', 'what the agent should know about your decision')
    .option(...homeOption)
    .option('--json', 'print the answer and the job as JSON')
    .action(async (target: string, reason: string[], flags: BridgePersonFlags) => {
      process.exitCode = await runBridgeDecide(verdict, target, reason, flags);
    });
}

bridgeCommand
  .command('reply')
  .description('Answer a question an agent left to you')
  .argument('<job-or-letter>', 'the number of the job, or the id of the letter from `asks`')
  .argument('[text...]', 'your answer, or pipe it in')
  .option(...homeOption)
  .option('--json', 'print the answer and the job as JSON')
  .showHelpAfterError(DASH_HINT)
  .action(async (target: string, text: string[], flags: BridgePersonFlags) => {
    process.exitCode = await runBridgeReply(target, text, flags);
  });

bridgeCommand
  .command('inbox')
  .description('From a session: read the letters that wait for it')
  .option('--job <number>', 'only the letters of one job', positiveInt)
  .option('--peek', 'look without taking them')
  .option('--unhandled', 'also the letters taken before and not answered since')
  .option(...homeOption)
  .option('--json', 'print the letters as JSON')
  .action(async (flags: BridgeInboxFlags) => {
    process.exitCode = await runBridgeInbox(flags);
  });

bridgeCommand
  .command('cancel')
  .description('From a session: take back a job it handed over, the agent is told to stop')
  .argument('<job>', 'the number of the job', positiveInt)
  .argument('[reason...]', 'why, for the agent that worked on it')
  .option(...homeOption)
  .option('--json', 'print the job as JSON')
  .action(async (job: number, reason: string[], flags: BridgeCancelFlags) => {
    process.exitCode = await runBridgeCancel(job, reason, flags);
  });

bridgeCommand
  .command('remember [text...]')
  .description(
    "Put a note on the board of the project: yours from a terminal, the agent's from a session"
  )
  .option('--lesson', 'it is what a job taught, not a fact of the project')
  .option('--job <number>', 'the job it was learned on', positiveInt)
  .option('--job-only', 'keep it to the two agents of that job')
  .option(...homeOption)
  .option('--json', 'print the note as JSON')
  .showHelpAfterError(DASH_HINT)
  .action(async (text: string[], flags: BridgeRememberFlags) => {
    process.exitCode = await runBridgeRemember(text, flags);
  });

bridgeCommand
  .command('suggest [type]')
  .description(
    'See how the jobs of each agent went and who the bridge would give a job to now, for a type of job such as code or review'
  )
  .option(...homeOption)
  .option('--json', 'print the suggestion as JSON')
  .action(async (type: string | undefined, flags: BridgeSuggestFlags) => {
    process.exitCode = await runBridgeSuggest(type, flags);
  });

bridgeCommand
  .command('results')
  .description(
    'See what became of the jobs that ended lately: who did each, its type, whether its result held, and what it took'
  )
  .option(...typeOption)
  .option('--agent <agent>', 'only the jobs of these agents: codex, claude, or the name of one')
  .option('--limit <number>', 'how many, the newest (default: 200)', positiveInt)
  .option(...homeOption)
  .option('--json', 'print the results as JSON')
  .action(async (flags: BridgeResultsFlags) => {
    process.exitCode = await runBridgeResults(flags);
  });

bridgeCommand
  .command('recall [words...]')
  .description('Look at the board of the project: the notes that fit the words, or the newest')
  .addOption(
    new Option('--kind <kind>', 'only notes of this kind').choices(['fact', 'lesson', 'outcome'])
  )
  .option('--limit <number>', 'how many (default: 10)', positiveInt)
  .option(...homeOption)
  .option('--json', 'print the notes as JSON')
  .action(async (words: string[], flags: BridgeRecallFlags) => {
    process.exitCode = await runBridgeRecall(words, flags);
  });

bridgeCommand
  .command('forget')
  .description('Take a note off the board: any note from a terminal, its own from a session')
  .argument('<id>', 'the id of the note, as recall shows it, or the start of it')
  .option(...homeOption)
  .option('--json', 'print the note as JSON')
  .action(async (id: string, flags: BridgeForgetFlags) => {
    process.exitCode = await runBridgeForget(id, flags);
  });

bridgeCommand
  .command('diff')
  .description('From a session: see what a job changed in the git worktree it was given')
  .argument('<job>', 'the number of the job', positiveInt)
  .argument('[path...]', 'only these files, paths from the top of the repository')
  .option('--stat', 'the list of files without the patch')
  .option(...homeOption)
  .option('--json', 'print the changes as JSON')
  .action(async (job: number, paths: string[], flags: BridgeDiffFlags) => {
    process.exitCode = await runBridgeDiff(job, paths, flags);
  });

bridgeCommand
  .command('accept')
  .description(
    'From a session: take the work of a finished job into the checkout here, staged and not committed'
  )
  .argument('<job>', 'the number of the job', positiveInt)
  .option(
    '--as-branch [name]',
    'leave the work as a branch instead: the one of the worktree, or the name given'
  )
  .option(...homeOption)
  .option('--json', 'print the result as JSON')
  .action(async (job: number, flags: BridgeAcceptFlags) => {
    process.exitCode = await runBridgeAccept(job, flags);
  });

bridgeCommand
  .command('reject')
  .description('From a session: drop the work of a finished job with its worktree')
  .argument('<job>', 'the number of the job', positiveInt)
  .argument('[reason...]', 'why, for the journal')
  .option(...homeOption)
  .option('--json', 'print the job as JSON')
  .action(async (job: number, reason: string[], flags: BridgeRejectFlags) => {
    process.exitCode = await runBridgeReject(job, reason, flags);
  });

bridgeCommand
  .command('wait')
  .description(
    'Wait for the mail of a session and exit with code 2 when it comes: what a wake hook runs'
  )
  .option('--hook <harness>', 'run as a hook of this harness: its stdin tells the session')
  .option('--timeout <seconds>', 'how long to wait (default 600)', positiveInt)
  .option('--agent <name>', 'the name the bridge gave the session')
  .option('--tools', 'the session has the bridge tools: tell it to reply with them')
  .option(...homeOption)
  .action(async (flags: BridgeWaitFlags) => {
    process.exitCode = await runBridgeWait(flags);
  });

bridgeCommand
  .command('mcp')
  .description(
    'Serve the bridge tools to a session over MCP (stdio): what Claude Code and Codex start'
  )
  .option(...homeOption)
  .action(async (flags: HomeFlags) => {
    process.exitCode = await runBridgeMcp(flags);
  });

bridgeCommand
  .command('offer [agent...]')
  .description(
    'Serve the agents of the bridge to an MCP client as tools (stdio): a call hands a job to the agent and returns its report'
  )
  .option(
    '--project <dir>',
    'the project the jobs are handed over in (default: the current folder)'
  )
  .option('--name <name>', 'what status and the journal call this server (default: outward)')
  .option('--worktree', 'give every job a git worktree of its own, off the last commit')
  .option(...typeOption)
  .option(...homeOption)
  .action(async (agents: string[], flags: BridgeOfferFlags) => {
    process.exitCode = await runBridgeOffer(agents, flags);
  });

bridgeCommand
  .command('limited')
  .description(
    'Tell the bridge a session ran into the limit of its subscription: what a hook runs when a turn of the session ends on an error'
  )
  .requiredOption('--hook <harness>', 'the harness whose hook runs the command')
  .option('--agent <name>', 'the name the bridge gave the session it started')
  .option(...homeOption)
  .action(async (flags: BridgeLimitedFlags) => {
    process.exitCode = await runBridgeLimited(flags);
  });

bridgeCommand
  .command('limits')
  .description(
    'See which agents ran into the limit of their subscription and until when the bridge hands them no job'
  )
  .option('--clear <agent>', 'say the limit of an agent is over: codex, claude, or the name of one')
  .option(...homeOption)
  .option('--json', 'print the limits as JSON')
  .action(async (flags: BridgeLimitsFlags) => {
    process.exitCode = await runBridgeLimits(flags);
  });

bridgeCommand
  .command('stuck')
  .description(
    'Tell the bridge a session waits for a person at its own window: what a hook runs when the session opens its permission dialog'
  )
  .requiredOption('--hook <harness>', 'the harness whose hook runs the command')
  .option(...homeOption)
  .action(async (flags: BridgeStuckFlags) => {
    process.exitCode = await runBridgeStuck(flags);
  });

bridgeCommand
  .command('permit')
  .description(
    'Ask leave for a call of a session through the bridge: what a hook runs when the session would show its permission dialog'
  )
  .requiredOption('--hook <harness>', 'the harness whose hook runs the command')
  .option('--timeout <seconds>', 'how long to wait for the decision', positiveInt)
  .option('--agent <name>', 'the name the bridge gave the session, for one it started')
  .option(...homeOption)
  .action(async (flags: BridgePermitFlags) => {
    process.exitCode = await runBridgePermit(flags);
  });

bridgeCommand
  .command('caller')
  .description(
    'Tell the bridge tools which session calls them: what a hook runs before a tool call'
  )
  .requiredOption('--hook <harness>', 'the harness whose hook runs the command')
  .action(async (flags: { hook: string }) => {
    process.exitCode = await runBridgeCaller(flags);
  });

const setupTarget = [
  '[harness]',
  `which harness: ${INSTALL_CHOICES.join(', ')} (default: all that are installed)`,
] as const;

bridgeCommand
  .command('install')
  .description(
    'Give the sessions you open in Claude Code and Codex the bridge: its tools, the hooks, the notes'
  )
  .argument(...setupTarget)
  .option('--user', 'for every project of yours, not only this one')
  .option('--take-jobs', 'let sessions carry out the jobs of other agents without asking you first')
  .option('--no-notes', 'leave CLAUDE.md and AGENTS.md as they are')
  .option('--no-allow', 'keep the permission prompt of Claude Code for the bridge tools')
  .option('--cwd <dir>', 'the project to set up (default: the one the current folder is in)')
  .option('--dry-run', 'list the changes, make none')
  .option('-y, --yes', 'make the changes without asking')
  .option(...homeOption)
  .option('--json', 'print the changes as JSON, with --yes or --dry-run')
  .action(async (harness: string | undefined, flags: BridgeInstallFlags) => {
    process.exitCode = await runBridgeInstall(harness, flags);
  });

bridgeCommand
  .command('uninstall')
  .description('Take out what install put in, and nothing else')
  .argument(...setupTarget)
  .option('--user', 'what was set up for every project of yours')
  .option('--cwd <dir>', 'the project (default: the one the current folder is in)')
  .option('--dry-run', 'list the changes, make none')
  .option('-y, --yes', 'make the changes without asking')
  .option(...homeOption)
  .option('--json', 'print the changes as JSON, with --yes or --dry-run')
  .action(async (harness: string | undefined, flags: BridgeUninstallFlags) => {
    process.exitCode = await runBridgeUninstall(harness, flags);
  });
