import { Router, json, type Request, type Response } from 'express';
import type { A2AServer } from '../server.js';

export function a2aExpress(server: A2AServer): Router {
  const router = Router();

  router.get('/.well-known/agent.json', (_req: Request, res: Response) => {
    const cards = server.getAgentCards();
    res.json(cards.length === 1 ? cards[0] : cards);
  });

  router.post('/a2a', json(), async (req: Request, res: Response) => {
    const body = req.body;
    const isStreaming =
      req.headers.accept === 'text/event-stream' || body?.method === 'message/stream';

    if (isStreaming) {
      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        Connection: 'keep-alive',
      });

      try {
        for await (const event of server.handleJsonRpcStream(body)) {
          res.write(`data: ${JSON.stringify(event)}\n\n`);
        }
        res.write('data: [DONE]\n\n');
      } catch (error) {
        res.write(`data: ${JSON.stringify({ error: String(error) })}\n\n`);
      }
      res.end();
      return;
    }

    const response = await server.handleJsonRpc(body);
    res.json(response);
  });

  return router;
}
