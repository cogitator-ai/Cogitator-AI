import type { Request, Response } from 'express';
import { generateSwaggerHTML, type OpenAPISpec } from '@cogitator-ai/server-shared';

export function serveSwaggerUI(spec: OpenAPISpec) {
  return (_req: Request, res: Response) => {
    res.setHeader('Content-Type', 'text/html');
    res.send(generateSwaggerHTML(spec));
  };
}
