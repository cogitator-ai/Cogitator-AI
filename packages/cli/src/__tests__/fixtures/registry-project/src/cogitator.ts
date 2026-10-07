import { Agent, Cogitator, tool } from '@cogitator-ai/core';
import type { SwarmConfig, Workflow } from '@cogitator-ai/types';
import { z } from 'zod';

console.log('the registry prints while it loads');

const lookup = tool({
  name: 'lookup',
  description: 'Look up a word',
  parameters: z.object({ word: z.string() }),
  execute: async ({ word }) => word,
});

const publish = tool({
  name: 'publish',
  description: 'Publish the draft',
  parameters: z.object({ title: z.string() }),
  requiresApproval: true,
  execute: async ({ title }) => `published ${title}`,
});

export const cogitator = new Cogitator({ llm: { defaultModel: 'openai/gpt-6.1-sol' } });

const assistant = new Agent({
  name: 'assistant',
  description: 'Answers questions',
  instructions: 'Answer briefly.',
  tools: [lookup, publish],
});
const writer = new Agent({
  name: 'writer',
  model: 'anthropic/claude-sonnet-5-5',
  instructions: 'Write.',
});

export const agents = { assistant, writer };

const report: Workflow = {
  name: 'report',
  initialState: {},
  nodes: new Map([
    ['draft', { name: 'draft', fn: async () => ({}) }],
    ['review', { name: 'review', fn: async () => ({}) }],
  ]),
  edges: [{ type: 'sequential', from: 'draft', to: 'review' }],
  entryPoint: 'draft',
};

export const workflows = { report };

export const swarms = {
  panel: { name: 'panel', strategy: 'debate', agents: [assistant, writer], moderator: writer },
} satisfies Record<string, SwarmConfig>;
