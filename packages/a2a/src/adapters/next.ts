import type { A2AServer } from '../server.js';
import { createErrorResponse } from '../json-rpc.js';
import * as errors from '../errors.js';

export function a2aNext(server: A2AServer) {
  return {
    async GET(): Promise<Response> {
      const cards = server.getAgentCards();
      return Response.json(cards.length === 1 ? cards[0] : cards);
    },

    async POST(request: Request): Promise<Response> {
      const contentType = request.headers.get('content-type');
      if (contentType && !contentType.includes('application/json')) {
        return Response.json(
          createErrorResponse(null, errors.contentTypeNotSupported(contentType))
        );
      }

      let body: unknown;
      try {
        body = await request.json();
      } catch {
        return Response.json(createErrorResponse(null, errors.parseError('Invalid JSON body')));
      }

      const isStreaming =
        request.headers.get('accept')?.includes('text/event-stream') ||
        (body as Record<string, unknown>)?.method === 'message/stream';

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

      try {
        const response = await server.handleJsonRpc(body);
        return Response.json(response);
      } catch (error) {
        return Response.json(createErrorResponse(null, errors.internalError(String(error))));
      }
    },
  };
}
