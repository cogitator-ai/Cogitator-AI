import { z } from 'zod';

export type JsonRpcId = string | number | null;

export interface JsonRpcRequest {
  jsonrpc: '2.0';
  method: string;
  params?: unknown;
  id?: string | number | null;
}

/** A request that wants no answer: it has no `id` */
export interface JsonRpcNotification {
  jsonrpc: '2.0';
  method: string;
  params?: unknown;
}

export interface JsonRpcResponse {
  jsonrpc: '2.0';
  result?: unknown;
  error?: JsonRpcError;
  id: string | number | null;
}

export interface JsonRpcError {
  code: number;
  message: string;
  data?: unknown;
}

/** Any message of JSON-RPC 2.0: a request, a notification or a response */
export type JsonRpcMessage = JsonRpcRequest | JsonRpcNotification | JsonRpcResponse;

/** The error codes JSON-RPC 2.0 defines */
export const JSON_RPC_ERROR_CODES = {
  parseError: -32700,
  invalidRequest: -32600,
  methodNotFound: -32601,
  invalidParams: -32602,
  internalError: -32603,
} as const;

export class JsonRpcParseError extends Error {
  constructor(
    message: string,
    public readonly code: number = -32700
  ) {
    super(message);
    this.name = 'JsonRpcParseError';
  }
}

export function isValidRequest(req: unknown): req is JsonRpcRequest {
  if (req === null || typeof req !== 'object' || Array.isArray(req)) {
    return false;
  }

  const obj = req as Record<string, unknown>;

  if (obj.jsonrpc !== '2.0' || typeof obj.method !== 'string') {
    return false;
  }

  if (obj.id === undefined || obj.id === null) return true;
  return typeof obj.id === 'string' || typeof obj.id === 'number';
}

const INVALID_REQUEST_CODE = JSON_RPC_ERROR_CODES.invalidRequest;

export function parseJsonRpcRequest(body: unknown): JsonRpcRequest | JsonRpcRequest[] {
  if (body === null || body === undefined || typeof body !== 'object') {
    throw new JsonRpcParseError(
      'Invalid JSON-RPC request: expected object or array',
      INVALID_REQUEST_CODE
    );
  }

  if (Array.isArray(body)) {
    if (body.length === 0) {
      throw new JsonRpcParseError('Invalid JSON-RPC batch: empty array', INVALID_REQUEST_CODE);
    }

    for (const item of body) {
      if (!isValidRequest(item)) {
        throw new JsonRpcParseError('Invalid JSON-RPC request in batch', INVALID_REQUEST_CODE);
      }
    }

    return body as JsonRpcRequest[];
  }

  if (!isValidRequest(body)) {
    throw new JsonRpcParseError('Invalid JSON-RPC request structure', INVALID_REQUEST_CODE);
  }

  return body as JsonRpcRequest;
}

export function createSuccessResponse(
  id: string | number | null,
  result: unknown
): JsonRpcResponse {
  return { jsonrpc: '2.0', result, id };
}

export function createErrorResponse(
  id: string | number | null,
  error: JsonRpcError
): JsonRpcResponse {
  return { jsonrpc: '2.0', error, id };
}

export function createRequest(
  id: string | number,
  method: string,
  params?: unknown
): JsonRpcRequest {
  return { jsonrpc: '2.0', method, ...(params !== undefined && { params }), id };
}

export function createNotification(method: string, params?: unknown): JsonRpcNotification {
  return { jsonrpc: '2.0', method, ...(params !== undefined && { params }) };
}

export const JsonRpcIdSchema = z.union([z.string(), z.number(), z.null()]);

export const JsonRpcErrorSchema = z.object({
  code: z.number().int(),
  message: z.string(),
  data: z.unknown().optional(),
});

const JsonRpcParamsSchema = z
  .union([z.record(z.string(), z.unknown()), z.array(z.unknown())])
  .optional()
  .describe('By name (an object) or by position (an array)');

