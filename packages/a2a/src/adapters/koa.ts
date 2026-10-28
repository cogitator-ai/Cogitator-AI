import type { Middleware, Context } from 'koa';
import type { A2AServer } from '../server.js';
import { createErrorResponse } from '../json-rpc.js';
import * as errors from '../errors.js';
import { handleA2AHttp } from './shared.js';
import { isEmptyObject, readRawBody } from './body.js';

/**
 * The JSON body: what a body parser put on `ctx.request.body`, else the raw body read here (at
 * most `A2A_BODY_LIMIT` bytes), so an `application/a2a+json` body a parser skipped is read too. A
 * parser that skips a body may leave `{}` without a `rawBody`: that body is read as well.
 * Undefined without a body.
 */
async function readBody(ctx: Context): Promise<unknown> {
  const request = ctx.request as unknown as { body?: unknown; rawBody?: unknown };
  const parsed = request.body;
  const skipped = isEmptyObject(parsed) && request.rawBody === undefined;
  if (parsed !== undefined && !skipped) return parsed;
  if (ctx.req.readableEnded) return parsed;
  const text = await readRawBody(ctx.req);
  return text.trim() === '' ? undefined : (JSON.parse(text) as unknown);
}

/** Where the middleware is mounted: the part of the original path before `ctx.path` (koa-mount). */
function mountPath(ctx: Context): string {
  const original = new URL(ctx.originalUrl, 'http://localhost').pathname;
  return original.endsWith(ctx.path) ? original.slice(0, original.length - ctx.path.length) : '';
}

/**
 * Koa middleware serving an A2A server: the Agent Card at `/.well-known/agent-card.json` (and the
 * pre-v0.3 `/.well-known/agent.json`), JSON-RPC at `basePath`, every agent's own card and
 * endpoint under `<basePath>/<agent name>`, the A2A 1.0 HTTP+JSON binding under `restPath`, and
 * the JWKS at `/.well-known/jwks.json` when the server publishes one. It takes the body a body
 * parser put on `ctx.request.body`, and reads it itself when none did.
 */
export function a2aKoa(server: A2AServer): Middleware {
  return async (ctx: Context, next: () => Promise<void>) => {
    const controller = new AbortController();
    ctx.res.on('close', () => controller.abort());
    let response;
    try {
      response = await handleA2AHttp(server, {
        method: ctx.method,
        path: ctx.path,
        mountUrl: `${ctx.protocol}://${ctx.host}${mountPath(ctx)}`,
        query: new URLSearchParams(ctx.querystring),
        header: (name) => ctx.get(name) || undefined,
        readBody: () => readBody(ctx),
        signal: controller.signal,
      });
    } catch (error) {
      ctx.body = createErrorResponse(null, errors.clientJsonRpcError(error, 'A2A request failed'));
      return;
    }

    switch (response.kind) {
      case 'pass':
        await next();
        return;
      case 'json':
        ctx.status = response.status;
        ctx.set(response.headers);
        ctx.body = response.body;
        return;
      case 'empty':
        ctx.status = response.status;
        ctx.set(response.headers ?? {});
        return;
      case 'sse': {
        ctx.respond = false;
        const res = ctx.res;
        res.writeHead(200, response.headers);
        await response.pipe((frame) => {
          if (!res.writableEnded && !res.destroyed) res.write(frame);
        });
        if (!res.writableEnded) res.end();
        return;
      }
    }
  };
}
