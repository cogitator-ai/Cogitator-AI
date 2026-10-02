import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { RunOptions, Tool } from '@cogitator-ai/types';
import type { SerializedAgent, SerializedWorkflow } from '../types';

const runMock = vi.fn();

vi.mock('@cogitator-ai/core', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@cogitator-ai/core')>();
  class Cogitator {
    run = runMock;
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
  it('prefixes unqualified models with the serialized provider', async () => {
    const { resolveModelString } = await import('../processors/shared');
    expect(resolveModelString('gpt-4o', 'openai')).toBe('openai/gpt-4o');
    expect(resolveModelString('ollama/llama3', 'openai')).toBe('ollama/llama3');
  });

  it('resolves tools by name from the worker registry', async () => {
    const { resolveTools } = await import('../processors/shared');
    const search = { name: 'search' } as Tool;

    const tools = resolveTools(
      [{ name: 'search', description: 'd', parameters: { type: 'object', properties: {} } }],
      [search]
    );

    expect(tools).toEqual([search]);
  });

  it('fails fast when a tool is not registered on the worker', async () => {
    const { resolveTools } = await import('../processors/shared');

    expect(() =>
      resolveTools(
        [{ name: 'deploy', description: 'd', parameters: { type: 'object', properties: {} } }],
        []
      )
    ).toThrow('Tools not registered on this worker: deploy');
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
    });

    expect(result).toMatchObject({ type: 'agent', output: 'hello', tokenUsage: { total: 5 } });
    expect(runMock.mock.calls[0][0].model).toBe('ollama/qwen2.5:0.5b');
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
    runOptions: { timeout: 1000, threadId: 'th' },
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
      strategy: 'round-robin',
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
