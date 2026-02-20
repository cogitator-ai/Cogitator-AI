import Fastify, { type FastifyInstance } from 'fastify';
import type { AddressInfo } from 'net';
import { cogitatorPlugin } from '@cogitator-ai/fastify';
import { describeServerAdapter, type ServerFactory } from '../../helpers/server-test-utils';

let fastify: FastifyInstance;

const factory: ServerFactory = {
  async start(cogitator, agents) {
    fastify = Fastify({ logger: false });
    await fastify.register(cogitatorPlugin, {
      cogitator,
      agents,
      prefix: '/cogitator',
      enableSwagger: false,
    });
    await fastify.listen({ port: 0 });
    const addr = fastify.server.address() as AddressInfo;
    return { port: addr.port };
  },
  async stop() {
    await fastify?.close();
  },
};

describeServerAdapter('Fastify', factory);
