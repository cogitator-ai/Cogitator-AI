/**
 * The Hono adapter on Bun, mounted at /cogitator as the README shows, served by `Bun.serve`.
 *
 *   OPENROUTER_API_KEY=... GAUNTLET_SERVER_MODEL=openrouter/<id> bun run fixtures/servers/hono-bun.ts
 */
import { cogitatorApp } from '@cogitator-ai/hono';
import { Hono } from 'hono';
import { announce, createFixtureRuntime } from './runtime.ts';

interface BunServer {
  port: number;
  stop(closeActiveConnections?: boolean): Promise<void>;
}
declare const Bun: {
  serve(options: {
    fetch: (request: Request) => Response | Promise<Response>;
    port: number;
    hostname: string;
  }): BunServer;
};

const { cogitator, agents } = createFixtureRuntime({
  apiKey: process.env.OPENROUTER_API_KEY,
  model: process.env.GAUNTLET_SERVER_MODEL,
});

const app = new Hono();
app.route('/cogitator', cogitatorApp({ cogitator, agents, enableSwagger: true }));

const server = Bun.serve({ fetch: app.fetch, port: 0, hostname: '127.0.0.1' });

const stop = async () => {
  await server.stop(true);
  await cogitator.close();
  process.exit(0);
};
process.on('SIGTERM', () => void stop());
process.on('SIGINT', () => void stop());

announce(server.port, { runtime: 'bun' });
