import { describe, it, expect } from 'vitest';
import { cogitatorModel } from '@cogitator-ai/ai-sdk';
import { Agent, Cogitator, tool } from '@cogitator-ai/core';
import { z } from 'zod';

const describeGoogle = process.env.GOOGLE_API_KEY ? describe : describe.skip;

const countOrders = tool({
  name: 'count_orders',
  description: 'Count the orders of a customer',
  parameters: z.object({ customer: z.string() }),
  execute: async () => ({ count: 3 }),
});

async function readAll<T>(stream: ReadableStream<T>): Promise<T[]> {
  const parts: T[] = [];
  const reader = stream.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) return parts;
    parts.push(value);
  }
}

describeGoogle('AI SDK: Cogitator agent as a model', () => {
  const cogitator = new Cogitator({
    llm: {
      defaultModel: 'google/gemini-2.5-flash',
      providers: { google: { apiKey: process.env.GOOGLE_API_KEY ?? '' } },
    },
  });
  const agent = new Agent({
    name: 'orders',
    model: 'google/gemini-2.5-flash',
    instructions:
      'Use count_orders to answer questions about orders. Say what you are about to do before calling a tool.',
    tools: [countOrders],
    temperature: 0,
  });
  const model = cogitatorModel(cogitator, agent, { specificationVersion: 'v4' });
  const ask = [
    {
      role: 'user' as const,
      content: [{ type: 'text' as const, text: 'How many orders does Alice have?' }],
    },
  ];

  it('streams only the final JSON in JSON mode, as doGenerate returns it', async () => {
    const responseFormat = {
      type: 'json' as const,
      schema: {
        type: 'object' as const,
        properties: { customer: { type: 'string' as const }, orders: { type: 'number' as const } },
        required: ['customer', 'orders'],
      },
    };

    const generated = await model.doGenerate({ prompt: ask, responseFormat });
    const { stream } = await model.doStream({ prompt: ask, responseFormat });
    const streamedText = (await readAll(stream))
      .flatMap((part) => (part.type === 'text-delta' ? [part.delta] : []))
      .join('');
    const generatedText = generated.content
      .flatMap((part) => (part.type === 'text' ? [part.text] : []))
      .join('');

    expect(JSON.parse(generatedText)).toMatchObject({ orders: 3 });
    expect(JSON.parse(streamedText)).toMatchObject({ orders: 3 });
  }, 120_000);

  it('remembers what a tool returned in an earlier turn', async () => {
    const result = await model.doGenerate({
      prompt: [
        ...ask,
        {
          role: 'assistant',
          content: [
            {
              type: 'tool-call',
              toolCallId: 'c1',
              toolName: 'count_orders',
              input: { customer: 'Alice' },
              providerExecuted: true,
            },
            {
              type: 'tool-result',
              toolCallId: 'c1',
              toolName: 'count_orders',
              output: { type: 'json', value: { count: 7 } },
            },
            { type: 'text', text: 'Alice has some orders.' },
          ],
        },
        {
          role: 'user',
          content: [
            { type: 'text', text: 'Without calling a tool: what count did count_orders return?' },
          ],
        },
      ],
      toolChoice: { type: 'none' },
    });

    const text = result.content.flatMap((part) => (part.type === 'text' ? [part.text] : []));
    expect(text.join('')).toContain('7');
  }, 120_000);
});
