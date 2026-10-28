/**
 * The runtime part of the generated client, printed after the types as it is: a JSON-RPC 2.0
 * client over a line transport. `  /* methods *\/` is replaced with a method per request
 */
export const CLIENT_RUNTIME = `/**
 * Moves lines between the client and an app-server, such as the stdin and stdout of
 * \`cogitator app-server\`: \`send\` writes one JSON message (the transport adds the newline),
 * \`onLine\` hears each line the server writes, \`close\` ends the connection
 */
export interface AppServerClientTransport {
  send(line: string): void;
  onLine(callback: (line: string) => void): void;
  close(): void;
}

/** An error the server answered a request with */
export class AppServerClientError extends Error {
  readonly code: number;
  readonly data?: unknown;

  constructor(error: { code: number; message: string; data?: unknown }) {
    super(error.message);
    this.name = 'AppServerClientError';
    this.code = error.code;
    if (error.data !== undefined) this.data = error.data;
  }
}

interface PendingRequest {
  resolve: (result: unknown) => void;
  reject: (error: Error) => void;
}

type IncomingMessage = Record<string, unknown>;

function isObject(value: unknown): value is IncomingMessage {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isId(value: unknown): value is string | number {
  return typeof value === 'string' || typeof value === 'number';
}

/**
 * A client of the Cogitator app-server: a typed method per request, \`on()\` for notifications
 * and \`onRequest()\` for what the server asks, such as \`approval/request\`. Call
 * \`initialize()\` first.
 *
 * @example
 * \`\`\`ts
 * const client = new AppServerClient(transport);
 * await client.initialize({ protocolVersion: APP_SERVER_PROTOCOL_VERSION, clientInfo: { name: 'my-app' } });
 * const { thread } = await client.threadStart();
 * client.on('turn/event', ({ event }) => {
 *   if (event.type === 'text-delta') process.stdout.write(event.delta);
 * });
 * await client.turnStart({ threadId: thread.id, input: [{ type: 'text', text: 'Hello' }] });
 * \`\`\`
 */
export class AppServerClient {
  private nextId = 1;
  private readonly pending = new Map<string | number, PendingRequest>();
  private readonly listeners = new Map<string, Set<(params: unknown) => void>>();
  private readonly handlers = new Map<string, (params: unknown) => unknown>();
  private closedReason: Error | undefined;

  constructor(private readonly transport: AppServerClientTransport) {
    transport.onLine((line) => this.receive(line));
  }

  /** Whether {@link close} was called */
  get closed(): boolean {
    return this.closedReason !== undefined;
  }

  /**
   * Sends a request and resolves with its result.
   *
   * @throws AppServerClientError when the server answers with an error
   */
  request<M extends keyof AppServerMethods>(
    method: M,
    params: AppServerMethods[M]['params']
  ): Promise<AppServerMethods[M]['result']> {
    if (this.closedReason) return Promise.reject(this.closedReason);
    const id = this.nextId++;
    return new Promise<AppServerMethods[M]['result']>((resolve, reject) => {
      this.pending.set(id, {
        resolve: (result) => resolve(result as AppServerMethods[M]['result']),
        reject,
      });
      try {
        this.transport.send(JSON.stringify({ jsonrpc: '2.0', id, method, params }));
      } catch (error) {
        this.pending.delete(id);
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    });
  }

  /** Sends a notification */
  notify(method: string, params?: unknown): void {
    if (this.closedReason) throw this.closedReason;
    this.transport.send(
      JSON.stringify({ jsonrpc: '2.0', method, ...(params !== undefined && { params }) })
    );
  }

  /** Hears notifications of \`method\`, until the returned function is called */
  on<M extends keyof AppServerNotifications>(
    method: M,
    listener: (params: AppServerNotifications[M]) => void
  ): () => void {
    const heard = (params: unknown) => listener(params as AppServerNotifications[M]);
    let set = this.listeners.get(method);
    if (!set) {
      set = new Set();
      this.listeners.set(method, set);
    }
    set.add(heard);
    return () => {
      set.delete(heard);
    };
  }

  /** Answers the requests of \`method\` the server sends, until the returned function is called */
  onRequest<M extends keyof AppServerServerRequests>(
    method: M,
    handler: (
      params: AppServerServerRequests[M]['params']
    ) => AppServerServerRequests[M]['result'] | Promise<AppServerServerRequests[M]['result']>
  ): () => void {
    const handle = (params: unknown) => handler(params as AppServerServerRequests[M]['params']);
    this.handlers.set(method, handle);
    return () => {
      if (this.handlers.get(method) === handle) this.handlers.delete(method);
    };
  }

  /** Closes the connection: requests still waiting reject, the transport closes */
  close(): void {
    if (this.closedReason) return;
    this.closedReason = new Error('The app-server client is closed');
    for (const pending of this.pending.values()) pending.reject(this.closedReason);
    this.pending.clear();
    this.transport.close();
  }

  /* methods */

  private receive(line: string): void {
    if (line.trim() === '') return;
    let value: unknown;
    try {
      value = JSON.parse(line);
    } catch {
      return;
    }
    for (const message of Array.isArray(value) ? value : [value]) {
      if (isObject(message)) this.dispatch(message);
    }
  }

  private dispatch(message: IncomingMessage): void {
    const method = message.method;
    if (typeof method !== 'string') {
      if (!isId(message.id)) return;
      const pending = this.pending.get(message.id);
      if (!pending) return;
      this.pending.delete(message.id);
      if (isObject(message.error)) {
        const error = message.error;
        pending.reject(
          new AppServerClientError({
            code: typeof error.code === 'number' ? error.code : APP_SERVER_ERROR_CODES.internalError,
            message: typeof error.message === 'string' ? error.message : 'Unknown error',
            data: error.data,
          })
        );
      } else {
        pending.resolve(message.result);
      }
      return;
    }
    if (!isId(message.id)) {
      for (const listener of [...(this.listeners.get(method) ?? [])]) listener(message.params);
      return;
    }
    void this.answer(message.id, method, message.params);
  }

  private async answer(id: string | number, method: string, params: unknown): Promise<void> {
    const handler = this.handlers.get(method);
    let reply: Record<string, unknown>;
    if (!handler) {
      reply = {
        jsonrpc: '2.0',
        id,
        error: { code: APP_SERVER_ERROR_CODES.methodNotFound, message: 'Method not found: ' + method },
      };
    } else {
      try {
        reply = { jsonrpc: '2.0', id, result: (await handler(params)) ?? null };
      } catch (error) {
        reply = {
          jsonrpc: '2.0',
          id,
          error: {
            code: APP_SERVER_ERROR_CODES.internalError,
            message: error instanceof Error ? error.message : String(error),
          },
        };
      }
    }
    if (!this.closedReason) this.transport.send(JSON.stringify(reply));
  }
}
`;