export const JsonRpcRequestSchema = z.object({
  jsonrpc: z.literal('2.0'),
  method: z.string(),
  params: JsonRpcParamsSchema,
  id: JsonRpcIdSchema,
});

export const JsonRpcNotificationSchema = z.object({
  jsonrpc: z.literal('2.0'),
  method: z.string(),
  params: JsonRpcParamsSchema,
});

export const JsonRpcSuccessResponseSchema = z.object({
  jsonrpc: z.literal('2.0'),
  result: z.unknown(),
  id: JsonRpcIdSchema,
});

export const JsonRpcErrorResponseSchema = z.object({
  jsonrpc: z.literal('2.0'),
  error: JsonRpcErrorSchema,
  id: JsonRpcIdSchema,
});

/** One JSON-RPC 2.0 message, `"jsonrpc": "2.0"` required */
export const JsonRpcMessageSchema = z.union([
  JsonRpcRequestSchema,
  JsonRpcNotificationSchema,
  JsonRpcSuccessResponseSchema,
  JsonRpcErrorResponseSchema,
]);

export interface ParseJsonRpcMessageOptions {
  /**
   * Whether a message must carry `"jsonrpc": "2.0"` (default true). Off, a message without the
   * field reads as one with it, as clients on stdio such as Codex's send them. A wrong version
   * is refused either way
   */
  requireVersion?: boolean;
}

/** Whether `message` is a response, to a request of this side */
export function isJsonRpcResponse(message: JsonRpcMessage): message is JsonRpcResponse {
  return !('method' in message);
}

/** Whether `message` is a notification: a request without an `id` that wants no answer */
export function isJsonRpcNotification(message: JsonRpcMessage): message is JsonRpcNotification {
  return 'method' in message && (!('id' in message) || message.id === undefined);
}

/**
 * `value` read as one JSON-RPC 2.0 message or a batch of them: requests, notifications and
 * responses alike, `jsonrpc` set on each. A batch must not be empty, and every message in it
 * must be valid.
 *
 * @throws JsonRpcParseError (`invalidRequest`) when it is not a valid message or batch
 */
export function parseJsonRpcMessage(
  value: unknown,
  options: ParseJsonRpcMessageOptions = {}
): JsonRpcMessage | JsonRpcMessage[] {
  if (Array.isArray(value)) {
    if (value.length === 0) {
      throw new JsonRpcParseError('Invalid JSON-RPC batch: empty array', INVALID_REQUEST_CODE);
    }
    return value.map((item) => parseOne(item, options));
  }
  return parseOne(value, options);
}

function parseOne(value: unknown, options: ParseJsonRpcMessageOptions): JsonRpcMessage {
  const parsed = JsonRpcMessageSchema.safeParse(
    options.requireVersion === false ? withVersion(value) : value
  );
  if (!parsed.success) {
    throw new JsonRpcParseError('Invalid JSON-RPC message', INVALID_REQUEST_CODE);
  }
  return parsed.data;
}

function withVersion(value: unknown): unknown {
  if (value === null || typeof value !== 'object' || Array.isArray(value) || 'jsonrpc' in value) {
    return value;
  }
  return { jsonrpc: '2.0', ...value };
}

/**
 * The id a message that could not be read names, to answer it with: its `id` when that is a
 * valid one, else null
 */
export function jsonRpcIdOf(value: unknown): JsonRpcId {
  if (value === null || typeof value !== 'object' || !('id' in value)) return null;
  const parsed = JsonRpcIdSchema.safeParse(value.id);
  return parsed.success ? parsed.data : null;
}

/**
 * An error a JSON-RPC call ends with: what a request of a {@link JsonRpcPeer} rejects with when
 * the other side answers with an error, and what a handler throws to answer with one
 */
export class JsonRpcCallError extends Error {
  readonly code: number;
  readonly data?: unknown;

