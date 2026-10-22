import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { RunOptions, Tool } from '@cogitator-ai/types';
import type { SerializedAgent, SerializedWorkflow } from '../types';

const runMock = vi.fn();

vi.mock('@cogitator-ai/core', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@cogitator-ai/core')>();
  const routing = new actual.Cogitator();
  class Cogitator {
    run = runMock;
    knowsProvider = (name: string) => routing.knowsProvider(name);
  }
  return { ...actual, Cogitator };
});

function runResult(output: string) {
  return {
    output,
    runId: 'run',
    agentId: 'agent',
    threadId: 'thread',
    usage: { inputTokens: 3, outputTokens: 2, totalTokens: 5, cost: 0, duration: 1 },
    toolCalls: [],
    messages: [],
    trace: { traceId: 't', spans: [] },
  };
}

const agentConfig = (overrides: Partial<SerializedAgent> = {}): SerializedAgent => ({
  name: 'writer',
  instructions: 'Write',
  model: 'qwen2.5:0.5b',
  provider: 'ollama',
  tools: [],
  ...overrides,
});

describe('processors/shared', () => {
  it('routes a serialized model like the same agent in-process', async () => {
    const { Cogitator, routeAgentWireModel } = await import('@cogitator-ai/core');
    const cog = new Cogitator();
    expect(routeAgentWireModel('gpt-4o', 'openai', cog)).toEqual({
      model: 'gpt-4o',
      provider: 'openai',
    });
    expect(routeAgentWireModel('openai/gpt-4o', 'openai', cog)).toEqual({
      model: 'gpt-4o',
      provider: 'openai',
    });
    expect(routeAgentWireModel('ollama/llama3', 'openai', cog)).toEqual({ model: 'ollama/llama3' });
    expect(routeAgentWireModel('meta-llama/llama-4', 'groq', cog)).toEqual({
      model: 'meta-llama/llama-4',
      provider: 'groq',
    });
    expect(routeAgentWireModel('meta-llama/llama-4', undefined, cog)).toEqual({
      model: 'meta-llama/llama-4',
    });
  });

  it('resolves tools by name from the worker registry', async () => {
    const { Cogitator } = await import('@cogitator-ai/core');
    const { createAgentFromConfig } = await import('../processors/shared');
    const search = { name: 'search' } as Tool;

    const agent = createAgentFromConfig(
      agentConfig({
        tools: [
          { name: 'search', description: 'd', parameters: { type: 'object', properties: {} } },
        ],
      }),
      { cogitator: new Cogitator(), tools: [search] }
    );

    expect(agent.tools).toEqual([search]);
  });

  it('fails fast when a tool is not registered on the worker', async () => {
    const { Cogitator } = await import('@cogitator-ai/core');
    const { createAgentFromConfig } = await import('../processors/shared');

    expect(() =>
      createAgentFromConfig(
        agentConfig({
          tools: [
            { name: 'deploy', description: 'd', parameters: { type: 'object', properties: {} } },
          ],
        }),
        { cogitator: new Cogitator(), tools: [] }
      )
    ).toThrow('not registered here: deploy');
  });
});

describe('processors/agent', () => {
  beforeEach(() => {
    runMock.mockReset();
  });

  it('runs the agent with a correctly prefixed model', async () => {
    runMock.mockResolvedValue(runResult('hello'));
    const { processAgentJob } = await import('../processors/agent');

    const result = await processAgentJob({
      type: 'agent',
      jobId: 'j',
      agentConfig: agentConfig({ model: 'ollama/qwen2.5:0.5b' }),
      input: 'hi',
      threadId: 't',
      userId: 'alice',
    });

    expect(result).toMatchObject({ type: 'agent', output: 'hello', tokenUsage: { total: 5 } });
    expect(runMock.mock.calls[0][1]).toMatchObject({ threadId: 't', userId: 'alice' });
    expect(runMock.mock.calls[0][0].config).toMatchObject({
      model: 'qwen2.5:0.5b',
      provider: 'ollama',
    });
  });

  it('recovers tool outputs from tool messages', async () => {
    const { findToolOutput } = await import('../processors/agent');
    expect(
      findToolOutput([{ role: 'tool', toolCallId: 'c1', content: '{"result":42}' }], 'c1')
    ).toEqual({ result: 42 });
    expect(findToolOutput([], 'missing')).toBeUndefined();
  });
});

