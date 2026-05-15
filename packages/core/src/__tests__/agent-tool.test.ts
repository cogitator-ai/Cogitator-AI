import { describe, it, expect, vi } from 'vitest';
import { agentAsTool } from '../agent-tool';
import { Agent } from '../agent';
import type { Cogitator } from '../cogitator';
import type { RunResult } from '@cogitator-ai/types';

const createMockRunResult = (output: string, overrides?: Partial<RunResult>): RunResult => ({
  output,
  runId: 'run_test123',
  agentId: 'agent_test123',
  threadId: 'thread_test123',
  usage: {
    inputTokens: 100,
    outputTokens: 50,
    totalTokens: 150,
    cost: 0.001,
    duration: 1000,
  },
  toolCalls: [],
  messages: [],
  trace: {
    traceId: 'trace_test123',
    spans: [],
  },
  ...overrides,
});

const createMockCogitator = (runFn: (agent: Agent, options: unknown) => Promise<RunResult>) => {
  return {
    run: runFn,
  } as unknown as Cogitator;
};

describe('agentAsTool()', () => {
  const testAgent = new Agent({
    name: 'test-agent',
    model: 'test/model',
    instructions: 'You are a test agent',
  });

  it('creates a tool with correct name and description', () => {
    const mockCogitator = createMockCogitator(() => Promise.resolve(createMockRunResult('test')));

    const tool = agentAsTool(mockCogitator, testAgent, {
      name: 'delegate',
      description: 'Delegate tasks',
    });

    expect(tool.name).toBe('delegate');
    expect(tool.description).toBe('Delegate tasks');
    expect(tool.sideEffects).toContain('external');
  });

  it('executes sub-agent and returns output', async () => {
    const runSpy = vi.fn().mockResolvedValue(createMockRunResult('Agent completed the task'));
    const mockCogitator = createMockCogitator(runSpy);

    const tool = agentAsTool(mockCogitator, testAgent, {
      name: 'research',
      description: 'Research a topic',
    });

    const mockContext = {
      agentId: 'parent_agent',
      runId: 'parent_run',
      signal: new AbortController().signal,
    };

    const result = await tool.execute({ task: 'Find information about AI' }, mockContext);

    expect(result.success).toBe(true);
    expect(result.output).toBe('Agent completed the task');
    expect(runSpy).toHaveBeenCalledWith(
      testAgent,
      expect.objectContaining({
        input: 'Find information about AI',
        signal: mockContext.signal,
      })
    );
  });

  it('handles sub-agent errors gracefully', async () => {
    const mockCogitator = createMockCogitator(() => {
      throw new Error('LLM connection failed');
    });

    const tool = agentAsTool(mockCogitator, testAgent, {
      name: 'failing',
      description: 'A failing tool',
    });

    const mockContext = {
      agentId: 'parent_agent',
      runId: 'parent_run',
      signal: new AbortController().signal,
    };

    const result = await tool.execute({ task: 'Do something' }, mockContext);

    expect(result.success).toBe(false);
    expect(result.error).toBe('LLM connection failed');
    expect(result.output).toBe('');
  });

  it('passes timeout to cogitator.run', async () => {
    const runSpy = vi.fn().mockResolvedValue(createMockRunResult('done'));
    const mockCogitator = createMockCogitator(runSpy);

    const tool = agentAsTool(mockCogitator, testAgent, {
      name: 'timed',
      description: 'Timed task',
      timeout: 30000,
    });

    const mockContext = {
      agentId: 'parent_agent',
      runId: 'parent_run',
      signal: new AbortController().signal,
    };

    await tool.execute({ task: 'Quick task' }, mockContext);

    expect(runSpy).toHaveBeenCalledWith(
      testAgent,
      expect.objectContaining({
        timeout: 30000,
      })
    );
  });

  it('includes usage when includeUsage is true', async () => {
    const mockCogitator = createMockCogitator(() =>
      Promise.resolve(
        createMockRunResult('done', {
          usage: {
            inputTokens: 200,
            outputTokens: 100,
            totalTokens: 300,
            cost: 0.002,
            duration: 2000,
          },
        })
      )
    );

    const tool = agentAsTool(mockCogitator, testAgent, {
      name: 'tracked',
      description: 'Tracked task',
      includeUsage: true,
    });

    const mockContext = {
      agentId: 'parent_agent',
      runId: 'parent_run',
      signal: new AbortController().signal,
    };

    const result = await tool.execute({ task: 'Task' }, mockContext);

    expect(result.usage).toBeDefined();
    expect(result.usage?.inputTokens).toBe(200);
    expect(result.usage?.cost).toBe(0.002);
  });

  it('excludes usage when includeUsage is false', async () => {
    const mockCogitator = createMockCogitator(() => Promise.resolve(createMockRunResult('done')));

    const tool = agentAsTool(mockCogitator, testAgent, {
      name: 'untracked',
      description: 'Untracked task',
      includeUsage: false,
    });

    const mockContext = {
      agentId: 'parent_agent',
      runId: 'parent_run',
      signal: new AbortController().signal,
    };

    const result = await tool.execute({ task: 'Task' }, mockContext);

    expect(result.usage).toBeUndefined();
  });

  it('includes tool calls when includeToolCalls is true', async () => {
    const mockCogitator = createMockCogitator(() =>
      Promise.resolve(
        createMockRunResult('done', {
          toolCalls: [
            { id: 'tc_1', name: 'search', arguments: { query: 'test' } },
            { id: 'tc_2', name: 'calculate', arguments: { expr: '2+2' } },
          ],
        })
      )
    );

    const tool = agentAsTool(mockCogitator, testAgent, {
      name: 'detailed',
      description: 'Detailed task',
      includeToolCalls: true,
    });

    const mockContext = {
      agentId: 'parent_agent',
      runId: 'parent_run',
      signal: new AbortController().signal,
    };

    const result = await tool.execute({ task: 'Task' }, mockContext);

    expect(result.toolCalls).toBeDefined();
    expect(result.toolCalls?.length).toBe(2);
    expect(result.toolCalls?.[0].name).toBe('search');
    expect(result.toolCalls?.[1].name).toBe('calculate');
  });

  it('provides toJSON method that returns valid schema', () => {
    const mockCogitator = createMockCogitator(() => Promise.resolve(createMockRunResult('test')));

    const tool = agentAsTool(mockCogitator, testAgent, {
      name: 'schema_test',
      description: 'Test schema generation',
    });

    const schema = tool.toJSON();

    expect(schema.name).toBe('schema_test');
    expect(schema.description).toBe('Test schema generation');
    expect(schema.parameters.type).toBe('object');
    expect(schema.parameters.properties).toHaveProperty('task');
    expect(schema.parameters.required).toContain('task');
  });

  it('uses agent timeout when no explicit timeout provided', async () => {
    const agentWithTimeout = new Agent({
      name: 'timed-agent',
      model: 'test/model',
      instructions: 'Test',
      timeout: 45000,
    });

    const runSpy = vi.fn().mockResolvedValue(createMockRunResult('done'));
    const mockCogitator = createMockCogitator(runSpy);

    const tool = agentAsTool(mockCogitator, agentWithTimeout, {
      name: 'inherit_timeout',
      description: 'Inherits agent timeout',
    });

    const mockContext = {
      agentId: 'parent_agent',
      runId: 'parent_run',
      signal: new AbortController().signal,
    };

    await tool.execute({ task: 'Task' }, mockContext);

    expect(runSpy).toHaveBeenCalledWith(
      agentWithTimeout,
      expect.objectContaining({
        timeout: 45000,
      })
    );
  });
});
