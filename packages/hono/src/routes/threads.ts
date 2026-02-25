import { Hono } from 'hono';
import type { Context } from 'hono';
import type { HonoEnv, ThreadResponse, AddMessageRequest } from '../types.js';

export function createThreadRoutes(): Hono<HonoEnv> {
  const app = new Hono<HonoEnv>();

  function getMemory(c: Context<HonoEnv>) {
    const ctx = c.get('cogitator');
    return ctx.runtime.memory;
  }

  app.get('/threads/:id', async (c) => {
    const memory = getMemory(c);
    if (!memory) {
      return c.json({ error: { message: 'Memory not configured', code: 'UNAVAILABLE' } }, 503);
    }

    const id = c.req.param('id');

    try {
      const result = await memory.getEntries({ threadId: id });
      if (!result.success) {
        return c.json({ error: { message: result.error, code: 'INTERNAL' } }, 500);
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
      return c.json(response);
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown error';
      return c.json({ error: { message, code: 'INTERNAL' } }, 500);
    }
  });

  app.post('/threads/:id/messages', async (c) => {
    const memory = getMemory(c);
    if (!memory) {
      return c.json({ error: { message: 'Memory not configured', code: 'UNAVAILABLE' } }, 503);
    }

    const id = c.req.param('id');

    let body: AddMessageRequest;
    try {
      body = await c.req.json<AddMessageRequest>();
    } catch {
      return c.json({ error: { message: 'Invalid JSON body', code: 'INVALID_INPUT' } }, 400);
    }

    if (!body?.role || !body?.content) {
      return c.json(
        { error: { message: 'Missing required fields: role, content', code: 'INVALID_INPUT' } },
        400
      );
    }

    try {
      const result = await memory.addEntry({
        threadId: id,
        message: { role: body.role, content: body.content },
        tokenCount: 0,
      });

      if (!result.success) {
        return c.json({ error: { message: result.error, code: 'INTERNAL' } }, 500);
      }

      return c.json({ success: true }, 201);
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown error';
      return c.json({ error: { message, code: 'INTERNAL' } }, 500);
    }
  });

  app.delete('/threads/:id', async (c) => {
    const memory = getMemory(c);
    if (!memory) {
      return c.json({ error: { message: 'Memory not configured', code: 'UNAVAILABLE' } }, 503);
    }

    const id = c.req.param('id');

    try {
      const result = await memory.clearThread(id);
      if (!result.success) {
        return c.json({ error: { message: result.error, code: 'INTERNAL' } }, 500);
      }

      return c.body(null, 204);
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown error';
      return c.json({ error: { message, code: 'INTERNAL' } }, 500);
    }
  });

  return app;
}