describe('processors/swarm-agent', () => {
  beforeEach(() => {
    runMock.mockReset();
  });

  const payload = {
    type: 'swarm-agent' as const,
    jobId: 'job_1',
    swarmId: 'swarm_1',
    agentName: 'writer',
    agentConfig: agentConfig(),
    input: 'draft',
    runOptions: { timeout: 1000, threadId: 'th', userId: 'alice' },
    stateKeys: { blackboard: 'b', messages: 'm', results: 'swarm:swarm_1:results' },
  };

  it('publishes results tagged with the job id', async () => {
    runMock.mockResolvedValue(runResult('done'));
    const publish = vi.fn().mockResolvedValue(1);
    const { processSwarmAgentJob } = await import('../processors/swarm-agent');

    const result = await processSwarmAgentJob(payload, { publisher: { publish } });

    expect(result).toMatchObject({ jobId: 'job_1', output: 'done' });
    expect(publish).toHaveBeenCalledWith('swarm:swarm_1:results', expect.stringContaining('job_1'));
    const options = runMock.mock.calls[0][1] as RunOptions;
    expect(options.timeout).toBe(1000);
    expect(options.threadId).toBe('th');
    expect(options.userId).toBe('alice');
  });

  it('keeps the result under the key the job names before it publishes it', async () => {
    runMock.mockResolvedValue(runResult('done'));
    const calls: string[] = [];
    const publisher = {
      set: vi.fn(async () => {
        calls.push('set');
        return 'OK';
      }),
      publish: vi.fn(async () => {
        calls.push('publish');
        return 1;
      }),
    };
    const { processSwarmAgentJob } = await import('../processors/swarm-agent');

    await processSwarmAgentJob(
      {
        ...payload,
        stateKeys: { ...payload.stateKeys, result: 'swarm:{swarm_1}:result:job_1' },
        resultTtl: 5_000,
      },
      { publisher }
    );

    expect(publisher.set).toHaveBeenCalledWith(
      'swarm:{swarm_1}:result:job_1',
      expect.stringContaining('job_1'),
      'PX',
      5_000
    );
    expect(calls).toEqual(['set', 'publish']);
  });

  it("runs the agent in the swarm's trace", async () => {
    runMock.mockResolvedValue(runResult('done'));
    const { processSwarmAgentJob } = await import('../processors/swarm-agent');
    const trace = { traceId: 'a'.repeat(32), parentSpanId: 'b'.repeat(16) };

    await processSwarmAgentJob(
      { ...payload, runOptions: { ...payload.runOptions, trace } },
      { publisher: { publish: vi.fn().mockResolvedValue(1) } }
    );

    expect((runMock.mock.calls[0][1] as RunOptions).trace).toEqual(trace);
  });

  it('publishes failures only on the final attempt and rethrows', async () => {
    runMock.mockRejectedValue(new Error('model down'));
    const publish = vi.fn().mockResolvedValue(1);
    const { processSwarmAgentJob } = await import('../processors/swarm-agent');

    await expect(
      processSwarmAgentJob(payload, { publisher: { publish }, isFinalAttempt: false })
    ).rejects.toThrow('model down');
    expect(publish).not.toHaveBeenCalled();

    await expect(
      processSwarmAgentJob(payload, { publisher: { publish }, isFinalAttempt: true })
    ).rejects.toThrow('model down');
    expect(JSON.parse(publish.mock.calls[0][1] as string)).toMatchObject({
      jobId: 'job_1',
      error: 'model down',
    });
  });
});

