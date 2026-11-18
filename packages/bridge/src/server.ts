import { chmodSync, unlinkSync } from 'node:fs';
import { createServer, type Server, type Socket } from 'node:net';
import type { z } from 'zod';
import {
  JSON_RPC_ERROR_CODES,
  JsonRpcPeer,
  encodeNdjsonLine,
  readNdjson,
  type JsonRpcError,
  type JsonRpcMessage,
} from '@cogitator-ai/server-shared';
import type { BridgeDispatcher } from './dispatcher.js';
import { BridgeError } from './errors.js';
import {
  AcknowledgeParamsSchema,
  DeliveredParamsSchema,
  BRIDGE_METHODS,
  BRIDGE_NOTIFICATIONS,
  BRIDGE_PROTOCOL_VERSION,
  CancelJobParamsSchema,
  HelloParamsSchema,
  JobNumberParamsSchema,
  SubscribeJournalParamsSchema,
  UnlimitParamsSchema,
  toJsonRpcError,
  type BridgeStatus,
  type DispatcherInfo,
  type HelloResult,
} from './protocol.js';
import type { JournalEntry } from './types.js';

/** The most connections the dispatcher holds at once. */
const MAX_CONNECTIONS = 256;

/** A connection that does not read is dropped once this much waits to be written to it. */
const MAX_PENDING_BYTES = 16 * 1024 * 1024;

export interface BridgeServerOptions {
  dispatcher: BridgeDispatcher;
  /** A unix socket path, or a named pipe on Windows */
  socketPath: string;
  info: DispatcherInfo;
  /** Hears what went wrong on a connection outside a call */
  onError?: (error: Error) => void;
}

export interface BridgeServer {
  /** How many connections are open */
  readonly connections: number;
  /**
   * Ends every connection and stops listening, which removes the socket file. With `abandon`
   * the file is left alone: a dispatcher that was replaced must not remove the socket its
   * successor now listens on at the same path, so it only stops serving
   */
  close(options?: { abandon?: boolean }): Promise<void>;
}

function isPipe(path: string): boolean {
  return path.startsWith('\\\\.\\pipe\\');
}

function params<Schema extends z.ZodType>(schema: Schema, value: unknown): z.output<Schema> {
  const parsed = schema.safeParse(value ?? {});
  if (parsed.success) return parsed.data;
  const issue = parsed.error.issues[0];
  const path = issue.path.length > 0 ? `${issue.path.join('.')}: ` : '';
  throw new BridgeError('invalid_input', `${path}${issue.message}`);
}

function describeError(error: unknown): JsonRpcError {
  if (error instanceof BridgeError) return toJsonRpcError(error);
  return {
    code: JSON_RPC_ERROR_CODES.internalError,
    message: `The bridge failed to handle the call: ${error instanceof Error ? error.message : String(error)}`,
  };
}

class Connection {
  private agent: string | undefined;
  private subscription: { job?: number } | undefined;
  private readonly peer: JsonRpcPeer;
  /** Aborts when the socket closes, so a call that waits ends with its connection */
  private readonly gone = new AbortController();

  constructor(
    private readonly socket: Socket,
    private readonly options: BridgeServerOptions
  ) {
    this.peer = new JsonRpcPeer({
      send: (message) => this.write(message),
      describeError,
      onError: (error) => options.onError?.(error),
    });
    socket.once('close', () => this.gone.abort());
    this.handle();
  }

  async serve(): Promise<void> {
    try {
      for await (const line of readNdjson(this.socket)) {
        if ('value' in line) {
          await this.peer.receive(line.value);
        } else {
          await this.peer.respondError(null, {
            code: JSON_RPC_ERROR_CODES.parseError,
            message: `Line ${line.error.line}: ${line.error.message}`,
          });
        }
      }
    } catch (error) {
      if (!this.socket.destroyed) this.options.onError?.(asError(error));
    } finally {
      this.end();
    }
  }

  end(): void {
    this.subscription = undefined;
    this.peer.close();
    if (!this.socket.destroyed) this.socket.destroy();
  }

  /** Passes a journal entry on when the connection asked for it */
  hear(entry: JournalEntry): void {
    if (!this.subscription || this.peer.closed) return;
    if (this.subscription.job !== undefined && this.subscription.job !== entry.job) return;
    this.peer.notify(BRIDGE_NOTIFICATIONS.journalEntry, entry).catch(() => undefined);
  }

  private write(message: JsonRpcMessage | JsonRpcMessage[]): void {
    if (this.socket.destroyed) return;
    if (this.socket.writableLength > MAX_PENDING_BYTES) {
      this.options.onError?.(new Error('A bridge connection stopped reading and was dropped'));
      this.end();
      return;
    }
    this.socket.write(encodeNdjsonLine(message));
  }

