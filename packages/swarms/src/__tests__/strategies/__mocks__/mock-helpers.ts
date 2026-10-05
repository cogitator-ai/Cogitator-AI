import { nanoid } from 'nanoid';
import type { RunResult, Agent, SwarmAgent, SwarmAgentMetadata } from '@cogitator-ai/types';

export function createMockRunResult(output: string, options?: Partial<RunResult>): RunResult {
  return {
    output,
    runId: options?.runId ?? `run_${nanoid(8)}`,
    agentId: options?.agentId ?? `agent_${nanoid(8)}`,
    threadId: options?.threadId ?? `thread_${nanoid(8)}`,
    usage: options?.usage ?? {
      inputTokens: 100,
      outputTokens: 50,
      totalTokens: 150,
      cost: 0.001,
      duration: 100,
    },
    toolCalls: options?.toolCalls ?? [],
    messages: options?.messages ?? [],
    trace: options?.trace ?? {
      traceId: `trace_${nanoid(12)}`,
      spans: [],
    },
    ...options,
  };
}

export function createMockAgent(
  name: string,
  options?: {
    instructions?: string;
    description?: string;
    model?: string;
  }
): Agent {
  const id = `agent_${nanoid(8)}`;
  const instructions = options?.instructions ?? `You are ${name}`;
  const model = options?.model ?? 'gpt-4o-mini';

  return {
    id,
    name,
    instructions,
    model,
    tools: [],
    config: {
      id,
      name,
      model,
      instructions,
      description: options?.description,
      tools: [],
    },
    clone: () => createMockAgent(name, options),
    serialize: () => ({
      version: '1.0.0',
      id,
      name,
      config: {
        model,
        instructions,
        tools: [],
        description: options?.description,
      },
      metadata: { serializedAt: new Date().toISOString() },
    }),
  };
}

export function createMockSwarmAgent(
  name: string,
  options?: {
    role?: SwarmAgentMetadata['role'];
    expertise?: string[];
    weight?: number;
    instructions?: string;
    description?: string;
  }
): SwarmAgent {
  const agent = createMockAgent(name, {
    instructions: options?.instructions,
    description: options?.description,
  });
  return {
    agent,
    metadata: {
      role: options?.role,
      expertise: options?.expertise,
      weight: options?.weight,
    },
    state: 'idle',
    messageCount: 0,
    tokenCount: 0,
  };
}

export type ResponseGenerator = (
  input: string,
  context?: Record<string, unknown>
) => string | RunResult | Promise<string | RunResult>;

export function createVoteResponse(vote: string, reasoning?: string): string {
  return `${reasoning ?? 'After careful consideration'}\n\nVOTE: ${vote}`;
}

export function createBidResponse(
  score: number,
  capabilities?: string,
  reasoning?: string
): string {
  return `${reasoning ?? 'Based on my expertise'}\n\nSCORE: ${score}\nCAPABILITIES: ${capabilities ?? 'general'}\nREASONING: ${reasoning ?? 'I can handle this task'}`;
}

export function createDebateResponse(position: string): string {
  return `My position: ${position}`;
}
