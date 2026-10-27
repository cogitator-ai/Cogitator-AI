import { Agent, Cogitator, tool } from '@cogitator-ai/core';
import type { InboxWriter, RoutineWorkflow } from '@cogitator-ai/types';
import { z } from 'zod';
import { scripted } from '../../project/src/scripted-backend.js';

let reviewInbox: InboxWriter | undefined;

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

const assistant = new Agent({
  name: 'assistant',
  description: 'Does what routines ask',
  model: 'scripted/test-model',
  instructions: 'Do the task.',
  tools: [publish, confirmPlan],
});

const review: RoutineWorkflow = {
  name: 'review',
  async run(context) {
    reviewInbox = context.inbox;
    await context.inbox.add({
      kind: 'approval',
      title: 'Review needs approval',
      summary: 'Approve the review to ship it',
      routineId: context.routine.id,
      triggerId: context.event.triggerId,
      triggerEventId: context.event.id,
      runId: context.runId,
      approvalId: `review_${context.runId}`,
    });
    return { status: 'waiting' };
  },
  async respond(approvalId, decision) {
    await reviewInbox?.add({
      kind: 'result',
      title: 'Review answered',
      summary: `${approvalId}: ${String(decision)}`,
      routineId: 'review',
    });
  },
};

export const cogitator = new Cogitator({
  llm: { defaultModel: 'scripted/test-model', backends: { scripted } },
  experimental_triggers: {
    agents: { assistant },
    workflows: { review },
    pollInterval: 50,
    routines: [
      {
        id: 'digest',
        name: 'Daily digest',
        prompt: 'Summarize the news.',
        target: { agent: 'assistant' },
        triggers: [
          { kind: 'cron', id: 'morning', cron: '0 9 * * *', timezone: 'UTC' },
          { kind: 'api', token: 'fixture-token' },
        ],
      },
      {
        id: 'release',
        prompt: 'Please publish the weekly post.',
        target: { agent: 'assistant' },
        triggers: [{ kind: 'api' }],
      },
      {
        id: 'planner',
        prompt: 'Please confirm the plan before acting.',
        target: { agent: 'assistant' },
        triggers: [{ kind: 'api' }],
      },
      {
        id: 'review',
        prompt: 'Review the draft.',
        target: { workflow: 'review' },
        triggers: [{ kind: 'api' }],
      },
    ],
  },
});

await cogitator.experimental_triggers!.scheduler.add({
  name: 'Remind about the report',
  delayMs: 60 * 60 * 1000,
  trigger: { agent: 'assistant' },
  metadata: { description: 'Remind about the report', threadId: 'reminders' },
});

export const agents = { assistant };
