import type { ProjectOptions, TemplateGenerator } from '../types.js';
import { defaultModels, providerConfig } from '../utils/providers.js';

export const memoryTemplate: TemplateGenerator = {
  files(options: ProjectOptions) {
    const model = defaultModels[options.provider];

    const indexTs = [
      `import { Cogitator, Agent } from '@cogitator-ai/core'`,
      `import { searchTool, noteTool } from './tools.js'`,
      ``,
      `const cogitator = new Cogitator({`,
      providerConfig(options.provider),
      `  memory: {`,
      `    adapter: 'redis',`,
      `    redis: { url: process.env.REDIS_URL || 'redis://localhost:6379' },`,
      `  },`,
      `})`,
      ``,
      `const agent = new Agent({`,
      `  name: '${options.name}-agent',`,
      `  model: '${model}',`,
      `  instructions: [`,
      `    'You are an AI assistant with persistent memory.',`,
      `    'You remember past conversations and user preferences.',`,
      `    'Use the note tool to save important information.',`,
      `  ].join(' '),`,
      `  tools: [searchTool, noteTool],`,
      `  temperature: 0.7,`,
      `})`,
      ``,
      `async function main() {`,
      `  const threadId = 'demo-thread'`,
      ``,
      `  const result1 = await cogitator.run(agent, {`,
      `    input: 'My name is Alex and I prefer TypeScript.',`,
      `    threadId,`,
      `    useMemory: true,`,
      `  })`,
      `  console.log('Response 1:', result1.output)`,
      ``,
      `  const result2 = await cogitator.run(agent, {`,
      `    input: 'What is my name and preferred language?',`,
      `    threadId,`,
      `    useMemory: true,`,
      `  })`,
      `  console.log('Response 2:', result2.output)`,
      ``,
      `  await cogitator.close()`,
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
      `  description: 'Search for information',`,
      `  parameters: z.object({`,
      `    query: z.string().describe('Search query'),`,
      `  }),`,
      `  execute: async ({ query }) => {`,
      `    return \`Results for: \${query}\``,
      `  },`,
      `})`,
      ``,
      `export const noteTool = tool({`,
      `  name: 'note',`,
      `  description: 'Save a note for later reference',`,
      `  parameters: z.object({`,
      `    title: z.string().describe('Note title'),`,
      `    content: z.string().describe('Note content'),`,
      `  }),`,
      `  execute: async ({ title, content }) => {`,
      `    return \`Saved note "\${title}": \${content}\``,
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
      '@cogitator-ai/memory': 'latest',
      '@cogitator-ai/redis': 'latest',
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
