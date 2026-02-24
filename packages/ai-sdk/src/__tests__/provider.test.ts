import { describe, it, expect, vi } from 'vitest';
import { createCogitatorProvider, cogitatorModel } from '../provider';
import type { Cogitator, Agent } from '@cogitator-ai/core';
import type { RunResult } from '@cogitator-ai/types';

function makeAgent(name: string, overrides: Record<string, unknown> = {}): Agent {
  return {
    name,
    id: `agent_${name}`,
    config: {
      name,
      model: 'test/model',
      instructions: 'test',
      temperature: 0.7,
      maxTokens: 1000,
      ...overrides,
    },
    clone: vi.fn().mockImplementation(function (this: Agent, o: Record<string, unknown>) {
      return makeAgent(name, { ...this.config, ...o });
    }),
  } as unknown as Agent;
}

function makeRunResult(overrides: Partial<RunResult> = {}): RunResult {
  return {
    output: 'test output',
    runId: 'run_test',
    agentId: 'agent_test',
    threadId: 'thread_test',
    toolCalls: [],
    messages: [],
    usage: { inputTokens: 10, outputTokens: 20, totalTokens: 30, cost: 0, duration: 100 },
    trace: { traceId: 'trace_test', spans: [] },
    ...overrides,
  };
}

function makeCogitator(runResult: Partial<RunResult> = {}): Cogitator {
  return {
    run: vi.fn().mockResolvedValue(makeRunResult(runResult)),
  } as unknown as Cogitator;
}

