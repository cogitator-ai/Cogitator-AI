import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import type { StreamEvent } from '@cogitator-ai/server-shared';
import type { ToolApprovalDecision, ToolApprovalRequest } from '@cogitator-ai/types';
import type {
  BridgeAdapter,
  BridgeCalls,
  CreatedSession,
  LetterDelivery,
  LiveSession,
  SessionRequest,
} from '../adapter.js';
import { isBridgeError } from '../errors.js';
import { pause } from './exec.js';
import { oneLine } from '../letters.js';
import { isInside } from '../paths.js';
import type { BridgeJob, JobState, LetterKind, PermissionAsk, RenderedLetter } from '../types.js';

/** How letters reach a session the host runs itself: handed to its agent in the same process. */
export const HOSTED_DELIVERY = 'hosted';

/** One turn of an agent the host runs. */
export interface HostedTurn {
  /** The agent's answer, once the turn is over. Rejects when the turn failed */
  readonly result: Promise<string>;
  /** Reaches the agent in the middle of the turn. False when the turn takes no more */
  steer?(text: string): boolean;
  /** Leaves a message the agent takes when it would stop. False when the turn takes no more */
  followUp?(text: string): boolean;
  /** Stops the turn */
  abort?(reason?: unknown): void;
}

/** What a turn is started for. */
export interface HostedTurnContext {
  /** The job the turn carries out, when the job's first letter starts it */
  job?: BridgeJob;
  /**
   * Asks leave for a tool call the agent's own rules do not settle: the bridge takes the request
   * to whoever may answer it, the agent that handed the job over or the person, and resolves
   * with their answer. Nobody sits at a hosted session, so this is the only way such a call is
   * ever allowed
   */
  approve?(request: ToolApprovalRequest): Promise<ToolApprovalDecision>;
}

/** A session of an agent the host runs. One turn goes on at a time. */
export interface HostedSession {
  turn(text: string, context?: HostedTurnContext): HostedTurn;
  close?(): Promise<void>;
}

/** What a hosted session is opened for. */
export interface HostedSessionContext {
  /** The id the adapter gave the session */
  sessionId: string;
  /** The name the bridge knows the session by */
  agentName: string;
  cwd: string;
  project: string;
  /** The job it is started for */
  job: BridgeJob;
}

export type OpenHostedSession = (
  context: HostedSessionContext
) => HostedSession | Promise<HostedSession>;

export interface HostedAdapterOptions {
  /** The word agents address these sessions by, such as `qwen` or `gemini` */
  harness: string;
  /** Opens a session for a job */
  open: OpenHostedSession;
  /** Whether a turn of these sessions takes messages while it goes on (`HostedTurn.steer`) */
  steer?: boolean;
  /** Hears what went wrong outside a call of the bridge: a report that could not be sent */
  onError?: (error: Error) => void;
  /** How long a turn that was told to stop is waited for when the host closes, 5 s by default */
  stopGraceMs?: number;
  /**
   * Says what a tool call an agent asks leave for touches, so the rules of the agent that handed
   * the job over can judge it. `permissionAskOf` by default, which knows the tools of the
   * Cogitator runtime and of ACP agents by name
   */
  askOf?: (request: ToolApprovalRequest, session: { cwd: string }) => PermissionAsk;
}

const DEFAULT_STOP_GRACE_MS = 5_000;

const FINISHED: readonly JobState[] = ['completed', 'failed', 'canceled'];

/** Letters an agent wants in the middle of its work, when its turn can take them. */
const STEERED: readonly LetterKind[] = ['answer', 'permission', 'note'];

interface Running {
  turn: HostedTurn;
  /** The job the turn carries out, when a job's first letter started it */
  job?: number;
  /** Set once the turn is over or was told to stop */
  done: boolean;
}

/** How long one look for the verdict of a permission request waits before it looks again. */
const VERDICT_POLL_MS = 60_000;

/**
 * The pause before the next look when a look came back at once without a verdict, as from a
 * dispatcher that is closing: the wait must not turn into a loop that never rests.
 */
const VERDICT_RETRY_MS = 250;

/** How much of a call's arguments the letter that asks leave for it shows. */
const ARGUMENTS_SHOWN = 2_000;

