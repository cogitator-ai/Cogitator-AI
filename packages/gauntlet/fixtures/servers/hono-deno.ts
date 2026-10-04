/**
 * The Hono adapter on Deno, served by `Deno.serve` as the README shows. Run with only network
 * and environment access, as the README promises is enough:
 *
 *   deno run --no-prompt --allow-net --allow-env=OPENROUTER_API_KEY,GAUNTLET_SERVER_MODEL fixtures/servers/hono-deno.ts
 */
import { cogitatorApp } from '@cogitator-ai/hono';
import { Hono } from 'hono';
import { announce, createFixtureRuntime } from './runtime.ts';

interface DenoServer {
  shutdown(): Promise<void>;
}
declare const Deno: {
  env: { get(name: string): string | undefined };
  serve(
    options: { port: number; hostname: string; onListen(address: { port: number }): void },
    handler: (request: Request) => Response | Promise<Response>
  ): DenoServer;
  addSignalListener(signal: 'SIGTERM' | 'SIGINT', handler: () => void): void;
  exit(code: number): never;
};

const { cogitator, agents } = createFixtureRuntime({
  apiKey: Deno.env.get('OPENROUTER_API_KEY'),
  model: Deno.env.get('GAUNTLET_SERVER_MODEL'),
});

const app = new Hono();
app.route('/cogitator', cogitatorApp({ cogitator, agents, enableSwagger: true }));

const server = Deno.serve(
  {
    port: 0,
    hostname: '127.0.0.1',
    onListen: ({ port }) => announce(port, { runtime: 'deno' }),
  },
  app.fetch
);

const stop = async () => {
  await server.shutdown();
  await cogitator.close();
  Deno.exit(0);
};
Deno.addSignalListener('SIGTERM', () => void stop());
Deno.addSignalListener('SIGINT', () => void stop());
