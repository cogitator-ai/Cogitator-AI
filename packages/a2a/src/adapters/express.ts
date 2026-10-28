import { Router, json, type Request, type Response, type NextFunction } from 'express';
import type { A2AServer } from '../server.js';
import { createErrorResponse } from '../json-rpc.js';
import * as errors from '../errors.js';
import { handleA2AHttp, type A2AHttpResponse } from './shared.js';
import { A2A_BODY_LIMIT, PayloadTooLargeError, isEmptyObject } from './body.js';

const parseJson = json({
  type: ['application/json', 'application/a2a+json'],
  limit: A2A_BODY_LIMIT,
});

/**
 * The JSON body: the one a body parser read (`req._body`), else parsed here (at most
 * `A2A_BODY_LIMIT` bytes). Express 4's parsers leave `{}` on a body of a type they skip, such as
 * `application/a2a+json`, without reading it: that body is read here too.
 */
function readBody(req: Request, res: Response): Promise<unknown> {
  const parsedUpstream = (req as Request & { _body?: boolean })._body === true;
  if (parsedUpstream || req.readableEnded) return Promise.resolve(req.body);
  if (req.body !== undefined && !isEmptyObject(req.body)) return Promise.resolve(req.body);
  return new Promise((resolve, reject) => {
    parseJson(req, res, (error?: unknown) => {
      if (!error) {
        resolve(req.body);
        return;
      }
      const status = (error as { status?: unknown }).status;
      reject(
        status === 413
          ? new PayloadTooLargeError(A2A_BODY_LIMIT)
          : error instanceof Error
            ? error
            : new SyntaxError(String(error))
      );
    });
  });
}

async function send(res: Response, response: A2AHttpResponse): Promise<void> {
  switch (response.kind) {
    case 'json':
      res.status(response.status).set(response.headers).json(response.body);
      return;
    case 'empty':
      res
        .status(response.status)
        .set(response.headers ?? {})
        .end();
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
 * pre-v0.3 `/.well-known/agent.json`), JSON-RPC at `basePath`, every agent's own card and
 * endpoint under `<basePath>/<agent name>`, the A2A 1.0 HTTP+JSON binding under `restPath`, and
 * the JWKS at `/.well-known/jwks.json` when the server publishes one.
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
        query: new URL(req.originalUrl, 'http://localhost').searchParams,
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
