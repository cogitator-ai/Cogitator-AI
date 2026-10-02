import { vi } from 'vitest';
import { Agent } from '@cogitator-ai/core';
import type { Cogitator } from '@cogitator-ai/core';
import type { RunOptions, RunResult, Tool, ToolCall } from '@cogitator-ai/types';

export interface FakeToolStep {
  call: ToolCall;
  result?: unknown;
  error?: string;
}

export interface FakeRunScript {
  tokens?: string[];
  output?: string;
  toolSteps?: FakeToolStep[];
  error?: Error;
  inputTokens?: number;
  outputTokens?: number;
}

export interface FakeCogitator {
  cogitator: Cogitator;
  run: ReturnType<typeof vi.fn<(agent: Agent, options: RunOptions) => Promise<RunResult>>>;
}

export function createFakeCogitator(script: FakeRunScript = {}): FakeCogitator {
  const run = vi.fn(async (agent: Agent, options: RunOptions): Promise<RunResult> => {
    options.onRunStart?.({
      runId: 'run_1',
      agentId: agent.id,
      input: options.input,
      threadId: 'thread_1',
    });

    for (const step of script.toolSteps ?? []) {
      options.onToolCall?.(step.call);
      options.onToolResult?.({
        callId: step.call.id,
        name: step.call.name,
        result: step.result ?? null,
        error: step.error,
      });
    }

    if (script.error) throw script.error;

    const tokens = script.tokens ?? ['Hello', ' world'];
    if (options.stream) {
      for (const token of tokens) options.onToken?.(token);
    }

    const inputTokens = script.inputTokens ?? 10;
    const outputTokens = script.outputTokens ?? 20;
    return {
      output: script.output ?? tokens.join(''),
      runId: 'run_1',
      agentId: agent.id,
      threadId: 'thread_1',
      modelUsed: agent.model,
      toolCalls: (script.toolSteps ?? []).map((step) => step.call),
      messages: [],
      usage: {
        inputTokens,
        outputTokens,
        totalTokens: inputTokens + outputTokens,
        cost: 0.001,
        duration: 42,
      },
      trace: { traceId: 'trace_1', spans: [] },
    };
  });

  return { cogitator: { run } as unknown as Cogitator, run };
}

export function createAgent(name = 'assistant', tools: Tool[] = []): Agent {
  return new Agent({
    name,
    model: 'test/model',
    instructions: 'You are a test agent.',
    temperature: 0.7,
    tools,
  });
}

export async function collect<T>(stream: ReadableStream<T>): Promise<T[]> {
  const parts: T[] = [];
  const reader = stream.getReader();
  while (true) {
    const { done, value } = await reader.read();
    if (done) return parts;
    parts.push(value);
  }
}

export async function collectAsync<T>(iterable: AsyncIterable<T>): Promise<T[]> {
  const items: T[] = [];
  for await (const item of iterable) items.push(item);
  return items;
}
