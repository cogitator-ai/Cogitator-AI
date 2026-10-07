import { code, tsString } from '../code.js';
import { runScript } from '../package-manager.js';
import type { ProjectBuilder } from '../project.js';
import { hasFeature, type ProjectSpec, type ServerFramework } from '../spec.js';
import { cogitatorVersion, VERSIONS } from '../versions.js';
import { a2aMount } from './a2a.js';
import { LIFECYCLE_TS, startupImports, startupStatements } from './shared.js';
import type { FeatureModule } from './types.js';

export const SERVER_BASE_PATH = '/api';
export const SERVER_PORT = 3000;

/** The registry exports a server mounts, by whether the project has workflows and swarms. */
export function registryImports(project: ProjectBuilder): { names: string[]; options: string } {
  const workflows = project.registry.some((entry) => entry.kind === 'workflows');
  const swarms = project.registry.some((entry) => entry.kind === 'swarms');
  const names = [
    'agents',
    'cogitator',
    ...(swarms ? ['swarms'] : []),
    ...(workflows ? ['workflows'] : []),
  ];
  const options = [
    'cogitator',
    'agents',
    ...(workflows ? ['workflows'] : []),
    ...(swarms ? ['swarms'] : []),
  ].join(', ');
  return { names, options };
}

const AUTH_TS = code`
  import { timingSafeEqual } from 'node:crypto';

  /** Routes under ${SERVER_BASE_PATH} that answer without a token: health probes and the API docs. */
  const PUBLIC_PATHS = new Set(['/health', '/ready', '/docs', '/openapi.json']);

  export interface Caller {
    userId: string;
  }

  export class UnauthorizedError extends Error {
    readonly status = 401;

    constructor() {
      super('Unauthorized');
      this.name = 'UnauthorizedError';
    }
  }

  function isPublic(path: string): boolean {
    const bare = path.split('?')[0] ?? path;
    const local = bare.startsWith('${SERVER_BASE_PATH}/') ? bare.slice(${SERVER_BASE_PATH.length}) : bare;
    return PUBLIC_PATHS.has(local);
  }

  function sameToken(given: string, expected: string): boolean {
    const a = Buffer.from(given);
    const b = Buffer.from(expected);
    return a.length === b.length && timingSafeEqual(a, b);
  }

  /**
   * Who is calling. With API_TOKEN set, every route except the public ones needs
   * \`Authorization: Bearer <API_TOKEN>\`; without it (local development only) all
   * requests are one local caller. Public routes are answered for anyone.
   */
  export function authenticate(path: string, authorization: string | undefined, token: string | undefined): Caller | undefined {
    if (isPublic(path)) return undefined;
    if (!token) return { userId: 'local' };
    const given = authorization?.startsWith('Bearer ') ? authorization.slice('Bearer '.length) : undefined;
    if (!given || !sameToken(given, token)) throw new UnauthorizedError();
    return { userId: 'api' };
  }
`;

/** The settings every server reads from the environment, checked at startup. */
function settings(spec: ProjectSpec): string {
  return code`
    const env = loadEnv();
    const production = process.env.NODE_ENV === 'production';
    const port = Number(env.PORT ?? ${SERVER_PORT});
    const host = env.HOST ?? (production ? '0.0.0.0' : '127.0.0.1');

    if (production && !env.API_TOKEN) {
      throw new Error('Set API_TOKEN in production: every route except health and docs requires it');
    }
    ${spec.server !== 'tetsu' && "const corsOrigins = env.CORS_ORIGIN?.split(',').map((origin) => origin.trim()).filter(Boolean);"}
  `;
}

function listening(): string {
  return code`
    console.log(\`API on http://\${host}:\${port}${SERVER_BASE_PATH}, docs on http://\${host}:\${port}${SERVER_BASE_PATH}/docs\`);
    if (!env.API_TOKEN) console.log('API_TOKEN is not set: the API answers anyone who can reach it');
  `;
}

/** The A2A routes of a server, when the project has the a2a feature. */
function a2a(project: ProjectBuilder): { imports: string | false; mount: string | false } {
  const server = project.spec.server;
  if (!hasFeature(project.spec, 'a2a') || !server || server === 'tetsu')
    return { imports: false, mount: false };
  const { imports, mount } = a2aMount(server);
  return { imports: imports.join('\n'), mount };
}

