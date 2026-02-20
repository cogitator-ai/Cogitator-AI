import Koa from 'koa';
import type { AddressInfo } from 'net';
import type { Server } from 'http';
import { cogitatorApp } from '@cogitator-ai/koa';
import { describeServerAdapter, type ServerFactory } from '../../helpers/server-test-utils';

let httpServer: Server;

const factory: ServerFactory = {
  async start(cogitator, agents) {
    const koa = new Koa();
    const router = cogitatorApp({ cogitator, agents, enableSwagger: false });
    router.prefix('/cogitator');
    koa.use(router.routes());
    koa.use(router.allowedMethods());

    return new Promise((resolve) => {
      httpServer = koa.listen(0, () => {
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

describeServerAdapter('Koa', factory);
