import { Router, raw, type Request, type Response } from 'express';
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
import type { CogitatorRequest } from '../types.js';
import { handleRouteError } from './utils.js';

function send(res: Response, answer: TriggerRouteAnswer): void {
  for (const [name, value] of Object.entries(answer.headers ?? {})) res.setHeader(name, value);
  res.status(answer.status).json(answer.body);
}

/**
 * Experimental. `POST /triggers/:id/fire` and `/webhook`, before the server's auth and JSON
 * parsing: a trigger checks its caller itself, by token or signature over the raw body
 */
export function createTriggerRoutes(host: TriggersHost): Router {
  const router = Router();
  const body = raw({ type: () => true, limit: MAX_TRIGGER_BODY_BYTES });
  for (const route of ['fire', 'webhook'] as const) {
    router.post(
      `/triggers/:id/${route}`,
      (req, res, next) => {
        body(req, res, (error?: unknown) => {
          if ((error as { type?: string } | undefined)?.type === 'entity.too.large') {
            send(res, TRIGGER_BODY_TOO_LARGE);
            return;
          }
          next(error);
        });
      },
      async (req: Request<{ id: string }>, res: Response) => {
        try {
          const rawBody = Buffer.isBuffer(req.body) ? new Uint8Array(req.body) : '';
          send(
            res,
            await handleTriggerRoute(
              host,
              route,
              req.params.id,
              triggerRequestOf({
                method: req.method,
                headers: req.headers,
                rawBody,
                query: req.query as Record<string, string | string[] | undefined>,
                ...(req.ip !== undefined && { ip: req.ip }),
              })
            )
          );
        } catch (error) {
          handleRouteError(res, error, 'Trigger error');
        }
      }
    );
  }
  return router;
}

/** Experimental. `GET /inbox` and `PATCH /inbox/:id`, behind the server's auth */
export function createInboxRoutes(host: TriggersHost): Router {
  const router = Router();
  router.get('/inbox', async (req: CogitatorRequest, res: Response) => {
    try {
      send(
        res,
        await listInboxRoute(
          host,
          req.query as Record<string, string | undefined>,
          req.cogitator?.auth?.userId
        )
      );
    } catch (error) {
      handleRouteError(res, error, 'Inbox error');
    }
  });
  router.patch('/inbox/:id', async (req: CogitatorRequest<{ id: string }>, res: Response) => {
    try {
      send(res, await patchInboxRoute(host, req.params.id, req.body, req.cogitator?.auth?.userId));
    } catch (error) {
      handleRouteError(res, error, 'Inbox error');
    }
  });
  return router;
}
