import type { ProjectOptions, TemplateGenerator } from '../types.js';
import { modelFor, providerConfig } from '../utils/providers.js';
import { cogitatorVersion, ZOD_VERSION } from './versions.js';
import {
  envHelperFiles,
  envHelperImport,
  RUN_MAIN,
  scriptTemplateDevDependencies,
  scriptTemplateScripts,
  tsString,
} from './shared.js';

/** Where the generated server mounts the Cogitator routes. */
const BASE_PATH = '/api';

/** Routes under BASE_PATH that answer without API_TOKEN: health probes and the API docs. */
const PUBLIC_PATHS = ['/health', '/ready', '/docs', '/openapi.json'];

export const apiServerTemplate: TemplateGenerator = {
  memoryAdapter: 'memory',
  secrets: ['API_TOKEN'],

  healthPath: `${BASE_PATH}/health`,

  files(options: ProjectOptions) {
    const model = modelFor(options);

    const agentsTs = [
      `import { Agent, tool } from '@cogitator-ai/core'`,
      `import { z } from 'zod'`,
      ``,
      `const searchTool = tool({`,
      `  name: 'search',`,
      `  description: 'Search for information',`,
      `  parameters: z.object({`,
      `    query: z.string().describe('Search query'),`,
      `  }),`,
      `  execute: async ({ query }) => {`,
      `    return \`Results for: \${query}\``,
      `  },`,
      `})`,
      ``,
      `export const assistant = new Agent({`,
      `  name: 'assistant',`,
      `  model: ${tsString(model)},`,
      `  instructions: 'You are a helpful API assistant. Answer questions clearly and concisely.',`,
      `  tools: [searchTool],`,
      `  temperature: 0.7,`,
      `})`,
      ``,
      `export const coder = new Agent({`,
      `  name: 'coder',`,
      `  model: ${tsString(model)},`,
      `  instructions: 'You are an expert programmer. Write clean, well-structured code.',`,
      `  temperature: 0.3,`,
      `})`,
      ``,
    ].join('\n');

    const indexTs = [
      `import { timingSafeEqual } from 'node:crypto'`,
      `import express, { type Request } from 'express'`,
      `import { Cogitator } from '@cogitator-ai/core'`,
      `import { CogitatorServer } from '@cogitator-ai/express'`,
      `import { assistant, coder } from './agents.js'`,
      ...envHelperImport(options.provider),
      ``,
      `const production = process.env.NODE_ENV === 'production'`,
      `const port = Number(process.env.PORT ?? 3000)`,
      `const host = process.env.HOST ?? (production ? '0.0.0.0' : '127.0.0.1')`,
      `const apiToken = process.env.API_TOKEN`,
      `const corsOrigin = process.env.CORS_ORIGIN`,
      `const publicPaths = new Set([${PUBLIC_PATHS.map(tsString).join(', ')}])`,
      ``,
      `function hasToken(header: string | undefined): boolean {`,
      `  if (!apiToken || !header) return false`,
      `  const expected = Buffer.from(\`Bearer \${apiToken}\`)`,
      `  const given = Buffer.from(header)`,
      `  return given.length === expected.length && timingSafeEqual(given, expected)`,
      `}`,
      ``,
      `function authenticate(req: Request) {`,
      `  if (!apiToken || publicPaths.has(req.path)) return undefined`,
      `  if (!hasToken(req.get('authorization'))) throw new Error('Unauthorized')`,
      `  return { userId: 'api-token' }`,
      `}`,
      ``,
      `const app = express()`,
      ``,
      `const cogitator = new Cogitator({`,
      providerConfig(options.provider, 'requireEnv'),
      `  memory: { adapter: 'memory' },`,
      `})`,
      ``,
      `const server = new CogitatorServer({`,
      `  app,`,
      `  cogitator,`,
      `  agents: { assistant, coder },`,
      `  config: {`,
      `    basePath: '${BASE_PATH}',`,
      `    enableSwagger: true,`,
      `    auth: authenticate,`,
      `    ...(corsOrigin ? { cors: { origin: corsOrigin.split(',').map((o) => o.trim()) } } : {}),`,
      `    swagger: {`,
      `      title: ${tsString(`${options.name} API`)},`,
      `      version: '1.0.0',`,
      `    },`,
      `  },`,
      `})`,
      ``,
      `async function main() {`,
      `  if (production && !apiToken) {`,
      `    throw new Error('Set API_TOKEN in production: it guards every route except health and docs')`,
      `  }`,
      ``,
      `  await server.init()`,
      ``,
      `  app.listen(port, host, () => {`,
      `    console.log(\`Server running at http://\${host}:\${port}\`)`,
      `    console.log(\`Swagger docs at http://\${host}:\${port}${BASE_PATH}/docs\`)`,
      `    if (!apiToken) console.log('API_TOKEN is not set, so the API is open to anyone who can reach it')`,
      `  })`,
      `}`,
      ``,
      ...RUN_MAIN,
    ].join('\n');

    return [
      { path: 'src/index.ts', content: indexTs },
      { path: 'src/agents.ts', content: agentsTs },
      ...envHelperFiles(options.provider),
    ];
  },

  dependencies() {
    return {
      '@cogitator-ai/core': cogitatorVersion('@cogitator-ai/core'),
      '@cogitator-ai/express': cogitatorVersion('@cogitator-ai/express'),
      express: '^5.2.1',
      zod: ZOD_VERSION,
    };
  },

  devDependencies() {
    return {
      ...scriptTemplateDevDependencies(),
      '@types/express': '^5.0.6',
    };
  },

  scripts() {
    return scriptTemplateScripts();
  },
};
