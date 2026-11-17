/**
 * cogitator bridge delegate | send | inbox | wait | doctor - the bridge as a session and a
 * person at a terminal use it
 */

import chalk from 'chalk';
import { resolve } from 'node:path';
import {
  BridgeClient,
  FINDING_SEVERITIES,
  RECIPE_HARNESS,
  bridgePaths,
  callerFromEnv,
  factLine,
  isBridgeError,
  mailText,
  shellQuote,
  waitForMail,
  type BridgeAdapter,
  type BridgePaths,
  type CallerIdentity,
  type ContextFile,
  type FindingSeverity,
  type HealthCheck,
  type JobContext,
  type LetterKind,
  type PersonLetter,
  type Verdict,
} from '@cogitator-ai/bridge';
import { CommandError, EXIT, printJson, reportFailure } from '../utils/cli.js';
import { bridgeAdapters, bridgeCommandOf } from '../utils/bridge-adapters.js';

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

function adaptersOf(flags: HomeFlags, context: BridgeSessionContext): readonly BridgeAdapter[] {
  return (
    context.adapters ?? bridgeAdapters(context.env, { ...(flags.home && { home: flags.home }) })
  );
}

/** What the bridge sets in the environment of a session it starts: the name it gave the session. */
const STARTED_BY_BRIDGE_ENV = 'COGITATOR_BRIDGE_AGENT';

const NO_SESSION = new CommandError('This command runs inside a session of an agent', {
  hints: [
    'Run it from Claude Code or Codex: the session is known by CLAUDE_CODE_SESSION_ID or CODEX_THREAD_ID',
    'See what goes on from a terminal: cogitator bridge status, cogitator bridge log',
  ],
});

