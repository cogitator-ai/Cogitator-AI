import type { ProjectOptions, TemplateGenerator } from '../types.js';
import { defaultModels, providerConfig } from '../utils/providers.js';

export const workflowTemplate: TemplateGenerator = {
  files(options: ProjectOptions) {
    const model = defaultModels[options.provider];

    const agentsTs = [
      `import { Agent } from '@cogitator-ai/core'`,
      ``,
      `export const analyzer = new Agent({`,
      `  name: 'analyzer',`,
      `  model: '${model}',`,
      `  instructions: 'You analyze input data and extract key information. Be thorough and structured.',`,
      `  temperature: 0.3,`,
      `})`,
      ``,
      `export const processor = new Agent({`,
      `  name: 'processor',`,
      `  model: '${model}',`,
      `  instructions: 'You process analyzed data and transform it into actionable insights.',`,
      `  temperature: 0.5,`,
      `})`,
      ``,
      `export const formatter = new Agent({`,
      `  name: 'formatter',`,
      `  model: '${model}',`,
      `  instructions: 'You format processed data into a clean, readable report.',`,
      `  temperature: 0.7,`,
      `})`,
      ``,
    ].join('\n');

    const indexTs = [
      `import { Cogitator } from '@cogitator-ai/core'`,
      `import {`,
      `  WorkflowBuilder,`,
      `  WorkflowExecutor,`,
      `  agentNode,`,
      `  functionNode,`,
      `} from '@cogitator-ai/workflows'`,
      `import { analyzer, processor, formatter } from './agents.js'`,
      ``,
      `const cogitator = new Cogitator({`,
      providerConfig(options.provider),
      `})`,
      ``,
      `interface WorkflowState {`,
      `  input: string`,
      `  analysis?: string`,
      `  processed?: string`,
      `  report?: string`,
      `}`,
      ``,
      `const analyzeNode = agentNode<WorkflowState>(analyzer, {`,
      `  inputMapper: (state) => \`Analyze the following: \${state.input}\`,`,
      `  stateMapper: (result) => ({ analysis: result.output }),`,
      `})`,
      ``,
      `const processNode = agentNode<WorkflowState>(processor, {`,
      `  inputMapper: (state) => \`Process this analysis: \${state.analysis ?? ''}\`,`,
      `  stateMapper: (result) => ({ processed: result.output }),`,
      `})`,
      ``,
      `const formatNode = agentNode<WorkflowState>(formatter, {`,
      `  inputMapper: (state) => \`Format this into a report: \${state.processed ?? ''}\`,`,
      `  stateMapper: (result) => ({ report: result.output }),`,
      `})`,
      ``,
      `const outputNode = functionNode<WorkflowState>(`,
      `  'output',`,
      `  async (state) => state.report,`,
      `)`,
      ``,
      `const workflow = new WorkflowBuilder<WorkflowState>('${options.name}-workflow')`,
      `  .initialState({ input: '' })`,
      `  .entryPoint(analyzeNode.name)`,
      `  .addNode(analyzeNode.name, analyzeNode.fn)`,
      `  .addNode(processNode.name, processNode.fn, { after: [analyzeNode.name] })`,
      `  .addNode(formatNode.name, formatNode.fn, { after: [processNode.name] })`,
      `  .addNode(outputNode.name, outputNode.fn, { after: [formatNode.name] })`,
      `  .build()`,
      ``,
      `async function main() {`,
      `  const executor = new WorkflowExecutor(cogitator)`,
      ``,
      `  console.log('Starting workflow...')`,
      ``,
      `  const result = await executor.execute(workflow, {`,
      `    input: 'Analyze the current state of AI agent frameworks and their adoption in enterprise.',`,
      `  })`,
      ``,
      `  console.log('Workflow completed!')`,
      `  console.log('Result:', JSON.stringify(result, null, 2))`,
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
      '@cogitator-ai/workflows': 'latest',
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
