/**
 * The Tetsu controller on Bun, grouped under /cogitator as the README shows, with the OpenAPI
 * document of `@tetsujs/openapi` at /openapi.json.
 *
 *   OPENROUTER_API_KEY=... GAUNTLET_SERVER_MODEL=openrouter/<id> bun run fixtures/servers/tetsu-bun.ts
 */
import { cogitatorController } from '@cogitator-ai/tetsu';
import { createApp, group } from '@tetsujs/core';
import { docs } from '@tetsujs/openapi';
import { announce, createFixtureRuntime } from './runtime.ts';

interface BunServer {
  port: number;
  stop(closeActiveConnections?: boolean): Promise<void>;
}
declare const Bun: {
  serve(options: object & { port: number; hostname: string }): BunServer;
};

const { cogitator, agents } = createFixtureRuntime({
  apiKey: process.env.OPENROUTER_API_KEY,
  model: process.env.GAUNTLET_SERVER_MODEL,
});

const app = createApp({
  routes: [
    group('/cogitator', { children: [cogitatorController({ cogitator, agents })] }),
    docs({ info: { title: 'Gauntlet', version: '1.0.0' } }),
  ],
  reportError: (error: unknown) => console.error('[tetsu]', error),
});

const server = Bun.serve({ ...app, port: 0, hostname: '127.0.0.1' });

const stop = async () => {
  await server.stop(true);
  await cogitator.close();
  process.exit(0);
};
process.on('SIGTERM', () => void stop());
process.on('SIGINT', () => void stop());

announce(server.port, { runtime: 'bun' });
