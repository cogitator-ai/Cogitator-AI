import { describe, it, expect, vi } from 'vitest';
import { z } from 'zod';
import type {
  AgentConfig,
  ChatRequest,
  ChatStreamChunk,
  Handoff,
  LLMBackend,
  Agent as IAgent,
  RunResult,
} from '@cogitator-ai/types';
import { Agent } from '../agent';
import { Cogitator } from '../cogitator';
import { tool } from '../tool';
import { defineSkill } from '../skill';
import {
  AGENT_CONFIG_WIRE_FIELDS,
  AgentWireError,
  fromAgentWire,
  fromAgentWireRunResult,
  toAgentWire,
  toAgentWireRunResult,
} from '../agent-wire';

const search = tool({
  name: 'search',
  description: 'Search the web',
  parameters: z.object({ query: z.string() }),
  execute: async ({ query }) => ({ hits: [query] }),
});
const cite = tool({
  name: 'cite',
  description: 'Format a citation',
  parameters: z.object({ url: z.string() }),
  execute: async ({ url }) => `[${url}]`,
});
const refund = tool({
  name: 'refund',
  description: 'Refund an order',
  parameters: z.object({ order: z.string() }),
  execute: async ({ order }) => ({ refunded: order }),
});

const Verdict = z.object({ verdict: z.enum(['run', 'hold']), reason: z.string() });

function recordingBackend(provider: string) {
  const models: string[] = [];
  const backend: LLMBackend = {
    provider,
    chat: vi.fn(async (request: ChatRequest) => {
      models.push(request.model);
      return {
        id: 'r',
        content: 'ok',
        finishReason: 'stop' as const,
        usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
      };
    }),
    chatStream: vi.fn(async function* (): AsyncGenerator<ChatStreamChunk> {
      yield { id: 's', delta: {}, finishReason: 'stop' };
    }),
  };
  return { backend, models };
}

const router = new Cogitator({
  llm: { backends: { openrouter: recordingBackend('openrouter').backend } },
});
const runtime = { cogitator: router, tools: [search, cite, refund] };

function sendAndReceive(agent: IAgent): Agent {
  return fromAgentWire(JSON.parse(JSON.stringify(toAgentWire(agent))), runtime);
}

function handoffShape(entries: AgentConfig['handoffs']) {
  return entries?.map((entry: IAgent | Handoff) =>
    'agent' in entry
      ? { agent: entry.agent.name, toolName: entry.toolName, description: entry.description }
      : { agent: entry.name }
  );
}

/**
 * The part of a config field that must survive the trip. Fields compare as they are unless they
 * travel in another form (tools as schemas, Zod as JSON Schema, handoffs as names).
 */
function project(key: keyof AgentConfig, config: AgentConfig): unknown {
  switch (key) {
    case 'tools':
      return config.tools?.map((t) => t.toJSON());
    case 'skills':
      return AGENT_CONFIG_WIRE_FIELDS.skills;
    case 'responseFormat': {
      const format = config.responseFormat;
      return format?.type === 'json_schema'
        ? z.toJSONSchema(format.schema, { unrepresentable: 'any' })
        : format;
    }
    case 'handoffs':
      return handoffShape(config.handoffs);
    default:
      return config[key];
  }
}

