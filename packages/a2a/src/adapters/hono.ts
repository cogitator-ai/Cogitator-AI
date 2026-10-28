import { Hono, type Context } from 'hono';
import { streamSSE } from 'hono/streaming';
import type { A2AServer } from '../server.js';
import { createErrorResponse } from '../json-rpc.js';
import * as errors from '../errors.js';
import { AGENT_CARD_PATH, JWKS_PATH, LEGACY_AGENT_CARD_PATH } from '../types.js';
import { SSE_HEADERS, handleA2AHttp, mountUrlOf } from './shared.js';
import { trimTrailingSlashes } from '../url.js';

/**
 * Hono app serving an A2A server: the Agent Card at `/.well-known/agent-card.json` (and the
 * pre-v0.3 `/.well-known/agent.json`), JSON-RPC at `basePath`, every agent's own card and
 * endpoint under `<basePath>/<agent name>`, the A2A 1.0 HTTP+JSON binding under `restPath`, and
 * the JWKS at `/.well-known/jwks.json` when the server publishes one.
 */
export function a2aHono(server: A2AServer): Hono {
  const app = new Hono();

  const serve = async (c: Context, relativePath: string): Promise<Response> => {
    const controller = new AbortController();
    c.req.raw.signal.addEventListener('abort', () => controller.abort(), { once: true });
    try {
      const url = new URL(c.req.url);
      const response = await handleA2AHttp(server, {
        method: c.req.method,
        path: relativePath,
        mountUrl: mountUrlOf(url, relativePath),
        query: url.searchParams,
        header: (name) => c.req.header(name),
        readBody: async () => {
          const text = await c.req.text();
          return text.trim() === '' ? undefined : (JSON.parse(text) as unknown);
        },
        signal: controller.signal,
      });
      switch (response.kind) {
        case 'json':
          return c.json(response.body as object, response.status as 200, response.headers);
        case 'empty':
          return c.body(null, response.status as 204, response.headers);
        case 'pass':
          return c.notFound();
        case 'sse':
          for (const [name, value] of Object.entries(response.headers)) {
            if (!(name in SSE_HEADERS) || name === 'X-Accel-Buffering') c.header(name, value);
          }
          return streamSSE(c, async (stream) => {
            stream.onAbort(() => controller.abort());
            await response.pipe(async (frame) => {
              await stream.write(frame);
            });
          });
      }
    } catch (error) {
      return c.json(
        createErrorResponse(null, errors.clientJsonRpcError(error, 'A2A request failed'))
      );
    }
  };

  const base = trimTrailingSlashes(server.basePath);
  const agentPath = (c: Context) => `${base}/${encodeURIComponent(c.req.param('agent') ?? '')}`;

  app.get(AGENT_CARD_PATH, (c) => serve(c, AGENT_CARD_PATH));
  app.get(LEGACY_AGENT_CARD_PATH, (c) => serve(c, LEGACY_AGENT_CARD_PATH));
  app.get(JWKS_PATH, (c) => serve(c, JWKS_PATH));
  app.get(`${base}/:agent${AGENT_CARD_PATH}`, (c) => serve(c, `${agentPath(c)}${AGENT_CARD_PATH}`));
  app.post(server.basePath, (c) => serve(c, server.basePath));
  app.post(`${base}/:agent`, (c) => serve(c, agentPath(c)));

  const restPath = server.restPath;
  if (restPath) {
    const restPattern = `${restPath}/*`;
    app.on(['GET', 'POST', 'DELETE'], restPattern, (c) => {
      const pathname = new URL(c.req.url).pathname;
      const at = pathname.indexOf(`${restPath}/`);
      return serve(c, at >= 0 ? pathname.slice(at) : pathname);
    });
  }

  return app;
}