const NODE_HTTP_CLOSE = code`
  interface Closable {
    close(callback: (error?: Error) => void): unknown;
    closeIdleConnections?: () => void;
  }

  function closeServer(server: Closable): Promise<void> {
    return new Promise((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
      server.closeIdleConnections?.();
    });
  }
`;

function honoEntry(project: ProjectBuilder): string {
  const { names, options } = registryImports(project);
  return code`
    import { serve } from '@hono/node-server';
    import { cogitatorApp } from '@cogitator-ai/hono';
    import { Hono } from 'hono';
    import { cors } from 'hono/cors';
    import { authenticate } from './auth.js';
    import { ${names.join(', ')} } from './cogitator.js';
    import { loadEnv } from './env.js';
    import { onShutdown } from './lifecycle.js';
    ${startupImports(project)}
    ${a2a(project).imports}

    ${settings(project.spec)}
    ${startupStatements(project)}

    const app = new Hono();
    if (corsOrigins?.length) app.use('${SERVER_BASE_PATH}/*', cors({ origin: corsOrigins }));
    ${a2a(project).mount}
    app.route(
      '${SERVER_BASE_PATH}',
      cogitatorApp({
        ${options},
        enableSwagger: true,
        swagger: { title: ${tsString(`${project.spec.name} API`)}, version: '0.1.0' },
        auth: (c) => authenticate(c.req.path, c.req.header('authorization'), env.API_TOKEN),
      })
    );

    const server = serve({ fetch: app.fetch, port, hostname: host }, () => {
      ${listening()}
    });

    ${NODE_HTTP_CLOSE}

    onShutdown(async () => {
      await closeServer(server);
      await cogitator.close();
    });
  `;
}

function expressEntry(project: ProjectBuilder): string {
  const { names, options } = registryImports(project);
  return code`
    import { CogitatorServer } from '@cogitator-ai/express';
    import express from 'express';
    import { authenticate } from './auth.js';
    import { ${names.join(', ')} } from './cogitator.js';
    import { loadEnv } from './env.js';
    import { onShutdown } from './lifecycle.js';
    ${startupImports(project)}
    ${a2a(project).imports}

    ${settings(project.spec)}
    ${startupStatements(project)}

    const app = express();
    ${a2a(project).mount}
    const api = new CogitatorServer({
      app,
      ${options},
      config: {
        basePath: '${SERVER_BASE_PATH}',
        enableSwagger: true,
        swagger: { title: ${tsString(`${project.spec.name} API`)}, version: '0.1.0' },
        auth: (req) => authenticate(req.path, req.get('authorization'), env.API_TOKEN),
        ...(corsOrigins?.length ? { cors: { origin: corsOrigins } } : {}),
      },
    });
    await api.init();

    const server = app.listen(port, host, () => {
      ${listening()}
    });

    ${NODE_HTTP_CLOSE}

    onShutdown(async () => {
      await closeServer(server);
      await cogitator.close();
    });
  `;
}

function fastifyEntry(project: ProjectBuilder): string {
  const { names, options } = registryImports(project);
  return code`
    import cors from '@fastify/cors';
    import { cogitatorPlugin } from '@cogitator-ai/fastify';
    import Fastify from 'fastify';
    import { authenticate } from './auth.js';
    import { ${names.join(', ')} } from './cogitator.js';
    import { loadEnv } from './env.js';
    import { onShutdown } from './lifecycle.js';
    ${startupImports(project)}
    ${a2a(project).imports}

    ${settings(project.spec)}
    ${startupStatements(project)}

    const app = Fastify({ logger: { level: production ? 'info' : 'warn' } });
    if (corsOrigins?.length) await app.register(cors, { origin: corsOrigins });
    ${a2a(project).mount}
    await app.register(cogitatorPlugin, {
      ${options},
      prefix: '${SERVER_BASE_PATH}',
      enableSwagger: true,
      swagger: { title: ${tsString(`${project.spec.name} API`)}, version: '0.1.0' },
      auth: (request) => authenticate(request.url, request.headers.authorization, env.API_TOKEN),
    });

    await app.listen({ port, host });
    ${listening()}

    onShutdown(async () => {
      await app.close();
      await cogitator.close();
    });
  `;
}

