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

export const basicTemplate: TemplateGenerator = {
  files(options: ProjectOptions) {
    const model = modelFor(options);

    const indexTs = [
      `import { Cogitator, Agent } from '@cogitator-ai/core'`,
      `import { searchTool, summarizeTool } from './tools.js'`,
      ...envHelperImport(options.provider),
      ``,
      `const cogitator = new Cogitator({`,
      providerConfig(options.provider, 'requireEnv'),
      `})`,
      ``,
      `const agent = new Agent({`,
      `  name: ${tsString(`${options.name}-agent`)},`,
      `  model: ${tsString(model)},`,
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
      ...RUN_MAIN,
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
      ...envHelperFiles(options.provider),
    ];
  },

  dependencies() {
    return {
      '@cogitator-ai/core': cogitatorVersion('@cogitator-ai/core'),
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
