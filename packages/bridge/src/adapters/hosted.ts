import { randomUUID } from 'node:crypto';
import type { StreamEvent } from '@cogitator-ai/server-shared';
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
import type { BridgeJob, LetterKind, RenderedLetter } from '../types.js';

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

/** A session of an agent the host runs. One turn goes on at a time. */
export interface HostedSession {
  turn(text: string): HostedTurn;
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
}

const DEFAULT_STOP_GRACE_MS = 5_000;

/** Letters an agent wants in the middle of its work, when its turn can take them. */
const STEERED: readonly LetterKind[] = ['answer', 'permission', 'note'];

interface Running {
  turn: HostedTurn;
  /** The job the turn carries out, when a job's first letter started it */
  job?: number;
}

interface Hosted {
  agentName: string;
  cwd: string;
  session: HostedSession;
  running?: Running;
  waiting: RenderedLetter[];
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
 * middle of it when the turn takes that, and otherwise starts the next turn.
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

  function start(hosted: Hosted, letter: RenderedLetter): void {
    let turn: HostedTurn;
    const job = letter.kind === 'task' ? letter.job : undefined;
    try {
      turn = hosted.session.turn(letter.text);
    } catch (error) {
      turn = { result: Promise.reject(asError(error)) };
    }
    const running: Running = { turn, ...(job !== undefined && { job }) };
    hosted.running = running;
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
        if (hosted.running !== running) return;
        delete hosted.running;
        const next = hosted.waiting.shift();
        if (next && !closed) start(hosted, next);
      });
  }

  function hand(hosted: Hosted, letter: RenderedLetter): void {
    const turn = hosted.running?.turn;
    if (!turn) {
      start(hosted, letter);
      return;
    }
    if (letter.kind !== 'task') {
      if (STEERED.includes(letter.kind) && turn.steer?.(letter.text)) return;
      if (turn.followUp?.(letter.text)) return;
    }
    hosted.waiting.push(letter);
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
      const hosted: Hosted = {
        agentName: request.agentName,
        cwd: request.cwd,
        session,
        waiting: [],
      };
      sessions.set(sessionId, hosted);
      start(hosted, request.firstLetter);
      return { sessionId, deliveredFirstLetter: true };
    },
    async deliver({ agent, letter }: LetterDelivery): Promise<void> {
      const hosted = sessions.get(agent.sessionId);
      if (!hosted) throw new Error(`The session of ${agent.name} does not run in this host`);
      hosted.agentName = agent.name;
      hand(hosted, letter);
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
  readonly result: Promise<{ output: string }>;
  steer(message: string): boolean;
  followUp(message: string): boolean;
  abort(reason?: unknown): unknown;
}

/** The part of the Cogitator runtime the bridge uses. `Cogitator` fits. */
export interface HostedRuntime<TAgent> {
  start(agent: TAgent, options: { input: string; threadId: string }): HostedRun;
}

export interface CogitatorSessionsOptions<TAgent> {
  runtime: HostedRuntime<TAgent>;
  /** The agent of every session, or how to make the one of a session */
  agent: TAgent | ((context: HostedSessionContext) => TAgent);
}

/**
 * Sessions of an agent of the Cogitator runtime, on whatever model the agent names: every turn
 * is a run on the session's own thread, so with memory configured the agent remembers the
 * turns before. A letter that arrives during a run steers it or follows it up.
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
      turn(text) {
        const run = options.runtime.start(agent, { input: text, threadId });
        return {
          result: run.result.then((result) => result.output),
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
}

export type ProviderPermissionMode =
  'default' | 'acceptEdits' | 'plan' | 'auto' | 'dontAsk' | 'bypassPermissions';

/** An agent that runs outside the runtime, turn by turn. `AcpAgentProvider` fits. */
export interface TurnProvider {
  runTurn(turn: ProviderTurn): Promise<{ output: string; refused?: boolean }>;
}

export interface ProviderSessionsOptions {
  provider: TurnProvider;
  /**
   * The permission mode of every turn, `default` when absent: what the provider's rules do not
   * settle is refused, since no person sits at a session the bridge started
   */
  permissionMode?: ProviderPermissionMode;
}

/**
 * Sessions of an agent behind a session provider, such as an agent of the Agent Client Protocol
 * (Gemini CLI and the others of its registry) launched by `AcpAgentProvider`: every hosted
 * session is a session of that agent, every turn a prompt. A turn of such an agent takes nothing
 * while it goes on, so letters wait for the next one. Whoever made the provider closes it.
 *
 * @example
 * ```ts
 * const gemini = hostedAdapter({
 *   harness: 'gemini',
 *   open: providerSessions({ provider: new AcpAgentProvider({ ...acpAgent('gemini'), workspace }) }),
 * });
 * ```
 */
export function providerSessions(options: ProviderSessionsOptions): OpenHostedSession {
  return (context) => {
    let metadata: Record<string, unknown> = {};
    let mode = options.permissionMode ?? 'default';
    return {
      turn(text) {
        const stop = new AbortController();
        const result = options.provider
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
