import { Router } from 'express';
import type { Response } from 'express';
import { assertThreadAccess, ensureThreadAccess } from '@cogitator-ai/core';
import {
  parseAddMessageRequest,
  parseThreadPageQuery,
  readThreadPage,
} from '@cogitator-ai/server-shared';
import type { RouteContext, CogitatorRequest, ThreadResponse } from '../types.js';
import { admitThread, handleRouteError, sendError } from './utils.js';

export function createThreadRoutes(ctx: RouteContext): Router {
  const router = Router();

  const getMemory = () => ctx.cogitator.getMemory();

  router.get('/threads/:id', async (req: CogitatorRequest<{ id: string }>, res: Response) => {
    const memory = await getMemory();
    if (!memory) {
      sendError(res, 503, 'Memory not configured', 'UNAVAILABLE');
      return;
    }

    const page = parseThreadPageQuery(req.query);
    if (!page.ok) {
      sendError(res, 400, page.message, 'INVALID_INPUT');
      return;
    }

    const { id } = req.params;
    const userId = req.cogitator?.auth?.userId;

    if (!(await admitThread(ctx, req, res, id, 'Thread get error'))) return;

    try {
      const thread = await assertThreadAccess(memory, id, userId);
      const response: ThreadResponse = await readThreadPage(memory, id, page.value, thread);
      res.json(response);
    } catch (error) {
      handleRouteError(res, error, 'Thread get error');
    }
  });

  router.post(
    '/threads/:id/messages',
    async (req: CogitatorRequest<{ id: string }>, res: Response) => {
      const memory = await getMemory();
      if (!memory) {
        sendError(res, 503, 'Memory not configured', 'UNAVAILABLE');
        return;
      }

      const { id } = req.params;
      const parsed = parseAddMessageRequest(req.body, { roles: ctx.config.threadMessageRoles });
      if (!parsed.ok) {
        sendError(res, 400, parsed.message, 'INVALID_INPUT');
        return;
      }
      const body = parsed.value;

      const userId = req.cogitator?.auth?.userId;

      if (!(await admitThread(ctx, req, res, id, 'Thread add message error'))) return;

      try {
        await ensureThreadAccess(memory, id, { agentId: '', userId });
        const result = await memory.addEntry({
          threadId: id,
          message: {
            role: body.role,
            content: body.content,
          },
          tokenCount: 0,
          metadata: body.metadata,
        });

        if (!result.success) {
          handleRouteError(res, new Error(result.error), 'Thread add message error');
          return;
        }

        res.status(201).json({ success: true });
      } catch (error) {
        handleRouteError(res, error, 'Thread add message error');
      }
    }
  );

  router.delete('/threads/:id', async (req: CogitatorRequest<{ id: string }>, res: Response) => {
    const memory = await getMemory();
    if (!memory) {
      sendError(res, 503, 'Memory not configured', 'UNAVAILABLE');
      return;
    }

    const { id } = req.params;
    const userId = req.cogitator?.auth?.userId;

    if (!(await admitThread(ctx, req, res, id, 'Thread delete error'))) return;

    try {
      await assertThreadAccess(memory, id, userId);
      const result = await memory.clearThread(id);
      if (!result.success) {
        handleRouteError(res, new Error(result.error), 'Thread delete error');
        return;
      }
      res.status(204).end();
    } catch (error) {
      handleRouteError(res, error, 'Thread delete error');
    }
  });

  return router;
}