function koaEntry(project: ProjectBuilder): string {
  const { names, options } = registryImports(project);
  return code`
    import cors from '@koa/cors';
    import { cogitatorApp } from '@cogitator-ai/koa';
    import Koa from 'koa';
    import { authenticate } from './auth.js';
    import { ${names.join(', ')} } from './cogitator.js';
    import { loadEnv } from './env.js';
    import { onShutdown } from './lifecycle.js';
    ${startupImports(project)}
    ${a2a(project).imports}

    ${settings(project.spec)}
    ${startupStatements(project)}

    const app = new Koa();
    ${a2a(project).mount}
    if (corsOrigins?.length) {
      const allowed = new Set(corsOrigins);
      app.use(cors({ origin: (ctx) => (allowed.has(ctx.get('origin')) ? ctx.get('origin') : '') }));
    }

    const router = cogitatorApp({
      ${options},
      enableSwagger: true,
      swagger: { title: ${tsString(`${project.spec.name} API`)}, version: '0.1.0' },
      auth: (ctx) => authenticate(ctx.path, ctx.get('authorization'), env.API_TOKEN),
    });
    router.prefix('${SERVER_BASE_PATH}');
    app.use(router.routes()).use(router.allowedMethods());

    const server = app.listen(port, host, () => {
      ${listening()}
    });

    ${NODE_HTTP_CLOSE}

    onShutdown(async () => {
      await closeServer(server);
      await cogitator.close();
    });
  `;
}

function tetsuEntry(project: ProjectBuilder): string {
  const { names, options } = registryImports(project);
  return code`
    import { cogitatorController } from '@cogitator-ai/tetsu';
    import { createApp, group } from '@tetsujs/core';
    import { docs } from '@tetsujs/openapi';
    import { authenticate } from './auth.js';
    import { ${names.join(', ')} } from './cogitator.js';
    import { loadEnv } from './env.js';
    import { onShutdown } from './lifecycle.js';
    ${startupImports(project)}
    ${a2a(project).imports}

    ${settings(project.spec)}
    ${startupStatements(project)}

    const app = createApp({
      routes: [
        group('${SERVER_BASE_PATH}', {
          children: [
            cogitatorController({
              ${options},
              auth: (ctx) =>
                authenticate(new URL(ctx.req.url).pathname, ctx.req.headers.get('authorization') ?? undefined, env.API_TOKEN) ?? {},
            }),
            docs({ info: { title: ${tsString(`${project.spec.name} API`)}, version: '0.1.0' } }),
          ],
        }),
      ],
    });

    const server = Bun.serve({ ...app, port, hostname: host });
    ${listening()}

    onShutdown(async () => {
      await server.stop();
      await cogitator.close();
    });
  `;
}

const ENTRIES: Record<ServerFramework, (project: ProjectBuilder) => string> = {
  hono: honoEntry,
  express: expressEntry,
  fastify: fastifyEntry,
  koa: koaEntry,
  tetsu: tetsuEntry,
};

function frameworkPackages(project: ProjectBuilder, server: ServerFramework): void {
  const adapter = `@cogitator-ai/${server}` as const;
  project.dependency(adapter, cogitatorVersion(adapter));
  switch (server) {
    case 'hono':
      project
        .dependency('hono', VERSIONS.hono)
        .dependency('@hono/node-server', VERSIONS.honoNodeServer);
      break;
    case 'express':
      project
        .dependency('express', VERSIONS.express)
        .devDependency('@types/express', VERSIONS.typesExpress);
      break;
    case 'fastify':
      project
        .dependency('fastify', VERSIONS.fastify)
        .dependency('@fastify/cors', VERSIONS.fastifyCors);
      break;
    case 'koa':
      project
        .dependency('koa', VERSIONS.koa)
        .dependency('@koa/router', VERSIONS.koaRouter)
        .dependency('@koa/cors', VERSIONS.koaCors)
        .devDependency('@types/koa', VERSIONS.typesKoa)
        .devDependency('@types/koa__cors', VERSIONS.typesKoaCors);
      break;
    case 'tetsu':
      project
        .dependency('@tetsujs/core', VERSIONS.tetsuCore)
        .dependency('@tetsujs/sse', VERSIONS.tetsuSse)
        .dependency('@tetsujs/openapi', VERSIONS.tetsuOpenapi);
      break;
  }
}

