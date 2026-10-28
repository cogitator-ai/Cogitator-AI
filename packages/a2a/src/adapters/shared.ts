import { createHash } from 'node:crypto';
import { encodeHeartbeat, startHeartbeat } from '@cogitator-ai/server-shared';
import type { A2AServer, A2AHandleOptions } from '../server.js';
import { STREAMING_METHODS } from '../server.js';
import { createErrorResponse, type JsonRpcResponse } from '../json-rpc.js';
import * as errors from '../errors.js';
import { AGENT_CARD_PATH, JWKS_PATH, LEGACY_AGENT_CARD_PATH } from '../types.js';
import { trimTrailingSlashes } from '../url.js';
import {
  A2A_CONTENT_TYPE,
  A2A_VERSION_HEADER,
  normalizeProtocolVersion,
  requestedProtocolVersion,
  resolveProtocolVersion,
  type A2AProtocolVersion,
} from '../version.js';
import {
  A2A_EXTENSIONS_HEADER,
  LEGACY_EXTENSIONS_HEADER,
  activatedExtensions,
  parseExtensionsHeader,
} from '../extensions.js';
import { V1_STREAMING_METHODS } from '../v1/json-rpc.js';
import { restErrorBody, toRestError, toV1JsonRpcError } from '../v1/errors.js';
import type { V1StreamResponse } from '../v1/types.js';
import { PayloadTooLargeError } from './body.js';

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

/** How long clients and proxies may keep an Agent Card or a JWKS (A2A 1.0, section 8.6). */
const CARD_CACHE_CONTROL = 'public, max-age=300';

/**
 * A request streams when its method is `message/stream` or `tasks/resubscribe` (A2A 1.0:
 * `SendStreamingMessage` or `SubscribeToTask`); the Accept header alone does not switch another
 * method to SSE.
 */
export function isStreamRequest(body: unknown, version: A2AProtocolVersion = '0.3'): boolean {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) return false;
  const method = (body as Record<string, unknown>).method;
  const streaming = version === '1.0' ? V1_STREAMING_METHODS : STREAMING_METHODS;
  return typeof method === 'string' && streaming.includes(method);
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
  /** The query string, for `A2A-Version` and the query parameters of the HTTP+JSON binding */
  query?: URLSearchParams;
  header(name: string): string | null | undefined;
  /** The parsed JSON body; throws a SyntaxError when the body is not JSON */
  readBody(): Promise<unknown>;
  /** Aborted when the client disconnects */
  signal: AbortSignal;
}

/** What the adapter sends back. */
export type A2AHttpResponse =
  | { kind: 'json'; status: number; headers: Record<string, string>; body: unknown }
  | { kind: 'empty'; status: number; headers?: Record<string, string> }
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
  | { kind: 'jwks' }
  | { kind: 'rpc'; agentName?: string }
  | { kind: 'rest'; path: string };

function agentNameFrom(segment: string): string | null {
  try {
    return decodeURIComponent(segment);
  } catch {
    return null;
  }
}

/**
 * The A2A route a request path names: the Agent Card at the well-known path, the pre-v0.3 card
 * path, the JWKS, the HTTP+JSON binding under `restPath`, the shared JSON-RPC endpoint at
 * `basePath`, or one agent's endpoint and card under `<basePath>/<agent name>`.
 */