const COMMAND_TOOLS: ReadonlySet<string> = new Set(['run_command', 'exec', 'bash', 'shell']);
const READ_TOOLS: ReadonlySet<string> = new Set([
  'read_file',
  'file_read',
  'list_files',
  'file_list',
  'glob',
  'grep',
]);
const EDIT_TOOLS: ReadonlySet<string> = new Set([
  'edit_file',
  'file_edit',
  'write_file',
  'file_write',
  'delete_file',
  'file_delete',
  'move_file',
]);
const FETCH_TOOLS: ReadonlySet<string> = new Set(['web_fetch', 'fetch']);

function textOf(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() !== '' ? value : undefined;
}

/**
 * What a tool call touches, read from the name of its tool and its arguments: the tools of the
 * Cogitator runtime and the names `AcpAgentProvider` gives the calls of an ACP agent. A call it
 * cannot read is known by the name of its tool alone, which leaves it to the person unless a
 * rule names that tool.
 */
export function permissionAskOf(
  request: Pick<ToolApprovalRequest, 'toolName' | 'arguments'>,
  session: { cwd: string }
): PermissionAsk {
  const args = request.arguments;
  const tool = oneLine(request.toolName).slice(0, 256) || 'tool';
  const absolute = (path: string): string => resolve(session.cwd, path);
  const paths = [args.file_path, args.path, args.filePath, args.notebook_path]
    .map(textOf)
    .filter((path): path is string => path !== undefined);
  if (Array.isArray(args.paths)) {
    paths.push(...args.paths.map(textOf).filter((path): path is string => path !== undefined));
  }
  if (COMMAND_TOOLS.has(tool)) {
    const command = textOf(args.command);
    const cwd = textOf(args.cwd);
    if (command) {
      return { tool, access: 'command', command, cwd: absolute(cwd ?? '.') };
    }
  }
  if (READ_TOOLS.has(tool) && paths.length > 0) {
    return { tool, access: 'read', paths: paths.map(absolute) };
  }
  if (EDIT_TOOLS.has(tool) && paths.length > 0) {
    return { tool, access: 'edit', paths: paths.map(absolute) };
  }
  if (FETCH_TOOLS.has(tool)) {
    const url = textOf(args.url);
    if (url) return { tool, access: 'fetch', url };
  }
  return { tool, access: 'other' };
}

/** The words of a letter that asks leave for a call: what the agent said of it, then the call. */
function describeCall(request: ToolApprovalRequest, ask: PermissionAsk): string {
  const said = request.description.trim();
  const call =
    ask.access === 'command' && ask.command
      ? `Run in ${ask.cwd ?? 'its folder'}:\n${ask.command}`
      : ask.access === 'fetch' && ask.url
        ? `Fetch ${ask.url}`
        : ask.paths && ask.paths.length > 0
          ? `${ask.access === 'edit' ? 'Change' : 'Read'}: ${ask.paths.join(', ')}`
          : `Call ${ask.tool} with ${JSON.stringify(request.arguments).slice(0, ARGUMENTS_SHOWN)}`;
  return said && said !== call ? `${said}\n${call}` : call;
}

/** A letter with the job it is about. */
interface Mail {
  letter: RenderedLetter;
  job: BridgeJob;
}

interface Hosted {
  agentName: string;
  cwd: string;
  session: HostedSession;
  running?: Running;
  waiting: Mail[];
  /** True while the next letter to start is being chosen: a letter that arrives then waits */
  choosing?: boolean;
  /** Jobs that were over before their turn came: the agent never saw them, and hears no more */
  unseen: Set<number>;
}

function asError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}

/**
 * Runs the sessions of a harness inside the host: agents of the Cogitator runtime on any model
 * (`cogitatorSessions`), agents behind the Agent Client Protocol (`providerSessions`), or
 * anything else that takes a text and answers. A job's first letter starts a turn, and the
 * agent's answer to it is the job's report: the agent needs no tool to report, and one that
 * failed reports that. A letter that arrives while a turn goes on reaches the agent in the
 * middle of it when the turn takes that, and otherwise starts the next turn. A letter about a
 * job that still waits for its turn waits with it, and does not reach the turn of another job.
 * A job that is canceled or fails stops the turn that carries it out, and is not started when it
 * still waited for its turn. The session is in the address book before its first turn starts, so
 * an agent that answers at once is heard.
 *
 * The sessions live in the host's process and end with it.
 */
