import Router from '@koa/router';
import type { Context } from 'koa';
import type { CogitatorState, ThreadResponse } from '../types.js';
import { assertThreadAccess, ensureThreadAccess } from '@cogitator-ai/core';
import { countMessageTokens } from '@cogitator-ai/memory';
import type { Message } from '@cogitator-ai/types';
import { invalidInput, respondWithError, sendError } from '../utils/errors.js';
import { getRequestBody, refuseThread } from '../utils/request.js';
import {
  parseAddMessageRequest,
  parseThreadPageQuery,
  readThreadPage,
} from '@cogitator-ai/server-shared';

function respondMemoryUnavailable(ctx: Context): void {
  sendError(ctx, { status: 503, code: 'UNAVAILABLE', message: 'Memory not configured' });
}

/** Answers the refusal `authorizeThread` gives the thread, and says whether there was one */
async function threadRefused(ctx: Context, threadId: string): Promise<boolean> {
  const refusal = await refuseThread(ctx, threadId);
  if (refusal) sendError(ctx, refusal);
  return refusal !== undefined;
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
    const page = parseThreadPageQuery(ctx.query);
    if (!page.ok) {
      invalidInput(ctx, page.message);
      return;
    }
    if (await threadRefused(ctx, id)) return;

    const userId = ctx.state.auth?.userId;

    try {
      const thread = await assertThreadAccess(memory, id, userId);
      const response: ThreadResponse = await readThreadPage(memory, id, page.value, thread);
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
      invalidInput(ctx, parsed.message);
      return;
    }
    if (await threadRefused(ctx, id)) return;

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
    if (await threadRefused(ctx, id)) return;

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
