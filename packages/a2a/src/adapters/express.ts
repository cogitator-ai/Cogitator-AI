import { Router, json, type Request, type Response, type NextFunction } from 'express';
import type { A2AServer } from '../server.js';
import { createErrorResponse } from '../json-rpc.js';
import * as errors from '../errors.js';
import { isStreamRequest, pipeJsonRpcStream, SSE_HEADERS } from './shared.js';

export function a2aExpress(server: A2AServer): Router {
  const router = Router();

  router.get('/.well-known/agent.json', (_req: Request, res: Response) => {
    const cards = server.getAgentCards();
    res.json(cards.length === 1 ? cards[0] : cards);
  });

  router.post('/a2a', json(), async (req: Request, res: Response) => {
    const contentType = req.headers['content-type'];
    if (contentType && !contentType.startsWith('application/json')) {
      res.json(createErrorResponse(null, errors.contentTypeNotSupported(contentType)));
      return;
    }

    const body: unknown = req.body;
    const authToken = server.getAuthToken((name) => req.get(name));

    if (isStreamRequest(body)) {
      const controller = new AbortController();
      res.on('close', () => controller.abort());
      res.writeHead(200, SSE_HEADERS);

      await pipeJsonRpcStream(server, body, authToken, controller.signal, (frame) => {
        if (!res.writableEnded && !res.destroyed) res.write(frame);
      });
      if (!res.writableEnded) res.end();
      return;
    }

    try {
      const response = await server.handleJsonRpc(body, authToken);
      if (response === null) {
        res.status(204).end();
        return;
      }
      res.json(response);
    } catch (error) {
      res.json(createErrorResponse(null, errors.internalError(String(error))));
    }
  });

  router.use((err: Error, _req: Request, res: Response, next: NextFunction) => {
    if (err instanceof SyntaxError) {
      res.json(createErrorResponse(null, errors.parseError('Invalid JSON body')));
      return;
    }
    next(err);
  });

  return router;
}
