import { Router } from 'express';
import type { Response } from 'express';
import { assertThreadAccess, ensureThreadAccess } from '@cogitator-ai/core';
import type {
  RouteContext,
  CogitatorRequest,
  ThreadResponse,
  AddMessageRequest,
} from '../types.js';
import { handleRouteError, isPlainObject, sendError } from './utils.js';

const MESSAGE_ROLES: ReadonlySet<string> = new Set(['user', 'assistant', 'system']);

function parseMessageBody(body: unknown): AddMessageRequest | null {
  if (!isPlainObject(body)) return null;
  const { role, content, metadata } = body;
  if (typeof role !== 'string' || !MESSAGE_ROLES.has(role)) return null;
  if (typeof content !== 'string' || content === '') return null;
  if (metadata !== undefined && !isPlainObject(metadata)) return null;
  return { role: role as AddMessageRequest['role'], content, metadata };
}

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
        sendError(res, 500, result.error, 'INTERNAL');
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
      const body = parseMessageBody(req.body);

      if (!body) {
        sendError(
          res,
          400,
          'Invalid message: role must be user, assistant or system and content a non-empty string',
          'INVALID_INPUT'
        );
        return;
      }

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
          sendError(res, 500, result.error, 'INTERNAL');
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
        sendError(res, 500, result.error, 'INTERNAL');
        return;
      }
      res.status(204).end();
    } catch (error) {
      handleRouteError(res, error, 'Thread delete error');
    }
  });

  return router;
}
