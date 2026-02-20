import { createCogitator, DEFAULT_MODEL, header, section } from '../_shared/setup.js';
import { Agent, tool } from '@cogitator-ai/core';
import { cogitatorModel, fromAISDK, toAISDKTool, fromAISDKTool } from '@cogitator-ai/ai-sdk';
import { generateText } from 'ai';
import { z } from 'zod';

const calculator = tool({
  name: 'calculator',
  description: 'Evaluate a math expression',
  parameters: z.object({
    expression: z.string().describe('Math expression to evaluate'),
  }),
  execute: async ({ expression }) => {
    const result = new Function(`return (${expression})`)() as number;
    return { expression, result };
  },
});

async function main() {
  header('07 — Vercel AI SDK Adapter');

  const cog = createCogitator();

  section('1. Cogitator as AI SDK provider (generateText)');

  const chatAgent = new Agent({
    name: 'chat',
    model: DEFAULT_MODEL,
    instructions: 'You are a helpful assistant. Be concise, answer in one sentence.',
    temperature: 0.3,
  });

  const model = cogitatorModel(cog, chatAgent);

  const { text, usage } = await generateText({
    model,
    prompt: 'What is the capital of France?',
  });

  console.log('Result:', text);
  console.log('Tokens:', usage);

  section('2. Tool conversion: Cogitator -> AI SDK');

  const aiTool = toAISDKTool(calculator);
  console.log('AI SDK tool description:', aiTool.description);
  console.log('Has execute:', typeof aiTool.execute === 'function');

  section('3. Tool conversion: AI SDK -> Cogitator');

  const aiStyleTool = {
    name: 'greet',
    description: 'Generate a greeting',
    parameters: z.object({
      name: z.string(),
    }),
    execute: async (params: { name: string }) => {
      return `Hello, ${params.name}!`;
    },
  };

  const cogTool = fromAISDKTool(aiStyleTool, 'greet');
  console.log('Cogitator tool name:', cogTool.name);
  console.log('Cogitator tool description:', cogTool.description);

  section('4. fromAISDK — wrap AI SDK model for Cogitator');

  const wrappedBackend = fromAISDK(model);
  console.log('Backend provider:', wrappedBackend.provider);
  console.log(
    '(Use this backend with new Agent({ backend: wrappedBackend }) for nested providers)'
  );

  await cog.close();
  console.log('\nDone.');
}

main();
