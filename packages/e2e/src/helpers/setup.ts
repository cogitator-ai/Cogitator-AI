import {
  Cogitator,
  Agent,
  tool,
  OllamaBackend,
  GoogleBackend,
  parseModel,
  createLLMBackend,
} from '@cogitator-ai/core';
import { InMemoryAdapter } from '@cogitator-ai/memory';
import { WorkflowExecutor } from '@cogitator-ai/workflows';
import { Swarm } from '@cogitator-ai/swarms';
import type { SwarmConfig } from '@cogitator-ai/swarms';
import { z } from 'zod';
import { LLMJudge } from './judge';

const TEST_MODEL = process.env.TEST_MODEL || 'qwen2.5:0.5b';
const OLLAMA_URL = process.env.OLLAMA_URL || 'http://localhost:11434';

export async function isOllamaRunning(): Promise<boolean> {
  try {
    const res = await fetch(`${OLLAMA_URL}/api/tags`);
    return res.ok;
  } catch {
    return false;
  }
}

export function createTestCogitator(opts?: { memory?: boolean }): Cogitator {
  return new Cogitator({
    llm: {
      defaultModel: `ollama/${TEST_MODEL}`,
    },
    ...(opts?.memory && { memory: { adapter: 'memory' as const } }),
  });
}

export function createOllamaBackend(): OllamaBackend {
  return new OllamaBackend({ baseUrl: OLLAMA_URL });
}

export function createTestAgent(opts?: {
  name?: string;
  instructions?: string;
  tools?: ReturnType<typeof tool>[];
  model?: string;
  maxTokens?: number;
  maxIterations?: number;
  responseFormat?: { type: 'text' } | { type: 'json' };
}): Agent {
  return new Agent({
    name: opts?.name ?? 'TestAgent',
    instructions: opts?.instructions ?? 'You are a helpful assistant. Keep responses brief.',
    model: opts?.model ?? `ollama/${TEST_MODEL}`,
    tools: opts?.tools,
    maxTokens: opts?.maxTokens,
    maxIterations: opts?.maxIterations,
    responseFormat: opts?.responseFormat,
  });
}

export function createTestTools() {
  const multiply = tool({
    name: 'multiply',
    description: 'Multiply two numbers together. Returns the product.',
    parameters: z.object({
      a: z.number().describe('First number'),
      b: z.number().describe('Second number'),
    }),
    execute: async ({ a, b }) => ({ result: a * b }),
  });

  const add = tool({
    name: 'add',
    description: 'Add two numbers together. Returns the sum.',
    parameters: z.object({
      a: z.number().describe('First number'),
      b: z.number().describe('Second number'),
    }),
    execute: async ({ a, b }) => ({ result: a + b }),
  });

  const failing = tool({
    name: 'divide',
    description: 'Divide two numbers. Throws error on division by zero.',
    parameters: z.object({
      a: z.number().describe('Numerator'),
      b: z.number().describe('Denominator'),
    }),
    execute: async ({ a, b }) => {
      if (b === 0) throw new Error('Division by zero');
      return { result: a / b };
    },
  });

  return { multiply, add, failing };
}

export function createTestJudge(): LLMJudge | null {
  const apiKey = process.env.GOOGLE_API_KEY;
  if (!apiKey) return null;
  const backend = new GoogleBackend({ apiKey });
  return new LLMJudge(backend, 'gemini-2.5-flash');
}

export function getTestModel(): string {
  return TEST_MODEL;
}

export function getOllamaUrl(): string {
  return OLLAMA_URL;
}

export function createTestMemoryAdapter(): InMemoryAdapter {
  return new InMemoryAdapter({ provider: 'memory' });
}

export function createTestWorkflowExecutor(cogitator: Cogitator): WorkflowExecutor {
  return new WorkflowExecutor(cogitator);
}

export function createTestSwarm(cogitator: Cogitator, config: SwarmConfig): Swarm {
  return new Swarm(cogitator, config);
}

export { parseModel, createLLMBackend, GoogleBackend };
