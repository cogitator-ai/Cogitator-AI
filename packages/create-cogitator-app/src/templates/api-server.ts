import type { ProjectOptions, TemplateGenerator } from '../types.js';
import { defaultModels, providerConfig } from '../utils/providers.js';

export const apiServerTemplate: TemplateGenerator = {
  files(options: ProjectOptions) {
    const model = defaultModels[options.provider];

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
      `  model: '${model}',`,
      `  instructions: 'You are a helpful API assistant. Answer questions clearly and concisely.',`,
      `  tools: [searchTool],`,
      `  temperature: 0.7,`,
      `})`,
      ``,
      `export const coder = new Agent({`,
      `  name: 'coder',`,
      `  model: '${model}',`,
      `  instructions: 'You are an expert programmer. Write clean, well-structured code.',`,
      `  temperature: 0.3,`,
      `})`,
      ``,
    ].join('\n');

    const indexTs = [
      `import express from 'express'`,
      `import { Cogitator } from '@cogitator-ai/core'`,
      `import { CogitatorServer } from '@cogitator-ai/express'`,
      `import { assistant, coder } from './agents.js'`,
      ``,
      `const app = express()`,
      `const port = process.env.PORT || 3000`,
      ``,
      `const cogitator = new Cogitator({`,
      providerConfig(options.provider),
      `})`,
      ``,
      `const server = new CogitatorServer({`,
      `  app,`,
      `  cogitator,`,
      `  agents: { assistant, coder },`,
      `  config: {`,
      `    basePath: '/api',`,
      `    enableSwagger: true,`,
      `    cors: { origin: '*' },`,
      `    swagger: {`,
      `      title: '${options.name} API',`,
      `      version: '1.0.0',`,
      `    },`,
      `  },`,
      `})`,
      ``,
      `async function main() {`,
      `  await server.init()`,
      ``,
      `  app.listen(port, () => {`,
      `    console.log(\`Server running at http://localhost:\${port}\`)`,
      `    console.log(\`Swagger docs at http://localhost:\${port}/api/docs\`)`,
      `  })`,
      `}`,
      ``,
      `main().catch(console.error)`,
      ``,
    ].join('\n');

    return [
      { path: 'src/index.ts', content: indexTs },
      { path: 'src/agents.ts', content: agentsTs },
    ];
  },

  dependencies() {
    return {
      '@cogitator-ai/core': 'latest',
      '@cogitator-ai/express': 'latest',
      express: '^4.21.0',
      zod: '^3.23.0',
    };
  },

  devDependencies() {
    return {
      typescript: '^5.8.0',
      tsx: '^4.19.0',
      '@types/node': '^22.0.0',
      '@types/express': '^5.0.0',
    };
  },

  scripts() {
    return {
      dev: 'tsx watch src/index.ts',
      start: 'tsx src/index.ts',
      build: 'tsc',
      typecheck: 'tsc --noEmit',
    };
  },
};
