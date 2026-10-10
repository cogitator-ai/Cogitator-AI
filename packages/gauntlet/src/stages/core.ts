import { Agent, CogitatorError, decisionTool, ErrorCode, tool } from '@cogitator-ai/core';
import type { DecisionUsage } from '@cogitator-ai/types';
import { z } from 'zod';
import { MATRIX_EXTRA_MODELS, modelRef } from '../llm.js';
import type { StageDefinition } from '../runner/types.js';

const CORE = '@cogitator-ai/core';
const TYPES = '@cogitator-ai/types';
const MODELS = '@cogitator-ai/models';

/** TypeSafe's Jev, a decision model on OpenRouter's Decisions API. */
const JEV = 'openrouter/typesafe/jev-1.13';

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

const triage = {
  team: {
    type: 'choice',
    instructions: 'Which support team should answer this message?',
    criteria: {
      billing: 'Payments, invoices, charges and refunds',
      technical: 'Bugs, crashes, errors and how the product works',
      sales: 'Plans, pricing and buying more seats',
    },
  },
  spam: {
    type: 'noul',
    instructions: 'Is this message spam rather than a customer writing in?',
    criteria: {
      true: 'Advertising, scams or nonsense',
      false: 'A real customer with a real question',
    },
  },
  urgency: {
    type: 'score',
    instructions: 'How urgently should the team answer it?',
    criteria: ['can wait', 'this week', 'today'],
  },
} as const;

/** A decision model answers typed questions, refuses chat, and serves an agent as a tool. */
const decisions: StageDefinition = {
  id: 'decisions',
  title: 'Decision model',
  description:
    "TypeSafe's Jev answers typed questions with probabilities through cog.decide(), refuses a chat run, and routes messages for an agent through decisionTool().",
  packages: [CORE, TYPES, MODELS],
  needs: ['handshake'],
  requires: [{ kind: 'env', name: 'OPENROUTER_API_KEY', why: 'OpenRouter Decisions API' }],
  timeoutMs: 180_000,
  async run(ctx) {
    const cog = ctx.createCogitator({
      llm: { providers: { openrouter: { apiKey: process.env.OPENROUTER_API_KEY ?? '' } } },
    });
    const decided: unknown[] = [];
    cog.observe({
      onRunComplete: (result) => {
        if (result.agentId === 'decide') decided.push(result.structured);
      },
    });
    const meter = (result: { usage: DecisionUsage }) =>
      ctx.recordUsage(JEV, {
        inputTokens: result.usage.inputTokens,
        outputTokens: result.usage.outputTokens,
        ...(result.usage.priced && { costUsd: result.usage.cost }),
      });

    await ctx.check('answers every kind of question', async (evidence) => {
      const result = await cog.decide({
        model: JEV,
        state:
          'I was charged twice for my subscription this month, please refund one of the payments.',
        questions: triage,
        signal: ctx.signal,
      });
      meter(result);
      evidence('answers', result.answers);
      evidence('usage', result.usage);
      if (result.answers.team.choice !== 'billing') {
        throw new Error(`A double charge went to ${result.answers.team.choice}`);
      }
      const { probability } = result.answers.spam;
      if (result.answers.spam.value || probability < 0 || probability > 1) {
        throw new Error(`A real customer was judged spam (p = ${probability})`);
      }
      if (!Number.isFinite(result.answers.urgency.score)) throw new Error('No urgency score');
      if (result.usage.inputTokens <= 0) throw new Error('Token usage was not reported');
    });

    await ctx.check('tells spam apart', async (evidence) => {
      const result = await cog.decide({
        model: JEV,
        state: 'BUY CHEAP WATCHES NOW!!! Best prices, click http://cheap-watches.example',
        questions: { spam: triage.spam },
        signal: ctx.signal,
      });
      meter(result);
      evidence('spam', result.answers.spam);
      if (!result.answers.spam.value) throw new Error('An advert was taken for a customer');
    });

    await ctx.check('refuses a chat run on a decision model', async (evidence) => {
      const agent = new Agent({ name: 'misrouted', model: JEV, instructions: 'Answer.' });
      try {
        await cog.run(agent, { input: 'hello' });
      } catch (error) {
        evidence('error', error instanceof Error ? error.message : String(error));
        if (
          CogitatorError.isCogitatorError(error) &&
          error.code === ErrorCode.CONFIGURATION_ERROR
        ) {
          return;
        }
        throw error;
      }
      throw new Error('A chat run on a decision model went through');
    });

    await ctx.check('an agent routes a message with decisionTool', async (evidence) => {
      const before = decided.length;
      const agent = new Agent({
        name: 'support-lead',
        model: ctx.model,
        instructions:
          'You lead a support team. Always route the message with the route_ticket tool, then say in one sentence which team takes it.',
        tools: [
          decisionTool(cog, {
            name: 'route_ticket',
            description: 'Decide which team answers a support message',
            model: JEV,
            questions: { team: triage.team },
          }),
        ],
        maxIterations: 4,
      });
      const run = await cog.run(agent, {
        input: 'A customer writes: the app crashes every time I open the settings page.',
      });
      const answers = decided.slice(before);
      evidence(
        'toolCalls',
        run.toolCalls.map((call) => call.name)
      );
      evidence('decisions', answers);
      evidence('output', run.output.slice(0, 400));
      if (!run.toolCalls.some((call) => call.name === 'route_ticket')) {
        throw new Error('The agent answered without asking the decision model');
      }
      if (answers.length === 0) throw new Error('Observers did not see the decision run');
    });
  },
};

export const coreStages: StageDefinition[] = [handshake, modelMatrix, decisions];
