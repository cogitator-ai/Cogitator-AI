/**
 * Requests the MCP SDK client cannot send or read itself, sent on the client's own transport:
 * `tools/call` answered by a task, and the `tasks/*` methods of the tasks extension
 * (io.modelcontextprotocol/tasks, protocol 2026-07-28)
 */

import {
  ProtocolError,
  SdkError,
  SdkErrorCode,
  type JSONRPCMessage,
  type MessageExtraInfo,
  type Transport,
} from '@modelcontextprotocol/client';

/** The `_meta` a request of protocol 2026-07-28 carries */
export type RequestFraming = () => Record<string, unknown>;

export interface RawRequestOptions {
  signal?: AbortSignal;
  timeout?: number;
  /** HTTP headers of this request, such as `Mcp-Param-*` */
  headers?: Record<string, string>;
}

interface Pending {
  resolve: (result: Record<string, unknown>) => void;
  reject: (error: Error) => void;
  cleanup: () => void;
}

const DEFAULT_TIMEOUT_MS = 60_000;

/**
 * Sends JSON-RPC requests on a transport the SDK client already drives, under ids of its own
 * (`cogitator:<n>`, strings the SDK never issues), and takes their responses before the client
 * sees them. Everything else passes on to the client untouched.
 */
export class RawDispatcher {
  private transport: Transport | undefined;
  private readonly pending = new Map<string, Pending>();
  private next = 0;

  constructor(private readonly framing: RequestFraming) {}

  /** Starts taking responses on `transport`, which the SDK client has connected */
  attach(transport: Transport): void {
    this.failPending(new SdkError(SdkErrorCode.ConnectionClosed, 'Connection closed'));
    this.transport = transport;
    const previousMessage = transport.onmessage;
    transport.onmessage = (message: JSONRPCMessage, extra?: MessageExtraInfo) => {
      if (this.take(message)) return;
      previousMessage?.(message, extra);
    };
    const previousClose = transport.onclose;
    transport.onclose = () => {
      this.failPending(new SdkError(SdkErrorCode.ConnectionClosed, 'Connection closed'));
      previousClose?.();
    };
  }

  /** Stops, failing the requests still waiting */
  detach(): void {
    this.failPending(new SdkError(SdkErrorCode.ConnectionClosed, 'Connection closed'));
    this.transport = undefined;
  }

  /**
   * Sends `method` with `params` framed with the request `_meta`, and resolves with the result.
   * A JSON-RPC error rejects with a `ProtocolError`, a timeout or a closed connection with an
   * `SdkError`
   */
  request(
    method: string,
    params: Record<string, unknown>,
    options: RawRequestOptions = {}
  ): Promise<Record<string, unknown>> {
    const transport = this.transport;
    if (!transport) {
      return Promise.reject(new SdkError(SdkErrorCode.NotConnected, 'Not connected'));
    }
    if (options.signal?.aborted) {
      return Promise.reject(abortError(options.signal));
    }
    const id = `cogitator:${++this.next}`;
    const meta = isRecord(params._meta) ? params._meta : {};
    const message: JSONRPCMessage = {
      jsonrpc: '2.0',
      id,
      method,
      params: { ...params, _meta: { ...this.framing(), ...meta } },
    };
    const streamAbort = new AbortController();
    const timeoutMs = options.timeout ?? DEFAULT_TIMEOUT_MS;

    return new Promise<Record<string, unknown>>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.cancel(id, 'timeout', streamAbort);
        reject(
          new SdkError(SdkErrorCode.RequestTimeout, `Request ${method} timed out`, {
            timeout: timeoutMs,
          })
        );
      }, timeoutMs);
      const onAbort = (): void => {
        this.cancel(id, 'aborted', streamAbort);
        reject(abortError(options.signal));
      };
      options.signal?.addEventListener('abort', onAbort, { once: true });
      const cleanup = (): void => {
        clearTimeout(timer);
        options.signal?.removeEventListener('abort', onAbort);
      };
      this.pending.set(id, { resolve, reject, cleanup });
      transport
        .send(message, {
          requestSignal: streamAbort.signal,
          ...(options.headers && { headers: options.headers }),
        })
        .catch((error: unknown) => {
          const entry = this.pending.get(id);
          if (!entry) return;
          this.pending.delete(id);
          entry.cleanup();
          entry.reject(error instanceof Error ? error : new Error(String(error)));
        });
    });
  }

  private cancel(id: string, reason: string, streamAbort: AbortController): void {
    const entry = this.pending.get(id);
    if (!entry) return;
    this.pending.delete(id);
    entry.cleanup();
    streamAbort.abort();
    if (this.transport?.hasPerRequestStream) return;
    this.transport
      ?.send({
        jsonrpc: '2.0',
        method: 'notifications/cancelled',
        params: { requestId: id, reason },
      })
      .catch(() => {});
  }

  private take(message: JSONRPCMessage): boolean {
    if (!('id' in message) || typeof message.id !== 'string' || 'method' in message) return false;
    const entry = this.pending.get(message.id);
    if (!entry) return false;
    this.pending.delete(message.id);
    entry.cleanup();
    if ('error' in message) {
      entry.reject(
        new ProtocolError(message.error.code, message.error.message, message.error.data)
      );
    } else {
      entry.resolve(message.result);
    }
    return true;
  }

  private failPending(error: Error): void {
    const entries = [...this.pending.values()];
    this.pending.clear();
    for (const entry of entries) {
      entry.cleanup();
      entry.reject(error);
    }
  }
}

function abortError(signal: AbortSignal | undefined): Error {
  const reason: unknown = signal?.reason;
  return reason instanceof Error
    ? reason
    : new DOMException('The operation was aborted', 'AbortError');
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