export function hostedAdapter(options: HostedAdapterOptions): BridgeAdapter {
  const sessions = new Map<string, Hosted>();
  const onError = options.onError ?? (() => undefined);
  let bridge: BridgeCalls | undefined;
  let closed = false;

  function report(hosted: Hosted, job: number, body: string, failed: boolean): void {
    if (!bridge) return;
    bridge
      .send(hosted.agentName, {
        job,
        kind: 'report',
        body,
        ...(failed && { outcome: 'failed' as const }),
      })
      .catch((error: unknown) => {
        if (isBridgeError(error) && error.code === 'job_finished') return;
        onError(asError(error));
      });
  }

  function start(hosted: Hosted, mail: Mail): void {
    let turn: HostedTurn;
    const { letter } = mail;
    const job = letter.kind === 'task' ? letter.job : undefined;
    const running: Running = {
      turn: { result: Promise.resolve('') },
      ...(job !== undefined && { job }),
      done: false,
    };
    try {
      turn = hosted.session.turn(letter.text, {
        ...(job !== undefined && { job: mail.job }),
        approve: (request) => approve(hosted, running, letter.job, request),
      });
    } catch (error) {
      turn = { result: Promise.reject(asError(error)) };
    }
    running.turn = turn;
    hosted.running = running;
    if (job !== undefined) {
      hosted.waiting = hosted.waiting.filter(
        (held) => held.letter.job !== job || !give(turn, held.letter)
      );
    }
    turn.result
      .then(
        (answer) => {
          if (job !== undefined) report(hosted, job, answer.trim() || 'Done', false);
        },
        (error: unknown) => {
          if (job !== undefined && !closed) {
            report(hosted, job, `The agent failed: ${asError(error).message}`, true);
          }
        }
      )
      .finally(() => {
        running.done = true;
        if (hosted.running !== running) return;
        delete hosted.running;
        void startNext(hosted);
      });
  }

  /**
   * Takes a call the agent asks leave for to the bridge, as a permission request on the job the
   * turn is about, and waits for the verdict. Whatever goes wrong refuses the call: a request
   * the bridge does not take, a turn that is over, a host that closes.
   */
  async function approve(
    hosted: Hosted,
    running: Running,
    job: number,
    request: ToolApprovalRequest
  ): Promise<ToolApprovalDecision> {
    if (!bridge) return { approved: false, reason: 'The bridge is not there to ask' };
    const ask = (options.askOf ?? permissionAskOf)(request, { cwd: hosted.cwd });
    let letter: string;
    try {
      const sent = await bridge.send(hosted.agentName, {
        job,
        kind: 'permission',
        body: describeCall(request, ask),
        ask,
      });
      letter = sent.letter.id;
    } catch (error) {
      return { approved: false, reason: asError(error).message };
    }
    while (!closed && !running.done) {
      const asked = Date.now();
      let decision;
      try {
        decision = await bridge.verdict(hosted.agentName, { letter, timeoutMs: VERDICT_POLL_MS });
      } catch (error) {
        return { approved: false, reason: asError(error).message };
      }
      if (decision.state === 'waiting') {
        if (Date.now() - asked < VERDICT_RETRY_MS) await pause(VERDICT_RETRY_MS);
        continue;
      }
      return decision.verdict === 'allow'
        ? { approved: true }
        : { approved: false, reason: `Refused by ${decision.by}: ${decision.reason}` };
    }
    return { approved: false, reason: 'The turn is over' };
  }

  /** Whether the job a letter is about is over: reported on, failed or canceled. */
  async function over(job: number): Promise<boolean> {
    if (!bridge) return false;
    try {
      return FINISHED.includes((await bridge.job(job)).state);
    } catch {
      return false;
    }
  }

  /**
   * Starts the turn of the oldest letter that waits. A job that was canceled or failed while its
   * first letter waited is not started, and what is written about it is dropped with it: the
   * agent never saw the job.
   */
  async function startNext(hosted: Hosted): Promise<void> {
    if (hosted.choosing) return;
    hosted.choosing = true;
    try {
      while (!closed && !hosted.running) {
        const next = hosted.waiting.shift();
        if (!next) return;
        if (next.letter.kind === 'task' && (await over(next.letter.job))) {
          forget(hosted, next.letter.job);
          continue;
        }
        if (closed) return;
        start(hosted, next);
      }
    } finally {
      hosted.choosing = false;
    }
  }

  /** Drops what waits about a job the agent never started, and what comes about it later. */
  function forget(hosted: Hosted, job: number): void {
    hosted.unseen.add(job);
    hosted.waiting = hosted.waiting.filter((held) => held.letter.job !== job);
  }

  /** Stops the turn that carries out a job once the job is over: nobody waits for its answer. */
  async function stopIfOver(hosted: Hosted, job: number): Promise<void> {
    const running = hosted.running;
    if (running?.job !== job || !(await over(job))) return;
    if (hosted.running === running) {
      running.done = true;
      running.turn.abort?.(new Error(`Job #${job} is over`));
    }
  }

  /** Hands a letter to a turn that goes on. False when the turn does not take it. */
  function give(turn: HostedTurn, letter: RenderedLetter): boolean {
    if (letter.kind === 'task') return false;
    if (STEERED.includes(letter.kind) && turn.steer?.(letter.text)) return true;
    return turn.followUp?.(letter.text) ?? false;
  }

  /** Whether a job's first letter still waits for its turn in the session. */
  function awaitsTurn(hosted: Hosted, job: number): boolean {
    return hosted.waiting.some((held) => held.letter.kind === 'task' && held.letter.job === job);
  }

  function hand(hosted: Hosted, mail: Mail): void {
    if (hosted.unseen.has(mail.letter.job)) return;
    const turn = hosted.running?.turn;
    if (!turn) {
      if (hosted.choosing) hosted.waiting.push(mail);
      else start(hosted, mail);
      return;
    }
    if (!awaitsTurn(hosted, mail.letter.job) && give(turn, mail.letter)) return;
    hosted.waiting.push(mail);
  }

  return {
    harness: options.harness,
    delivery: HOSTED_DELIVERY,
    ownsSessions: true,
    capabilities: {
      createSession: true,
      push: true,
      steer: options.steer ?? false,
      nativeWindow: false,
    },
    attach(calls: BridgeCalls): void {
      bridge = calls;
    },
    async createSession(request: SessionRequest): Promise<CreatedSession> {
      if (closed) throw new Error('The host is closing');
      const sessionId = randomUUID();
      const session = await options.open({
        sessionId,
        agentName: request.agentName,
        cwd: request.cwd,
        project: request.project,
        job: request.job,
      });
      if (closed) {
        await session.close?.();
        throw new Error('The host is closing');
      }
      const hosted: Hosted = {
        agentName: request.agentName,
        cwd: request.cwd,
        session,
        waiting: [],
        unseen: new Set(),
      };
      sessions.set(sessionId, hosted);
      await bridge?.register({
        harness: options.harness,
        sessionId,
        cwd: request.cwd,
        project: request.project,
        agentName: request.agentName,
      });
      if (await over(request.job.number)) forget(hosted, request.job.number);
      else if (!closed) hand(hosted, { letter: request.firstLetter, job: request.job });
      return { sessionId, deliveredFirstLetter: true };
    },
    async deliver({ agent, letter, job }: LetterDelivery): Promise<void> {
      const hosted = sessions.get(agent.sessionId);
      if (!hosted) throw new Error(`The session of ${agent.name} does not run in this host`);
      hosted.agentName = agent.name;
      hand(hosted, { letter, job });
      void stopIfOver(hosted, letter.job);
    },
    async liveSessions(): Promise<LiveSession[]> {
      return [...sessions].map(([sessionId, hosted]) => ({
        sessionId,
        cwd: hosted.cwd,
        busy: hosted.running !== undefined,
      }));
    },
    async close(): Promise<void> {
      closed = true;
      const open = [...sessions.values()];
      sessions.clear();
      await Promise.all(
        open.map(async (hosted) => {
          hosted.waiting.length = 0;
          const turn = hosted.running?.turn;
          if (turn) {
            if (hosted.running) hosted.running.done = true;
            turn.abort?.(new Error('The host is closing'));
            await Promise.race([
              turn.result.catch(() => undefined),
              pause(options.stopGraceMs ?? DEFAULT_STOP_GRACE_MS),
            ]);
          }
          await hosted.session.close?.();
        })
      );
    },
  };
}