describe('processors/swarm', () => {
  it('builds valid configs for every topology', async () => {
    const { buildSwarmConfig } = await import('../processors/swarm');
    const agents = [agentConfig({ name: 'a' }), agentConfig({ name: 'b' })];
    const coordinator = agentConfig({ name: 'lead' });

    expect(buildSwarmConfig({ topology: 'sequential', agents }, {})).toMatchObject({
      strategy: 'pipeline',
      pipeline: { stages: [{ name: 'a' }, { name: 'b' }] },
    });
    expect(buildSwarmConfig({ topology: 'hierarchical', agents, coordinator }, {})).toMatchObject({
      strategy: 'hierarchical',
    });
    expect(buildSwarmConfig({ topology: 'debate', agents, maxRounds: 2 }, {})).toMatchObject({
      strategy: 'debate',
      debate: { rounds: 2 },
    });
    expect(
      buildSwarmConfig({ topology: 'voting', agents, consensusThreshold: 0.8 }, {})
    ).toMatchObject({ strategy: 'consensus', consensus: { threshold: 0.8 } });
    expect(buildSwarmConfig({ topology: 'collaborative', agents }, {})).toMatchObject({
      strategy: 'pipeline',
    });
  });

  it('requires a coordinator for hierarchical swarms', async () => {
    const { buildSwarmConfig } = await import('../processors/swarm');
    expect(() => buildSwarmConfig({ topology: 'hierarchical', agents: [] }, {})).toThrow(
      'requires a coordinator'
    );
  });

  it('runs a sequential swarm end to end', async () => {
    runMock.mockReset();
    runMock.mockImplementation(async (agent: { name: string }) => runResult(`${agent.name} out`));
    const { processSwarmJob } = await import('../processors/swarm');

    const result = await processSwarmJob({
      type: 'swarm',
      jobId: 'j',
      swarmConfig: {
        topology: 'sequential',
        agents: [agentConfig({ name: 'a' }), agentConfig({ name: 'b' })],
      },
      input: 'go',
    });

    expect(result.output).toBe('b out');
    expect(result.agentOutputs.map((o) => o.agent)).toEqual(['a', 'b']);
  });
});

describe('processors/swarm collaborative topology', () => {
  it('has every agent contribute in every round, each building on the others', async () => {
    runMock.mockReset();
    runMock.mockImplementation(async (agent: { name: string }, options: RunOptions) =>
      runResult(`${agent.name}#${(options.input.match(/\[/g) ?? []).length}`)
    );
    const { processSwarmJob } = await import('../processors/swarm');

    const result = await processSwarmJob({
      type: 'swarm',
      jobId: 'collab',
      swarmConfig: {
        topology: 'collaborative',
        agents: [
          agentConfig({ name: 'researcher' }),
          agentConfig({ name: 'writer' }),
          agentConfig({ name: 'editor' }),
        ],
        maxRounds: 2,
      },
      input: 'Write about tides',
    });

    const order = runMock.mock.calls.map(([agent]) => (agent as { name: string }).name);
    expect(order).toEqual(['researcher', 'writer', 'editor', 'researcher', 'writer', 'editor']);
    const lastInput = (runMock.mock.calls.at(-1)![1] as RunOptions).input;
    expect(lastInput).toContain('Write about tides');
    expect(lastInput).toContain('researcher#0');
    expect(lastInput).toContain('writer#4');
    expect(result.rounds).toBe(2);
    expect(result.output).toBe('editor#5');
    expect(result.agentOutputs.map((o) => o.agent)).toEqual(order);
  });

  it('ends with the coordinator combining the contributions', async () => {
    runMock.mockReset();
    runMock.mockImplementation(async (agent: { name: string }) => runResult(`${agent.name} says`));
    const { processSwarmJob } = await import('../processors/swarm');

    const result = await processSwarmJob({
      type: 'swarm',
      jobId: 'collab-lead',
      swarmConfig: {
        topology: 'collaborative',
        agents: [agentConfig({ name: 'a' }), agentConfig({ name: 'b' })],
        coordinator: agentConfig({ name: 'lead' }),
        maxRounds: 1,
      },
      input: 'Plan the launch',
    });

    const order = runMock.mock.calls.map(([agent]) => (agent as { name: string }).name);
    expect(order).toEqual(['a', 'b', 'lead']);
    expect((runMock.mock.calls[2][1] as RunOptions).input).toContain('b says');
    expect(result.output).toBe('lead says');
  });
});

