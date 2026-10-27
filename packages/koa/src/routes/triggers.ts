import Router from '@koa/router';
import type { Context, Middleware } from 'koa';
import {
  MAX_TRIGGER_BODY_BYTES,
  TRIGGER_BODY_TOO_LARGE,
  handleTriggerRoute,
  listInboxRoute,
  patchInboxRoute,
  triggerRequestOf,
  type TriggerRouteAnswer,
  type TriggersHost,
  type AnonymousPolicy,
} from '@cogitator-ai/server-shared';
import type { CogitatorState } from '../types.js';
import { isBodyConsumed, readRawBody } from '../middleware/body-parser.js';
import { respondWithError } from '../utils/errors.js';
import { getRequestBody } from '../utils/request.js';

function send(ctx: Context, answer: TriggerRouteAnswer): void {
  ctx.status = answer.status;
  ctx.set(answer.headers ?? {});
  ctx.type = 'application/json';
  ctx.body = JSON.stringify(answer.body);
}

/**
 * The body as the client sent it. A body parser upstream of the router that read it first leaves
 * only the text it kept as `rawBody`, if any
 */
async function rawBodyOf(ctx: Context): Promise<string | Uint8Array> {
  if (!isBodyConsumed(ctx)) return new Uint8Array(await readRawBody(ctx, MAX_TRIGGER_BODY_BYTES));
  const kept = (ctx.request as Context['request'] & { rawBody?: unknown }).rawBody;
  return typeof kept === 'string' ? kept : '';
}

/**
 * Experimental. `POST /triggers/:id/fire` and `/webhook`, before the router's auth and JSON body
 * parsing: a trigger checks its caller itself, by token or signature over the raw body
 */
export function createTriggerRoutes(
  host: TriggersHost,
  errorHandler: Middleware
): Router<CogitatorState> {
  const router = new Router<CogitatorState>();
  for (const route of ['fire', 'webhook'] as const) {
    router.post(`/triggers/:id/${route}`, errorHandler, async (ctx) => {
      let rawBody: string | Uint8Array;
      try {
        rawBody = await rawBodyOf(ctx);
      } catch (error) {
        if ((error as { status?: unknown } | null)?.status !== 413) throw error;
        send(ctx, TRIGGER_BODY_TOO_LARGE);
        return;
      }
      send(
        ctx,
        await handleTriggerRoute(
          host,
          route,
          ctx.params.id,
          triggerRequestOf({
            method: ctx.method,
            headers: ctx.headers,
            rawBody,
            query: ctx.query,
            ip: ctx.ip,
          })
        )
      );
    });
  }
  return router;
}

/** Experimental. `GET /inbox` and `PATCH /inbox/:id`, behind the router's auth */
export function createInboxRoutes(
  host: TriggersHost,
  anonymous?: AnonymousPolicy
): Router<CogitatorState> {
  const router = new Router<CogitatorState>();
  router.get('/inbox', async (ctx) => {
    try {
      const query = Object.fromEntries(
        Object.entries(ctx.query).map(([key, value]) => [
          key,
          Array.isArray(value) ? value[0] : value,
        ])
      );
      send(ctx, await listInboxRoute(host, query, ctx.state.auth?.userId, anonymous));
    } catch (error) {
      respondWithError(ctx, error, 'Inbox error');
    }
  });
  router.patch('/inbox/:id', async (ctx) => {
    try {
      send(
        ctx,
        await patchInboxRoute(
          host,
          ctx.params.id,
          getRequestBody(ctx),
          ctx.state.auth?.userId,
          anonymous
        )
      );
    } catch (error) {
      respondWithError(ctx, error, 'Inbox error');
    }
  });
  return router;
}
