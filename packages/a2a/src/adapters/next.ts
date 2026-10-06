import type { A2AServer } from '../server.js';
import { createErrorResponse } from '../json-rpc.js';
import * as errors from '../errors.js';
import { AGENT_CARD_PATH } from '../types.js';
import { handleA2AHttp, type A2AHttpResponse } from './shared.js';
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
      return new Response(null, { status: response.status });
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

/**
 * Next.js App Router handlers for an A2A server. Export `GET` from the route that serves
 * `/.well-known/agent-card.json` and `POST` from the route at `basePath`. In a dynamic
 * `[agent]` route they serve that agent's own card and endpoint.
 */
export function a2aNext(server: A2AServer) {
  const base = trimTrailingSlashes(server.basePath);

  const serve = async (
    request: Request,
    relativePath: string,
    method: 'GET' | 'POST'
  ): Promise<Response> => {
    const controller = new AbortController();
    request.signal?.addEventListener('abort', () => controller.abort(), { once: true });
    try {
      const response = await handleA2AHttp(server, {
        method,
        path: relativePath,
        mountUrl: new URL(request.url).origin,
        header: (name) => request.headers.get(name),
        readBody: () => request.json() as Promise<unknown>,
        signal: controller.signal,
      });
      return toResponse(response, controller);
    } catch (error) {
      return Response.json(
        createErrorResponse(null, errors.clientJsonRpcError(error, 'A2A request failed'))
      );
    }
  };

  return {
    async GET(request: Request, context?: NextRouteContext): Promise<Response> {
      const agent = await agentParam(context);
      const path = agent
        ? `${base}/${encodeURIComponent(agent)}${AGENT_CARD_PATH}`
        : AGENT_CARD_PATH;
      return serve(request, path, 'GET');
    },

    async POST(request: Request, context?: NextRouteContext): Promise<Response> {
      const agent = await agentParam(context);
      const path = agent ? `${base}/${encodeURIComponent(agent)}` : server.basePath;
      return serve(request, path, 'POST');
    },
  };
}
