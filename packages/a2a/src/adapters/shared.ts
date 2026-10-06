import { encodeHeartbeat, startHeartbeat } from '@cogitator-ai/server-shared';
import type { A2AServer } from '../server.js';
import { STREAMING_METHODS } from '../server.js';
import { createErrorResponse, type JsonRpcResponse } from '../json-rpc.js';
import * as errors from '../errors.js';
import { AGENT_CARD_PATH, LEGACY_AGENT_CARD_PATH } from '../types.js';

export type HeaderValue = string | string[] | null | undefined;

export function firstHeader(value: HeaderValue): string | undefined {
  if (Array.isArray(value)) return value[0];
  return value ?? undefined;
}

export const SSE_HEADERS: Record<string, string> = {
  'Content-Type': 'text/event-stream',
  'Cache-Control': 'no-cache',
  Connection: 'keep-alive',
  'X-Accel-Buffering': 'no',
};

/**
 * A request streams when its method is `message/stream` or `tasks/resubscribe`; the Accept
 * header alone does not switch another method to SSE.
 */
export function isStreamRequest(body: unknown): boolean {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) return false;
  const method = (body as Record<string, unknown>).method;
  return typeof method === 'string' && STREAMING_METHODS.includes(method);
}

/** One SSE event carrying a JSON-RPC response (A2A v0.3, section 3.3.1). */
export function sseFrame(response: JsonRpcResponse): string {
  return `data: ${JSON.stringify(response)}\n\n`;
}

/** A request as a framework adapter hands it over. */
export interface A2AHttpRequest {
  method: string;
  /** The path relative to where the adapter is mounted, e.g. `/a2a` */
  path: string;
  /** Absolute URL the adapter is mounted at (origin plus mount path), for the cards' `url` */
  mountUrl: string;
  header(name: string): string | null | undefined;
  /** The parsed JSON body; throws a SyntaxError when the body is not JSON */
  readBody(): Promise<unknown>;
  /** Aborted when the client disconnects */
  signal: AbortSignal;
}

/** What the adapter sends back. */
export type A2AHttpResponse =
  | { kind: 'json'; status: number; headers: Record<string, string>; body: unknown }
  | { kind: 'empty'; status: number }
  | {
      kind: 'sse';
      headers: Record<string, string>;
      /** Write the stream's frames until it ends or the client disconnects */
      pipe(write: (frame: string) => void | Promise<void>): Promise<void>;
    }
  | { kind: 'pass' };

type Route =
  | { kind: 'card'; agentName?: string }
  | { kind: 'legacy-card' }
  | { kind: 'rpc'; agentName?: string };

function agentNameFrom(segment: string): string | null {
  try {
    return decodeURIComponent(segment);
  } catch {
    return null;
  }
}

/**
 * The A2A route a request path names: the Agent Card at the well-known path, the pre-v0.3 card
 * path, the shared JSON-RPC endpoint at `basePath`, or one agent's endpoint and card under
 * `<basePath>/<agent name>`.
 */
function matchRoute(server: A2AServer, method: string, path: string): Route | null {
  const basePath = server.basePath.replace(/\/+$/, '') || '';
  if (method === 'GET') {
    if (path === AGENT_CARD_PATH) return { kind: 'card' };
    if (path === LEGACY_AGENT_CARD_PATH) return { kind: 'legacy-card' };
    const prefix = `${basePath}/`;
    if (path.startsWith(prefix) && path.endsWith(AGENT_CARD_PATH)) {
      const segment = path.slice(prefix.length, path.length - AGENT_CARD_PATH.length);
      const agentName = segment.includes('/') ? null : agentNameFrom(segment);
      if (agentName) return { kind: 'card', agentName };
    }
    return null;
  }
  if (method === 'POST') {
    if (path === server.basePath || path === basePath) return { kind: 'rpc' };
    const prefix = `${basePath}/`;
    if (path.startsWith(prefix)) {
      const segment = path.slice(prefix.length).replace(/\/$/, '');
      const agentName = segment && !segment.includes('/') ? agentNameFrom(segment) : null;
      if (agentName) return { kind: 'rpc', agentName };
    }
  }
  return null;
}

function json(
  status: number,
  body: unknown,
  headers: Record<string, string> = {}
): A2AHttpResponse {
  return { kind: 'json', status, headers, body };
}

