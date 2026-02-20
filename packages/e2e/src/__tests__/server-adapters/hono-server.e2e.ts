import { Hono } from 'hono';
import { serve } from '@hono/node-server';
import type { AddressInfo } from 'net';
import type { Server } from 'http';
import { cogitatorApp } from '@cogitator-ai/hono';
import { describeServerAdapter, type ServerFactory } from '../../helpers/server-test-utils';

let httpServer: Server;

const factory: ServerFactory = {
  async start(cogitator, agents) {
    const app = cogitatorApp({
      cogitator,
      agents,
      enableSwagger: false,
    });

    const root = new Hono();
    root.route('/cogitator', app);

    httpServer = serve({ fetch: root.fetch, port: 0 });
    const addr = httpServer.address() as AddressInfo;
    return { port: addr.port };
  },
  async stop() {
    return new Promise((resolve) => {
      httpServer?.close(() => resolve());
    });
  },
};

describeServerAdapter('Hono', factory);