/** A run of the Cogitator runtime, as much of it as the bridge uses. `RunHandle` fits. */
export interface HostedRun {
  readonly result: Promise<{ output: string; status?: 'completed' | 'paused' }>;
  steer(message: string): boolean;
  followUp(message: string): boolean;
  abort(reason?: unknown): unknown;
}

/**
 * Why a run that paused fails its job: nothing is finished, and nobody is there to approve a
 * tool call or answer a tool's question in a session the bridge hosts.
 */
const PAUSED =
  'the run stopped to wait for an answer nobody gives in a hosted session: a question of a tool, or an approval the runtime did not ask the bridge for';

/** The part of the Cogitator runtime the bridge uses. `Cogitator` fits. */
export interface HostedRuntime<TAgent> {
  start(
    agent: TAgent,
    options: {
      input: string;
      threadId: string;
      /** Asked for every tool call the agent's permission rules do not settle */
      onApproval?: (request: ToolApprovalRequest) => Promise<ToolApprovalDecision | 'pause'>;
    }
  ): HostedRun;
}

export interface CogitatorSessionsOptions<TAgent> {
  runtime: HostedRuntime<TAgent>;
  /** The agent of every session, or how to make the one of a session */
  agent: TAgent | ((context: HostedSessionContext) => TAgent);
}