  private caller(): string {
    if (!this.agent) {
      throw new BridgeError(
        'not_registered',
        'This connection did not say which session is calling. Say hello with the caller first'
      );
    }
    return this.agent;
  }

  private handle(): void {
    const { dispatcher, info } = this.options;
    const on = (method: string, handler: (value: unknown) => unknown) =>
      this.peer.onRequest(method, (value) => handler(value));

    on(BRIDGE_METHODS.hello, async (value): Promise<HelloResult> => {
      const hello = params(HelloParamsSchema, value);
      if (hello.protocol !== undefined && hello.protocol > BRIDGE_PROTOCOL_VERSION) {
        throw new BridgeError(
          'invalid_input',
          `The client speaks protocol ${hello.protocol}, this dispatcher speaks ${BRIDGE_PROTOCOL_VERSION}. Restart the dispatcher with the newer version`
        );
      }
      if (!hello.caller) return { dispatcher: info };
      const agent = await dispatcher.register(hello.caller);
      this.agent = agent.name;
      return { dispatcher: info, agent };
    });
    on(BRIDGE_METHODS.status, async (): Promise<BridgeStatus> => ({
      ...(await dispatcher.status()),
      dispatcher: info,
    }));
    on(BRIDGE_METHODS.createJob, (value) =>
      dispatcher.createJob(this.caller(), value as Parameters<BridgeDispatcher['createJob']>[1])
    );
    on(BRIDGE_METHODS.getJob, (value) => dispatcher.job(params(JobNumberParamsSchema, value).job));
    on(BRIDGE_METHODS.listJobs, (value) =>
      dispatcher.jobs((value ?? {}) as Parameters<BridgeDispatcher['jobs']>[0])
    );
    on(BRIDGE_METHODS.cancelJob, (value) => {
      const request = params(CancelJobParamsSchema, value);
      return dispatcher.cancel(this.caller(), request.job, request.reason);
    });
    on(BRIDGE_METHODS.send, (value) =>
      dispatcher.send(this.caller(), value as Parameters<BridgeDispatcher['send']>[1])
    );
    on(BRIDGE_METHODS.inbox, (value) =>
      dispatcher.inbox(this.caller(), (value ?? {}) as Parameters<BridgeDispatcher['inbox']>[1])
    );
    on(BRIDGE_METHODS.acknowledge, (value) =>
      dispatcher.acknowledge(this.caller(), params(AcknowledgeParamsSchema, value).letter)
    );
    on(BRIDGE_METHODS.wait, (value) =>
      dispatcher.wait(
        this.caller(),
        (value ?? {}) as Parameters<BridgeDispatcher['wait']>[1],
        this.gone.signal
      )
    );
    on(BRIDGE_METHODS.delivered, (value) =>
      dispatcher.delivered(this.caller(), params(DeliveredParamsSchema, value).letters)
    );
    on(BRIDGE_METHODS.diff, (value) =>
      dispatcher.diff(this.caller(), value as Parameters<BridgeDispatcher['diff']>[1])
    );
    on(BRIDGE_METHODS.accept, (value) =>
      dispatcher.accept(this.caller(), value as Parameters<BridgeDispatcher['accept']>[1])
    );
    on(BRIDGE_METHODS.reject, (value) =>
      dispatcher.reject(this.caller(), value as Parameters<BridgeDispatcher['reject']>[1])
    );
    on(BRIDGE_METHODS.escalate, (value) =>
      dispatcher.escalate(this.caller(), value as Parameters<BridgeDispatcher['escalate']>[1])
    );
    on(BRIDGE_METHODS.verdict, (value) =>
      dispatcher.verdict(
        this.caller(),
        value as Parameters<BridgeDispatcher['verdict']>[1],
        this.gone.signal
      )
    );
    on(BRIDGE_METHODS.withdraw, (value) =>
      dispatcher.withdraw(this.caller(), value as Parameters<BridgeDispatcher['withdraw']>[1])
    );
    on(BRIDGE_METHODS.listLetters, (value) =>
      dispatcher.letters((value ?? {}) as Parameters<BridgeDispatcher['letters']>[0])
    );
    on(BRIDGE_METHODS.forPerson, () => dispatcher.forPerson());
    on(BRIDGE_METHODS.personAnswer, (value) => {
      if (this.agent) {
        throw new BridgeError(
          'not_a_party',
          `${this.agent} is a session of an agent, and only the person answers for the person`
        );
      }
      return dispatcher.personAnswer(value as Parameters<BridgeDispatcher['personAnswer']>[0]);
    });
    on(BRIDGE_METHODS.stuck, (value) =>
      dispatcher.stuck(this.caller(), value as Parameters<BridgeDispatcher['stuck']>[1])
    );
    on(BRIDGE_METHODS.limited, (value) =>
      dispatcher.limited(this.caller(), (value ?? {}) as Parameters<BridgeDispatcher['limited']>[1])
    );
    on(BRIDGE_METHODS.unlimit, (value) => {
      if (this.agent !== undefined) {
        throw new BridgeError(
          'not_a_party',
          'Only the person takes the limit of a harness back: an agent does not'
        );
      }
      return dispatcher.unlimit(params(UnlimitParamsSchema, value).agent);
    });
    on(BRIDGE_METHODS.remember, (value) =>
      dispatcher.remember(this.agent ?? null, value as Parameters<BridgeDispatcher['remember']>[1])
    );
    on(BRIDGE_METHODS.recall, (value) =>
      dispatcher.recall(
        this.agent ?? null,
        (value ?? {}) as Parameters<BridgeDispatcher['recall']>[1]
      )
    );
    on(BRIDGE_METHODS.forget, (value) =>
      dispatcher.forget(this.agent ?? null, value as Parameters<BridgeDispatcher['forget']>[1])
    );
    on(BRIDGE_METHODS.suggest, (value) =>
      dispatcher.suggest((value ?? {}) as Parameters<BridgeDispatcher['suggest']>[0])
    );
    on(BRIDGE_METHODS.results, (value) =>
      dispatcher.results((value ?? {}) as Parameters<BridgeDispatcher['results']>[0])
    );
    on(BRIDGE_METHODS.listAgents, (value) =>
      dispatcher.agents((value ?? {}) as Parameters<BridgeDispatcher['agents']>[0])
    );
    on(BRIDGE_METHODS.readJournal, (value) =>
      dispatcher.readJournal((value ?? {}) as Parameters<BridgeDispatcher['readJournal']>[0])
    );
    on(BRIDGE_METHODS.subscribeJournal, (value) => {
      const { job } = params(SubscribeJournalParamsSchema, value);
      this.subscription = job === undefined ? {} : { job };
      return { subscribed: true };
    });
    on(BRIDGE_METHODS.unsubscribeJournal, () => {
      this.subscription = undefined;
      return { subscribed: false };
    });
  }
}