  constructor(error: JsonRpcError) {
    super(error.message);
    this.name = 'JsonRpcCallError';
    this.code = error.code;
    if (error.data !== undefined) this.data = error.data;
  }

  toJSON(): JsonRpcError {
    return {
      code: this.code,
      message: this.message,
      ...(this.data !== undefined && { data: this.data }),
    };
  }
}

/** What a handler of a {@link JsonRpcPeer} gets with the params */
export interface JsonRpcHandlerContext {
  method: string;
  /** The request's id, absent for a notification */
  id?: string | number | null;
  /** Aborts when the peer closes */
  signal: AbortSignal;
}

/** Answers a request: its result, or a thrown {@link JsonRpcCallError} for an error */
export type JsonRpcRequestHandler = (params: unknown, context: JsonRpcHandlerContext) => unknown;

export type JsonRpcNotificationHandler = (
  params: unknown,
  context: JsonRpcHandlerContext
) => void | Promise<void>;

export interface JsonRpcPeerOptions {
  /** Hands a message, or a batch of answers, to the other side */
  send: (message: JsonRpcMessage | JsonRpcMessage[]) => void | Promise<void>;
  /**
   * Whether incoming messages must carry `"jsonrpc": "2.0"` (default false, as clients on
   * stdio leave it out). Outgoing ones always do
   */
  requireVersion?: boolean;
  /**
   * The error a request is answered with when its handler threw something other than a
   * {@link JsonRpcCallError}. By default `internalError` without the thrown message, which
   * may hold what the other side must not see
   */
  describeError?: (error: unknown, context: JsonRpcHandlerContext) => JsonRpcError;
  /**
   * Hears what went wrong outside a call: a message that could not be sent, a response to no
   * request of this side, a notification handler that threw
   */
  onError?: (error: Error) => void;
}

export interface JsonRpcRequestOptions {
  /** Stops waiting: the request rejects with the signal's reason, a late answer is dropped */
  signal?: AbortSignal;
  /** Milliseconds to wait for the answer before rejecting */
  timeoutMs?: number;
}

interface PendingRequest {
  resolve: (result: unknown) => void;
  reject: (error: Error) => void;
}

/**
 * One side of a JSON-RPC 2.0 connection, on any transport that moves whole messages: it sends
 * requests and waits for their answers by id, sends notifications, and answers the requests the
 * other side sends with the handlers registered for their methods (`methodNotFound` for others).
 * Pass what arrives to {@link receive}, single messages and batches alike: a batch is answered
 * with one batch, as JSON-RPC asks. {@link close} rejects the requests still waiting and aborts
 * the handlers still running.
 *
 * @example
 * ```ts
 * const peer = new JsonRpcPeer({ send: (message) => write(encodeNdjsonLine(message)) });
 * peer.onRequest('ping', () => 'pong');
 * for await (const line of readNdjson(stdin)) {
 *   if ('value' in line) void peer.receive(line.value);
 * }
 * ```
 */
export class JsonRpcPeer {
  private readonly requestHandlers = new Map<string, JsonRpcRequestHandler>();
  private readonly notificationHandlers = new Map<string, JsonRpcNotificationHandler>();
  private readonly waiting = new Map<string | number, PendingRequest>();
  private readonly closing = new AbortController();
  private nextId = 1;

  constructor(private readonly options: JsonRpcPeerOptions) {}

  /** Whether {@link close} was called */
  get closed(): boolean {
    return this.closing.signal.aborted;
  }

  /** How many requests of this side wait for their answer */
  get pending(): number {
    return this.waiting.size;
  }

  /** Answers requests for `method` with `handler`, until the returned function is called */
  onRequest(method: string, handler: JsonRpcRequestHandler): () => void {
    this.requestHandlers.set(method, handler);
    return () => {
      if (this.requestHandlers.get(method) === handler) this.requestHandlers.delete(method);
    };
  }

