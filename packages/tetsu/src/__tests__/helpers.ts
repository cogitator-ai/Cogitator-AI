import { mock } from 'bun:test';
import { Agent, tool } from '@cogitator-ai/core';
import type { Cogitator } from '@cogitator-ai/core';
import type { RunOptions, RunResult } from '@cogitator-ai/types';
import { z } from 'zod';

export function runResult(overrides: Partial<RunResult> = {}): RunResult {
  return {
    output: 'hello world',
    runId: 'run-1',
    agentId: 'agent-1',
    threadId: 'thread-1',
    usage: { inputTokens: 10, outputTokens: 20, totalTokens: 30, cost: 0, duration: 5 },
    toolCalls: [],
    messages: [],
    trace: { traceId: 'trace-1', spans: [] },
    ...overrides,
  };
}

export type RunImpl = (agent: Agent, options: RunOptions) => Promise<RunResult>;

export interface MemoryEntry {
  message: { role: 'user' | 'assistant' | 'system'; content: string };
  createdAt: Date;
}

export function fakeMemory(entries: MemoryEntry[] = []) {
  return {
    getEntries: mock(() => Promise.resolve({ success: true as const, data: entries })),
    addEntry: mock(() => Promise.resolve({ success: true as const, data: {} })),
    clearThread: mock(() => Promise.resolve({ success: true as const, data: undefined })),
  };
}

export function lastRunOptions(run: { mock: { calls: Array<[Agent, RunOptions]> } }): RunOptions {
  const call = run.mock.calls.at(-1);
  if (!call) throw new Error('The runtime was never called');
  return call[1];
}

export function fakeCogitator(
  run: RunImpl = () => Promise.resolve(runResult()),
  memory?: ReturnType<typeof fakeMemory>
) {
  const runMock = mock(run);
  const cogitator = { run: runMock, memory } as unknown as Cogitator;
  return { cogitator, run: runMock };
}

export const weather = tool({
  name: 'get_weather',
  description: 'Weather for a city',
  parameters: z.object({ city: z.string() }),
  execute: async ({ city }) => `Sunny in ${city}`,
});

export function chatAgent(): Agent {
  return new Agent({
    name: 'chat',
    model: 'ollama/qwen3:0.6b',
    description: 'Answers questions',
    instructions: 'You are helpful.',
    tools: [weather],
  });
}

export interface ParsedStream {
  events: Array<Record<string, unknown>>;
  done: boolean;
}

export async function readStream(res: Response): Promise<ParsedStream> {
  const text = await res.text();
  const events: Array<Record<string, unknown>> = [];
  let done = false;
  for (const block of text.split('\n\n')) {
    const data = block
      .split('\n')
      .filter((line) => line.startsWith('data:'))
      .map((line) => line.slice(5).trimStart())
      .join('\n');
    if (!data) continue;
    if (data === '[DONE]') {
      done = true;
      continue;
    }
    events.push(JSON.parse(data) as Record<string, unknown>);
  }
  return { events, done };
}

export function json(body: unknown): RequestInit {
  return {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  };
}

export function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}
