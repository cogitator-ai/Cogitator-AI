import { connect, type Socket } from 'node:net';
import {
  JsonRpcPeer,
  encodeNdjsonLine,
  readNdjson,
  type JsonRpcMessage,
} from '@cogitator-ai/server-shared';
import { BridgeError } from './errors.js';
import {
  DEFAULT_VERDICT_WAIT_MS,
  DEFAULT_WAIT_MS,
  type CreateJobInput,
  type CreateJobResult,
  type EscalateInput,
  type InboxInput,
  type PersonAnswerInput,
  type SendLetterInput,
  type SendLetterResult,
  type StuckInput,
  type VerdictInput,
  type VerdictResult,
  type WaitInput,
  type WaitResult,
} from './inputs.js';
import {
  BRIDGE_METHODS,
  BRIDGE_NOTIFICATIONS,
  BRIDGE_PROTOCOL_VERSION,
  fromJsonRpcError,
  type BridgeStatus,
  type DispatcherInfo,
  type HelloResult,
} from './protocol.js';
import type { AgentFilter, JobTaskFilter, JournalQuery, LetterFilter } from './store/store.js';
import type {
  AgentRecord,
  BridgeJob,
  CallerIdentity,
  JournalEntry,
  Letter,
  RenderedLetter,
} from './types.js';
import type { PersonLetter } from './person.js';

export interface BridgeClientOptions {
  /** Where the dispatcher listens */
  socketPath: string;
  /** The session calling. Without it the client can read, and cannot act as an agent */
  caller?: CallerIdentity;
  /** How long to wait for the dispatcher to answer a call, 30 s by default */
  timeoutMs?: number;
}

const DEFAULT_TIMEOUT_MS = 30_000;
const NO_DISPATCHER_CODES = new Set(['ENOENT', 'ECONNREFUSED', 'ENOTSOCK']);

function open(socketPath: string): Promise<Socket> {
  return new Promise<Socket>((resolve, reject) => {
    const socket = connect(socketPath);
    const onError = (error: NodeJS.ErrnoException) => {
      reject(
        error.code && NO_DISPATCHER_CODES.has(error.code)
          ? new BridgeError(
              'not_running',
              'No bridge dispatcher is running on this machine. Start one: cogitator bridge serve',
              { socket: socketPath }
            )
          : error
      );
    };
    socket.once('error', onError);
    socket.once('connect', () => {
      socket.off('error', onError);
      resolve(socket);
    });
  });
}

/**
 * A connection to the dispatcher of this machine. Created for a session it acts as that agent:
 * the jobs it hands over and the letters it sends are from it, its inbox is that agent's.
 *
 * @example
 * ```ts
 * const caller = callerFromEnv(process.env, process.cwd());
 * const bridge = await BridgeClient.connect({ socketPath: bridgePaths().socket, caller });
 * const { job } = await bridge.createJob({ to: 'codex', body: 'Write the tests' });
 * await bridge.close();
 * ```
 */
export class BridgeClient {
  /** What the dispatcher sends this connection: one job, everything, or nothing */
  private subscribed: number | 'all' | null = null;
  /** The last change of the subscription: they run one after another, each seeing the listeners as they are then */
  private syncing: Promise<void> = Promise.resolve();

  private constructor(
    private readonly socket: Socket,
    private readonly peer: JsonRpcPeer,
    private readonly timeoutMs: number,
    private readonly listeners: Map<(entry: JournalEntry) => void, number | undefined>,
    /** The dispatcher the client reached */
    readonly dispatcher: DispatcherInfo,
    /** The agent the client acts as, when it was created for a session */
    readonly agent: AgentRecord | undefined
  ) {}

  /**
   * @throws BridgeError `not_running` when no dispatcher listens on the socket
   */
  static async connect(options: BridgeClientOptions): Promise<BridgeClient> {
    const socket = await open(options.socketPath);
    const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    const peer = new JsonRpcPeer({
      send: (message: JsonRpcMessage | JsonRpcMessage[]) => {
        socket.write(encodeNdjsonLine(message));
      },
    });
    const listeners = new Map<(entry: JournalEntry) => void, number | undefined>();
    peer.onNotification(BRIDGE_NOTIFICATIONS.journalEntry, (value) => {
      const entry = value as JournalEntry;
      for (const [listener, job] of [...listeners]) {
        if (job === undefined || job === entry.job) listener(entry);
      }
    });
    const closed = new BridgeError('not_running', 'The connection to the bridge dispatcher closed');
    socket.on('error', () => peer.close(closed));
    socket.on('close', () => peer.close(closed));
    void (async () => {
      try {
        for await (const line of readNdjson(socket)) {
          if ('value' in line) {
            void peer.receive(line.value);
            continue;
          }
          peer.close(
            new BridgeError(
              'storage',
              `The bridge dispatcher sent an answer the client could not read (${line.error.message}). Ask for less at once with a limit`
            )
          );
          socket.destroy();
          return;
        }
      } catch {
        peer.close(closed);
      }
    })();

    let hello: HelloResult;
    try {
      hello = await peer.request<HelloResult>(
        BRIDGE_METHODS.hello,
        { protocol: BRIDGE_PROTOCOL_VERSION, ...(options.caller && { caller: options.caller }) },
        { timeoutMs }
      );
    } catch (error) {
      peer.close();
      socket.destroy();
      throw fromJsonRpcError(error);
    }
    return new BridgeClient(socket, peer, timeoutMs, listeners, hello.dispatcher, hello.agent);
  }

  /** Whether the connection is gone */
  get closed(): boolean {
    return this.peer.closed;
  }