/** The HTTP status of a JSON-RPC response: 401 for missing or rejected credentials, else 200. */
function errorStatus(server: A2AServer, response: JsonRpcResponse): A2AHttpResponse {
  if (response.error?.code === errors.A2A_ERROR_CODES.unauthorized) {
    const challenge = server.authChallenge;
    return json(401, response, challenge ? { 'WWW-Authenticate': challenge } : {});
  }
  return json(200, response);
}

/**
 * Serve an A2A request: the Agent Cards and the JSON-RPC endpoints, with streams as SSE where
 * every event is a JSON-RPC response. Errors before a stream starts are answered as a plain
 * JSON-RPC error, with HTTP 401 for missing or rejected credentials.
 */
export async function handleA2AHttp(
  server: A2AServer,
  request: A2AHttpRequest
): Promise<A2AHttpResponse> {
  const route = matchRoute(server, request.method, request.path);
  if (!route) return { kind: 'pass' };

  if (route.kind === 'legacy-card') {
    const cards = server.getAgentCards({ baseUrl: request.mountUrl });
    return json(200, cards.length === 1 ? cards[0] : cards);
  }

  if (route.agentName !== undefined && !server.hasAgent(route.agentName)) {
    return json(404, createErrorResponse(null, errors.agentNotFound(route.agentName)));
  }

  if (route.kind === 'card') {
    return json(200, server.getAgentCard(route.agentName, { baseUrl: request.mountUrl }));
  }

  const contentType = request.header('content-type');
  if (contentType && !contentType.toLowerCase().startsWith('application/json')) {
    return json(
      415,
      createErrorResponse(null, errors.invalidRequest('Content-Type must be application/json'))
    );
  }

  let body: unknown;
  try {
    body = await request.readBody();
  } catch {
    return json(200, createErrorResponse(null, errors.parseError('Invalid JSON body')));
  }
  if (body === undefined) {
    return json(
      200,
      createErrorResponse(
        null,
        errors.parseError('Request body not parsed. Ensure body-parsing middleware is applied.')
      )
    );
  }

  const authToken = server.getAuthToken((name) => request.header(name));
  const options = route.agentName !== undefined ? { agentName: route.agentName } : undefined;

  if (!isStreamRequest(body)) {
    const response = await server.handleJsonRpc(body, authToken, options);
    if (response === null) return { kind: 'empty', status: 204 };
    return response.error ? errorStatus(server, response) : json(200, response);
  }

  const stream = server.handleJsonRpcStream(body, authToken, request.signal, options);
  const first = await stream.next();
  if (first.done) return { kind: 'empty', status: 204 };
  if (first.value.error) {
    await stream.return(undefined);
    return errorStatus(server, first.value);
  }

  return {
    kind: 'sse',
    headers: SSE_HEADERS,
    pipe: (write) => pipeStream(server, first.value, stream, request.signal, write),
  };
}

/**
 * Write the frames of a stream until it ends, the client disconnects or a write fails. While the
 * stream is open a heartbeat comment goes out every `server.sseHeartbeatMs`, so a run that waits
 * on a slow tool is not cut off by an idle timeout.
 */
async function pipeStream(
  server: A2AServer,
  first: JsonRpcResponse,
  rest: AsyncGenerator<JsonRpcResponse>,
  signal: AbortSignal,
  write: (frame: string) => void | Promise<void>
): Promise<void> {
  const stopHeartbeat = startHeartbeat(() => {
    if (signal.aborted) return false;
    void Promise.resolve()
      .then(() => write(encodeHeartbeat()))
      .catch(() => undefined);
    return true;
  }, server.sseHeartbeatMs);
  try {
    await write(sseFrame(first));
    for await (const response of rest) {
      if (signal.aborted) return;
      await write(sseFrame(response));
    }
  } catch (error) {
    if (signal.aborted) return;
    try {
      await write(
        sseFrame(createErrorResponse(null, errors.clientJsonRpcError(error, 'A2A stream failed')))
      );
    } catch {
      return;
    }
  } finally {
    stopHeartbeat();
    await rest.return(undefined);
  }
}

/** The URL an adapter is mounted at, from the full request URL and the path relative to the mount. */
export function mountUrlOf(requestUrl: URL, relativePath: string): string {
  const pathname = requestUrl.pathname;
  const prefix = pathname.endsWith(relativePath)
    ? pathname.slice(0, pathname.length - relativePath.length)
    : '';
  return `${requestUrl.origin}${prefix}`;
}
