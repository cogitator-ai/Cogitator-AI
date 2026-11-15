import type {
  CreateJobInput,
  CreateJobResult,
  InboxInput,
  SendLetterInput,
  SendLetterResult,
} from './inputs.js';
import type {
  AdapterCapabilities,
  AgentRecord,
  BridgeJob,
  CallerIdentity,
  Letter,
  RenderedLetter,
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

/** A session of a harness that runs on this machine right now, as the harness lists it. */
export interface LiveSession {
  sessionId: string;
  cwd?: string;
  name?: string;
  /** In the middle of a turn */
  busy?: boolean;
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
  inbox(caller: string, input?: InboxInput): Promise<RenderedLetter[]>;
  acknowledge(caller: string, letterId: string): Promise<Letter>;
  cancel(caller: string, job: number, reason?: string): Promise<BridgeJob>;
  job(number: number): Promise<BridgeJob>;
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
   * The sessions of the harness running on this machine, when the harness can list them. The
   * bridge keeps a listed session in its address book however long it is silent, and takes one
   * that was listed and no longer is for gone
   */
  liveSessions?(): Promise<LiveSession[]>;
  /** What `cogitator bridge doctor` shows about the harness: its version, its commands, the folder */
  health?(context: HealthContext): Promise<HealthCheck[]>;
  /** Called once by the dispatcher that uses the adapter, with the calls its sessions may make */
  attach?(bridge: BridgeCalls): void;
  /** Stops what the adapter runs. The host calls it when it closes */
  close?(): Promise<void>;
}
