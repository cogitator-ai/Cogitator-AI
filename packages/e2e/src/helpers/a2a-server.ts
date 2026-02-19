import express, { type Router } from 'express';
import http from 'node:http';
import { A2AServer } from '@cogitator-ai/a2a';
import { a2aExpress } from '@cogitator-ai/a2a/express';
import type { A2AServerConfig } from '@cogitator-ai/a2a';

export interface TestA2AServer {
  server: A2AServer;
  httpServer: http.Server;
  url: string;
  close: () => Promise<void>;
}

export async function startTestA2AServer(config: A2AServerConfig): Promise<TestA2AServer> {
  const a2aServer = new A2AServer(config);
  const app = express();
  const router = a2aExpress(a2aServer) as unknown as Router;
  app.use(router);

  return new Promise((resolve) => {
    const httpServer = app.listen(0, () => {
      const addr = httpServer.address();
      const port = typeof addr === 'object' && addr ? addr.port : 0;
      const url = `http://localhost:${port}`;

      resolve({
        server: a2aServer,
        httpServer,
        url,
        close: () => new Promise<void>((res) => httpServer.close(() => res())),
      });
    });
  });
}