  /** Hears notifications of `method` with `handler`, until the returned function is called */
  onNotification(method: string, handler: JsonRpcNotificationHandler): () => void {
    this.notificationHandlers.set(method, handler);
    return () => {
      if (this.notificationHandlers.get(method) === handler) {
        this.notificationHandlers.delete(method);
      }
    };
  }

  /**
   * Sends a request and resolves with its result.
   *
   * @throws JsonRpcCallError when the other side answers with an error. Also rejects when the
   * peer closes, the signal aborts or the timeout passes first, or the message cannot be sent
   */
  request<T = unknown>(
    method: string,
    params?: unknown,
    options: JsonRpcRequestOptions = {}
  ): Promise<T> {
    if (this.closed) return Promise.reject(this.closedError());
    const { signal, timeoutMs } = options;
    if (signal?.aborted) return Promise.reject(abortReason(signal));
    const id = this.nextId++;
    return new Promise<T>((resolve, reject) => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      const onAbort = () => {
        if (signal) settle(() => reject(abortReason(signal)));
      };
      const settle = (finish: () => void) => {
        if (!this.waiting.delete(id)) return;
        if (timer !== undefined) clearTimeout(timer);
        signal?.removeEventListener('abort', onAbort);
        finish();
      };
      this.waiting.set(id, {
        resolve: (result) => settle(() => resolve(result as T)),
        reject: (error) => settle(() => reject(error)),
      });
      signal?.addEventListener('abort', onAbort, { once: true });
      if (timeoutMs !== undefined) {
        timer = setTimeout(
          () =>
            settle(() =>
              reject(new Error(`JSON-RPC request ${method} got no answer in ${timeoutMs}ms`))
            ),
          timeoutMs
        );
      }
      this.deliver(createRequest(id, method, params)).catch((error: unknown) =>
        settle(() => reject(asError(error)))
      );
    });
  }

  /** Sends a notification. Rejects when it cannot be sent or the peer is closed */
  async notify(method: string, params?: unknown): Promise<void> {
    if (this.closed) throw this.closedError();
    await this.deliver(createNotification(method, params));
  }

  /** Answers request `id` with `result`, for a request answered outside its handler */
  async respond(id: JsonRpcId, result: unknown): Promise<void> {
    await this.deliver(createSuccessResponse(id, result));
  }

  /** Answers request `id`, or a message that could not be read (`null`), with `error` */
  async respondError(id: JsonRpcId, error: JsonRpcError): Promise<void> {
    await this.deliver(createErrorResponse(id, error));
  }

  /**
   * Handles what the other side sent, a message or a batch, already read from JSON: settles the
   * requests its responses answer, runs the handlers of its requests and notifications and sends
   * the answers. Resolves once every answer is sent. A message that is not valid JSON-RPC is
   * answered with `invalidRequest`. Nothing is handled once the peer is closed
   */
  async receive(value: unknown): Promise<void> {
    if (this.closed) return;
    if (!Array.isArray(value)) {
      const answer = await this.handle(value);
      if (answer) await this.send(answer);
      return;
    }
    if (value.length === 0) {
      await this.send(
        createErrorResponse(null, {
          code: JSON_RPC_ERROR_CODES.invalidRequest,
          message: 'Invalid JSON-RPC batch: empty array',
        })
      );
      return;
    }
    const answers = (await Promise.all(value.map((item) => this.handle(item)))).filter(
      (answer): answer is JsonRpcResponse => answer !== undefined
    );
    if (answers.length > 0) await this.send(answers);
  }

  /**
   * Closes the peer: the requests still waiting reject with `reason`, the handlers still running
   * see their signal abort, and nothing more is sent or handled
   */
  close(reason?: Error): void {
    if (this.closed) return;
    const error = reason ?? this.closedError();
    this.closing.abort(error);
    for (const pending of [...this.waiting.values()]) pending.reject(error);
    this.waiting.clear();
  }

  private async handle(value: unknown): Promise<JsonRpcResponse | undefined> {
    let message: JsonRpcMessage;
    try {
      message = parseOne(value, { requireVersion: this.options.requireVersion ?? false });
    } catch (error) {
      if (isAnswerShaped(value)) {
        this.report(new Error('Received a JSON-RPC response that is not valid'));
        return undefined;
      }
      return createErrorResponse(jsonRpcIdOf(value), {
        code: JSON_RPC_ERROR_CODES.invalidRequest,
        message: error instanceof Error ? error.message : 'Invalid JSON-RPC message',
      });
    }
    if (isJsonRpcResponse(message)) {
      this.settle(message);
      return undefined;
    }
    if (isJsonRpcNotification(message)) {
      await this.notified(message);
      return undefined;
    }
    return this.answer(message);
  }

  private settle(response: JsonRpcResponse): void {
    const pending = response.id === null ? undefined : this.waiting.get(response.id);
    if (!pending) {
      this.report(new Error(`Received a JSON-RPC response to no request: ${String(response.id)}`));
      return;
    }
    if (response.error) pending.reject(new JsonRpcCallError(response.error));
    else pending.resolve(response.result);
  }

  private async notified(notification: JsonRpcNotification): Promise<void> {
    const handler = this.notificationHandlers.get(notification.method);
    if (!handler) return;
    try {
      await handler(notification.params, {
        method: notification.method,
        signal: this.closing.signal,
      });
    } catch (error) {
      this.report(asError(error));
    }
  }

  private async answer(request: JsonRpcRequest): Promise<JsonRpcResponse> {
    const id = request.id ?? null;
    const handler = this.requestHandlers.get(request.method);
    if (!handler) {
      return createErrorResponse(id, {
        code: JSON_RPC_ERROR_CODES.methodNotFound,
        message: `Method not found: ${request.method}`,
      });
    }
    const context: JsonRpcHandlerContext = {
      method: request.method,
      id,
      signal: this.closing.signal,
    };
    try {
      const result: unknown = await handler(request.params, context);
      return createSuccessResponse(id, result === undefined ? null : result);
    } catch (error) {
      return createErrorResponse(id, this.describe(error, context));
    }
  }

  private describe(error: unknown, context: JsonRpcHandlerContext): JsonRpcError {
    if (error instanceof JsonRpcCallError) return error.toJSON();
    if (error instanceof JsonRpcParseError) return { code: error.code, message: error.message };
    if (this.options.describeError) return this.options.describeError(error, context);
    return { code: JSON_RPC_ERROR_CODES.internalError, message: 'Internal error' };
  }

  /** Sends `message` unless the peer closed, reporting a transport that failed */
  private async send(message: JsonRpcMessage | JsonRpcMessage[]): Promise<void> {
    if (this.closed) return;
    try {
      await this.options.send(message);
    } catch (error) {
      this.report(asError(error));
    }
  }

  /** Sends `message`, rejecting when the transport fails or the peer closed */
  private async deliver(message: JsonRpcMessage): Promise<void> {
    if (this.closed) throw this.closedError();
    await this.options.send(message);
  }

  private report(error: Error): void {
    try {
      this.options.onError?.(error);
    } catch {
      return;
    }
  }

  private closedError(): Error {
    const reason: unknown = this.closing.signal.reason;
    return reason instanceof Error ? reason : new Error('The JSON-RPC peer is closed');
  }
}

/** Whether `value` looks like an answer, so it gets no answer of its own when it is not valid */
function isAnswerShaped(value: unknown): boolean {
  return (
    value !== null &&
    typeof value === 'object' &&
    !Array.isArray(value) &&
    !('method' in value) &&
    ('result' in value || 'error' in value)
  );
}

function abortReason(signal: AbortSignal): Error {
  const reason: unknown = signal.reason;
  return reason instanceof Error ? reason : new Error('JSON-RPC request aborted');
}

function asError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}
