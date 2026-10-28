import type { A2AServer } from '../server.js';
import { createErrorResponse } from '../json-rpc.js';
import * as errors from '../errors.js';
import { AGENT_CARD_PATH } from '../types.js';
import { handleA2AHttp, matchRoute, type A2AHttpResponse } from './shared.js';
import { trimTrailingSlashes } from '../url.js';

type RouteParams = Record<string, string | string[] | undefined>;

/** The context Next.js passes a route handler; `agent` is read from a dynamic `[agent]` segment. */
export interface NextRouteContext {
  params?: RouteParams | Promise<RouteParams>;
}

async function agentParam(context: NextRouteContext | undefined): Promise<string | undefined> {
  const params = await context?.params;
  const agent = params?.agent;
  return Array.isArray(agent) ? agent[0] : agent;
}

function toResponse(response: A2AHttpResponse, abort: AbortController): Response {
  switch (response.kind) {
    case 'json':
      return Response.json(response.body, { status: response.status, headers: response.headers });
    case 'empty':
      return new Response(null, { status: response.status, headers: response.headers });
    case 'pass':
      return Response.json(createErrorResponse(null, errors.invalidRequest('Not an A2A route')), {
        status: 404,
      });
    case 'sse': {
      const encoder = new TextEncoder();
      const stream = new ReadableStream<Uint8Array>({
        async start(controller) {
          await response.pipe((frame) => {
            if (!abort.signal.aborted) controller.enqueue(encoder.encode(frame));
          });
          try {
            controller.close();
          } catch {
            return;
          }
        },
        cancel() {
          abort.abort();
        },
      });
      return new Response(stream, { headers: response.headers });
    }
  }
}

async function readJson(request: Request): Promise<unknown> {
  const text = await request.text();
  return text.trim() === '' ? undefined : (JSON.parse(text) as unknown);
}

/**
 * Next.js App Router handlers for an A2A server. In a catch-all route that covers the server's
 * paths (e.g. `app/[[...a2a]]/route.ts` exporting `GET`, `POST` and `DELETE`) they serve every
 * route by the request path: the cards, JSON-RPC, the A2A 1.0 HTTP+JSON binding and the JWKS.
 * Exported from a route at `/.well-known/agent-card.json`, `GET` serves the card, and from the
 * route at `basePath`, `POST` serves JSON-RPC. In a dynamic `[agent]` route they serve that
 * agent's own card and endpoint.
 */
export function a2aNext(server: A2AServer) {
  const base = trimTrailingSlashes(server.basePath);

  const serve = async (
    request: Request,
    relativePath: string,
    method: 'GET' | 'POST' | 'DELETE'
  ): Promise<Response> => {
    const controller = new AbortController();
    request.signal?.addEventListener('abort', () => controller.abort(), { once: true });
    const url = new URL(request.url);
    try {
      const response = await handleA2AHttp(server, {
        method,
        path: relativePath,
        mountUrl: url.origin,
        query: url.searchParams,
        header: (name) => request.headers.get(name),
        readBody: () => readJson(request),
        signal: controller.signal,
      });
      return toResponse(response, controller);
    } catch (error) {
      return Response.json(
        createErrorResponse(null, errors.clientJsonRpcError(error, 'A2A request failed'))
      );
    }
  };

  /** The request path when it names an A2A route, the fixed path of the export otherwise. */
  const pathOf = async (
    request: Request,
    context: NextRouteContext | undefined,
    method: 'GET' | 'POST' | 'DELETE',
    fallback: string
  ): Promise<string> => {
    const agent = await agentParam(context);
    if (agent) {
      return method === 'GET'
        ? `${base}/${encodeURIComponent(agent)}${AGENT_CARD_PATH}`
        : `${base}/${encodeURIComponent(agent)}`;
    }
    const pathname = new URL(request.url).pathname;
    return matchRoute(server, method, pathname) ? pathname : fallback;
  };

  return {
    async GET(request: Request, context?: NextRouteContext): Promise<Response> {
      return serve(request, await pathOf(request, context, 'GET', AGENT_CARD_PATH), 'GET');
    },

    async POST(request: Request, context?: NextRouteContext): Promise<Response> {
      return serve(request, await pathOf(request, context, 'POST', server.basePath), 'POST');
    },

    async DELETE(request: Request): Promise<Response> {
      return serve(request, new URL(request.url).pathname, 'DELETE');
    },
  };
}
