import { Router, json, type Request, type Response, type NextFunction } from 'express';
import type { A2AServer } from '../server.js';
import { createErrorResponse } from '../json-rpc.js';
import * as errors from '../errors.js';
import { handleA2AHttp, type A2AHttpResponse } from './shared.js';

const parseJson = json();

function readBody(req: Request, res: Response): Promise<unknown> {
  if (req.body !== undefined) return Promise.resolve(req.body);
  return new Promise((resolve, reject) => {
    parseJson(req, res, (error?: unknown) => {
      if (error) reject(error instanceof Error ? error : new SyntaxError(String(error)));
      else resolve(req.body);
    });
  });
}

async function send(res: Response, response: A2AHttpResponse): Promise<void> {
  switch (response.kind) {
    case 'json':
      res.status(response.status).set(response.headers).json(response.body);
      return;
    case 'empty':
      res.status(response.status).end();
      return;
    case 'sse':
      res.writeHead(200, response.headers);
      await response.pipe((frame) => {
        if (!res.writableEnded && !res.destroyed) res.write(frame);
      });
      if (!res.writableEnded) res.end();
      return;
    case 'pass':
      return;
  }
}

/**
 * Express router serving an A2A server: the Agent Card at `/.well-known/agent-card.json` (and the
 * pre-v0.3 `/.well-known/agent.json`), JSON-RPC at `basePath`, and every agent's own card and
 * endpoint under `<basePath>/<agent name>`.
 */
export function a2aExpress(server: A2AServer): Router {
  const router = Router();

  router.use(async (req: Request, res: Response, next: NextFunction) => {
    const controller = new AbortController();
    res.on('close', () => controller.abort());
    try {
      const response = await handleA2AHttp(server, {
        method: req.method,
        path: req.path,
        mountUrl: `${req.protocol}://${req.get('host') ?? 'localhost'}${req.baseUrl}`,
        header: (name) => req.get(name),
        readBody: () => readBody(req, res),
        signal: controller.signal,
      });
      if (response.kind === 'pass') {
        next();
        return;
      }
      await send(res, response);
    } catch (error) {
      if (res.headersSent) {
        if (!res.writableEnded) res.end();
        return;
      }
      res.json(createErrorResponse(null, errors.clientJsonRpcError(error, 'A2A request failed')));
    }
  });

  return router;
}
