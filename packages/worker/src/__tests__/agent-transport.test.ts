import { describe, it, expect, vi, afterEach } from 'vitest';
import { z } from 'zod';
import { Agent, Cogitator, tool } from '@cogitator-ai/core';
import { MockLLMBackend } from '@cogitator-ai/test-utils';
import type { Agent as IAgent, Handoff } from '@cogitator-ai/types';
import { serializeAgent } from '../serialize';
import { processAgentJob } from '../processors/agent';
import { processWorkflowJob } from '../processors/workflow';
import { executeSwarmAgentJob } from '../processors/swarm-agent';
import type { SwarmAgentJobPayload } from '../types';

const Verdict = z.object({ verdict: z.enum(['run', 'hold']), reason: z.string() });

const cogitators: Cogitator[] = [];
function cogitatorWith(backends: Record<string, MockLLMBackend>): Cogitator {
  const cogitator = new Cogitator({ llm: { backends, retry: false } });
  cogitators.push(cogitator);
  return cogitator;
}

afterEach(async () => {
  await Promise.all(cogitators.splice(0).map((c) => c.close()));
});

function lastRunAgent(spy: { mock: { calls: unknown[][] } }): IAgent {
  return spy.mock.calls.at(-1)![0] as IAgent;
}

describe('agent jobs', () => {
  it('route an agent with an explicit provider where it runs in-process', async () => {
    const openai = new MockLLMBackend().setResponse({ content: 'from openai' });
    const openrouter = new MockLLMBackend().setResponse({ content: 'from openrouter' });
    const cogitator = cogitatorWith({ openai, openrouter });
    const agent = new Agent({
      name: 'routed',
      model: 'openai/gpt-6.1-sol',
      provider: 'openrouter',
      instructions: 'x',
    });

    const inProcess = await cogitator.run(agent, { input: 'hi' });
    const queued = await processAgentJob(
      { type: 'agent', jobId: 'j', agentConfig: serializeAgent(agent), input: 'hi', threadId: 't' },
      { cogitator }
    );

    expect(inProcess.output).toBe('from openrouter');
    expect(queued.output).toBe('from openrouter');
    expect(openai.getCalls()).toHaveLength(0);
    expect(openrouter.getLastCall()?.model).toBe('openai/gpt-6.1-sol');
  });

  it('keep the timeout, stop sequences and handoffs of the agent', async () => {
    const mock = new MockLLMBackend().setResponse({ content: 'done' });
    const cogitator = cogitatorWith({ mock });
    const run = vi.spyOn(cogitator, 'run');
    const billing = new Agent({
      name: 'billing',
      model: 'mock/billing',
      instructions: 'You are billing.',
    });
    const triage = new Agent({
      name: 'triage',
      model: 'mock/triage',
      instructions: 'You are triage.',
      timeout: 600000,
      stopSequences: ['END'],
      handoffs: [{ agent: billing, description: 'Refunds and invoices' }],
    });

    await processAgentJob(
      {
        type: 'agent',
        jobId: 'j',
        agentConfig: JSON.parse(JSON.stringify(serializeAgent(triage))),
        input: 'refund please',
        threadId: 't',
      },
      { cogitator }
    );

    const received = lastRunAgent(run);
    expect(received.config.timeout).toBe(600000);
    expect(received.config.stopSequences).toEqual(['END']);
    const [handoff] = received.config.handoffs ?? [];
    expect((handoff as Handoff).agent.name).toBe('billing');
    expect((handoff as Handoff).description).toBe('Refunds and invoices');
    expect(mock.getLastCall()?.tools?.map((t) => t.name)).toContain('transfer_to_billing');
  });
});

describe('workflow jobs', () => {
  it('run agent nodes with the whole agent and keep the structured answer', async () => {
    const mock = new MockLLMBackend().setResponse({
      content: JSON.stringify({ verdict: 'run', reason: 'Fresh.' }),
    });
    const cogitator = cogitatorWith({ mock });
    const run = vi.spyOn(cogitator, 'run');
    const chief = new Agent({
      name: 'chief',
      model: 'mock/editor',
      instructions: 'Decide.',
      topP: 0.8,
      reasoning: { effort: 'high' },
      responseFormat: { type: 'json_schema', schema: Verdict },
    });

    const result = await processWorkflowJob(
      {
        type: 'workflow',
        jobId: 'w',
        runId: 'r',
        input: { pitch: 'A story' },
        workflowConfig: {
          id: 'desk',
          name: 'Desk',
          nodes: [
            {
              id: 'decide',
              type: 'agent',
              config: {
                agentConfig: JSON.parse(JSON.stringify(serializeAgent(chief))),
                prompt: 'Pitch: {{pitch}}',
                outputKey: 'decision',
              },
            },
            {
              id: 'headline',
              type: 'transform',
              config: { transform: 'template', template: '{{decision.verdict}}' },
            },
          ],
          edges: [{ from: 'decide', to: 'headline' }],
        },
      },
      { cogitator }
    );

    const received = lastRunAgent(run);
    expect(received.config.topP).toBe(0.8);
    expect(received.config.reasoning).toEqual({ effort: 'high' });
    expect(received.config.responseFormat?.type).toBe('json_schema');
    expect(result.output.decision).toEqual({ verdict: 'run', reason: 'Fresh.' });
    expect(result.output.headline).toBe('run');
  });

  it('refuse an agent node config with fields the worker does not know', async () => {
    const chief = new Agent({ name: 'chief', model: 'mock/editor', instructions: 'Decide.' });

    await expect(
      processWorkflowJob(
        {
          type: 'workflow',
          jobId: 'w',
          runId: 'r',
          input: {},
          workflowConfig: {
            id: 'desk',
            name: 'Desk',
            nodes: [
              {
                id: 'decide',
                type: 'agent',
                config: { agentConfig: { ...serializeAgent(chief), temprature: 0 } },
              },
            ],
            edges: [],
          },
        },
        { cogitator: cogitatorWith({}) }
      )
    ).rejects.toThrow(/temprature/);
  });
});

describe('distributed swarm turns', () => {
  it('report cost, duration, reasoning tokens and truncation', async () => {
    const mock = new MockLLMBackend().setResponse({
      content: 'cut off',
      finishReason: 'length',
      usage: {
        inputTokens: 100,
        outputTokens: 40,
        totalTokens: 140,
        cost: 0.05,
        reasoningTokens: 30,
      },
    });
    const cogitator = cogitatorWith({ mock });
    const lookup = tool({
      name: 'lookup',
      description: 'Look up',
      parameters: z.object({ q: z.string() }),
      execute: async () => 'found',
    });
    const payload: SwarmAgentJobPayload = {
      type: 'swarm-agent',
      jobId: 'job_1',
      swarmId: 'swarm_1',
      agentName: 'debater',
      agentConfig: serializeAgent(
        new Agent({ name: 'debater', model: 'mock/m', instructions: 'Argue.', tools: [lookup] })
      ),
      input: 'Topic',
      stateKeys: { blackboard: 'b', messages: 'm', results: 'r' },
    };

    const result = await executeSwarmAgentJob(payload, { cogitator, tools: [lookup] });

    expect(result.error).toBeUndefined();
    expect(result.usage).toMatchObject({
      inputTokens: 100,
      outputTokens: 40,
      totalTokens: 140,
      cost: 0.05,
      reasoningTokens: 30,
    });
    expect(result.truncated).toBe(true);
    expect(result.tokenUsage).toEqual({ prompt: 100, completion: 40, total: 140 });
  });
});