describe('createCogitatorProvider', () => {
  it('creates a provider from an array of agents', () => {
    const cogitator = makeCogitator();
    const agent = makeAgent('writer');

    const provider = createCogitatorProvider(cogitator, { agents: [agent] });

    expect(provider).toBeTypeOf('function');
    expect(provider.languageModel).toBe(provider);
  });

  it('creates a provider from a Map of agents', () => {
    const cogitator = makeCogitator();
    const agent = makeAgent('writer');
    const map = new Map([['writer', agent]]);

    const provider = createCogitatorProvider(cogitator, { agents: map });
    const model = provider('writer');

    expect(model.modelId).toBe('writer');
    expect(model.provider).toBe('cogitator');
  });

  it('creates a provider from a Record of agents', () => {
    const cogitator = makeCogitator();
    const agent = makeAgent('writer');

    const provider = createCogitatorProvider(cogitator, { agents: { writer: agent } });
    const model = provider('writer');

    expect(model.modelId).toBe('writer');
  });

  it('throws for unknown agent name', () => {
    const cogitator = makeCogitator();
    const provider = createCogitatorProvider(cogitator, { agents: [makeAgent('writer')] });

    expect(() => provider('nonexistent')).toThrow('Agent "nonexistent" not found');
  });

  it('error message lists available agents', () => {
    const cogitator = makeCogitator();
    const provider = createCogitatorProvider(cogitator, {
      agents: [makeAgent('alpha'), makeAgent('beta')],
    });

    expect(() => provider('gamma')).toThrow('Available agents: alpha, beta');
  });

  it('doGenerate calls cogitator.run and returns result', async () => {
    const cogitator = makeCogitator({ output: 'hello world' });
    const agent = makeAgent('test');
    const provider = createCogitatorProvider(cogitator, { agents: [agent] });
    const model = provider('test');

    const result = await model.doGenerate({
      inputFormat: 'prompt',
      mode: { type: 'regular' },
      prompt: [{ role: 'user', content: [{ type: 'text', text: 'Hi' }] }],
      abortSignal: undefined,
      headers: {},
    });

    expect(result.text).toBe('hello world');
    expect(result.finishReason).toBe('stop');
    expect(result.usage.promptTokens).toBe(10);
    expect(result.usage.completionTokens).toBe(20);
    expect(cogitator.run).toHaveBeenCalledWith(agent, expect.objectContaining({ input: 'Hi' }));
  });

  it('doGenerate handles tool calls', async () => {
    const cogitator = makeCogitator({
      output: '',
      toolCalls: [{ id: 'tc1', name: 'search', arguments: { q: 'test' } }],
    });
    const agent = makeAgent('test');
    const provider = createCogitatorProvider(cogitator, { agents: [agent] });
    const model = provider('test');

    const result = await model.doGenerate({
      inputFormat: 'prompt',
      mode: { type: 'regular' },
      prompt: [{ role: 'user', content: [{ type: 'text', text: 'search' }] }],
      abortSignal: undefined,
      headers: {},
    });

    expect(result.finishReason).toBe('tool-calls');
    expect(result.toolCalls).toHaveLength(1);
    expect(result.toolCalls![0].toolName).toBe('search');
    expect(result.toolCalls![0].toolCallId).toBe('tc1');
    expect(result.toolCalls![0].args).toBe('{"q":"test"}');
  });

  it('doGenerate extracts system prompt', async () => {
    const cogitator = makeCogitator();
    const agent = makeAgent('test');
    const provider = createCogitatorProvider(cogitator, { agents: [agent] });
    const model = provider('test');

    await model.doGenerate({
      inputFormat: 'prompt',
      mode: { type: 'regular' },
      prompt: [
        { role: 'system', content: 'You are helpful' },
        { role: 'user', content: [{ type: 'text', text: 'Hello' }] },
      ],
      abortSignal: undefined,
      headers: {},
    });

    expect(cogitator.run).toHaveBeenCalledWith(agent, expect.objectContaining({ input: 'Hello' }));
  });

  it('doGenerate includes assistant messages in user prompt', async () => {
    const cogitator = makeCogitator();
    const agent = makeAgent('test');
    const provider = createCogitatorProvider(cogitator, { agents: [agent] });
    const model = provider('test');

    await model.doGenerate({
      inputFormat: 'prompt',
      mode: { type: 'regular' },
      prompt: [
        { role: 'user', content: [{ type: 'text', text: 'What is 2+2?' }] },
        { role: 'assistant', content: [{ type: 'text', text: '4' }] },
        { role: 'user', content: [{ type: 'text', text: 'And 3+3?' }] },
      ],
      abortSignal: undefined,
      headers: {},
    });

    const input = (cogitator.run as ReturnType<typeof vi.fn>).mock.calls[0][1].input;
    expect(input).toContain('What is 2+2?');
    expect(input).toContain('Assistant: 4');
    expect(input).toContain('And 3+3?');
  });

  it('doGenerate applies temperature/maxTokens overrides via clone', async () => {
    const cogitator = makeCogitator();
    const agent = makeAgent('test');
    const provider = createCogitatorProvider(cogitator, { agents: [agent] });
    const model = provider('test', { temperature: 0.1, maxTokens: 500 });

    await model.doGenerate({
      inputFormat: 'prompt',
      mode: { type: 'regular' },
      prompt: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
      abortSignal: undefined,
      headers: {},
    });

    expect(agent.clone).toHaveBeenCalledWith(
      expect.objectContaining({ temperature: 0.1, maxTokens: 500 })
    );
  });

  it('doStream returns a readable stream', async () => {
    const cogitator = {
      run: vi.fn().mockResolvedValue({
        output: 'streamed',
        toolCalls: [],
        usage: { inputTokens: 5, outputTokens: 10, totalTokens: 15 },
        finishReason: 'stop',
      }),
    } as unknown as Cogitator;

    const agent = makeAgent('test');
    const provider = createCogitatorProvider(cogitator, { agents: [agent] });
    const model = provider('test');

    const { stream } = await model.doStream({
      inputFormat: 'prompt',
      mode: { type: 'regular' },
      prompt: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
      abortSignal: undefined,
      headers: {},
    });

    expect(stream).toBeInstanceOf(ReadableStream);

    const reader = stream.getReader();
    const chunks: unknown[] = [];
    let done = false;
    while (!done) {
      const result = await reader.read();
      if (result.done) {
        done = true;
      } else {
        chunks.push(result.value);
      }
    }

    const finishChunk = chunks.find((c: unknown) => (c as { type: string }).type === 'finish');
    expect(finishChunk).toBeDefined();
  });

  it('doStream emits error when cogitator.run throws', async () => {
    const cogitator = {
      run: vi.fn().mockRejectedValue(new Error('LLM timeout')),
    } as unknown as Cogitator;

    const agent = makeAgent('test');
    const provider = createCogitatorProvider(cogitator, { agents: [agent] });
    const model = provider('test');

    const { stream } = await model.doStream({
      inputFormat: 'prompt',
      mode: { type: 'regular' },
      prompt: [{ role: 'user', content: [{ type: 'text', text: 'fail' }] }],
      abortSignal: undefined,
      headers: {},
    });

    const reader = stream.getReader();
    const chunks: unknown[] = [];
    let done = false;
    while (!done) {
      const result = await reader.read();
      if (result.done) {
        done = true;
      } else {
        chunks.push(result.value);
      }
    }

    const errorChunk = chunks.find((c: unknown) => (c as { type: string }).type === 'error') as
      | { type: string; error: Error }
      | undefined;
    expect(errorChunk).toBeDefined();
    expect(errorChunk!.error.message).toBe('LLM timeout');
  });

  it('doStream emits tool-call and tool-calls finish reason', async () => {
    const cogitator = {
      run: vi
        .fn()
        .mockImplementation(async (_agent: Agent, opts: { onToolCall?: (tc: unknown) => void }) => {
          opts.onToolCall?.({ id: 'tc1', name: 'search', arguments: { q: 'test' } });
          return {
            output: '',
            toolCalls: [{ id: 'tc1', name: 'search', arguments: { q: 'test' } }],
            usage: { inputTokens: 5, outputTokens: 10, totalTokens: 15 },
            finishReason: 'tool-calls',
          };
        }),
    } as unknown as Cogitator;

    const agent = makeAgent('test');
    const provider = createCogitatorProvider(cogitator, { agents: [agent] });
    const model = provider('test');

    const { stream } = await model.doStream({
      inputFormat: 'prompt',
      mode: { type: 'regular' },
      prompt: [{ role: 'user', content: [{ type: 'text', text: 'search' }] }],
      abortSignal: undefined,
      headers: {},
    });

    const reader = stream.getReader();
    const chunks: unknown[] = [];
    let done = false;
    while (!done) {
      const result = await reader.read();
      if (result.done) {
        done = true;
      } else {
        chunks.push(result.value);
      }
    }

    const toolCallChunk = chunks.find(
      (c: unknown) => (c as { type: string }).type === 'tool-call'
    ) as { toolName: string; toolCallId: string } | undefined;
    expect(toolCallChunk).toBeDefined();
    expect(toolCallChunk!.toolName).toBe('search');

    const finishChunk = chunks.find((c: unknown) => (c as { type: string }).type === 'finish') as
      | { finishReason: string }
      | undefined;
    expect(finishChunk!.finishReason).toBe('tool-calls');
  });

  it('doGenerate does not clone agent when no overrides', async () => {
    const cogitator = makeCogitator();
    const agent = makeAgent('test');
    const provider = createCogitatorProvider(cogitator, { agents: [agent] });
    const model = provider('test');

    await model.doGenerate({
      inputFormat: 'prompt',
      mode: { type: 'regular' },
      prompt: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
      abortSignal: undefined,
      headers: {},
    });

    expect(agent.clone).not.toHaveBeenCalled();
  });
});

describe('cogitatorModel', () => {
  it('wraps agent directly as LanguageModelV1', async () => {
    const cogitator = makeCogitator({ output: 'direct' });
    const agent = makeAgent('direct_agent');

    const model = cogitatorModel(cogitator, agent);

    expect(model.modelId).toBe('direct_agent');
    expect(model.provider).toBe('cogitator');

    const result = await model.doGenerate({
      inputFormat: 'prompt',
      mode: { type: 'regular' },
      prompt: [{ role: 'user', content: [{ type: 'text', text: 'test' }] }],
      abortSignal: undefined,
      headers: {},
    });

    expect(result.text).toBe('direct');
  });
});
