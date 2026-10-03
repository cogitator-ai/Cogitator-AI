import { Hono } from 'hono';
import type { Context } from 'hono';
import { assertThreadAccess, ensureThreadAccess } from '@cogitator-ai/core';
import { countMessageTokens } from '@cogitator-ai/memory';
import type { Message } from '@cogitator-ai/types';
import type { HonoEnv, ThreadResponse } from '../types.js';
import { errorResponse, invalidInput, invalidJson, readJsonBody } from '../utils/request.js';
import { parseAddMessageRequest } from '../utils/validation.js';

function memoryUnavailable(c: Context<HonoEnv>): Response {
  return c.json({ error: { message: 'Memory not configured', code: 'UNAVAILABLE' } }, 503);
}

export function createThreadRoutes(): Hono<HonoEnv> {
  const app = new Hono<HonoEnv>();

  app.get('/threads/:id', async (c) => {
    const memory = await c.get('cogitator').runtime.getMemory();
    if (!memory) return memoryUnavailable(c);

    const id = c.req.param('id');
    const userId = c.get('cogitatorAuth')?.userId;

    try {
      await assertThreadAccess(memory, id, userId);
      const result = await memory.getEntries({ threadId: id });
      if (!result.success) {
        return errorResponse(c, new Error(result.error), 'Thread get error');
      }

      const entries = result.data;
      const now = Date.now();
      const response: ThreadResponse = {
        id,
        messages: entries.map((entry) => entry.message),
        createdAt: entries.length > 0 ? entries[0].createdAt.getTime() : now,
        updatedAt: entries.length > 0 ? entries[entries.length - 1].createdAt.getTime() : now,
      };
      return c.json(response);
    } catch (error) {
      return errorResponse(c, error, 'Thread get error');
    }
  });

  app.post('/threads/:id/messages', async (c) => {
    const memory = await c.get('cogitator').runtime.getMemory();
    if (!memory) return memoryUnavailable(c);

    const id = c.req.param('id');

    const body = await readJsonBody(c);
    if (!body.ok) return invalidJson(c);
    const parsed = parseAddMessageRequest(body.value);
    if (!parsed.ok) return invalidInput(c, parsed.message);

    const message: Message = { role: parsed.value.role, content: parsed.value.content };
    const userId = c.get('cogitatorAuth')?.userId;

    try {
      await ensureThreadAccess(memory, id, { agentId: '', userId });
      const result = await memory.addEntry({
        threadId: id,
        message,
        tokenCount: countMessageTokens(message),
        ...(parsed.value.metadata && { metadata: parsed.value.metadata }),
      });

      if (!result.success) {
        return errorResponse(c, new Error(result.error), 'Thread add message error');
      }

      return c.json({ success: true }, 201);
    } catch (error) {
      return errorResponse(c, error, 'Thread add message error');
    }
  });

  app.delete('/threads/:id', async (c) => {
    const memory = await c.get('cogitator').runtime.getMemory();
    if (!memory) return memoryUnavailable(c);

    const id = c.req.param('id');
    const userId = c.get('cogitatorAuth')?.userId;

    try {
      await assertThreadAccess(memory, id, userId);
      const result = await memory.clearThread(id);
      if (!result.success) {
        return errorResponse(c, new Error(result.error), 'Thread delete error');
      }

      return c.body(null, 204);
    } catch (error) {
      return errorResponse(c, error, 'Thread delete error');
    }
  });

  return app;
}
