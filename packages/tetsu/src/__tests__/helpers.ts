import { mock } from 'bun:test';
import { Agent, tool } from '@cogitator-ai/core';
import type { Cogitator } from '@cogitator-ai/core';
import type {
  MemoryAdapter,
  MemoryResult,
  ResumeOptions,
  RunOptions,
  RunResult,
  Thread,
} from '@cogitator-ai/types';
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
export type ResumeImpl = (
  agent: Agent,
  threadId: string,
  options: ResumeOptions
) => Promise<RunResult>;

export interface MemoryEntry {
  message: { role: 'user' | 'assistant' | 'system'; content: string };
  createdAt: Date;
}

export function fakeMemory(entries: MemoryEntry[] = []) {
  return {
    getThread: mock((_threadId: string): Promise<MemoryResult<Thread | null>> =>
      Promise.resolve({ success: true, data: null })
    ),
    createThread: mock(
      (agentId: string, metadata: Record<string, unknown> | undefined, threadId: string) =>
        Promise.resolve({
          success: true as const,
          data: {
            id: threadId,
            agentId,
            metadata: metadata ?? {},
            createdAt: new Date(),
            updatedAt: new Date(),
          },
        })
    ),
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
  memory?: MemoryAdapter | ReturnType<typeof fakeMemory>,
  resume: ResumeImpl = () => Promise.resolve(runResult())
) {
  const runMock = mock(run);
  const resumeMock = mock(resume);
  const cogitator = {
    run: runMock,
    resume: resumeMock,
    memory,
    getMemory: async () => memory,
  } as unknown as Cogitator;
  return { cogitator, run: runMock, resume: resumeMock };
}

export const refundApproval = {
  toolCallId: 'call-1',
  toolName: 'refund',
  arguments: { order: 'A-1', amount: 500 },
  description: 'Refund an order',
  sideEffects: ['payment'],
};

/** A run that stopped before `refund` because it needs approval. */
export function pausedResult(overrides: Partial<RunResult> = {}): RunResult {
  return runResult({
    output: 'Let me do that.',
    status: 'paused',
    pendingApprovals: [refundApproval],
    checkpoint: {
      version: 1,
      runId: 'run-1',
      agentId: 'agent-1',
      threadId: 'thread-1',
      userId: 'ada',
      model: 'mock/m',
      input: 'Refund A-1',
      messages: [{ role: 'system', content: 'secret instructions' }],
      toolCalls: [],
      turn: { toolCalls: [], decisions: {} },
      iterations: 1,
      lastToolCallSignature: '',
      usage: {
        inputTokens: 10,
        outputTokens: 5,
        cachedInputTokens: 0,
        cacheWriteTokens: 0,
        reasoningTokens: 0,
      },
      reasoning: [],
      startedAt: 0,
    },
    ...overrides,
  });
}

export function lastResumeCall(resume: {
  mock: { calls: Array<[Agent, string, ResumeOptions]> };
}): { threadId: string; options: ResumeOptions } {
  const call = resume.mock.calls.at(-1);
  if (!call) throw new Error('The runtime never resumed a run');
  return { threadId: call[1], options: call[2] };
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
