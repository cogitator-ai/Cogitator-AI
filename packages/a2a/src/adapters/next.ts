import type { A2AServer } from '../server.js';

interface NextRequest {
  json(): Promise<unknown>;
  headers: Headers;
}

export function a2aNext(server: A2AServer) {
  return {
    async GET(): Promise<Response> {
      const cards = server.getAgentCards();
      return Response.json(cards.length === 1 ? cards[0] : cards);
    },

    async POST(request: NextRequest): Promise<Response> {
      const body = (await request.json()) as Record<string, unknown> | undefined;
      const isStreaming =
        request.headers.get('accept') === 'text/event-stream' || body?.method === 'message/stream';

      if (isStreaming) {
        const encoder = new TextEncoder();
        const stream = new ReadableStream({
          async start(controller) {
            try {
              for await (const event of server.handleJsonRpcStream(body)) {
                controller.enqueue(encoder.encode(`data: ${JSON.stringify(event)}\n\n`));
              }
              controller.enqueue(encoder.encode('data: [DONE]\n\n'));
            } catch (error) {
              controller.enqueue(
                encoder.encode(`data: ${JSON.stringify({ error: String(error) })}\n\n`)
              );
            }
            controller.close();
          },
        });

        return new Response(stream, {
          headers: {
            'Content-Type': 'text/event-stream',
            'Cache-Control': 'no-cache',
            Connection: 'keep-alive',
          },
        });
      }

      const response = await server.handleJsonRpc(body);
      return Response.json(response);
    },
  };
}