  createJob(input: CreateJobInput): Promise<CreateJobResult> {
    return this.call(BRIDGE_METHODS.createJob, input);
  }

  send(input: SendLetterInput): Promise<SendLetterResult> {
    return this.call(BRIDGE_METHODS.send, input);
  }

  inbox(input: InboxInput = {}): Promise<RenderedLetter[]> {
    return this.call(BRIDGE_METHODS.inbox, input);
  }

  acknowledge(letter: string): Promise<Letter> {
    return this.call(BRIDGE_METHODS.acknowledge, { letter });
  }

  /**
   * Waits for the session's mail, see `BridgeDispatcher.wait`. The connection answers nothing
   * else until the wait ends: a process that waits uses a connection of its own. Closing the
   * client ends the wait
   */
  wait(input: WaitInput = {}): Promise<WaitResult> {
    const waitMs = input.timeoutMs ?? DEFAULT_WAIT_MS;
    return this.call(BRIDGE_METHODS.wait, input, waitMs + this.timeoutMs);
  }

  /** Says the letters a wait returned reached the session */
  delivered(letters: readonly string[]): Promise<Letter[]> {
    return this.call(BRIDGE_METHODS.delivered, { letters });
  }

  /** Passes a question or a permission request addressed to the session on to the person */
  escalate(input: EscalateInput): Promise<Letter> {
    return this.call(BRIDGE_METHODS.escalate, input);
  }

  /**
   * Whether a permission request the session sent is decided, see `BridgeDispatcher.verdict`.
   * It waits for the decision as long as `timeoutMs` says, and answers `waiting` after that
   */
  verdict(input: VerdictInput): Promise<VerdictResult> {
    const waitMs = input.timeoutMs ?? DEFAULT_VERDICT_WAIT_MS;
    return this.call(BRIDGE_METHODS.verdict, input, waitMs + this.timeoutMs);
  }

  /**
   * Says the session waits for a person at its own window. Resolves with the jobs whose other
   * party was told
   */
  stuck(input: StuckInput): Promise<number[]> {
    return this.call(BRIDGE_METHODS.stuck, input);
  }

  /** The letters that wait for the person */
  forPerson(): Promise<PersonLetter[]> {
    return this.call(BRIDGE_METHODS.forPerson, {});
  }

  /**
   * Answers a letter that waits for the person, as the person. Only a connection that did not
   * say hello as a session of an agent may
   */
  personAnswer(input: PersonAnswerInput): Promise<SendLetterResult> {
    return this.call(BRIDGE_METHODS.personAnswer, input);
  }

  cancel(job: number, reason?: string): Promise<BridgeJob> {
    return this.call(BRIDGE_METHODS.cancelJob, { job, ...(reason !== undefined && { reason }) });
  }

  job(number: number): Promise<BridgeJob> {
    return this.call(BRIDGE_METHODS.getJob, { job: number });
  }

  jobs(filter: JobTaskFilter = {}): Promise<BridgeJob[]> {
    return this.call(BRIDGE_METHODS.listJobs, filter);
  }

  agents(filter: AgentFilter = {}): Promise<AgentRecord[]> {
    return this.call(BRIDGE_METHODS.listAgents, filter);
  }

  letters(filter: LetterFilter = {}): Promise<Letter[]> {
    return this.call(BRIDGE_METHODS.listLetters, filter);
  }

  readJournal(query: JournalQuery = {}): Promise<JournalEntry[]> {
    return this.call(BRIDGE_METHODS.readJournal, query);
  }

  status(): Promise<BridgeStatus> {
    return this.call(BRIDGE_METHODS.status, {});
  }

  /**
   * Hears every entry the journal gets from now on, of one job or of all. Each listener has its
   * own filter. Resolves once the dispatcher is sending, with a function that stops it.
   */
  async subscribe(
    listener: (entry: JournalEntry) => void,
    options: { job?: number } = {}
  ): Promise<() => Promise<void>> {
    this.listeners.set(listener, options.job);
    try {
      await this.syncSubscription();
    } catch (error) {
      this.listeners.delete(listener);
      throw error;
    }
    return async () => {
      if (!this.listeners.delete(listener) || this.peer.closed) return;
      await this.syncSubscription();
    };
  }

  /**
   * Asks the dispatcher for what the listeners need between them: one job when they all want the
   * same one, everything otherwise, nothing when none is left. Changes run one after another, so
   * one made while another is on its way is not lost.
   */
  private syncSubscription(): Promise<void> {
    const sync = this.syncing.then(async () => {
      const jobs = new Set(this.listeners.values());
      const wanted =
        this.listeners.size === 0 ? null : jobs.size === 1 ? ([...jobs][0] ?? 'all') : 'all';
      if (wanted === this.subscribed) return;
      if (wanted === null) await this.call(BRIDGE_METHODS.unsubscribeJournal, {});
      else {
        await this.call(BRIDGE_METHODS.subscribeJournal, wanted === 'all' ? {} : { job: wanted });
      }
      this.subscribed = wanted;
    });
    this.syncing = sync.catch(() => undefined);
    return sync;
  }

  /** Ends the connection. Calls still waiting for an answer reject */
  async close(): Promise<void> {
    this.peer.close(new BridgeError('not_running', 'The connection to the bridge was closed'));
    if (this.socket.destroyed) return;
    await new Promise<void>((resolve) => {
      this.socket.once('close', () => resolve());
      this.socket.end();
    });
  }

  private async call<T>(method: string, params: unknown, timeoutMs = this.timeoutMs): Promise<T> {
    try {
      return await this.peer.request<T>(method, params, { timeoutMs });
    } catch (error) {
      throw fromJsonRpcError(error);
    }
  }
}
