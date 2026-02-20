import express from 'express';
import type { AddressInfo } from 'net';
import type { Server } from 'http';
import { CogitatorServer } from '@cogitator-ai/express';
import { describeServerAdapter, type ServerFactory } from '../../helpers/server-test-utils';

let httpServer: Server;

const factory: ServerFactory = {
  async start(cogitator, agents) {
    const app = express();
    const server = new CogitatorServer({
      app,
      cogitator,
      agents,
      config: { basePath: '/cogitator', enableSwagger: false },
    });
    await server.init();

    return new Promise((resolve) => {
      httpServer = app.listen(0, () => {
        const addr = httpServer.address() as AddressInfo;
        resolve({ port: addr.port });
      });
    });
  },
  async stop() {
    return new Promise((resolve) => {
      httpServer?.close(() => resolve());
    });
  },
};

describeServerAdapter('Express', factory);
