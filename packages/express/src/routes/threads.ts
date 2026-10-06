import { Router } from 'express';
import type { Response } from 'express';
import { assertThreadAccess, ensureThreadAccess } from '@cogitator-ai/core';
import { parseAddMessageRequest } from '@cogitator-ai/server-shared';
import type { RouteContext, CogitatorRequest, ThreadResponse } from '../types.js';
import { handleRouteError, sendError } from './utils.js';

export function createThreadRoutes(ctx: RouteContext): Router {
  const router = Router();

  const getMemory = () => ctx.cogitator.getMemory();

  router.get('/threads/:id', async (req: CogitatorRequest<{ id: string }>, res: Response) => {
    const memory = await getMemory();
    if (!memory) {
      sendError(res, 503, 'Memory not configured', 'UNAVAILABLE');
      return;
    }

    const { id } = req.params;
    const userId = req.cogitator?.auth?.userId;

    try {
      await assertThreadAccess(memory, id, userId);
      const result = await memory.getEntries({ threadId: id });
      if (!result.success) {
        handleRouteError(res, new Error(result.error), 'Thread get error');
        return;
      }

      const entries = result.data;
      const messages = entries.map((entry) => entry.message);
      const createdAt = entries.length > 0 ? entries[0].createdAt.getTime() : Date.now();
      const updatedAt =
        entries.length > 0 ? entries[entries.length - 1].createdAt.getTime() : Date.now();
      const response: ThreadResponse = {
        id,
        messages,
        createdAt,
        updatedAt,
      };
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