function asError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}

/**
 * Narrows the umask to the owner and returns what puts it back. A worker thread cannot change
 * the umask of the process: there the socket is narrowed right after it is bound instead.
 */
function narrowUmask(): () => void {
  try {
    const previous = process.umask(0o177);
    return () => {
      process.umask(previous);
    };
  } catch {
    return () => undefined;
  }
}

/**
 * Removes what a dispatcher that died left at the socket path, a symlink included, without
 * following it.
 */
function removeStale(socketPath: string): void {
  try {
    unlinkSync(socketPath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
}

/**
 * Binds the socket. The bind happens inside this call, so the caller narrows the umask around it
 * and the socket file is never there with wider access than its owner's.
 */
function listen(server: Server, socketPath: string): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const onError = (error: Error) => reject(error);
    server.once('error', onError);
    server.listen(socketPath, () => {
      server.off('error', onError);
      resolve();
    });
  });
}

/**
 * Serves a dispatcher on a socket of this machine: JSON-RPC 2.0, one message per line. A
 * connection says which session is calling with `bridge/hello`, and acts as that agent from then
 * on. The calls of one connection are handled in the order they were written, one at a time, so
 * a call written right behind the hello already acts as the agent. Whoever serves must hold the dispatcher's lease: a socket file left by a dispatcher that
 * died is removed.
 */
export async function serveBridge(options: BridgeServerOptions): Promise<BridgeServer> {
  const { dispatcher, socketPath } = options;
  const connections = new Set<Connection>();
  const server = createServer((socket) => {
    const connection = new Connection(socket, options);
    connections.add(connection);
    socket.on('error', () => undefined);
    void connection.serve().finally(() => connections.delete(connection));
  });

  const pipe = isPipe(socketPath);
  server.maxConnections = MAX_CONNECTIONS;
  if (pipe) {
    await listen(server, socketPath);
  } else {
    removeStale(socketPath);
    const restore = narrowUmask();
    let listening: Promise<void>;
    try {
      listening = listen(server, socketPath);
    } finally {
      restore();
    }
    await listening;
    chmodSync(socketPath, 0o600);
  }
  server.on('error', (error) => options.onError?.(error));

  const onJournal = (entry: JournalEntry) => {
    for (const connection of connections) connection.hear(entry);
  };
  dispatcher.on('journal', onJournal);

  let closing: Promise<void> | undefined;
  return {
    get connections() {
      return connections.size;
    },
    close(closeOptions = {}) {
      closing ??= (async () => {
        dispatcher.off('journal', onJournal);
        if (closeOptions.abandon) {
          server.removeAllListeners('connection');
          server.on('connection', (socket) => socket.destroy());
          server.unref();
          for (const connection of connections) connection.end();
          return;
        }
        const closed = new Promise<void>((resolve) => server.close(() => resolve()));
        for (const connection of connections) connection.end();
        await closed;
      })();
      return closing;
    },
  };
}
