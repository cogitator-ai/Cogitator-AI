import { Agent, agentAsTool, Cogitator, tool } from '@cogitator-ai/core';
import { WorkflowBuilder } from '@cogitator-ai/workflows';
import { z } from 'zod';
import { scripted } from './scripted-backend.js';

console.log('the fixture registry loads');

export const cogitator = new Cogitator({
  llm: { defaultModel: 'scripted/test-model', backends: { scripted } },
});

const lookupWeather = tool({
  name: 'lookup_weather',
  description: 'The weather in a city',
  parameters: z.object({ city: z.string() }),
  execute: async ({ city }) => `sunny in ${city}`,
});

const publish = tool({
  name: 'publish',
  description: 'Publish a post',
  parameters: z.object({ title: z.string() }),
  requiresApproval: true,
  execute: async ({ title }) => `published ${title}`,
});

const researcher = new Agent({
  name: 'researcher',
  description: 'Finds facts',
  model: 'scripted/test-model',
  instructions: 'Research the task.',
});

const assistant = new Agent({
  name: 'assistant',
  description: 'The fixture assistant',
  model: 'scripted/test-model',
  instructions: 'Help the user.',
  tools: [
    lookupWeather,
    publish,
    agentAsTool(cogitator, researcher, { name: 'researcher', description: 'Delegate research' }),
  ],
});

export const agents = { assistant, researcher };

type ReportState = { topic: string; draft?: string; review?: string };

const report = new WorkflowBuilder<ReportState>('report')
  .initialState({ topic: 'tides' })
  .addNode('draft', async (ctx) => ({ state: { draft: `Draft about ${ctx.state.topic}` } }))
  .addNode(
    'review',
    async (ctx) => {
      const result = await cogitator.run(researcher, { input: `review ${ctx.state.draft ?? ''}` });
      return { state: { review: result.output } };
    },
    { after: ['draft'] }
  )
  .build();

export const workflows = { report };
