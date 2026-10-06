import Router from '@koa/router';
import type { Context } from 'koa';
import type { CogitatorState, ThreadResponse } from '../types.js';
import { assertThreadAccess, ensureThreadAccess } from '@cogitator-ai/core';
import { countMessageTokens } from '@cogitator-ai/memory';
import type { Message } from '@cogitator-ai/types';
import { resolveError } from '../utils/errors.js';
import { getRequestBody } from '../utils/request.js';
import { parseAddMessageRequest } from '@cogitator-ai/server-shared';

function respondWithError(ctx: Context, error: unknown, label: string): void {
  const { status, body } = resolveError(error, label);
  ctx.status = status;
  ctx.body = body;
}

function respondMemoryUnavailable(ctx: Context): void {
  ctx.status = 503;
  ctx.body = { error: { message: 'Memory not configured', code: 'UNAVAILABLE' } };
}

export function createThreadRoutes(): Router<CogitatorState> {
  const router = new Router<CogitatorState>();

  router.get('/threads/:id', async (ctx) => {
    const memory = await ctx.state.cogitator.runtime.getMemory();
    if (!memory) {
      respondMemoryUnavailable(ctx);
      return;
    }

    const { id } = ctx.params;
    const userId = ctx.state.auth?.userId;

    try {
      await assertThreadAccess(memory, id, userId);
      const result = await memory.getEntries({ threadId: id });
      if (!result.success) {
        respondWithError(ctx, new Error(result.error), 'Thread get error');
        return;
      }

      const entries = result.data;
      const now = Date.now();
      const response: ThreadResponse = {
        id,
        messages: entries.map((entry) => entry.message),
        createdAt: entries.length > 0 ? entries[0].createdAt.getTime() : now,
        updatedAt: entries.length > 0 ? entries[entries.length - 1].createdAt.getTime() : now,
      };
      ctx.body = response;
    } catch (error) {
      respondWithError(ctx, error, 'Thread get error');
    }
  });

  router.post('/threads/:id/messages', async (ctx) => {
    const memory = await ctx.state.cogitator.runtime.getMemory();
    if (!memory) {
      respondMemoryUnavailable(ctx);
      return;
    }

    const { id } = ctx.params;
    const parsed = parseAddMessageRequest(getRequestBody(ctx), {
      roles: ctx.state.cogitator.threadMessageRoles,
    });
    if (!parsed.ok) {
      ctx.status = 400;
      ctx.body = { error: { message: parsed.message, code: 'INVALID_INPUT' } };
      return;
    }

    const message: Message = { role: parsed.value.role, content: parsed.value.content };
    const userId = ctx.state.auth?.userId;

    try {
      await ensureThreadAccess(memory, id, { agentId: '', userId });
      const result = await memory.addEntry({
        threadId: id,
        message,
        tokenCount: countMessageTokens(message),
        ...(parsed.value.metadata && { metadata: parsed.value.metadata }),
      });

      if (!result.success) {
        respondWithError(ctx, new Error(result.error), 'Thread add message error');
        return;
      }

      ctx.status = 201;
      ctx.body = { success: true };
    } catch (error) {
      respondWithError(ctx, error, 'Thread add message error');
    }
  });

  router.delete('/threads/:id', async (ctx) => {
    const memory = await ctx.state.cogitator.runtime.getMemory();
    if (!memory) {
      respondMemoryUnavailable(ctx);
      return;
    }

    const { id } = ctx.params;
    const userId = ctx.state.auth?.userId;

    try {
      await assertThreadAccess(memory, id, userId);
      const result = await memory.clearThread(id);
      if (!result.success) {
        respondWithError(ctx, new Error(result.error), 'Thread delete error');
        return;
      }
      ctx.status = 204;
    } catch (error) {
      respondWithError(ctx, error, 'Thread delete error');
    }
  });

  return router;
}
