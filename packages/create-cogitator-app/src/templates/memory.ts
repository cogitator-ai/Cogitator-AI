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

export const memoryTemplate: TemplateGenerator = {
  memoryAdapter: 'redis',

  files(options: ProjectOptions) {
    const model = modelFor(options);

    const indexTs = [
      `import { Cogitator, Agent } from '@cogitator-ai/core'`,
      `import { searchTool, noteTool } from './tools.js'`,
      ...envHelperImport(options.provider),
      ``,
      `const cogitator = new Cogitator({`,
      providerConfig(options.provider, 'requireEnv'),
      `  memory: {`,
      `    adapter: 'redis',`,
      `    redis: { url: process.env.REDIS_URL || 'redis://localhost:6379' },`,
      `  },`,
      `})`,
      ``,
      `const agent = new Agent({`,
      `  name: ${tsString(`${options.name}-agent`)},`,
      `  model: ${tsString(model)},`,
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
      `  try {`,
      `    const result1 = await cogitator.run(agent, {`,
      `      input: 'My name is Alex and I prefer TypeScript.',`,
      `      threadId,`,
      `      useMemory: true,`,
      `    })`,
      `    console.log('Response 1:', result1.output)`,
      ``,
      `    const result2 = await cogitator.run(agent, {`,
      `      input: 'What is my name and preferred language?',`,
      `      threadId,`,
      `      useMemory: true,`,
      `    })`,
      `    console.log('Response 2:', result2.output)`,
      `  } finally {`,
      `    await cogitator.close()`,
      `  }`,
      `}`,
      ``,
      ...RUN_MAIN,
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
      ...envHelperFiles(options.provider),
    ];
  },

  dependencies() {
    return {
      '@cogitator-ai/core': cogitatorVersion('@cogitator-ai/core'),
      '@cogitator-ai/memory': cogitatorVersion('@cogitator-ai/memory'),
      '@cogitator-ai/redis': cogitatorVersion('@cogitator-ai/redis'),
      zod: ZOD_VERSION,
    };
  },

  devDependencies() {
    return scriptTemplateDevDependencies();
  },

  scripts() {
    return scriptTemplateScripts();
  },
};
