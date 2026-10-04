import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { Agent, Cogitator } from '@cogitator-ai/core';
import { CogitatorServer } from '@cogitator-ai/express';
import { cogitatorPlugin } from '@cogitator-ai/fastify';
import { cogitatorApp as cogitatorHonoApp } from '@cogitator-ai/hono';
import { cogitatorApp as cogitatorKoaRouter } from '@cogitator-ai/koa';
import { serve } from '@hono/node-server';
import Router from '@koa/router';
import express from 'express';
import Fastify from 'fastify';
import { Hono } from 'hono';
import Koa from 'koa';
import type { StageContext } from '../../runner/types.js';
import { SHARED_ERRORS, type ServerTarget } from './probe.js';

/** Every adapter mounts at the default base path of Express and Fastify. */
export const BASE_PATH = '/cogitator';

export interface AdapterSetup {
  cogitator: Cogitator;
  agents: Record<string, Agent>;
}

const HOST = '127.0.0.1';

function listen(server: Server, port: number): Promise<void> {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, HOST, () => {
      server.off('error', reject);
      resolve();
    });
  });
}

function closeServer(server: Server): Promise<void> {
  return new Promise((resolve) => {
    server.close(() => resolve());
    server.closeAllConnections();
  });
}

function target(label: string, port: number, openapiPath: string): ServerTarget {
  return { label, base: `http://${HOST}:${port}${BASE_PATH}`, openapiPath, dialect: SHARED_ERRORS };
}

/** `CogitatorServer` on an Express 5 app, default base path, Swagger on. */
export async function startExpress(ctx: StageContext, setup: AdapterSetup): Promise<ServerTarget> {
  const app = express();
  const server = new CogitatorServer({
    app,
    cogitator: setup.cogitator,
    agents: setup.agents,
    config: { enableSwagger: true },
  });
  await server.init();
  const port = await ctx.freePort();
  const http = createServer(app);
  await listen(http, port);
  ctx.onCleanup(() => closeServer(http));
  return target('express', port, '/openapi.json');
}

/** `cogitatorPlugin` on Fastify 5, default prefix, Swagger on (served at `/docs/json`). */
export async function startFastify(ctx: StageContext, setup: AdapterSetup): Promise<ServerTarget> {
  const app = Fastify({ logger: false });
  ctx.onCleanup(() => app.close());
  await app.register(cogitatorPlugin, {
    cogitator: setup.cogitator,
    agents: setup.agents,
    enableSwagger: true,
  });
  const port = await ctx.freePort();
  await app.listen({ port, host: HOST });
  return target('fastify', port, '/docs/json');
}

/** `cogitatorApp` mounted on a Hono app, served on Node by `@hono/node-server`. */
export async function startHonoNode(ctx: StageContext, setup: AdapterSetup): Promise<ServerTarget> {
  const app = new Hono();
  app.route(
    BASE_PATH,
    cogitatorHonoApp({ cogitator: setup.cogitator, agents: setup.agents, enableSwagger: true })
  );
  const port = await ctx.freePort();
  const server = await new Promise<ReturnType<typeof serve>>((resolve) => {
    const instance = serve({ fetch: app.fetch, port, hostname: HOST }, () => resolve(instance));
  });
  ctx.onCleanup(
    () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve());
        if ('closeAllConnections' in server) server.closeAllConnections();
      })
  );
  const address = server.address() as AddressInfo | null;
  return target('hono@node', address?.port ?? port, '/openapi.json');
}

/** `cogitatorApp` router nested under a Koa router at the base path, as the README shows. */
export async function startKoa(ctx: StageContext, setup: AdapterSetup): Promise<ServerTarget> {
  const app = new Koa();
  const main = new Router();
  const api = cogitatorKoaRouter({
    cogitator: setup.cogitator,
    agents: setup.agents,
    enableSwagger: true,
  });
  main.use(BASE_PATH, api.routes(), api.allowedMethods());
  app.use(main.routes());
  app.use(main.allowedMethods());
  const port = await ctx.freePort();
  const server = createServer(app.callback());
  await listen(server, port);
  ctx.onCleanup(() => closeServer(server));
  return target('koa', port, '/openapi.json');
}
