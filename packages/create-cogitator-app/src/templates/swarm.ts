import type { ProjectOptions, TemplateGenerator } from '../types.js';
import { defaultModels, providerConfig } from '../utils/providers.js';

export const swarmTemplate: TemplateGenerator = {
  files(options: ProjectOptions) {
    const model = defaultModels[options.provider];

    const researcherTs = [
      `import { Agent } from '@cogitator-ai/core'`,
      `import { searchTool } from '../tools.js'`,
      ``,
      `export const researcher = new Agent({`,
      `  name: 'researcher',`,
      `  model: '${model}',`,
      `  instructions: [`,
      `    'You are a research specialist.',`,
      `    'Use the search tool to find information.',`,
      `    'Provide detailed, factual findings.',`,
      `  ].join(' '),`,
      `  tools: [searchTool],`,
      `  temperature: 0.3,`,
      `})`,
      ``,
    ].join('\n');

    const writerTs = [
      `import { Agent } from '@cogitator-ai/core'`,
      ``,
      `export const writer = new Agent({`,
      `  name: 'writer',`,
      `  model: '${model}',`,
      `  instructions: [`,
      `    'You are a skilled content writer.',`,
      `    'Take research findings and craft well-structured, engaging content.',`,
      `    'Focus on clarity and readability.',`,
      `  ].join(' '),`,
      `  temperature: 0.8,`,
      `})`,
      ``,
    ].join('\n');

    const reviewerTs = [
      `import { Agent } from '@cogitator-ai/core'`,
      ``,
      `export const reviewer = new Agent({`,
      `  name: 'reviewer',`,
      `  model: '${model}',`,
      `  instructions: [`,
      `    'You are a meticulous content reviewer.',`,
      `    'Check for accuracy, grammar, and overall quality.',`,
      `    'Provide constructive feedback.',`,
      `  ].join(' '),`,
      `  temperature: 0.2,`,
      `})`,
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
      `    query: z.string().describe('Search query'),`,
      `  }),`,
      `  execute: async ({ query }) => {`,
      `    return \`Research findings for "\${query}": Cogitator is a production-grade AI agent runtime for TypeScript that supports swarms, workflows, and tool execution.\``,
      `  },`,
      `})`,
      ``,
    ].join('\n');

    const indexTs = [
      `import { Cogitator } from '@cogitator-ai/core'`,
      `import { Swarm } from '@cogitator-ai/swarms'`,
      `import { researcher } from './agents/researcher.js'`,
      `import { writer } from './agents/writer.js'`,
      `import { reviewer } from './agents/reviewer.js'`,
      ``,
      `const cogitator = new Cogitator({`,
      providerConfig(options.provider),
      `})`,
      ``,
      `const team = new Swarm(cogitator, {`,
      `  name: '${options.name}-team',`,
      `  strategy: 'hierarchical',`,
      `  supervisor: reviewer,`,
      `  workers: [researcher, writer],`,
      `  hierarchical: {`,
      `    coordination: {`,
      `      visibility: 'full',`,
      `      workerCommunication: true,`,
      `      maxParallelTasks: 2,`,
      `    },`,
      `  },`,
      `  resources: {`,
      `    maxConcurrency: 3,`,
      `    timeout: 120000,`,
      `  },`,
      `})`,
      ``,
      `async function main() {`,
      `  console.log('Starting swarm...')`,
      ``,
      `  const result = await team.run({`,
      `    input: 'Write a comprehensive article about AI agent orchestration.',`,
      `  })`,
      ``,
      `  console.log('Result:', result.output)`,
      `  console.log('Strategy:', result.strategy)`,
      ``,
      `  await team.close()`,
      `}`,
      ``,
      `main().catch(console.error)`,
      ``,
    ].join('\n');

    return [
      { path: 'src/index.ts', content: indexTs },
      { path: 'src/tools.ts', content: toolsTs },
      { path: 'src/agents/researcher.ts', content: researcherTs },
      { path: 'src/agents/writer.ts', content: writerTs },
      { path: 'src/agents/reviewer.ts', content: reviewerTs },
    ];
  },

  dependencies() {
    return {
      '@cogitator-ai/core': 'latest',
      '@cogitator-ai/swarms': 'latest',
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
