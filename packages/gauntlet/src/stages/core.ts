import { Agent, tool } from '@cogitator-ai/core';
import { z } from 'zod';
import { MATRIX_EXTRA_MODELS, modelRef } from '../llm.js';
import type { StageDefinition } from '../runner/types.js';

const CORE = '@cogitator-ai/core';
const TYPES = '@cogitator-ai/types';

/** A tool whose answer the model cannot guess, so a correct final answer proves it was called. */
const inventory = tool({
  name: 'warehouse_stock',
  description: 'Current stock of an item in the warehouse.',
  parameters: z.object({ item: z.string().describe('Item name') }),
  execute: async ({ item }) => ({ item, units: item.toLowerCase().includes('brass') ? 417 : 0 }),
});

const Stock = z.object({
  item: z.string(),
  units: z.number().int(),
  inStock: z.boolean(),
});

/** Proves the runtime reaches OpenRouter and gets a plain answer back. */
const handshake: StageDefinition = {
  id: 'handshake',
  title: 'Handshake',
  description: 'The runtime reaches OpenRouter through a custom backend and gets an answer.',
  packages: [CORE, TYPES],
  timeoutMs: 60_000,
  async run(ctx) {
    const result = await ctx.check('primary model answers', async (evidence) => {
      const agent = new Agent({
        name: 'handshake',
        model: ctx.model,
        instructions: 'Reply with exactly the single word READY and nothing else.',
        maxIterations: 1,
      });
      const run = await ctx.cogitator.run(agent, { input: 'Status?' });
      evidence('model', ctx.model);
      evidence('output', run.output);
      evidence('tokens', run.usage.totalTokens);
      if (!/ready/i.test(run.output)) throw new Error(`Unexpected answer: ${run.output}`);
      return run;
    });

    await ctx.check('run reports usage and a trace', (evidence) => {
      evidence('inputTokens', result.usage.inputTokens);
      evidence('outputTokens', result.usage.outputTokens);
      evidence('spans', result.trace.spans.length);
      if (result.usage.inputTokens <= 0 || result.usage.outputTokens <= 0) {
        throw new Error('Token usage was not reported');
      }
      if (result.trace.spans.length === 0) throw new Error('The run recorded no spans');
    });
  },
};

/** Every gauntlet model must call a tool and answer in a JSON schema. */
const modelMatrix: StageDefinition = {
  id: 'model-matrix',
  title: 'Model matrix',
  description:
    'Popular models from five vendors each call a tool and answer in a JSON schema through the same runtime.',
  packages: [CORE, TYPES],
  needs: ['handshake'],
  timeoutMs: 180_000,
  async run(ctx) {
    const models = [...new Set([...ctx.models, ...MATRIX_EXTRA_MODELS.map(modelRef)])];
    const outcomes = await Promise.allSettled(
      models.map((model) =>
        ctx.check(
          `${model.replace(/^openrouter\//, '')} uses tools and the schema`,
          async (evidence) => {
            const agent = new Agent({
              name: 'quartermaster',
              model,
              instructions:
                'You manage a warehouse. Always look stock up with the warehouse_stock tool before answering.',
              tools: [inventory],
              responseFormat: { type: 'json_schema', schema: Stock },
              maxIterations: 4,
            });
            const run = await ctx.cogitator.run(agent, {
              input: 'How many units of "brass gears" do we have, and are they in stock?',
            });
            evidence(
              'toolCalls',
              run.toolCalls.map((call) => call.name)
            );
            evidence('structured', run.structured);
            if (run.structured === undefined) evidence('output', run.output.slice(0, 400));
            if (!run.toolCalls.some((call) => call.name === 'warehouse_stock')) {
              throw new Error('The model answered without calling warehouse_stock');
            }
            const stock = Stock.parse(run.structured);
            if (stock.units !== 417 || !stock.inStock) {
              throw new Error(`Wrong answer: ${JSON.stringify(stock)}`);
            }
          }
        )
      )
    );
    const failure = outcomes.find((outcome) => outcome.status === 'rejected');
    if (failure) throw failure.reason;
  },
};

export const coreStages: StageDefinition[] = [handshake, modelMatrix];
