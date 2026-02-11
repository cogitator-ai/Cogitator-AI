import type { ProjectOptions, TemplateGenerator } from '../types.js';
import { defaultModels, providerConfig } from '../utils/providers.js';

export const basicTemplate: TemplateGenerator = {
  files(options: ProjectOptions) {
    const model = defaultModels[options.provider];

    const indexTs = [
      `import { Cogitator, Agent } from '@cogitator-ai/core'`,
      `import { searchTool, summarizeTool } from './tools.js'`,
      ``,
      `const cogitator = new Cogitator({`,
      providerConfig(options.provider),
      `})`,
      ``,
      `const agent = new Agent({`,
      `  name: '${options.name}-agent',`,
      `  model: '${model}',`,
      `  instructions: 'You are a helpful AI assistant. Use your tools to help the user.',`,
      `  tools: [searchTool, summarizeTool],`,
      `  temperature: 0.7,`,
      `})`,
      ``,
      `async function main() {`,
      `  const result = await cogitator.run(agent, {`,
      `    input: 'What is Cogitator and how does it work?',`,
      `  })`,
      ``,
      `  console.log(result.output)`,
      `}`,
      ``,
      `main().catch(console.error)`,
      ``,
    ].join('\n');

    const toolsTs = [
      `import { tool } from '@cogitator-ai/core'`,
      `import { z } from 'zod'`,
      ``,
      `export const searchTool = tool({`,
      `  name: 'search',`,
      `  description: 'Search for information on a topic',`,
      `  parameters: z.object({`,
      `    query: z.string().describe('The search query'),`,
      `  }),`,
      `  execute: async ({ query }) => {`,
      `    return \`Search results for: \${query}\\n\\nCogitator is a self-hosted AI agent runtime for TypeScript.\``,
      `  },`,
      `})`,
      ``,
      `export const summarizeTool = tool({`,
      `  name: 'summarize',`,
      `  description: 'Summarize a piece of text',`,
      `  parameters: z.object({`,
      `    text: z.string().describe('The text to summarize'),`,
      `    maxLength: z.number().optional().describe('Maximum summary length'),`,
      `  }),`,
      `  execute: async ({ text, maxLength }) => {`,
      `    const limit = maxLength || 200`,
      `    return text.length > limit ? text.slice(0, limit) + '...' : text`,
      `  },`,
      `})`,
      ``,
    ].join('\n');

    return [
      { path: 'src/index.ts', content: indexTs },
      { path: 'src/tools.ts', content: toolsTs },
    ];
  },

  dependencies() {
    return {
      '@cogitator-ai/core': 'latest',
      zod: '^3.23.0',
    };
  },

  devDependencies() {
    return {
      typescript: '^5.8.0',
      tsx: '^4.19.0',
      '@types/node': '^22.0.0',
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
