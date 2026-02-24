import { Router, json, type Request, type Response } from 'express';
import type { A2AServer } from '../server.js';
import { createErrorResponse } from '../json-rpc.js';
import * as errors from '../errors.js';

export function a2aExpress(server: A2AServer): Router {
  const router = Router();

  router.get('/.well-known/agent.json', (_req: Request, res: Response) => {
    const cards = server.getAgentCards();
    res.json(cards.length === 1 ? cards[0] : cards);
  });

  router.post('/a2a', json(), async (req: Request, res: Response) => {
    const contentType = req.headers['content-type'];
    if (contentType && !contentType.includes('application/json')) {
      res.json(createErrorResponse(null, errors.contentTypeNotSupported(contentType)));
      return;
    }

    const body = req.body;
    const isStreaming =
      req.headers.accept?.includes('text/event-stream') || body?.method === 'message/stream';

    if (isStreaming) {
      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        Connection: 'keep-alive',
      });

      try {
        for await (const event of server.handleJsonRpcStream(body)) {
          if (res.writableEnded) break;
          res.write(`data: ${JSON.stringify(event)}\n\n`);
        }
        if (!res.writableEnded) res.write('data: [DONE]\n\n');
      } catch (error) {
        if (!res.writableEnded) {
          res.write(`data: ${JSON.stringify({ error: String(error) })}\n\n`);
        }
      }
      if (!res.writableEnded) res.end();
      return;
    }

    try {
      const response = await server.handleJsonRpc(body);
      res.json(response);
    } catch (error) {
      res.json(createErrorResponse(null, errors.internalError(String(error))));
    }
  });

  return router;
}