async function connect(
  flags: HomeFlags,
  context: BridgeSessionContext,
  caller?: CallerIdentity
): Promise<BridgeClient> {
  try {
    return await BridgeClient.connect({
      socketPath: pathsOf(flags, context).socket,
      ...(caller && { caller }),
    });
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

/**
 * A call made as the person at the machine. A session of an agent is refused: the answers of
 * the person must not come from the agents they are asked about.
 */
async function asPerson<T>(
  flags: HomeFlags,
  context: BridgeSessionContext,
  work: (client: BridgeClient) => Promise<T>
): Promise<T> {
  const session = callerFromEnv(context.env, context.cwd);
  const started = context.env[STARTED_BY_BRIDGE_ENV]?.trim();
  if (session || started) {
    throw new CommandError(
      `This runs in a session of ${session?.harness ?? started}, and an agent does not answer for the person`,
      {
        hints: [
          'Run it in a terminal of your own',
          'An agent refuses a request sent to it with: cogitator bridge send --kind answer --decision deny',
        ],
      }
    );
  }
  const client = await connect(flags, context);
  try {
    return await work(client);
  } finally {
    await client.close();
  }
}

/**
 * A call about the board of facts, made as the session the command runs in, or as the person
 * when it runs in a terminal of their own: `work` gets the project the person is in then, which
 * an agent's own project stands for otherwise.
 */
async function onBoard<T>(
  flags: HomeFlags,
  context: BridgeSessionContext,
  work: (client: BridgeClient, project: string | undefined) => Promise<T>
): Promise<T> {
  const caller = callerFromEnv(context.env, context.cwd);
  const started = context.env[STARTED_BY_BRIDGE_ENV]?.trim();
  if (!caller && started) {
    throw new CommandError(
      `This runs in a session the bridge started as ${started}, and nothing here says which session it is, so it cannot speak as that agent, and an agent does not speak for the person`,
      {
        hints: [
          'Use the bridge tools of the session, or run the command in a terminal of your own',
        ],
      }
    );
  }
  const client = await connect(flags, context, caller);
  try {
    return await work(client, caller ? undefined : context.cwd);
  } finally {
    await client.close();
  }
}

/** A file of `delegate --file`: `path`, `path:120-180`, and after `=` what is there. */
export function contextFile(value: string): ContextFile {
  const [named, ...why] = value.split('=');
  const said = why.join('=').trim();
  const match = /^(.*):(\d+(?:-\d+)?)$/.exec(named.trim());
  return {
    path: match ? match[1] : named.trim(),
    ...(match && { lines: match[2] }),
    ...(said && { why: said }),
  };
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
  worktree?: boolean;
  done?: string[];
  constraint?: string[];
  decision?: string[];
  file?: string[];
  contextTokens?: number;
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
    const context_ = contextOf(flags);
    const { job } = await asSession(flags, context, (client) =>
      client.createJob({
        to,
        body,
        ...(flags.title && { title: flags.title }),
        ...(flags.cwd && { cwd: flags.cwd }),
        ...(flags.check?.length && { checks: flags.check.map((command) => ({ command })) }),
        ...(flags.worktree && { worktree: true }),
        ...(context_ && { context: context_ }),
        ...(flags.contextTokens !== undefined && { contextTokens: flags.contextTokens }),
        ...(flags.parent !== undefined && { parent: flags.parent }),
      })
    );
    if (flags.json) printJson(job);
    else {
      context.print(
        `Job #${job.number} is with ${job.to} (${job.state}). Its answer arrives as a letter: nothing to wait for here`
      );
      if (job.isolation === 'worktree') {
        context.print(
          `  It is done in a git worktree of its own. Its work comes back with: cogitator bridge accept ${job.number}`
        );
      }
    }
    return 0;
  } catch (error) {
    return reportFailure(error, { json: flags.json ?? false });
  }
}

/** The context of a job, as the flags of a command name it. Undefined when they name none. */
function contextOf(
  flags: Pick<BridgeDelegateFlags, 'done' | 'constraint' | 'decision' | 'file'>
): JobContext | undefined {
  const named: JobContext = {
    ...(flags.done?.length && { done: flags.done }),
    ...(flags.constraint?.length && { constraints: flags.constraint }),
    ...(flags.decision?.length && { decisions: flags.decision }),
    ...(flags.file?.length && { files: flags.file.map(contextFile) }),
  };
  return Object.keys(named).length > 0 ? named : undefined;
}

/** How a review goes, as `build` and `review` take it. */
export interface BridgeReviewOptions {
  by?: string;
  rounds?: number;
  threshold?: FindingSeverity;
  focus?: string;
}

function reviewInput(flags: BridgeReviewOptions): Record<string, unknown> {
  if (flags.threshold && !FINDING_SEVERITIES.includes(flags.threshold)) {
    throw new CommandError(`--threshold is one of: ${FINDING_SEVERITIES.join(', ')}`);
  }
  return {
    ...(flags.by && { by: flags.by }),
    ...(flags.rounds !== undefined && { rounds: flags.rounds }),
    ...(flags.threshold && { threshold: flags.threshold }),
    ...(flags.focus && { focus: flags.focus }),
  };
}

const AFTER_RECIPE =
  'The bridge hands its steps to the agents itself. Its report arrives as a letter: nothing to wait for here';

export interface BridgeBuildFlags
  extends
    HomeFlags,
    BridgeReviewOptions,
    Pick<
      BridgeDelegateFlags,
      'title' | 'cwd' | 'check' | 'done' | 'constraint' | 'decision' | 'file'
    > {
  /** False with `--no-worktree`: the work is done in the folder of the caller */
  worktree?: boolean;
  json?: boolean;
}

/**
 * cogitator bridge build <to> <text>: hands a job over to be done, checked and reviewed, and
 * prints the number of the recipe's job at once.
 */
export async function runBridgeBuild(
  to: string,
  words: readonly string[],
  flags: BridgeBuildFlags,
  context: BridgeSessionContext = defaultContext()
): Promise<number> {
  try {
    const body = await bodyOf(words, context);
    const named = contextOf(flags);
    const input = {
      to,
      ...(flags.check?.length && { checks: flags.check.map((command) => ({ command })) }),
      ...(flags.worktree === false && { worktree: false }),
      ...(named && { context: named }),
      ...reviewInput(flags),
    };
    const { job } = await asSession(flags, context, (client) =>
      client.createJob({
        to: RECIPE_HARNESS,
        body,
        ...(flags.title && { title: flags.title }),
        ...(flags.cwd && { cwd: flags.cwd }),
        recipe: { name: 'build', input },
      })
    );
    if (flags.json) printJson(job);
    else {
      context.print(
        `Job #${job.number} is the build (${job.state}): ${to} does the work, then it is checked and reviewed. ${AFTER_RECIPE}`
      );
    }
    return 0;
  } catch (error) {
    return reportFailure(error, { json: flags.json ?? false });
  }
}

export interface BridgeReviewFlags extends HomeFlags, BridgeReviewOptions {
  json?: boolean;
}

/** cogitator bridge review <job>: has the work of a job that is done reviewed by another agent. */
export async function runBridgeReview(
  reviewed: number,
  flags: BridgeReviewFlags,
  context: BridgeSessionContext = defaultContext()
): Promise<number> {
  try {
    const input = { job: reviewed, ...reviewInput(flags) };
    const { job } = await asSession(flags, context, (client) =>
      client.createJob({
        to: RECIPE_HARNESS,
        title: `Review of job #${reviewed}`,
        body: `Review the work of job #${reviewed}${flags.focus ? `: ${flags.focus}` : ''}`,
        recipe: { name: 'review', input },
      })
    );
    if (flags.json) printJson(job);
    else {
      context.print(
        `Job #${job.number} is the review of job #${reviewed} (${job.state}). ${AFTER_RECIPE}`
      );
    }
    return 0;
  } catch (error) {
    return reportFailure(error, { json: flags.json ?? false });
  }
}

export interface BridgeRecipeFlags extends HomeFlags {
  /** What the recipe is started with, as JSON */
  input?: string;
  title?: string;
  cwd?: string;
  json?: boolean;
}

/**
 * cogitator bridge recipe <name> <text>: starts any recipe the dispatcher knows, with its input
 * as JSON. `build` and `review` are the same thing with flags for the input.
 */
export async function runBridgeRecipe(
  name: string,
  words: readonly string[],
  flags: BridgeRecipeFlags,
  context: BridgeSessionContext = defaultContext()
): Promise<number> {
  try {
    let input: unknown;
    if (flags.input !== undefined) {
      try {
        input = JSON.parse(flags.input);
      } catch (error) {
        throw new CommandError(
          `--input is not JSON: ${error instanceof Error ? error.message : String(error)}`,
          { hints: [`Such as: --input '{"to":"codex"}'`] }
        );
      }
    }
    const body = await bodyOf(words, context);
    const { job } = await asSession(flags, context, (client) =>
      client.createJob({
        to: RECIPE_HARNESS,
        body,
        ...(flags.title && { title: flags.title }),
        ...(flags.cwd && { cwd: flags.cwd }),
        recipe: { name, ...(input !== undefined && { input }) },
      })
    );
    if (flags.json) printJson(job);
    else context.print(`Job #${job.number} is the recipe ${name} (${job.state}). ${AFTER_RECIPE}`);
    return 0;
  } catch (error) {
    return reportFailure(error, { json: flags.json ?? false });
  }
}

export const SENDABLE_KINDS = ['question', 'answer', 'report', 'note', 'permission'] as const;

export const DECISIONS = ['allow', 'deny', 'person'] as const;

export interface BridgeSendFlags extends HomeFlags {
  job: number;
  kind: Exclude<LetterKind, 'task'>;
  failed?: boolean;
  /** Of a report: what the job taught, for the board of the project */
  lesson?: string[];
  replyTo?: string;
  /** Of an answer: the decision of a permission request, or `person` to leave it to the user */
  decision?: (typeof DECISIONS)[number];
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
    const decision = flags.decision;
    if (decision && flags.kind !== 'answer') {
      throw new CommandError('--decision goes with --kind answer');
    }
    if (decision === 'person') {
      const passed = await asSession(flags, context, (client) =>
        client.escalate(flags.replyTo ? { letter: flags.replyTo } : { job: flags.job })
      );
      if (flags.json) printJson(passed);
      else {
        context.print(
          `Left the ${passed.kind} ${passed.id} to the person: their answer goes to ${passed.from}`
        );
      }
      return 0;
    }
    const body = decision
      ? words.join(' ').trim() || (decision === 'allow' ? 'Allowed' : 'Refused')
      : await bodyOf(words, context);
    const sent = await asSession(flags, context, (client) =>
      client.send({
        job: flags.job,
        kind: flags.kind,
        body,
        ...(decision && { verdict: decision }),
        ...(flags.replyTo && { inReplyTo: flags.replyTo }),
        ...(flags.failed && { outcome: 'failed' as const }),
        ...(flags.lesson?.length && { lessons: flags.lesson }),
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

export interface BridgePersonFlags extends HomeFlags {
  json?: boolean;
}

/** What a waiting letter is answered with, as the person types it. */
function answerHint({ letter, job }: PersonLetter, several: boolean): string {
  const target = several ? letter.id : String(job.number);
  return letter.ask
    ? `Allow: cogitator bridge allow ${target}   Refuse: cogitator bridge deny ${target}`
    : `Answer: cogitator bridge reply ${target} "<your answer>"`;
}

/** cogitator bridge asks: what waits for the word of the person. */
export async function runBridgeAsks(
  flags: BridgePersonFlags,
  context: BridgeSessionContext = defaultContext()
): Promise<number> {
  try {
    const waiting = await asPerson(flags, context, (client) => client.forPerson());
    if (flags.json) {
      printJson(waiting);
      return 0;
    }
    if (waiting.length === 0) {
      context.print('Nothing waits for you');
      return 0;
    }
    const perJob = new Map<number, number>();
    for (const { job } of waiting) perJob.set(job.number, (perJob.get(job.number) ?? 0) + 1);
    for (const waited of waiting) {
      const { letter, job } = waited;
      context.print(
        `${chalk.bold(`Job #${job.number}`)} "${job.title}" in ${job.project}  ${chalk.dim(letter.id)}`
      );
      context.print(`${letter.from} ${letter.ask ? 'asks leave' : 'asks'}:`);
      for (const line of letter.body.split('\n')) context.print(`  ${line}`);
      context.print(chalk.dim(answerHint(waited, (perJob.get(job.number) ?? 0) > 1)));
      context.print('');
    }
    return 0;
  } catch (error) {
    return reportFailure(error, { json: flags.json ?? false });
  }
}

/**
 * The letter a word of the person names: the id of a letter, else a job number when one letter
 * of that job waits for them, else the start of an id.
 */
function waitingLetter(waiting: readonly PersonLetter[], word: string): PersonLetter {
  const named = word.trim();
  const exact = waiting.find(({ letter }) => letter.id === named);
  if (exact) return exact;
  const number = /^#?(\d+)$/.exec(named)?.[1];
  const found =
    number === undefined
      ? waiting.filter(({ letter }) => letter.id.startsWith(named))
      : waiting.filter(({ job }) => job.number === Number(number));
  if (found.length === 1) return found[0];
  if (found.length === 0) {
    throw new CommandError(`Nothing that waits for you is named ${word}`, {
      hints: ['See what waits: cogitator bridge asks'],
    });
  }
  throw new CommandError(`${found.length} letters that wait for you are named ${word}`, {
    hints: [`Name one by its id: ${found.map(({ letter }) => letter.id).join(', ')}`],
  });
}

/** cogitator bridge allow | deny <job or letter> [reason]: the person decides a permission request. */
export async function runBridgeDecide(
  verdict: Verdict,
  target: string,
  words: readonly string[],
  flags: BridgePersonFlags,
  context: BridgeSessionContext = defaultContext()
): Promise<number> {
  try {
    const reason = words.join(' ').trim();
    const { sent, waited } = await asPerson(flags, context, async (client) => {
      const found = waitingLetter(await client.forPerson(), target);
      if (!found.letter.ask) {
        throw new CommandError(
          `The ${found.letter.kind} ${found.letter.id} takes an answer in words`,
          {
            hints: [`Answer it: cogitator bridge reply ${target} "<your answer>"`],
          }
        );
      }
      return {
        waited: found,
        sent: await client.personAnswer({
          letter: found.letter.id,
          verdict,
          ...(reason && { body: reason }),
        }),
      };
    });
    if (flags.json) printJson(sent);
    else {
      context.print(
        `${verdict === 'allow' ? 'Allowed' : 'Refused'}: ${waited.letter.from} is told. Job #${sent.job.number} is ${sent.job.state}`
      );
    }
    return 0;
  } catch (error) {
    return reportFailure(error, { json: flags.json ?? false });
  }
}

/** cogitator bridge reply <job or letter> <text>: the person answers a question. */
export async function runBridgeReply(
  target: string,
  words: readonly string[],
  flags: BridgePersonFlags,
  context: BridgeSessionContext = defaultContext()
): Promise<number> {
  try {
    const body = await bodyOf(words, context);
    const { sent, waited } = await asPerson(flags, context, async (client) => {
      const found = waitingLetter(await client.forPerson(), target);
      if (found.letter.ask) {
        throw new CommandError(`The permission request ${found.letter.id} takes a decision`, {
          hints: [
            `Decide it: cogitator bridge allow ${target}, or cogitator bridge deny ${target}`,
          ],
        });
      }
      return {
        waited: found,
        sent: await client.personAnswer({ letter: found.letter.id, body }),
      };
    });
    if (flags.json) printJson(sent);
    else {
      context.print(`Sent to ${waited.letter.from}. Job #${sent.job.number} is ${sent.job.state}`);
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

export interface BridgeCancelFlags extends HomeFlags {
  json?: boolean;
}

/**
 * cogitator bridge cancel <job> [reason]: the session that handed a job over takes it back. The
 * agent it was with is told to stop.
 */
export async function runBridgeCancel(
  job: number,
  words: readonly string[],
  flags: BridgeCancelFlags,
  context: BridgeSessionContext = defaultContext()
): Promise<number> {
  try {
    const reason = words.join(' ').trim();
    const canceled = await asSession(flags, context, (client) =>
      client.cancel(job, reason || undefined)
    );
    if (flags.json) printJson(canceled);
    else context.print(`Job #${canceled.number} is ${canceled.state}, ${canceled.to} is told`);
    return 0;
  } catch (error) {
    return reportFailure(error, { json: flags.json ?? false });
  }
}

export interface BridgeRememberFlags extends HomeFlags {
  lesson?: boolean;
  job?: number;
  jobOnly?: boolean;
  json?: boolean;
}

/**
 * cogitator bridge remember <text>: puts a note on the board of the project. From a session it
 * is the note of that agent, from a terminal of your own it is yours, for the project the
 * command runs in.
 */
export async function runBridgeRemember(
  words: readonly string[],
  flags: BridgeRememberFlags,
  context: BridgeSessionContext = defaultContext()
): Promise<number> {
  try {
    const text = await bodyOf(words, context);
    const kept = await onBoard(flags, context, (client, project) =>
      client.remember({
        text,
        ...(flags.lesson && { kind: 'lesson' as const }),
        ...(flags.job !== undefined && { job: flags.job }),
        ...(flags.jobOnly && { jobOnly: true }),
        ...(project && { project }),
      })
    );
    if (flags.json) printJson(kept);
    else {
      context.print(
        `Kept as ${kept.id}, for ${kept.job === undefined ? `every agent of ${kept.project}` : `the two agents of job #${kept.job}`}`
      );
    }
    return 0;
  } catch (error) {
    return reportFailure(error, { json: flags.json ?? false });
  }
}

export interface BridgeRecallFlags extends HomeFlags {
  kind?: 'fact' | 'lesson' | 'outcome';
  limit?: number;
  json?: boolean;
}

/**
 * cogitator bridge recall [words]: the notes on the board of the project that fit the words
 * best, or the newest, each with who said it and when.
 */
export async function runBridgeRecall(
  words: readonly string[],
  flags: BridgeRecallFlags,
  context: BridgeSessionContext = defaultContext()
): Promise<number> {
  try {
    const text = words.join(' ').trim();
    const found = await onBoard(flags, context, (client, project) =>
      client.recall({
        ...(text && { text }),
        ...(flags.kind && { kinds: [flags.kind] }),
        ...(flags.limit !== undefined && { limit: flags.limit }),
        ...(project && { project }),
      })
    );
    if (flags.json) {
      printJson(found);
      return 0;
    }
    if (found.length === 0) {
      context.print(text ? 'Nothing on the board fits that' : 'The board of this project is empty');
      return 0;
    }
    for (const fact of found) context.print(`${fact.id}  ${factLine(fact)}`);
    return 0;
  } catch (error) {
    return reportFailure(error, { json: flags.json ?? false });
  }
}

export interface BridgeForgetFlags extends HomeFlags {
  json?: boolean;
}

/**
 * cogitator bridge forget <id>: takes a note off the board. A session takes off what it said
 * itself, you any note of the project the command runs in.
 */
export async function runBridgeForget(
  id: string,
  flags: BridgeForgetFlags,
  context: BridgeSessionContext = defaultContext()
): Promise<number> {
  try {
    const gone = await onBoard(flags, context, (client, project) =>
      client.forget({ id, ...(project && { project }) })
    );
    if (flags.json) printJson(gone);
    else context.print(`The note ${gone.id} is off the board: ${gone.text}`);
    return 0;
  } catch (error) {
    return reportFailure(error, { json: flags.json ?? false });
  }
}

export interface BridgeDiffFlags extends HomeFlags {
  stat?: boolean;
  json?: boolean;
}

/**
 * cogitator bridge diff <job> [path...]: what a job changed in the git worktree it was given,
 * as its two agents may see it: the files, and the patch unless `--stat` leaves it out.
 */
export async function runBridgeDiff(
  job: number,
  paths: readonly string[],
  flags: BridgeDiffFlags,
  context: BridgeSessionContext = defaultContext()
): Promise<number> {
  try {
    const found = await asSession(flags, context, (client) =>
      client.diff({
        job,
        ...(paths.length > 0 && { paths: [...paths] }),
        ...(flags.stat && { maxChars: 0 }),
      })
    );
    if (flags.json) {
      printJson(found);
      return 0;
    }
    if (found.files.length === 0) {
      context.print(`Job #${found.job} changed nothing in its worktree, ${found.worktree}`);
      return 0;
    }
    context.print(
      `Job #${found.job}: ${found.files.length} ${found.files.length === 1 ? 'file' : 'files'}, +${found.insertions} -${found.deletions}, in ${found.worktree} (branch ${found.branch})`
    );
    for (const file of found.files) {
      const mark = file.kind === 'added' ? 'A' : file.kind === 'deleted' ? 'D' : 'M';
      const size =
        file.insertions === undefined ? 'binary' : `+${file.insertions} -${file.deletions}`;
      context.print(`  ${mark} ${file.path}  ${size}`);
    }
    if (!flags.stat) {
      context.print('');
      context.print(found.patch.trimEnd());
      if (found.truncated) {
        context.print(
          `[cut here: the patch is longer. Name some files, or read them in ${found.worktree}]`
        );
      }
    }
    return 0;
  } catch (error) {
    return reportFailure(error, { json: flags.json ?? false });
  }
}

export interface BridgeAcceptFlags extends HomeFlags {
  asBranch?: string | boolean;
  json?: boolean;
}

/**
 * cogitator bridge accept <job>: the session that handed a job over takes its work out of the
 * worktree, into the checkout the command runs in, staged and not committed. `--as-branch`
 * leaves it as a branch instead. Files that would conflict are named, nothing is touched then,
 * and the command fails.
 */
export async function runBridgeAccept(
  job: number,
  flags: BridgeAcceptFlags,
  context: BridgeSessionContext = defaultContext()
): Promise<number> {
  try {
    const taken = await asSession(flags, context, (client) =>
      client.accept({ job, ...(flags.asBranch !== undefined && { asBranch: flags.asBranch }) })
    );
    if (flags.json) {
      printJson(taken);
      return taken.state === 'conflict' ? EXIT.failed : 0;
    }
    switch (taken.state) {
      case 'accepted':
        context.print(
          `The work of job #${job} is in ${taken.into}: ${taken.files} ${taken.files === 1 ? 'file' : 'files'}, +${taken.insertions} -${taken.deletions}, staged and not committed`
        );
        context.print('  Look at it: git diff --cached   Then commit it yourself');
        return 0;
      case 'branch':
        context.print(
          `The work of job #${job} is the branch ${taken.branch}, at commit ${taken.commit.slice(0, 10)}`
        );
        return 0;
      case 'nothing':
        context.print(`Job #${job} changed nothing: there was nothing to take`);
        return 0;
      case 'conflict':
        context.print(
          `Nothing was taken: the work of job #${job} would leave these files of ${taken.into} in conflict`
        );
        for (const file of taken.files) context.print(`  ${file}`);
        context.print(
          `  Its worktree is still there. Take it as a branch: cogitator bridge accept ${job} --as-branch   Or drop it: cogitator bridge reject ${job}`
        );
        return EXIT.failed;
    }
  } catch (error) {
    return reportFailure(error, { json: flags.json ?? false });
  }
}

export interface BridgeRejectFlags extends HomeFlags {
  json?: boolean;
}

/**
 * cogitator bridge reject <job> [reason]: the session that handed a job over drops its work.
 * The worktree and its branch are removed with everything in them.
 */
export async function runBridgeReject(
  job: number,
  words: readonly string[],
  flags: BridgeRejectFlags,
  context: BridgeSessionContext = defaultContext()
): Promise<number> {
  try {
    const reason = words.join(' ').trim();
    const dropped = await asSession(flags, context, (client) =>
      client.reject({ job, ...(reason && { reason }) })
    );
    if (flags.json) printJson(dropped);
    else context.print(`The work of job #${dropped.number} is dropped, and its worktree is gone`);
    return 0;
  } catch (error) {
    return reportFailure(error, { json: flags.json ?? false });
  }
}

/**
 * How a session without the bridge's tools answers a letter it was woken with: the command line
 * as the session can run it, whatever its `PATH`.
 */
export function replyHint(bridgeCommand: string, home?: string): string {
  return (
    '(The agent bridge woke this session with the mail above. Answer through it, not in this chat: ' +
    `${bridgeCommand} send --job <number> --kind <answer|question|report|note> "<text>"` +
    `${home ? ` --home ${shellQuote(home)}` : ''})`
  );
}

/** How a session with the bridge's tools answers a letter it was woken with. */
export const TOOLS_REPLY_HINT =
  '(The agent bridge woke this session with the mail above. Reply with the bridge tools, not only in this chat: ' +
  'answer for a question, report for the result of a job handed to you, ask when whoever handed it over has to decide something.)';

export interface BridgeWaitFlags extends HomeFlags {
  /** The harness whose hook runs the command: its stdin tells the session */
  hook?: string;
  /** Seconds to wait */
  timeout?: number;
  /** The name the bridge gave the session, for one it started */
  agent?: string;
  /** The session has the bridge's tools: it is told to reply with them, not with the command line */
  tools?: boolean;
}

/** What `wait` exits with when it has mail: the code that makes a harness wake its session. */
export const WAKE_EXIT_CODE = 2;

const DEFAULT_WAIT_S = 600;

/**
 * cogitator bridge wait: waits for the session's mail and exits. With mail it writes the letters
 * to stderr and exits with code 2, which is what wakes a Claude Code session whose background
 * hook ran it. Without, it exits with 0 and says nothing. A failure exits with 1, never with 2:
 * an error must not wake the session.
 */
export async function runBridgeWait(
  flags: BridgeWaitFlags,
  context: BridgeSessionContext = defaultContext()
): Promise<number> {
  try {
    let caller: CallerIdentity | undefined;
    if (flags.hook) {
      const harness = flags.hook.trim().toLowerCase();
      const adapter = adaptersOf(flags, context).find((candidate) => candidate.harness === harness);
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
    const hint = flags.tools
      ? TOOLS_REPLY_HINT
      : replyHint(bridgeCommandOf(context.env), flags.home);
    context.wake(`${mailText(waited.letters)}\n\n${hint}`);
    await waited.confirm().catch(() => undefined);
    return WAKE_EXIT_CODE;
  } catch (error) {
    reportFailure(error, { json: false });
    return EXIT.failed;
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
    for (const adapter of adaptersOf(flags, context)) {
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
