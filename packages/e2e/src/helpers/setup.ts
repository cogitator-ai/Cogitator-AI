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
import type { ResponseFormat } from '@cogitator-ai/types';
import { z } from 'zod';
import { LLMJudge } from './judge';

const TEST_MODEL = process.env.TEST_MODEL || 'gpt-oss:20b';
const OLLAMA_URL = process.env.OLLAMA_URL || 'http://localhost:11434';

const OLLAMA_PROBE_TIMEOUT_MS = 5_000;

/** OLLAMA_URL for messages, without the credentials a URL may carry. */
function displayOllamaUrl(): string {
  let url: URL;
  try {
    url = new URL(OLLAMA_URL);
  } catch {
    return OLLAMA_URL;
  }
  if (!url.username && !url.password) return OLLAMA_URL;
  url.username = '';
  url.password = '';
  return url.href.replace(/\/$/, '');
}

interface OllamaTagsResponse {
  models?: Array<{ name?: string; model?: string }>;
}

type OllamaModels = { ok: true; names: string[] } | { ok: false; reason: string };

async function listOllamaModels(): Promise<OllamaModels> {
  let res: Response;
  try {
    res = await fetch(`${OLLAMA_URL}/api/tags`, {
      signal: AbortSignal.timeout(OLLAMA_PROBE_TIMEOUT_MS),
    });
  } catch {
    return { ok: false, reason: `Ollama is not reachable at ${displayOllamaUrl()}` };
  }
  if (!res.ok) {
    return {
      ok: false,
      reason: `Ollama at ${displayOllamaUrl()} answered /api/tags with ${res.status}`,
    };
  }
  try {
    const body = (await res.json()) as OllamaTagsResponse;
    const names = (body.models ?? []).flatMap((m) => [m.name, m.model]);
    return { ok: true, names: names.filter((n): n is string => typeof n === 'string') };
  } catch {
    return {
      ok: false,
      reason: `Ollama at ${displayOllamaUrl()} answered /api/tags with invalid JSON`,
    };
  }
}

/** Ollama lists an untagged pull as `<name>:latest`. */
function matchesOllamaModel(pulled: string, wanted: string): boolean {
  const withTag = wanted.includes(':') ? wanted : `${wanted}:latest`;
  return pulled === wanted || pulled === withTag;
}

/** Whether the local Ollama answers and has `model` pulled. */
export async function ollamaHasModel(model: string = TEST_MODEL): Promise<boolean> {
  const listed = await listOllamaModels();
  return listed.ok && listed.names.some((name) => matchesOllamaModel(name, model));
}

async function probeOllama(): Promise<string | null> {
  if (process.env.TEST_OLLAMA !== 'true') return 'TEST_OLLAMA is not "true"';
  const listed = await listOllamaModels();
  if (!listed.ok) return listed.reason;
  if (!listed.names.some((name) => matchesOllamaModel(name, TEST_MODEL))) {
    return `model ${TEST_MODEL} is not pulled, run: ollama pull ${TEST_MODEL}`;
  }
  return null;
}

let ollamaProbe: Promise<string | null> | undefined;

/**
 * Why the local Ollama e2e cannot run here, or null when they can: TEST_OLLAMA is "true",
 * Ollama answers at OLLAMA_URL and TEST_MODEL is pulled. Probed once per test file, and the
 * reason is printed when TEST_OLLAMA asked for these tests, the way the Studio e2e reports a
 * missing Chromium. In CI a run that asked for them fails instead: a job that set up Ollama
 * must not go green with every Ollama suite skipped.
 */
export function ollamaSkipReason(): Promise<string | null> {
  ollamaProbe ??= probeOllama().then((reason) => {
    if (reason === null || process.env.TEST_OLLAMA !== 'true') return reason;
    if (process.env.CI === 'true') {
      throw new Error(`TEST_OLLAMA is "true" in CI, but ${reason}`);
    }
    console.warn(`Skipping the Ollama e2e: ${reason}`);
    return reason;
  });
  return ollamaProbe;
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
  responseFormat?: ResponseFormat;
  temperature?: number;
}): Agent {
  return new Agent({
    name: opts?.name ?? 'TestAgent',
    instructions: opts?.instructions ?? 'You are a helpful assistant. Keep responses brief.',
    model: opts?.model ?? `ollama/${TEST_MODEL}`,
    tools: opts?.tools,
    maxTokens: opts?.maxTokens,
    maxIterations: opts?.maxIterations,
    responseFormat: opts?.responseFormat,
    temperature: opts?.temperature,
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
  return new LLMJudge(backend, 'gemini-3.5-flash-lite');
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
