import { createCogitator, DEFAULT_MODEL, header } from '../_shared/setup.js';
import { Agent, tool } from '@cogitator-ai/core';
import { createOpenAIServer } from '@cogitator-ai/openai-compat';
import OpenAI from 'openai';
import { z } from 'zod';

const PORT = 8080;

const multiply = tool({
  name: 'multiply',
  description: 'Multiply two numbers',
  parameters: z.object({
    a: z.number().describe('First factor'),
    b: z.number().describe('Second factor'),
  }),
  execute: async ({ a, b }) => ({ a, b, product: a * b }),
});

const mathHelper = new Agent({
  name: 'math-helper',
  model: DEFAULT_MODEL,
  instructions:
    'You are a math helper. Use the multiply tool for products and get_unit_price for prices. Be concise.',
  tools: [multiply],
});

const getUnitPrice: OpenAI.ChatCompletionTool = {
  type: 'function',
  function: {
    name: 'get_unit_price',
    description: 'Get the unit price in USD of a product from the client catalog',
    parameters: {
      type: 'object',
      properties: { product: { type: 'string' } },
      required: ['product'],
    },
  },
};

async function main() {
  header('06 - OpenAI-Compatible Server');

  const cog = createCogitator();

  const server = createOpenAIServer(cog, {
    port: PORT,
    agents: { 'math-helper': mathHelper },
    logging: false,
  });

  await server.start();

  console.log();
  console.log('Test with curl:');
  console.log();
  console.log(`  curl ${server.getBaseUrl()}/models`);
  console.log(
    `  curl ${server.getBaseUrl()}/chat/completions -H 'Content-Type: application/json' \\`
  );
  console.log(
    `    -d '{"model":"math-helper","messages":[{"role":"user","content":"What is 6 * 7?"}]}'`
  );
  console.log();
  console.log('Or use the OpenAI SDK (demo below):');
  console.log();

  try {
    await demoOpenAIClient(server.getBaseUrl());
  } finally {
    await server.stop();
    await cog.close();
  }
}

async function demoOpenAIClient(baseURL: string) {
  const client = new OpenAI({ baseURL, apiKey: 'not-needed' });

  const models = await client.models.list();
  console.log(
    'Models:',
    models.data.map((model) => model.id)
  );

  console.log('\n--- Chat Completions ---');
  const completion = await client.chat.completions.create({
    model: 'math-helper',
    messages: [{ role: 'user', content: 'What is 42 * 17?' }],
  });
  console.log('Response:', completion.choices[0].message.content);
  console.log('Tokens:', completion.usage?.total_tokens);

  console.log('\n--- Client-side function calling ---');
  const messages: OpenAI.ChatCompletionMessageParam[] = [
    { role: 'user', content: 'How much do 3 widgets cost? Look up the widget price first.' },
  ];
  let priced = await client.chat.completions.create({
    model: 'math-helper',
    messages,
    tools: [getUnitPrice],
  });
  while (priced.choices[0].finish_reason === 'tool_calls') {
    const reply = priced.choices[0].message;
    messages.push(reply);
    for (const call of reply.tool_calls ?? []) {
      if (call.type !== 'function') continue;
      console.log(`Model asked for ${call.function.name}(${call.function.arguments})`);
      messages.push({
        role: 'tool',
        tool_call_id: call.id,
        content: JSON.stringify({ currency: 'USD', unit_price: 19.99 }),
      });
    }
    priced = await client.chat.completions.create({
      model: 'math-helper',
      messages,
      tools: [getUnitPrice],
    });
  }
  console.log('Response:', priced.choices[0].message.content);

  console.log('\n--- Responses, streamed ---');
  const first = await client.responses.create({
    model: 'math-helper',
    input: 'Remember the number 12.',
  });
  const stream = client.responses.stream({
    model: 'math-helper',
    previous_response_id: first.id,
    input: 'What is that number times 3?',
  });
  stream.on('response.output_text.delta', (event) => process.stdout.write(event.delta));
  const final = await stream.finalResponse();
  console.log(`\nStatus: ${final.status}`);
}

main();
