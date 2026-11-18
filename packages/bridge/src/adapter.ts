import type {
  CreateJobInput,
  CreateJobResult,
  InboxInput,
  LimitedInput,
  LimitedResult,
  SendLetterInput,
  SendLetterResult,
  VerdictInput,
  VerdictResult,
  WithdrawInput,
  WithdrawResult,
} from './inputs.js';
import type { LimitSignal } from './limit.js';
import type { AgentFilter, JobTaskFilter, LetterFilter } from './store/store.js';
import type {
  AdapterCapabilities,
  AgentRecord,
  BridgeJob,
  CallerIdentity,
  JobRecipe,
  Letter,
  PermissionAsk,
  RenderedLetter,
  Verdict,
} from './types.js';

/** A letter on its way to a session, as an adapter gets it. */
export interface LetterDelivery {
  agent: AgentRecord;
  letter: RenderedLetter;
  job: BridgeJob;
}

/** What an adapter adds about a letter it handed over, kept in the journal. */
export interface DeliveryReceipt {
  /** What a person should know: the harness took the letter, but the session will not wake */
  note?: string;
}

/** What the bridge asks of an adapter that starts a session for a job. */
export interface SessionRequest {
  /** The name the bridge gave the session, to hand to it as `COGITATOR_BRIDGE_AGENT` */
  agentName: string;
  harness: string;
  project: string;
  cwd: string;
  sessionName?: string;
  job: BridgeJob;
  /** The job's first letter, for a harness that takes the first message when it starts a session */
  firstLetter: RenderedLetter;
}

export interface CreatedSession {
  sessionId: string;
  sessionName?: string;
  /** Whether the session got `firstLetter` when it started, so the bridge does not deliver it again */
  deliveredFirstLetter?: boolean;
}

/** A call a session needs leave for, as its harness told a hook. */
export interface PermissionHookCall {
  /** The session that makes the call */
  caller: CallerIdentity;
  ask: PermissionAsk;
  /** The words of the letter that asks leave */
  body: string;
  /** What the hook writes to tell the harness the decision */
  answer(verdict: Verdict, reason: string): string;
}

/** A session of a harness that runs on this machine right now, as the harness lists it. */
export interface LiveSession {
  sessionId: string;
  cwd?: string;
  name?: string;
  /** In the middle of a turn */
  busy?: boolean;
  /**
   * What the session waits for from a person at its window, in the words of its harness, such
   * as `permission prompt`. Absent for a session that waits for nobody
   */
  waitingFor?: string;
}

/** What tells a process of a harness apart: its environment and, for a hook, what the harness wrote to it. */
export interface IdentifyContext {
  env: NodeJS.ProcessEnv;
  /** The folder the process runs in, an absolute path */
  cwd: string;
  /** The stdin of a hook of the harness, when the process is one */
  hookInput?: string;
}

export type HealthStatus = 'ok' | 'warn' | 'fail';

/** One thing `cogitator bridge doctor` looked at. */
export interface HealthCheck {
  /** Stable among the checks of one adapter: `version`, `trust`, `hook` */
  id: string;
  /** What was looked at, in a few words */
  title: string;
  status: HealthStatus;
  /** What was found */
  detail?: string;
  /** What to do about a `warn` or a `fail`, a command where there is one */
  fix?: string;
}

export interface HealthContext {
  /** The project folder to look at: its trust, its hooks */
  cwd: string;
}

/**
 * The bridge as a session an adapter runs itself calls it, such as to report when its agent is
 * done. Every call names the agent it is made as.
 */
export interface BridgeCalls {
  register(identity: CallerIdentity): Promise<AgentRecord>;
  createJob(caller: string, input: CreateJobInput): Promise<CreateJobResult>;
  send(caller: string, input: SendLetterInput): Promise<SendLetterResult>;
  verdict(caller: string, input: VerdictInput, signal?: AbortSignal): Promise<VerdictResult>;
  withdraw(caller: string, input: WithdrawInput): Promise<WithdrawResult>;
  inbox(caller: string, input?: InboxInput): Promise<RenderedLetter[]>;
  acknowledge(caller: string, letterId: string): Promise<Letter>;
  cancel(caller: string, job: number, reason?: string): Promise<BridgeJob>;
  /**
   * Says the harness of a session ran into the limit of its subscription or its key: the bridge
   * hands that harness no job until the limit is over, and the jobs of the session go to others
   */
  limited(caller: string, input?: LimitedInput): Promise<LimitedResult>;
  job(number: number): Promise<BridgeJob>;
  jobs(filter?: JobTaskFilter): Promise<BridgeJob[]>;
  agents(filter?: AgentFilter): Promise<AgentRecord[]>;
  /** The harnesses the bridge can start a session of */
  startable(): Promise<string[]>;
  /**
   * Whether an agent takes a letter by itself right now: it is there, and its harness wakes it
   * for mail or it waits for mail itself. False for a session that would only find the letter
   * when a person opens it
   */
  wakes(agent: string): Promise<boolean>;
  letters(filter?: LetterFilter): Promise<Letter[]>;
}