/**
 * Sessions of an agent of the Cogitator runtime, on whatever model the agent names: every turn
 * is a run on the session's own thread, so with memory configured the agent remembers the
 * turns before. A letter that arrives during a run steers it or follows it up. A tool call the
 * agent's permission rules leave open is taken to the bridge: the agent that handed the job over
 * answers within its own rights, the person for the rest. A run that pauses for a question of a
 * tool fails its job: its answer is not a report.
 *
 * @example
 * ```ts
 * const qwen = hostedAdapter({
 *   harness: 'qwen',
 *   steer: true,
 *   open: cogitatorSessions({ runtime: cogitator, agent: reviewer }),
 * });
 * ```
 */
export function cogitatorSessions<TAgent>(
  options: CogitatorSessionsOptions<TAgent>
): OpenHostedSession {
  const agentOf = (context: HostedSessionContext): TAgent =>
    typeof options.agent === 'function'
      ? (options.agent as (context: HostedSessionContext) => TAgent)(context)
      : options.agent;
  return (context) => {
    const agent = agentOf(context);
    const threadId = `bridge-${context.sessionId}`;
    return {
      turn(text, about) {
        const approve = about?.approve;
        const run = options.runtime.start(agent, {
          input: text,
          threadId,
          ...(approve && { onApproval: approve }),
        });
        return {
          result: run.result.then((result) => {
            if (result.status === 'paused') throw new Error(PAUSED);
            return result.output;
          }),
          steer: (message) => run.steer(message),
          followUp: (message) => run.followUp(message),
          abort: (reason) => {
            run.abort(reason);
          },
        };
      },
    };
  };
}

/** A turn of a session provider, as the bridge starts it. `SessionProviderTurn` of the app-server fits. */
export interface ProviderTurn {
  readonly threadId: string;
  readonly turnId: string;
  readonly input: readonly { type: 'text'; text: string }[];
  readonly metadata: Readonly<Record<string, unknown>>;
  saveMetadata(patch: Record<string, unknown>): Promise<void>;
  permissionMode(): ProviderPermissionMode;
  setPermissionMode(mode: ProviderPermissionMode): Promise<void>;
  emit(event: StreamEvent): void;
  readonly signal: AbortSignal;
  /** Asked for every call of the agent the provider's permission rules do not settle */
  onApproval?(request: ToolApprovalRequest): Promise<ToolApprovalDecision | 'pause'>;
}