export function matchRoute(server: A2AServer, method: string, path: string): Route | null {
  if (server.restPath && isRestPath(server, path)) {
    return { kind: 'rest', path: path.slice(server.restPath.length) };
  }
  const basePath = trimTrailingSlashes(server.basePath) || '';
  if (method === 'GET') {
    if (path === AGENT_CARD_PATH) return { kind: 'card' };
    if (path === LEGACY_AGENT_CARD_PATH) return { kind: 'legacy-card' };
    if (path === JWKS_PATH) return { kind: 'jwks' };
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

/** Whether a path relative to the mount is under the HTTP+JSON binding. */
export function isRestPath(server: A2AServer, path: string): boolean {
  return server.restPath !== null && path.startsWith(`${server.restPath}/`);
}

function json(
  status: number,
  body: unknown,
  headers: Record<string, string> = {}
): A2AHttpResponse {
  return { kind: 'json', status, headers, body };
}

/** The HTTP status of a JSON-RPC response: 401 for missing or rejected credentials, else 200. */
function errorStatus(
  server: A2AServer,
  response: JsonRpcResponse,
  headers: Record<string, string> = {}
): A2AHttpResponse {
  if (response.error?.code === errors.A2A_ERROR_CODES.unauthorized) {
    const challenge = server.authChallenge;
    return json(401, response, {
      ...headers,
      ...(challenge && { 'WWW-Authenticate': challenge }),
    });
  }
  return json(200, response, headers);
}

/** The strong ETag of a JSON body: the SHA-256 of its serialization. */
function etagOf(body: unknown): string {
  return `"${createHash('sha256').update(JSON.stringify(body)).digest('base64url')}"`;
}

/** Whether an `If-None-Match` header names the ETag (weak comparison, RFC 9110 section 13.1.2). */
function matchesEtag(ifNoneMatch: string | null | undefined, etag: string): boolean {
  if (!ifNoneMatch) return false;
  return ifNoneMatch
    .split(',')
    .map((entry) => entry.trim().replace(/^W\//, ''))
    .some((entry) => entry === '*' || entry === etag);
}

/** A cacheable JSON resource: a card or a JWKS, with its ETag, or 304 when the client has it. */
function cacheable(
  request: A2AHttpRequest,
  body: unknown,
  headers: Record<string, string>
): A2AHttpResponse {
  const etag = etagOf(body);
  const cacheHeaders = { ...headers, ETag: etag, 'Cache-Control': CARD_CACHE_CONTROL };
  if (matchesEtag(request.header('if-none-match'), etag)) {
    return { kind: 'empty', status: 304, headers: cacheHeaders };
  }
  return json(200, body, cacheHeaders);
}

/**
 * The card of an agent in the version the client names: the A2A 1.0 card for `A2A-Version` 1.0
 * or later, else the A2A 0.3 card (with the 1.0 interfaces in `supportedInterfaces` when the
 * server speaks both). A server that speaks only one version serves its card to everyone.
 */
function serveCard(
  server: A2AServer,
  request: A2AHttpRequest,
  agentName: string | undefined
): A2AHttpResponse {
  const requested = normalizeProtocolVersion(
    requestedProtocolVersion((name) => request.header(name), request.query)
  );
  const wantsV1 = requested !== '' && !requested.startsWith('0.');
  const v1 =
    server.protocolVersions.includes('1.0') &&
    (wantsV1 || !server.protocolVersions.includes('0.3'));
  const options = { baseUrl: request.mountUrl };
  const card = v1
    ? server.getV1AgentCard(agentName, options)
    : server.getAgentCard(agentName, options);
  return cacheable(request, card, { Vary: A2A_VERSION_HEADER });
}

/** The extensions a request asks for, and the header the response names the activated ones in. */
function negotiateExtensions(
  server: A2AServer,
  request: A2AHttpRequest,
  version: A2AProtocolVersion
): { requested: string[]; headers: Record<string, string> } {
  const requested = parseExtensionsHeader(
    version === '1.0'
      ? request.header(A2A_EXTENSIONS_HEADER)
      : (request.header(LEGACY_EXTENSIONS_HEADER) ?? request.header(A2A_EXTENSIONS_HEADER))
  );
  const activated = activatedExtensions(server.getAgentExtensions(), requested);
  const header = version === '1.0' ? A2A_EXTENSIONS_HEADER : LEGACY_EXTENSIONS_HEADER;
  return { requested, headers: activated.length > 0 ? { [header]: activated.join(', ') } : {} };
}

/** Whether a body was refused for its size: `PayloadTooLargeError`, or a parser's `413` error. */
function isPayloadTooLarge(error: unknown): error is Error {
  return (
    error instanceof PayloadTooLargeError ||
    (error instanceof Error && (error as { status?: unknown }).status === 413)
  );
}

function mediaTypeOf(contentType: string): string {
  return contentType.split(';', 1)[0].trim().toLowerCase();
}

/**
 * Serve an A2A request: the Agent Cards, the JWKS, the JSON-RPC endpoints and the HTTP+JSON
 * binding, with streams as SSE. Errors before a JSON-RPC stream starts are answered as a plain
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

  if (route.kind === 'jwks') {
    const jwks = server.getJwks();
    return jwks
      ? cacheable(request, jwks, { 'Content-Type': 'application/jwk-set+json' })
      : { kind: 'pass' };
  }

  if (route.kind === 'rest') return handleRestHttp(server, request, route.path);

  if (route.agentName !== undefined && !server.hasAgent(route.agentName)) {
    return json(404, createErrorResponse(null, errors.agentNotFound(route.agentName)));
  }

  if (route.kind === 'card') return serveCard(server, request, route.agentName);

  let version: A2AProtocolVersion | undefined;
  let versionError: unknown;
  try {
    version = resolveProtocolVersion(
      requestedProtocolVersion((name) => request.header(name), request.query),
      server.protocolVersions
    );
  } catch (error) {
    versionError = error;
  }
  const rpcError = (id: string | number | null, error: errors.A2AError) =>
    createErrorResponse(
      id,
      version === '0.3' ? error.jsonRpcError : toV1JsonRpcError(error, 'A2A request')
    );

  const contentType = request.header('content-type');
  if (contentType && !contentType.toLowerCase().startsWith('application/json')) {
    return json(
      415,
      rpcError(
        null,
        new errors.A2AError(errors.invalidRequest('Content-Type must be application/json'))
      )
    );
  }

  let body: unknown;
  try {
    body = await request.readBody();
  } catch (error) {
    if (isPayloadTooLarge(error)) {
      return json(413, rpcError(null, new errors.A2AError(errors.invalidRequest(error.message))));
    }
    return json(200, rpcError(null, new errors.A2AError(errors.parseError('Invalid JSON body'))));
  }
  if (body === undefined) {
    return json(
      200,
      rpcError(
        null,
        new errors.A2AError(
          errors.parseError('Request body not parsed. Ensure body-parsing middleware is applied.')
        )
      )
    );
  }

  if (version === undefined) {
    return json(
      200,
      createErrorResponse(requestIdOf(body), toV1JsonRpcError(versionError, 'A2A-Version'))
    );
  }

  const { requested, headers } = negotiateExtensions(server, request, version);
  const authToken = server.getAuthToken((name) => request.header(name));
  const options: A2AHandleOptions = {
    ...(route.agentName !== undefined && { agentName: route.agentName }),
    ...(version === '1.0' && { protocolVersion: '1.0' as const }),
    ...(requested.length > 0 && { extensions: requested }),
    ...(version === '1.0' && { baseUrl: request.mountUrl }),
  };
  const handleOptions = Object.keys(options).length > 0 ? options : undefined;

  if (!isStreamRequest(body, version)) {
    const response = await server.handleJsonRpc(body, authToken, handleOptions);
    if (response === null) return { kind: 'empty', status: 204, headers };
    return response.error ? errorStatus(server, response, headers) : json(200, response, headers);
  }

  const stream = server.handleJsonRpcStream(body, authToken, request.signal, handleOptions);
  const first = await stream.next();
  if (first.done) return { kind: 'empty', status: 204, headers };
  if (first.value.error) {
    await stream.return(undefined);
    return errorStatus(server, first.value, headers);
  }

  const v1 = version === '1.0';
  return {
    kind: 'sse',
    headers: { ...SSE_HEADERS, ...headers },
    pipe: (write) =>
      pipeStream(server, sseFrame(first.value), stream, request.signal, write, {
        frame: sseFrame,
        failure: (error) =>
          sseFrame(
            createErrorResponse(
              null,
              v1
                ? toV1JsonRpcError(error, 'A2A stream failed')
                : errors.clientJsonRpcError(error, 'A2A stream failed')
            )
          ),
      }),
  };
}

function requestIdOf(body: unknown): string | number | null {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) return null;
  const id = (body as { id?: unknown }).id;
  return typeof id === 'string' || typeof id === 'number' ? id : null;
}

/** The `WWW-Authenticate` challenge of a 401, when the auth scheme has one. */
function challengeHeaders(server: A2AServer, status: number): Record<string, string> {
  const challenge = status === 401 ? server.authChallenge : undefined;
  return challenge ? { 'WWW-Authenticate': challenge } : {};
}

function restJson(status: number, body: unknown, headers: Record<string, string> = {}) {
  return json(status, body, { 'Content-Type': A2A_CONTENT_TYPE, ...headers });
}

/** An SSE event of the HTTP+JSON binding: the `StreamResponse` itself. */
function restFrame(event: V1StreamResponse): string {
  return `data: ${JSON.stringify(event)}\n\n`;
}

/**
 * Serve the HTTP+JSON binding: A2A 1.0 only, so a request must name `A2A-Version: 1.0`. Bodies
 * are `application/a2a+json` or `application/json`, errors `google.rpc.Status` with their HTTP
 * status, streams SSE whose events are `StreamResponse` objects.
 */
async function handleRestHttp(
  server: A2AServer,
  request: A2AHttpRequest,
  path: string
): Promise<A2AHttpResponse> {
  try {
    resolveProtocolVersion(
      requestedProtocolVersion((name) => request.header(name), request.query),
      ['1.0']
    );
  } catch (error) {
    const { status, body } = toRestError(error, 'A2A-Version');
    return restJson(status, body);
  }

  const { requested, headers } = negotiateExtensions(server, request, '1.0');
  const method = request.method.toUpperCase();
  let body: unknown;
  if (method === 'POST') {
    const contentType = request.header('content-type');
    const mediaType = contentType ? mediaTypeOf(contentType) : undefined;
    if (mediaType && mediaType !== 'application/json' && mediaType !== A2A_CONTENT_TYPE) {
      return restJson(
        415,
        restErrorBody(
          415,
          'INVALID_ARGUMENT',
          `Content-Type must be ${A2A_CONTENT_TYPE} or application/json`
        ),
        headers
      );
    }
    try {
      body = await request.readBody();
    } catch (failure) {
      if (isPayloadTooLarge(failure)) {
        return restJson(413, restErrorBody(413, 'INVALID_ARGUMENT', failure.message), headers);
      }
      const { status, body: error } = toRestError(
        new errors.A2AError(errors.parseError('Invalid JSON body')),
        'parse'
      );
      return restJson(status, error, headers);
    }
  }

  const authToken = server.getAuthToken((name) => request.header(name));
  const response = await server.handleRest({
    method,
    path,
    ...(request.query && { query: request.query }),
    ...(body !== undefined && { body }),
    ...(authToken !== undefined && { authToken }),
    extensions: requested,
    baseUrl: request.mountUrl,
    signal: request.signal,
  });

  switch (response.kind) {
    case 'empty':
      return { kind: 'empty', status: response.status, headers };
    case 'json':
      return restJson(response.status, response.body, {
        ...headers,
        ...challengeHeaders(server, response.status),
      });
    case 'stream': {
      const stream = response.events;
      let first: IteratorResult<V1StreamResponse>;
      try {
        first = await stream.next();
      } catch (error) {
        const { status, body: errorBody } = toRestError(error, 'A2A stream failed');
        return restJson(status, errorBody, { ...headers, ...challengeHeaders(server, status) });
      }
      if (first.done) return { kind: 'empty', status: 204, headers };
      return {
        kind: 'sse',
        headers: { ...SSE_HEADERS, ...headers },
        pipe: (write) =>
          pipeStream(server, restFrame(first.value), stream, request.signal, write, {
            frame: restFrame,
            failure: (error) =>
              `event: error\ndata: ${JSON.stringify(toRestError(error, 'A2A stream failed').body)}\n\n`,
          }),
      };
    }
  }
}

/**
 * Write the frames of a stream until it ends, the client disconnects or a write fails. While the
 * stream is open a heartbeat comment goes out every `server.sseHeartbeatMs`, so a run that waits
 * on a slow tool is not cut off by an idle timeout.
 */
async function pipeStream<T>(
  server: A2AServer,
  firstFrame: string,
  rest: AsyncGenerator<T>,
  signal: AbortSignal,
  write: (frame: string) => void | Promise<void>,
  format: { frame: (event: T) => string; failure: (error: unknown) => string }
): Promise<void> {
  const stopHeartbeat = startHeartbeat(() => {
    if (signal.aborted) return false;
    void Promise.resolve()
      .then(() => write(encodeHeartbeat()))
      .catch(() => undefined);
    return true;
  }, server.sseHeartbeatMs);
  try {
    await write(firstFrame);
    for await (const event of rest) {
      if (signal.aborted) return;
      await write(format.frame(event));
    }
  } catch (error) {
    if (signal.aborted) return;
    try {
      await write(format.failure(error));
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