/**
 * How the bridge reaches the sessions of one harness. Without an adapter a session still takes
 * part: it reads its inbox whenever it calls the bridge.
 */
export interface BridgeAdapter {
  /** The harness it reaches, in lower case: letters, digits, `.`, `_` and `-` */
  readonly harness: string;
  /** The mechanism letters travel by, recorded with every session of the harness */
  readonly delivery: string;
  readonly capabilities: AdapterCapabilities;
  /**
   * True when the adapter runs every session of the harness itself, so one `liveSessions` does
   * not list cannot be running. Otherwise only a session that was listed before and no longer
   * is counts as gone: a harness may run sessions it lists nowhere
   */
  readonly ownsSessions?: boolean;
  /**
   * Hands the letter to the session. Rejects when it could not, and the bridge tries again.
   * Absent when the sessions of the harness wait for their mail themselves (`BridgeDispatcher.wait`,
   * `cogitator bridge wait`): the bridge then keeps a letter until the session's waiter takes it
   */
  deliver?(delivery: LetterDelivery): Promise<DeliveryReceipt | void>;
  /** Starts a session for a job. Present when `capabilities.createSession` is true */
  createSession?(request: SessionRequest): Promise<CreatedSession>;
  /**
   * Tells which session of the harness a process belongs to. Undefined when it is none of them.
   * A harness that only names its session in the environment needs none: `callerFromEnv` reads
   * the variables of the harnesses the bridge knows
   */
  identify?(context: IdentifyContext): CallerIdentity | undefined;
  /**
   * What a hook of the harness answers before a call of a bridge tool, so the call carries the
   * session that makes it: the harness then hands the tool the arguments with the hint in them
   * (`TOOL_CALL_HINT_KEY`). Undefined when the hook's input names no session, and the call goes
   * on as it was. For a harness whose server of tools outlives its sessions
   */
  toolCallHook?(context: IdentifyContext): string | undefined;
  /**
   * Reads what the harness wrote to a hook that runs when a session needs leave for a call: who
   * asks, for what, and how to tell the harness the decision. Undefined when the input is not
   * that of such a hook
   */
  permissionHook?(context: IdentifyContext): PermissionHookCall | undefined;
  /**
   * Reads what the harness wrote to a hook that runs when a session begins to wait for a person
   * at its own window: who waits, and for what. Undefined when the input is not that of such a
   * hook
   */
  stuckHook?(context: IdentifyContext): { caller: CallerIdentity; what: string } | undefined;
  /**
   * Reads what the harness wrote to a hook that runs when a turn of a session ends on an error:
   * who it was, and the limit it ran into. Undefined when the input is not that of such a hook,
   * or the error is no limit
   */
  limitHook?(context: IdentifyContext): { caller: CallerIdentity; limit: LimitSignal } | undefined;
  /**
   * The sessions of the harness running on this machine, when the harness can list them. The
   * bridge keeps a listed session in its address book however long it is silent, and takes one
   * that was listed and no longer is for gone
   */
  liveSessions?(): Promise<LiveSession[]>;
  /**
   * Present on an adapter that carries jobs out by recipes, the conductor of the bridge: says
   * what is wrong with the recipe a job names, such as a name it does not know or an input the
   * recipe cannot start with. Undefined when the job can start. The bridge hands such an adapter
   * only jobs that name a recipe, each to a session of its own, and takes its sessions for no
   * party to the rules of a job: the jobs a recipe hands out are bound by the rules of whoever
   * started the recipe
   */
  recipeProblem?(recipe: JobRecipe): string | undefined;
  /**
   * Whether a session of the harness wakes for a letter handed to it right now. Absent when
   * every session `deliver` reaches does. A harness that only queues mail for some sessions,
   * such as Codex for a thread that is open nowhere while no local daemon runs, says so here, and
   * whoever needs the work done by itself starts a fresh session instead
   */
  wakesFor?(agent: AgentRecord): Promise<boolean>;
  /** What `cogitator bridge doctor` shows about the harness: its version, its commands, the folder */
  health?(context: HealthContext): Promise<HealthCheck[]>;
  /** Called once by the dispatcher that uses the adapter, with the calls its sessions may make */
  attach?(bridge: BridgeCalls): void;
  /** Stops what the adapter runs. The host calls it when it closes */
  close?(): Promise<void>;
}