describe('agent wire format', () => {
  it('carries every AgentConfig field', () => {
    const escalation = new Agent({
      name: 'escalation',
      model: 'anthropic/claude-sonnet-5-5',
      instructions: 'You escalate.',
      tools: [refund],
    });
    const full: Required<AgentConfig> = {
      id: 'agent_chief',
      name: 'chief',
      description: 'Decides what runs',
      provider: 'openrouter',
      model: 'openai/gpt-6-luna',
      instructions: 'Decide whether the pitch runs.',
      tools: [search],
      skills: [
        defineSkill({
          name: 'citations',
          version: '1.0.0',
          description: 'Cites sources',
          tools: [cite],
          instructions: 'Cite every source.',
        }),
      ],
      temperature: 0.2,
      topP: 0.9,
      maxTokens: 2048,
      stopSequences: ['END'],
      responseFormat: { type: 'json_schema', schema: Verdict },
      reasoning: { effort: 'medium', summary: true },
      handoffs: [{ agent: escalation, toolName: 'escalate', description: 'When unsure' }],
      maxIterations: 7,
      onIterationLimit: 'stop',
      timeout: 600000,
    };
    const original = new Agent(full);

    const received = sendAndReceive(original);

    expect(Object.keys(AGENT_CONFIG_WIRE_FIELDS).sort()).toEqual(Object.keys(full).sort());
    for (const key of Object.keys(full) as (keyof AgentConfig)[]) {
      expect(project(key, received.config), `AgentConfig.${key}`).toEqual(
        project(key, original.config)
      );
    }
    expect(received.id).toBe('agent_chief');
    expect(received.instructions).toContain('Cite every source.');
  });

  it('carries the agents a handoff reaches, cycles included', () => {
    const billing = new Agent({
      name: 'billing',
      model: 'openai/gpt-6.1-sol',
      instructions: 'You are billing.',
      tools: [refund],
      handoffs: [],
    });
    const triage = new Agent({
      name: 'triage',
      model: 'openai/gpt-6.1-sol',
      instructions: 'You are triage.',
      handoffs: [billing],
    });
    billing.config.handoffs!.push({ agent: triage, toolName: 'back_to_triage' });

    const received = sendAndReceive(triage);
    const [toBilling] = received.config.handoffs ?? [];
    const billingAgent = toBilling as IAgent;
    const [back] = billingAgent.config.handoffs ?? [];

    expect(billingAgent.name).toBe('billing');
    expect(billingAgent.tools.map((t) => t.name)).toEqual(['refund']);
    expect((back as Handoff).agent).toBe(received);
    expect((back as Handoff).toolName).toBe('back_to_triage');
  });

  it('refuses two different handoff agents with one name', () => {
    const a = new Agent({ name: 'twin', model: 'openai/x', instructions: 'a' });
    const b = new Agent({ name: 'twin', model: 'openai/y', instructions: 'b' });
    const entry = new Agent({
      name: 'entry',
      model: 'openai/z',
      instructions: 'e',
      handoffs: [a, b],
    });

    expect(() => toAgentWire(entry)).toThrow(AgentWireError);
  });

  it('runs an agent with an explicit provider on the same route as in-process', async () => {
    const { backend: openrouter, models } = recordingBackend('openrouter');
    const cogitator = new Cogitator({ llm: { backends: { openrouter } } });
    const agent = new Agent({
      name: 'routed',
      model: 'openai/gpt-6.1-sol',
      provider: 'openrouter',
      instructions: 'x',
    });

    await cogitator.run(agent, { input: 'hi' });
    await cogitator.run(fromAgentWire(toAgentWire(agent), { cogitator }), { input: 'hi' });

    expect(models).toEqual(['openai/gpt-6.1-sol', 'openai/gpt-6.1-sol']);
  });

  it('uses resolveModel for an agent without a model', () => {
    const agent = new Agent({ name: 'default', instructions: 'x' });

    expect(() => toAgentWire(agent)).toThrow(/has no model/);
    expect(toAgentWire(agent, { resolveModel: () => 'openai/gpt-6.1-sol' }).model).toBe(
      'openai/gpt-6.1-sol'
    );
  });

  it('refuses unknown fields instead of dropping them', () => {
    const wire = { ...toAgentWire(new Agent({ name: 'a', model: 'openai/x', instructions: 'i' })) };

    expect(() => fromAgentWire({ ...wire, temperatur: 0.1 }, runtime)).toThrow(/temperatur/);
  });

  it('names the tools the receiving side lacks', () => {
    const wire = toAgentWire(
      new Agent({ name: 'a', model: 'openai/x', instructions: 'i', tools: [search, refund] })
    );

    expect(() => fromAgentWire(wire, { cogitator: router, tools: [search] })).toThrow(
      'not registered here: refund'
    );
  });

  it('refuses a provider the receiving side cannot route to', () => {
    const wire = { name: 'a', instructions: 'i', model: 'llama-4', provider: 'nowhere', tools: [] };

    expect(() => fromAgentWire(wire, runtime)).toThrow('"nowhere"');
  });

  it('keeps cost, flags and tool outputs of a run', () => {
    const result: RunResult = {
      output: 'partial answer',
      structured: { verdict: 'hold' },
      structuredError: undefined,
      reasoning: 'thought about it',
      runId: 'run_1',
      agentId: 'agent_1',
      threadId: 'thread_1',
      modelUsed: 'openai/gpt-6.1-sol',
      usage: {
        inputTokens: 100,
        outputTokens: 50,
        totalTokens: 150,
        cost: 0.42,
        duration: 1200,
        reasoningTokens: 30,
        cachedInputTokens: 10,
        cacheWriteTokens: 5,
      },
      truncated: true,
      blocked: 'refusal',
      iterationLimitReached: true,
      handoffs: [{ from: 'a', to: 'b' }],
      finalAgent: 'b',
      toolCalls: [{ id: 'c1', name: 'search', arguments: { query: 'q' } }],
      messages: [
        { role: 'assistant', content: '' },
        { role: 'tool', toolCallId: 'c1', name: 'search', content: '{"hits":["q"]}' },
      ],
      trace: { traceId: 't', spans: [] },
    };

    const wire = JSON.parse(JSON.stringify(toAgentWireRunResult(result)));
    const back = fromAgentWireRunResult(wire, { agentId: 'agent_1' });

    expect(wire.toolCalls).toEqual([
      { id: 'c1', name: 'search', input: { query: 'q' }, output: { hits: ['q'] } },
    ]);
    expect(back.usage).toEqual(result.usage);
    expect(back).toMatchObject({
      output: 'partial answer',
      structured: { verdict: 'hold' },
      reasoning: 'thought about it',
      truncated: true,
      blocked: 'refusal',
      iterationLimitReached: true,
      finalAgent: 'b',
      runId: 'run_1',
      threadId: 'thread_1',
      modelUsed: 'openai/gpt-6.1-sol',
    });
    expect(back.toolCalls).toEqual(result.toolCalls);
  });
});