describe('processors/workflow', () => {
  beforeEach(() => {
    runMock.mockReset();
  });

  const workflow = (overrides: Partial<SerializedWorkflow>): SerializedWorkflow => ({
    id: 'wf',
    name: 'test',
    nodes: [],
    edges: [],
    ...overrides,
  });

  it('runs agent and transform nodes in order with templated prompts', async () => {
    runMock.mockImplementation(async (_agent: unknown, options: RunOptions) =>
      runResult(`summary of ${options.input}`)
    );
    const { processWorkflowJob } = await import('../processors/workflow');

    const result = await processWorkflowJob({
      type: 'workflow',
      jobId: 'j',
      runId: 'r',
      input: { topic: 'rust' },
      workflowConfig: workflow({
        nodes: [
          {
            id: 'write',
            type: 'agent',
            config: {
              agentConfig: agentConfig(),
              prompt: 'Write about {{topic}}',
              outputKey: 'draft',
            },
          },
          { id: 'shout', type: 'transform', config: { transform: 'uppercase' } },
        ],
        edges: [{ from: 'write', to: 'shout' }],
      }),
    });

    expect(result.output).toMatchObject({
      topic: 'rust',
      draft: 'summary of Write about rust',
      shout: 'SUMMARY OF WRITE ABOUT RUST',
    });
    expect(result.nodeResults.shout).toBe('SUMMARY OF WRITE ABOUT RUST');
  });

  it('goes on from its checkpoint when a retried job runs again, and lets it go once done', async () => {
    const { InMemoryCheckpointStore } = await import('@cogitator-ai/workflows');
    const checkpoints = new InMemoryCheckpointStore();
    let failing = true;
    runMock.mockImplementation(async (agent: { name: string }, options: RunOptions) => {
      if (agent.name === 'reviewer' && failing) throw new Error('provider down');
      return runResult(`${agent.name} on ${options.input}`);
    });
    const { processWorkflowJob, workflowCheckpointId } = await import('../processors/workflow');
    const job = {
      type: 'workflow' as const,
      jobId: 'j',
      runId: 'run-1',
      input: { topic: 'rust' },
      workflowConfig: workflow({
        nodes: [
          {
            id: 'write',
            type: 'agent',
            config: {
              agentConfig: agentConfig(),
              prompt: 'Write about {{topic}}',
              outputKey: 'draft',
            },
          },
          { id: 'check', type: 'condition', config: { key: 'draft', operator: 'exists' } },
          {
            id: 'review',
            type: 'agent',
            config: { agentConfig: agentConfig({ name: 'reviewer' }), prompt: 'Review {{draft}}' },
          },
          { id: 'skip', type: 'transform', config: { transform: 'template', template: 'none' } },
        ],
        edges: [
          { from: 'write', to: 'check' },
          { from: 'check', to: 'review', condition: 'true' },
          { from: 'check', to: 'skip', condition: 'false' },
        ],
      }),
    };

    await expect(
      processWorkflowJob(job, { checkpoints }, { willRetry: () => true })
    ).rejects.toThrow('provider down');
    expect(runMock).toHaveBeenCalledTimes(2);
    expect((await checkpoints.list('test')).map((one) => one.id)).toEqual([
      workflowCheckpointId(job),
    ]);
    expect((await checkpoints.load(workflowCheckpointId(job)))?.completedNodes).toEqual([
      'write',
      'check',
    ]);

    failing = false;
    const result = await processWorkflowJob(job, { checkpoints }, { willRetry: () => false });

    expect(runMock.mock.calls.map(([agent]) => (agent as { name: string }).name)).toEqual([
      'writer',
      'reviewer',
      'reviewer',
    ]);
    expect(result.output).toEqual({
      topic: 'rust',
      draft: 'writer on Write about rust',
      review: 'reviewer on Review writer on Write about rust',
    });
    expect(result.nodeResults.skip).toEqual({ skipped: true });
    expect(result.usage).toEqual({
      inputTokens: 6,
      outputTokens: 4,
      totalTokens: 10,
      cost: 0,
      runs: 2,
    });
    expect(await checkpoints.list('test')).toEqual([]);
  });

  it('lets its checkpoints go when its last attempt fails', async () => {
    const { InMemoryCheckpointStore } = await import('@cogitator-ai/workflows');
    const checkpoints = new InMemoryCheckpointStore();
    runMock.mockImplementation(async (agent: { name: string }) => {
      if (agent.name === 'reviewer') throw new Error('provider down');
      return runResult('ok');
    });
    const { processWorkflowJob } = await import('../processors/workflow');

    await expect(
      processWorkflowJob(
        {
          type: 'workflow',
          jobId: 'j',
          runId: 'run-2',
          input: {},
          workflowConfig: workflow({
            nodes: [
              { id: 'a', type: 'agent', config: { agentConfig: agentConfig() } },
              {
                id: 'b',
                type: 'agent',
                config: { agentConfig: agentConfig({ name: 'reviewer' }) },
              },
            ],
            edges: [{ from: 'a', to: 'b' }],
          }),
        },
        { checkpoints },
        { willRetry: () => false }
      )
    ).rejects.toThrow('provider down');
    expect(await checkpoints.list('test')).toEqual([]);
  });

  it('starts a graph of many roots at all of them', async () => {
    const { processWorkflowJob } = await import('../processors/workflow');
    const result = await processWorkflowJob({
      type: 'workflow',
      jobId: 'j',
      runId: 'r',
      input: { name: 'ada' },
      workflowConfig: workflow({
        nodes: [
          { id: 'a', type: 'transform', config: { transform: 'template', template: 'A {{name}}' } },
          { id: 'b', type: 'transform', config: { transform: 'template', template: 'B {{name}}' } },
          {
            id: 'join',
            type: 'transform',
            config: { transform: 'template', template: '{{a}}+{{b}}' },
          },
        ],
        edges: [
          { from: 'a', to: 'join' },
          { from: 'b', to: 'join' },
        ],
      }),
    });
    expect(result.output.join).toBe('A ada+B ada');
    expect(Object.keys(result.nodeResults).sort()).toEqual(['a', 'b', 'join']);
  });

  it('follows only the matching branch of a condition node', async () => {
    const { processWorkflowJob } = await import('../processors/workflow');

    const result = await processWorkflowJob({
      type: 'workflow',
      jobId: 'j',
      runId: 'r',
      input: { score: 7 },
      workflowConfig: workflow({
        nodes: [
          { id: 'check', type: 'condition', config: { key: 'score', operator: 'gt', value: 5 } },
          {
            id: 'high',
            type: 'transform',
            config: { transform: 'template', template: 'high {{score}}' },
          },
          {
            id: 'low',
            type: 'transform',
            config: { transform: 'template', template: 'low {{score}}' },
          },
          { id: 'after-low', type: 'transform', config: { transform: 'trim', inputKey: 'low' } },
        ],
        edges: [
          { from: 'check', to: 'high', condition: 'true' },
          { from: 'check', to: 'low', condition: 'false' },
          { from: 'low', to: 'after-low' },
        ],
      }),
    });

    expect(result.output).toMatchObject({ high: 'high 7' });
    expect(result.output).not.toHaveProperty('low');
    expect(result.nodeResults.low).toEqual({ skipped: true });
    expect(result.nodeResults['after-low']).toEqual({ skipped: true });
  });

  it('runs parallel branches concurrently and joins them', async () => {
    let inFlight = 0;
    let peak = 0;
    runMock.mockImplementation(async (agent: { name: string }) => {
      inFlight++;
      peak = Math.max(peak, inFlight);
      await new Promise((r) => setTimeout(r, 10));
      inFlight--;
      return runResult(agent.name);
    });
    const { processWorkflowJob } = await import('../processors/workflow');

    const result = await processWorkflowJob({
      type: 'workflow',
      jobId: 'j',
      runId: 'r',
      input: {},
      workflowConfig: workflow({
        nodes: [
          { id: 'fan', type: 'parallel', config: {} },
          { id: 'a', type: 'agent', config: { agentConfig: agentConfig({ name: 'a' }) } },
          { id: 'b', type: 'agent', config: { agentConfig: agentConfig({ name: 'b' }) } },
          {
            id: 'join',
            type: 'transform',
            config: { transform: 'template', template: '{{a}}+{{b}}' },
          },
        ],
        edges: [
          { from: 'fan', to: 'a' },
          { from: 'fan', to: 'b' },
          { from: 'a', to: 'join' },
          { from: 'b', to: 'join' },
        ],
      }),
    });

    expect(peak).toBe(2);
    expect(result.output).toMatchObject({ join: 'a+b' });
  });

  it('never resumes a job from the checkpoint of another job with the same runId', async () => {
    const { InMemoryCheckpointStore } = await import('@cogitator-ai/workflows');
    const checkpoints = new InMemoryCheckpointStore();
    runMock.mockImplementation(async (agent: { name: string }, options: RunOptions) => {
      if (agent.name === 'reviewer') throw new Error('provider down');
      return runResult(`${agent.name} on ${options.input}`);
    });
    const { processWorkflowJob } = await import('../processors/workflow');
    const job = (jobId: string, secret: string) => ({
      type: 'workflow' as const,
      jobId,
      runId: 'shared',
      input: { secret },
      workflowConfig: workflow({
        nodes: [
          {
            id: 'a',
            type: 'agent',
            config: { agentConfig: agentConfig(), prompt: '{{secret}}', outputKey: 'seen' },
          },
          { id: 'b', type: 'agent', config: { agentConfig: agentConfig({ name: 'reviewer' }) } },
        ],
        edges: [{ from: 'a', to: 'b' }],
      }),
    });

    await expect(
      processWorkflowJob(job('one', 'A-SECRET'), { checkpoints }, { willRetry: () => true })
    ).rejects.toThrow('provider down');
    runMock.mockImplementation(async (agent: { name: string }, options: RunOptions) =>
      runResult(`${agent.name} on ${options.input}`)
    );
    const other = await processWorkflowJob(job('two', 'B-secret'), { checkpoints });

    expect(other.output).toMatchObject({ secret: 'B-secret', seen: 'writer on B-secret' });
    expect(await checkpoints.list('test')).toHaveLength(1);
  });

  it('refuses input keys and output keys under the prefix the run keeps for itself', async () => {
    const { processWorkflowJob, validateWorkflow } = await import('../processors/workflow');

    await expect(
      processWorkflowJob({
        type: 'workflow',
        jobId: 'j',
        runId: 'r',
        input: { '__cogitator:usage:x': { totalTokens: -5000, cost: -12.5, runs: -1 } },
        workflowConfig: workflow({
          nodes: [{ id: 'a', type: 'transform', config: { transform: 'trim' } }],
        }),
      })
    ).rejects.toThrow("input key '__cogitator:usage:x'");
    expect(() =>
      validateWorkflow(
        workflow({
          nodes: [
            {
              id: 'a',
              type: 'transform',
              config: { transform: 'trim', outputKey: '__cogitator:done:b' },
            },
          ],
        })
      )
    ).toThrow("Output key '__cogitator:done:b'");
    expect(() =>
      validateWorkflow(
        workflow({ nodes: [{ id: '__cogitator:start', type: 'parallel', config: {} }] })
      )
    ).toThrow("node id '__cogitator:start'");
  });

  it('gives a join after a condition the output of the branch that ran, once', async () => {
    const { processWorkflowJob } = await import('../processors/workflow');

    const result = await processWorkflowJob({
      type: 'workflow',
      jobId: 'j',
      runId: 'r',
      input: { score: 2 },
      workflowConfig: workflow({
        nodes: [
          { id: 'check', type: 'condition', config: { key: 'score', operator: 'gt', value: 5 } },
          { id: 'high', type: 'transform', config: { transform: 'template', template: 'HIGH' } },
          { id: 'low', type: 'transform', config: { transform: 'template', template: ' low ' } },
          { id: 'join', type: 'transform', config: { transform: 'trim' } },
        ],
        edges: [
          { from: 'check', to: 'high', condition: 'true' },
          { from: 'check', to: 'low', condition: 'false' },
          { from: 'high', to: 'join' },
          { from: 'low', to: 'join' },
        ],
      }),
    });

    expect(result.output.join).toBe('low');
    expect(result.nodeResults.high).toEqual({ skipped: true });
  });

  it('runs every branch of a wide fan-out at once and a long chain to its end', async () => {
    let inFlight = 0;
    let peak = 0;
    runMock.mockImplementation(async (agent: { name: string }) => {
      inFlight++;
      peak = Math.max(peak, inFlight);
      await new Promise((r) => setTimeout(r, 10));
      inFlight--;
      return runResult(agent.name);
    });
    const { processWorkflowJob } = await import('../processors/workflow');
    const branches = ['a', 'b', 'c', 'd', 'e', 'f'];

    await processWorkflowJob({
      type: 'workflow',
      jobId: 'j',
      runId: 'r',
      input: {},
      workflowConfig: workflow({
        nodes: [
          { id: 'fan', type: 'parallel', config: {} },
          ...branches.map((name) => ({
            id: name,
            type: 'agent' as const,
            config: { agentConfig: agentConfig({ name }) },
          })),
        ],
        edges: branches.map((name) => ({ from: 'fan', to: name })),
      }),
    });
    expect(peak).toBe(6);

    const chain = Array.from({ length: 120 }, (_, at) => `n${at}`);
    const long = await processWorkflowJob({
      type: 'workflow',
      jobId: 'j',
      runId: 'r',
      input: { text: ' x ' },
      workflowConfig: workflow({
        nodes: chain.map((id, at) => ({
          id,
          type: 'transform' as const,
          config: at === 0 ? { transform: 'trim', inputKey: 'text' } : { transform: 'trim' },
        })),
        edges: chain.slice(1).map((id, at) => ({ from: chain[at]!, to: id })),
      }),
    });
    expect(long.output.n119).toBe('x');
  });

  it('aborts the agent runs next to a failing node and fails once they settled', async () => {
    const { InMemoryCheckpointStore } = await import('@cogitator-ai/workflows');
    let slowAborted = false;
    let slowSettled = false;
    runMock.mockImplementation(async (agent: { name: string }, options: RunOptions) => {
      if (agent.name === 'bad') throw new Error('bad node');
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, 200);
        options.signal?.addEventListener('abort', () => {
          slowAborted = true;
          clearTimeout(timer);
          setTimeout(resolve, 20);
        });
      });
      slowSettled = true;
      return runResult('slow');
    });
    const { processWorkflowJob } = await import('../processors/workflow');

    await expect(
      processWorkflowJob(
        {
          type: 'workflow',
          jobId: 'j',
          runId: 'r',
          input: {},
          workflowConfig: workflow({
            nodes: [
              { id: 'fan', type: 'parallel', config: {} },
              { id: 'bad', type: 'agent', config: { agentConfig: agentConfig({ name: 'bad' }) } },
              { id: 'slow', type: 'agent', config: { agentConfig: agentConfig({ name: 'slow' }) } },
            ],
            edges: [
              { from: 'fan', to: 'bad' },
              { from: 'fan', to: 'slow' },
            ],
          }),
        },
        { checkpoints: new InMemoryCheckpointStore() }
      )
    ).rejects.toThrow('bad node');
    expect(slowAborted).toBe(true);
    expect(slowSettled).toBe(true);
  });

  it('aborts the agent runs in flight when a checkpoint cannot be saved', async () => {
    const { InMemoryCheckpointStore } = await import('@cogitator-ai/workflows');
    const checkpoints = new InMemoryCheckpointStore();
    const save = checkpoints.save.bind(checkpoints);
    let saves = 0;
    checkpoints.save = async (checkpoint) => {
      if (++saves > 1) throw new Error('redis down');
      await save(checkpoint);
    };
    let slowAborted = false;
    runMock.mockImplementation(async (agent: { name: string }, options: RunOptions) => {
      if (agent.name === 'slow') {
        await new Promise<void>((resolve) => {
          const timer = setTimeout(resolve, 500);
          options.signal?.addEventListener('abort', () => {
            slowAborted = true;
            clearTimeout(timer);
            resolve();
          });
        });
      }
      return runResult(agent.name);
    });
    const { processWorkflowJob } = await import('../processors/workflow');

    await expect(
      processWorkflowJob(
        {
          type: 'workflow',
          jobId: 'j',
          runId: 'r',
          input: {},
          workflowConfig: workflow({
            nodes: [
              { id: 'fan', type: 'parallel', config: {} },
              { id: 'fast', type: 'agent', config: { agentConfig: agentConfig({ name: 'fast' }) } },
              { id: 'slow', type: 'agent', config: { agentConfig: agentConfig({ name: 'slow' }) } },
            ],
            edges: [
              { from: 'fan', to: 'fast' },
              { from: 'fan', to: 'slow' },
            ],
          }),
        },
        { checkpoints }
      )
    ).rejects.toThrow('redis down');
    expect(slowAborted).toBe(true);
  });

  it('reports a node that ran with no output as run after a resume from a JSON store', async () => {
    const { InMemoryCheckpointStore } = await import('@cogitator-ai/workflows');
    const checkpoints = new InMemoryCheckpointStore();
    const save = checkpoints.save.bind(checkpoints);
    checkpoints.save = async (checkpoint) => {
      await save(JSON.parse(JSON.stringify(checkpoint)) as typeof checkpoint);
    };
    let failing = true;
    runMock.mockImplementation(async () => {
      if (failing) throw new Error('provider down');
      return runResult('done');
    });
    const { processWorkflowJob } = await import('../processors/workflow');
    const job = {
      type: 'workflow' as const,
      jobId: 'j',
      runId: 'r',
      input: {},
      workflowConfig: workflow({
        nodes: [
          { id: 'parse', type: 'transform', config: { transform: 'json-parse', inputKey: 'none' } },
          { id: 'agent', type: 'agent', config: { agentConfig: agentConfig() } },
        ],
        edges: [{ from: 'parse', to: 'agent' }],
      }),
    };

    await expect(
      processWorkflowJob(job, { checkpoints }, { willRetry: () => true })
    ).rejects.toThrow('provider down');
    failing = false;
    const result = await processWorkflowJob(job, { checkpoints });

    expect(result.nodeResults).toEqual({ parse: undefined, agent: 'done' });
  });

  it('finishes a run whose checkpoint cannot be deleted at its end', async () => {
    const { InMemoryCheckpointStore } = await import('@cogitator-ai/workflows');
    const checkpoints = new InMemoryCheckpointStore();
    checkpoints.delete = async () => {
      throw new Error('redis down');
    };
    runMock.mockImplementation(async () => runResult('done'));
    const { processWorkflowJob } = await import('../processors/workflow');

    const result = await processWorkflowJob(
      {
        type: 'workflow',
        jobId: 'j',
        runId: 'r',
        input: {},
        workflowConfig: workflow({
          nodes: [{ id: 'a', type: 'agent', config: { agentConfig: agentConfig() } }],
        }),
      },
      { checkpoints }
    );

    expect(result.output).toEqual({ a: 'done' });
  });

  it('rejects invalid graphs before running anything', async () => {
    const { validateWorkflow } = await import('../processors/workflow');

    expect(() =>
      validateWorkflow(
        workflow({
          nodes: [
            { id: 'a', type: 'parallel', config: {} },
            { id: 'b', type: 'parallel', config: {} },
          ],
          edges: [
            { from: 'a', to: 'b' },
            { from: 'b', to: 'a' },
          ],
        })
      )
    ).toThrow('contains a cycle');

    expect(() =>
      validateWorkflow(workflow({ nodes: [], edges: [{ from: 'x', to: 'y' }] }))
    ).toThrow("unknown node 'x'");

    expect(() =>
      validateWorkflow(
        workflow({ nodes: [{ id: 'a', type: 'transform', config: { transform: 'explode' } }] })
      )
    ).toThrow("Invalid config for transform node 'a'");

    expect(() =>
      validateWorkflow(
        workflow({
          nodes: [
            { id: 'c', type: 'condition', config: { key: 'x', operator: 'exists' } },
            { id: 'd', type: 'parallel', config: {} },
          ],
          edges: [{ from: 'c', to: 'd' }],
        })
      )
    ).toThrow("must set condition to 'true' or 'false'");

    expect(runMock).not.toHaveBeenCalled();
  });
});
