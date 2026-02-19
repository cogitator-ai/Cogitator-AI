import { Hono } from 'hono';
import { streamSSE } from 'hono/streaming';
import type { A2AServer } from '../server.js';

export function a2aHono(server: A2AServer): Hono {
  const app = new Hono();

  app.get('/.well-known/agent.json', (c) => {
    const cards = server.getAgentCards();
    return c.json(cards.length === 1 ? cards[0] : cards);
  });

  app.post('/a2a', async (c) => {
    const body = await c.req.json();
    const isStreaming =
      c.req.header('accept') === 'text/event-stream' || body?.method === 'message/stream';

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

    const response = await server.handleJsonRpc(body);
    return c.json(response);
  });

  return app;
}
