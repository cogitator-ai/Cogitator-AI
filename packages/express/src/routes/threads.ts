import { Router } from 'express';
import type { Response } from 'express';
import type {
  RouteContext,
  CogitatorRequest,
  ThreadResponse,
  AddMessageRequest,
} from '../types.js';

export function createThreadRoutes(ctx: RouteContext): Router {
  const router = Router();

  const getMemory = () => {
    return ctx.cogitator.memory;
  };

  router.get('/threads/:id', async (req: CogitatorRequest, res: Response) => {
    const memory = getMemory();
    if (!memory) {
      res.status(503).json({
        error: { message: 'Memory not configured', code: 'UNAVAILABLE' },
      });
      return;
    }

    const { id } = req.params;

    try {
      const result = await memory.getEntries({ threadId: id });
      if (!result.success) {
        res.status(500).json({
          error: { message: result.error, code: 'INTERNAL' },
        });
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
      const message = error instanceof Error ? error.message : 'Unknown error';
      res.status(500).json({
        error: { message, code: 'INTERNAL' },
      });
    }
  });

  router.post('/threads/:id/messages', async (req: CogitatorRequest, res: Response) => {
    const memory = getMemory();
    if (!memory) {
      res.status(503).json({
        error: { message: 'Memory not configured', code: 'UNAVAILABLE' },
      });
      return;
    }

    const { id } = req.params;
    const body = req.body as AddMessageRequest;

    if (!body?.role || !body?.content) {
      res.status(400).json({
        error: { message: 'Missing required fields: role, content', code: 'INVALID_INPUT' },
      });
      return;
    }

    try {
      const result = await memory.addEntry({
        threadId: id,
        message: {
          role: body.role,
          content: body.content,
        },
        tokenCount: 0,
      });

      if (!result.success) {
        res.status(500).json({
          error: { message: result.error, code: 'INTERNAL' },
        });
        return;
      }

      res.status(201).json({ success: true });
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown error';
      res.status(500).json({
        error: { message, code: 'INTERNAL' },
      });
    }
  });

  router.delete('/threads/:id', async (req: CogitatorRequest, res: Response) => {
    const memory = getMemory();
    if (!memory) {
      res.status(503).json({
        error: { message: 'Memory not configured', code: 'UNAVAILABLE' },
      });
      return;
    }

    const { id } = req.params;

    try {
      const result = await memory.clearThread(id);
      if (!result.success) {
        res.status(500).json({
          error: { message: result.error, code: 'INTERNAL' },
        });
        return;
      }
      res.status(204).end();
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown error';
      res.status(500).json({
        error: { message, code: 'INTERNAL' },
      });
    }
  });

  return router;
}
