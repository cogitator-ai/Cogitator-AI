import { Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import {
  MAX_TRIGGER_BODY_BYTES,
  TRIGGER_BODY_TOO_LARGE,
  handleTriggerRoute,
  listInboxRoute,
  patchInboxRoute,
  triggerRequestOf,
  type TriggerRouteAnswer,
  type TriggersHost,
} from '@cogitator-ai/server-shared';
import type { HonoEnv } from '../types.js';
import { bodyRefused, errorResponse, readJsonBody } from '../utils/request.js';

function send(answer: TriggerRouteAnswer): Response {
  return new Response(JSON.stringify(answer.body), {
    status: answer.status,
    headers: { 'Content-Type': 'application/json', ...answer.headers },
  });
}

/**
 * Experimental. `POST /triggers/:id/fire` and `/webhook`, before the app's body limit and auth:
 * a trigger checks its caller itself, by token or signature over the raw body
 */
export function createTriggerRoutes(host: TriggersHost): Hono<HonoEnv> {
  const app = new Hono<HonoEnv>();
  const limit = bodyLimit({
    maxSize: MAX_TRIGGER_BODY_BYTES,
    onError: () => send(TRIGGER_BODY_TOO_LARGE),
  });
  for (const route of ['fire', 'webhook'] as const) {
    app.post(`/triggers/:id/${route}`, limit, async (c) => {
      try {
        const rawBody = new Uint8Array(await c.req.arrayBuffer());
        return send(
          await handleTriggerRoute(
            host,
            route,
            c.req.param('id'),
            triggerRequestOf({
              method: c.req.method,
              headers: Object.fromEntries(c.req.raw.headers),
              rawBody,
              query: c.req.query(),
            })
          )
        );
      } catch (error) {
        return errorResponse(c, error, 'Trigger error');
      }
    });
  }
  return app;
}

/** Experimental. `GET /inbox` and `PATCH /inbox/:id`, behind the app's auth */
export function createInboxRoutes(host: TriggersHost): Hono<HonoEnv> {
  const app = new Hono<HonoEnv>();
  app.get('/inbox', async (c) => {
    try {
      return send(await listInboxRoute(host, c.req.query(), c.get('cogitatorAuth')?.userId));
    } catch (error) {
      return errorResponse(c, error, 'Inbox error');
    }
  });
  app.patch('/inbox/:id', async (c) => {
    const body = await readJsonBody(c);
    if (!body.ok) return bodyRefused(c, body.refusal);
    try {
      return send(
        await patchInboxRoute(host, c.req.param('id'), body.value, c.get('cogitatorAuth')?.userId)
      );
    } catch (error) {
      return errorResponse(c, error, 'Inbox error');
    }
  });
  return app;
}
