import { Hono } from 'hono';
import { streamSSE } from 'hono/streaming';
import type { A2AServer } from '../server.js';
import { createErrorResponse } from '../json-rpc.js';
import * as errors from '../errors.js';

export function a2aHono(server: A2AServer): Hono {
  const app = new Hono();

  app.get('/.well-known/agent.json', (c) => {
    const cards = server.getAgentCards();
    return c.json(cards.length === 1 ? cards[0] : cards);
  });

  app.post('/a2a', async (c) => {
    const contentType = c.req.header('content-type');
    if (contentType && !contentType.includes('application/json')) {
      return c.json(createErrorResponse(null, errors.contentTypeNotSupported(contentType)));
    }

    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return c.json(createErrorResponse(null, errors.parseError('Invalid JSON body')));
    }

    const isStreaming =
      c.req.header('accept')?.includes('text/event-stream') ||
      (body as Record<string, unknown>)?.method === 'message/stream';

    if (isStreaming) {
      return streamSSE(c, async (stream) => {
        try {
          for await (const event of server.handleJsonRpcStream(body)) {
            await stream.writeSSE({ data: JSON.stringify(event) });
          }
          await stream.writeSSE({ data: '[DONE]' });
        } catch (error) {
          await stream.writeSSE({ data: JSON.stringify({ error: String(error) }) });
        }
      });
    }

    try {
      const response = await server.handleJsonRpc(body);
      return c.json(response);
    } catch (error) {
      return c.json(createErrorResponse(null, errors.internalError(String(error))));
    }
  });

  return app;
}