export const appServerFeature: FeatureModule = {
  id: 'app:server',
  applies: (spec) => spec.app === 'server',
  apply(project) {
    const { spec } = project;
    const server = spec.server ?? 'hono';
    const bun = server === 'tetsu';

    frameworkPackages(project, server);
    project.file('src/auth.ts', AUTH_TS).file('src/lifecycle.ts', LIFECYCLE_TS);

    if (bun) {
      project.script('dev', 'bun --watch src/index.ts').script('start', 'bun src/index.ts');
    } else {
      project
        .devDependency('tsx', VERSIONS.tsx)
        .script('dev', 'tsx watch --env-file-if-exists=.env src/index.ts')
        .script('build', 'tsc -p tsconfig.build.json')
        .script('start', 'node --env-file-if-exists=.env dist/index.js');
    }

    project
      .envVar({
        name: 'PORT',
        description: 'Port the API listens on',
        example: String(SERVER_PORT),
        required: false,
        secret: false,
      })
      .envVar({
        name: 'HOST',
        description: 'Interface to listen on: 127.0.0.1 in development, 0.0.0.0 in production',
        example: '127.0.0.1',
        required: false,
        secret: false,
      })
      .envVar({
        name: 'API_TOKEN',
        description:
          'Bearer token every route except health and docs requires, mandatory in production',
        required: false,
        secret: true,
        deploy: true,
      });
    if (!bun) {
      project.envVar({
        name: 'CORS_ORIGIN',
        description:
          'Comma-separated browser origins allowed to call the API, CORS is off without it',
        example: 'http://localhost:5173',
        required: false,
        secret: false,
      });
    }

    project.deploy.kind = 'server';
    project.deploy.port = SERVER_PORT;
    project.deploy.healthPath = `${SERVER_BASE_PATH}/health`;
  },
  finalize(project) {
    const { spec } = project;
    const server = spec.server ?? 'hono';
    const pm = spec.packageManager;
    project.file('src/index.ts', ENTRIES[server](project));

    project.section(
      'Server',
      code`
        \`src/index.ts\` serves the registry over HTTP with ${server === 'tetsu' ? 'Tetsu on Bun' : server}: every agent${project.registry.some((e) => e.kind === 'workflows') ? ', workflow' : ''}${project.registry.some((e) => e.kind === 'swarms') ? ' and swarm' : ''} in \`src/cogitator.ts\` gets REST and SSE routes under \`${SERVER_BASE_PATH}\`, with OpenAPI docs at \`${SERVER_BASE_PATH}/docs\`. \`src/auth.ts\` decides who may call: with \`API_TOKEN\` set every route but health and docs needs \`Authorization: Bearer <token>\`. Start it with \`${runScript(pm, 'dev')}\` and try:

        \`\`\`bash
        curl -X POST http://localhost:${SERVER_PORT}${SERVER_BASE_PATH}/agents/assistant/run -H 'content-type: application/json' -d '{"input":"What time is it in Tokyo?"}'
        \`\`\`
      `
    );
    project.readmeSection(
      'API',
      code`
        \`${runScript(pm, 'dev')}\` starts the API on http://localhost:${SERVER_PORT}${SERVER_BASE_PATH}, with interactive docs at http://localhost:${SERVER_PORT}${SERVER_BASE_PATH}/docs.

        \`\`\`bash
        curl -X POST http://localhost:${SERVER_PORT}${SERVER_BASE_PATH}/agents/assistant/run \\
          -H 'content-type: application/json' \\
          -d '{"input":"What time is it in Tokyo?"}'
        \`\`\`

        Set \`API_TOKEN\` in \`.env\` to require \`Authorization: Bearer <token>\` on every route but health and docs. In production (\`NODE_ENV=production\`) the server refuses to start without it.
      `
    );
  },
};
