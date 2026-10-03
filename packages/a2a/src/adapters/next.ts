import type { A2AServer } from '../server.js';
import { createErrorResponse } from '../json-rpc.js';
import * as errors from '../errors.js';
import { isStreamRequest, pipeJsonRpcStream, SSE_HEADERS } from './shared.js';

export function a2aNext(server: A2AServer) {
  return {
    async GET(): Promise<Response> {
      const cards = server.getAgentCards();
      return Response.json(cards.length === 1 ? cards[0] : cards);
    },

    async POST(request: Request): Promise<Response> {
      const contentType = request.headers.get('content-type');
      if (contentType && !contentType.startsWith('application/json')) {
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

      const authToken = server.getAuthToken((name) => request.headers.get(name));

      if (isStreamRequest(body)) {
        const encoder = new TextEncoder();
        const controller = new AbortController();
        const abort = () => controller.abort();
        request.signal?.addEventListener('abort', abort, { once: true });

        const stream = new ReadableStream<Uint8Array>({
          async start(streamController) {
            await pipeJsonRpcStream(server, body, authToken, controller.signal, (frame) => {
              streamController.enqueue(encoder.encode(frame));
            });
            request.signal?.removeEventListener('abort', abort);
            try {
              streamController.close();
            } catch {
              return;
            }
          },
          cancel() {
            controller.abort();
          },
        });

        return new Response(stream, { headers: SSE_HEADERS });
      }

      try {
        const response = await server.handleJsonRpc(body, authToken);
        if (response === null) {
          return new Response(null, { status: 204 });
        }
        return Response.json(response);
      } catch (error) {
        return Response.json(
          createErrorResponse(null, errors.clientJsonRpcError(error, 'A2A request failed'))
        );
      }
    },
  };
}