export type ProviderPermissionMode =
  'default' | 'acceptEdits' | 'plan' | 'auto' | 'dontAsk' | 'bypassPermissions';

/** An agent that runs outside the runtime, turn by turn. `AcpAgentProvider` fits. */
export interface TurnProvider {
  runTurn(turn: ProviderTurn): Promise<{ output: string; refused?: boolean }>;
  close?(): Promise<void>;
}

export interface ProviderSessionsOptions {
  /**
   * The provider of every session, or how to make the one of a session. A provider works in the
   * folder of its own workspace, whatever folder a job names: make one per session to follow the
   * job (the adapter closes those), or give one and say where it works with `root`
   */
  provider:
    TurnProvider | ((context: HostedSessionContext) => TurnProvider | Promise<TurnProvider>);
  /**
   * The folder the one provider works in. A job for another folder is refused, rather than done
   * in the wrong place. Required with one provider for every session
   */
  root?: string;
  /**
   * The permission mode of every turn, `default` when absent: what the provider's rules do not
   * settle is taken to the bridge, which asks the agent that handed the job over or the person
   */
  permissionMode?: ProviderPermissionMode;
}

/**
 * Sessions of an agent behind a session provider, such as an agent of the Agent Client Protocol
 * (Gemini CLI and the others of its registry) launched by `AcpAgentProvider`: every hosted
 * session is a session of that agent, every turn a prompt. A turn of such an agent takes nothing
 * while it goes on, so letters wait for the next one. A provider works in the folder of its
 * workspace: one provider serves the jobs of that folder (`root`), a function makes a provider
 * for the folder of each session. A later job of the session for a folder outside the one its
 * provider works in fails with that reason, rather than being done in the wrong place. Whoever
 * made a provider closes it, the adapter those it made.
 *
 * @example
 * ```ts
 * const gemini = hostedAdapter({
 *   harness: 'gemini',
 *   open: providerSessions({
 *     provider: new AcpAgentProvider({ agent, workspace, name: 'gemini' }),
 *     root: workspace.root,
 *   }),
 * });
 * ```
 */
export function providerSessions(options: ProviderSessionsOptions): OpenHostedSession {
  const shared = typeof options.provider === 'function' ? undefined : options.provider;
  if (shared && options.root === undefined) {
    throw new Error(
      'providerSessions needs `root`, the folder the provider works in, or a function that makes a provider for each session'
    );
  }
  return async (context) => {
    const folder = shared && options.root !== undefined ? options.root : context.cwd;
    const elsewhere = (cwd: string): Error | undefined =>
      isInside(folder, cwd)
        ? undefined
        : new Error(
            `this agent works in ${folder}, and the job is for ${cwd}. Hand it a job in its own folder`
          );
    const refusal = elsewhere(context.cwd);
    if (refusal) throw refusal;
    const make = options.provider as (
      context: HostedSessionContext
    ) => TurnProvider | Promise<TurnProvider>;
    const provider = shared ?? (await make(context));
    let metadata: Record<string, unknown> = {};
    let mode = options.permissionMode ?? 'default';
    return {
      ...(!shared && provider.close && { close: () => provider.close?.() ?? Promise.resolve() }),
      turn(text, about) {
        const misplaced = about?.job && elsewhere(about.job.cwd);
        if (misplaced) return { result: Promise.reject(misplaced) };
        const stop = new AbortController();
        const result = provider
          .runTurn({
            threadId: `bridge-${context.sessionId}`,
            turnId: randomUUID(),
            input: [{ type: 'text', text }],
            get metadata() {
              return metadata;
            },
            saveMetadata: async (patch) => {
              metadata = { ...metadata, ...patch };
            },
            permissionMode: () => mode,
            setPermissionMode: async (next) => {
              mode = next;
            },
            emit: () => undefined,
            signal: stop.signal,
            ...(about?.approve && { onApproval: about.approve }),
          })
          .then((answer) => {
            if (answer.refused)
              throw new Error(answer.output.trim() || 'the agent refused the job');
            return answer.output;
          });
        return { result, abort: (reason) => stop.abort(reason) };
      },
    };
  };
}
