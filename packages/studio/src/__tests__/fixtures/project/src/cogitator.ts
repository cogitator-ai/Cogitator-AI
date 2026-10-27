import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  Agent,
  agentAsTool,
  Cogitator,
  LocalWorkspace,
  tool,
  workspaceTools,
} from '@cogitator-ai/core';
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

const confirmPlan = tool({
  name: 'confirm_plan',
  description: 'Asks the user to confirm a plan',
  parameters: z.object({ plan: z.string() }),
  execute: async ({ plan }, context) => {
    const reply = await context.interrupt!({
      reason: 'confirm_plan',
      message: `Go ahead with ${plan}?`,
      responseSchema: z.object({ ok: z.boolean() }),
    });
    return reply.ok ? `going ahead with ${plan}` : 'stopped';
  },
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
    confirmPlan,
    agentAsTool(cogitator, researcher, { name: 'researcher', description: 'Delegate research' }),
  ],
});

const publisher = new Agent({
  name: 'publisher',
  description: 'Publishes under permission rules',
  model: 'scripted/test-model',
  instructions: 'Publish what the user asks for.',
  tools: [publish],
  permissions: { mode: 'default' },
});

const workspace = new LocalWorkspace({
  root:
    process.env.STUDIO_FIXTURE_WORKSPACE ?? join(tmpdir(), 'cogitator-studio-fixture-workspace'),
});

const coder = new Agent({
  name: 'coder',
  description: 'Writes files in its workspace',
  model: 'scripted/coder',
  instructions: 'Write the files the user asks for.',
  tools: workspaceTools(undefined, { tools: ['read_file', 'write_file'] }),
  workspace,
  checkpoints: true,
});

export const agents = { assistant, researcher, publisher, coder };

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

const editor = new Agent({
  name: 'editor',
  model: 'scripted/team-lead',
  instructions: 'Lead the team.',
});

const scout = new Agent({
  name: 'scout',
  description: 'Finds facts',
  model: 'scripted/team-member',
  instructions: 'Find facts.',
});

export const swarms = {
  newsroom: {
    name: 'newsroom',
    strategy: 'team' as const,
    supervisor: editor,
    workers: [scout],
    team: { maxLeadTurns: 2, maxTurnsPerMember: 2 },
  },
};
