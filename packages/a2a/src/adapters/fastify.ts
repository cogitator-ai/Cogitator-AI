import type { FastifyInstance, FastifyPluginAsync } from 'fastify';
import type { A2AServer } from '../server.js';

export function a2aFastify(server: A2AServer): FastifyPluginAsync {
  return async (fastify: FastifyInstance) => {
    fastify.get('/.well-known/agent.json', async (_request, reply) => {
      const cards = server.getAgentCards();
      return reply.send(cards.length === 1 ? cards[0] : cards);
    });

    fastify.post('/a2a', async (request, reply) => {
      const body = request.body as Record<string, unknown> | undefined;
      const isStreaming =
        request.headers.accept === 'text/event-stream' || body?.method === 'message/stream';

      if (isStreaming) {
        reply.raw.writeHead(200, {
          'Content-Type': 'text/event-stream',
          'Cache-Control': 'no-cache',
          Connection: 'keep-alive',
        });

        try {
          for await (const event of server.handleJsonRpcStream(body)) {
            reply.raw.write(`data: ${JSON.stringify(event)}\n\n`);
          }
          reply.raw.write('data: [DONE]\n\n');
        } catch (error) {
          reply.raw.write(`data: ${JSON.stringify({ error: String(error) })}\n\n`);
        }
        reply.raw.end();
        return;
      }

      const response = await server.handleJsonRpc(body);
      return reply.send(response);
    });
  };
}
