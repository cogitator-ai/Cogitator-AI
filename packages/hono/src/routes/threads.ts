import { Hono } from 'hono';
import type { Context } from 'hono';
import { assertThreadAccess, ensureThreadAccess } from '@cogitator-ai/core';
import { countMessageTokens } from '@cogitator-ai/memory';
import type { Message } from '@cogitator-ai/types';
import type { HonoEnv, ThreadResponse } from '../types.js';
import {
  bodyRefused,
  errorResponse,
  invalidInput,
  readJsonBody,
  refuseThread,
  sendError,
} from '../utils/request.js';
import {
  parseAddMessageRequest,
  parseThreadPageQuery,
  readThreadPage,
} from '@cogitator-ai/server-shared';

function memoryUnavailable(c: Context<HonoEnv>): Response {
  return sendError(c, { status: 503, code: 'UNAVAILABLE', message: 'Memory not configured' });
}

export function createThreadRoutes(): Hono<HonoEnv> {
  const app = new Hono<HonoEnv>();

  app.get('/threads/:id', async (c) => {
    const memory = await c.get('cogitator').runtime.getMemory();
    if (!memory) return memoryUnavailable(c);

    const id = c.req.param('id');
    const page = parseThreadPageQuery(c.req.queries());
    if (!page.ok) return invalidInput(c, page.message);
    const refusal = await refuseThread(c, id);
    if (refusal) return sendError(c, refusal);

    const userId = c.get('cogitatorAuth')?.userId;

    try {
      const thread = await assertThreadAccess(memory, id, userId);
      const response: ThreadResponse = await readThreadPage(memory, id, page.value, thread);
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
    if (!body.ok) return bodyRefused(c, body.refusal);
    const parsed = parseAddMessageRequest(body.value, {
      roles: c.get('cogitator').threadMessageRoles,
    });
    if (!parsed.ok) return invalidInput(c, parsed.message);
    const refusal = await refuseThread(c, id);
    if (refusal) return sendError(c, refusal);

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
    const refusal = await refuseThread(c, id);
    if (refusal) return sendError(c, refusal);

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
