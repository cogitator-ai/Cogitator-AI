import { Hono } from 'hono';
import { streamSSE } from 'hono/streaming';
import type { A2AServer } from '../server.js';
import { createErrorResponse } from '../json-rpc.js';
import * as errors from '../errors.js';
import { buildSseErrorEvent } from './sse-error-event.js';
import { isStreamRequest } from './shared.js';

export function a2aHono(server: A2AServer): Hono {
  const app = new Hono();

  app.get('/.well-known/agent.json', (c) => {
    const cards = server.getAgentCards();
    return c.json(cards.length === 1 ? cards[0] : cards);
  });

  app.post(server.basePath, async (c) => {
    const contentType = c.req.header('content-type');
    if (contentType && !contentType.startsWith('application/json')) {
      return c.json(createErrorResponse(null, errors.contentTypeNotSupported(contentType)));
    }

    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return c.json(createErrorResponse(null, errors.parseError('Invalid JSON body')));
    }

    const authToken = server.getAuthToken((name) => c.req.header(name));

    if (isStreamRequest(body)) {
      c.header('X-Accel-Buffering', 'no');
      return streamSSE(c, async (stream) => {
        const controller = new AbortController();
        stream.onAbort(() => controller.abort());
        try {
          for await (const event of server.handleJsonRpcStream(
            body,
            authToken,
            controller.signal
          )) {
            if (controller.signal.aborted) return;
            await stream.writeSSE({ data: JSON.stringify(event) });
          }
          if (!controller.signal.aborted) await stream.writeSSE({ data: '[DONE]' });
        } catch (error) {
          if (controller.signal.aborted) return;
          try {
            await stream.writeSSE({ data: JSON.stringify(buildSseErrorEvent(error)) });
          } catch {
            return;
          }
        }
      });
    }

    try {
      const response = await server.handleJsonRpc(body, authToken);
      if (response === null) {
        return c.body(null, 204);
      }
      return c.json(response);
    } catch (error) {
      return c.json(
        createErrorResponse(null, errors.clientJsonRpcError(error, 'A2A request failed'))
      );
    }
  });

  return app;
}
