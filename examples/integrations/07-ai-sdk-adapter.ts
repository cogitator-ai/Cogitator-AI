import { createCogitator, DEFAULT_MODEL, header, section } from '../_shared/setup.js';
import { Agent, calculator } from '@cogitator-ai/core';
import { cogitatorModel, fromAISDK, fromAISDKTool, toAISDKTool } from '@cogitator-ai/ai-sdk';
import { generateText, streamText, tool as aiTool } from 'ai';
import { z } from 'zod';

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

  console.log('Model spec:', model.specificationVersion);
  console.log('Result:', text);
  console.log('Tokens:', { input: usage.inputTokens, output: usage.outputTokens });

  section('2. Agent with tools (streamText)');

  const mathAgent = new Agent({
    name: 'math',
    model: DEFAULT_MODEL,
    instructions: 'Use the calculator tool for arithmetic, then answer in one sentence.',
    tools: [calculator],
    temperature: 0,
  });

  const stream = streamText({
    model: cogitatorModel(cog, mathAgent),
    prompt: 'What is 1234 * 5678?',
  });

  process.stdout.write('Streamed: ');
  for await (const chunk of stream.textStream) {
    process.stdout.write(chunk);
  }
  process.stdout.write('\n');
  for (const call of await stream.toolCalls) {
    console.log(`Agent called ${call.toolName}(${JSON.stringify(call.input)})`);
  }

  section('3. Tool conversion: Cogitator -> AI SDK');

  const aiCalculator = toAISDKTool(calculator);
  console.log('AI SDK tool description:', aiCalculator.description);

  const calculation = await aiCalculator.execute(
    { expression: '6 * 7' },
    { toolCallId: 'demo', messages: [] }
  );
  console.log('AI SDK tool result:', calculation);

  section('4. Tool conversion: AI SDK -> Cogitator');

  const greet = aiTool({
    description: 'Generate a greeting',
    inputSchema: z.object({ name: z.string() }),
    execute: async ({ name }) => `Hello, ${name}!`,
  });

  const cogTool = fromAISDKTool(greet, 'greet');
  console.log('Cogitator tool name:', cogTool.name);
  console.log('Cogitator tool schema:', JSON.stringify(cogTool.toJSON().parameters));

  section('5. fromAISDK — wrap AI SDK model for Cogitator');

  const wrappedBackend = fromAISDK(model);
  const response = await wrappedBackend.chat({
    model: 'chat',
    messages: [{ role: 'user', content: 'Name one primary color.' }],
  });
  console.log('Backend provider:', wrappedBackend.provider);
  console.log('Backend response:', response.content);

  await cog.close();
  console.log('\nDone.');
}

main();
