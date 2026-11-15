import { connect, type Socket } from 'node:net';
import {
  JsonRpcPeer,
  encodeNdjsonLine,
  readNdjson,
  type JsonRpcMessage,
} from '@cogitator-ai/server-shared';
import type { CreateJobResult, SendLetterResult } from './dispatcher.js';
import { BridgeError } from './errors.js';
import type { CreateJobInput, InboxInput, SendLetterInput } from './inputs.js';
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
  JobVerification,
  JournalEntry,
  Letter,
  RenderedLetter,
} from './types.js';

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
  private constructor(
    private readonly socket: Socket,
    private readonly peer: JsonRpcPeer,
    private readonly timeoutMs: number,
    private readonly listeners: Set<(entry: JournalEntry) => void>,
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
    const listeners = new Set<(entry: JournalEntry) => void>();
    peer.onNotification(BRIDGE_NOTIFICATIONS.journalEntry, (entry) => {
      for (const listener of listeners) listener(entry as JournalEntry);
    });
    const closed = new BridgeError('not_running', 'The connection to the bridge dispatcher closed');
    socket.on('error', () => peer.close(closed));
    socket.on('close', () => peer.close(closed));
    void (async () => {
      try {
        for await (const line of readNdjson(socket)) {
          if ('value' in line) void peer.receive(line.value);
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

  cancel(job: number, reason?: string): Promise<BridgeJob> {
    return this.call(BRIDGE_METHODS.cancelJob, { job, ...(reason !== undefined && { reason }) });
  }

  recordVerification(
    job: number,
    verification: Pick<JobVerification, 'verified' | 'summary'>
  ): Promise<BridgeJob> {
    return this.call(BRIDGE_METHODS.verifyJob, { job, ...verification });
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
   * Hears every entry the journal gets from now on, of one job or of all. Resolves once the
   * dispatcher is sending, with a function that stops it.
   */
  async subscribe(
    listener: (entry: JournalEntry) => void,
    options: { job?: number } = {}
  ): Promise<() => Promise<void>> {
    this.listeners.add(listener);
    await this.call(BRIDGE_METHODS.subscribeJournal, options);
    return async () => {
      this.listeners.delete(listener);
      if (this.listeners.size === 0 && !this.peer.closed) {
        await this.call(BRIDGE_METHODS.unsubscribeJournal, {});
      }
    };
  }

  /** Ends the connection. Calls still waiting for an answer reject */
  async close(): Promise<void> {
    this.peer.close();
    if (this.socket.destroyed) return;
    await new Promise<void>((resolve) => {
      this.socket.once('close', () => resolve());
      this.socket.end();
    });
  }

  private async call<T>(method: string, params: unknown): Promise<T> {
    try {
      return await this.peer.request<T>(method, params, { timeoutMs: this.timeoutMs });
    } catch (error) {
      throw fromJsonRpcError(error);
    }
  }
}
