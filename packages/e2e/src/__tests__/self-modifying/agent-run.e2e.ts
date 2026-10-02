import { describe, it, expect, beforeAll } from 'vitest';
import { Agent, OllamaBackend, tool } from '@cogitator-ai/core';
import { SelfModifyingAgent } from '@cogitator-ai/self-modifying';
import { z } from 'zod';

const hasOllamaCloud = !!process.env.OLLAMA_API_KEY;
const useLocalOllama = process.env.TEST_OLLAMA === 'true';
const describeLocal = useLocalOllama ? describe : describe.skip;
const describeCloud = hasOllamaCloud ? describe : describe.skip;

const LOCAL_URL = process.env.OLLAMA_URL || 'http://localhost:11434';
const LOCAL_MODEL = process.env.TEST_MODEL || 'gpt-oss:20b';
const CLOUD_URL = process.env.OLLAMA_URL || 'https://ollama.com';
const CLOUD_MODEL = process.env.TOOL_GEN_MODEL || 'gpt-oss:20b';

async function isReachable(url: string): Promise<boolean> {
  try {
    const res = await fetch(`${url}/api/tags`, {
      headers: process.env.OLLAMA_API_KEY
        ? { Authorization: `Bearer ${process.env.OLLAMA_API_KEY}` }
        : undefined,
    });
    return res.ok;
  } catch {
    return false;
  }
}

describeLocal('self-modifying: agent run pipeline (Ollama)', () => {
  let llm: OllamaBackend;

  beforeAll(async () => {
    if (!(await isReachable(LOCAL_URL))) throw new Error('Ollama not running');
    llm = new OllamaBackend({ baseUrl: LOCAL_URL, apiKey: process.env.OLLAMA_API_KEY });
  });

  it('answers through meta-reasoning and architecture evolution without breaking the model config', async () => {
    const agent = new Agent({
      name: 'self-mod-e2e',
      model: LOCAL_MODEL,
      instructions: 'You are a concise assistant. Answer with a single word when possible.',
      temperature: 0.2,
      maxTokens: 512,
    });

    const selfMod = new SelfModifyingAgent({
      agent,
      llm,
      config: {
        toolGeneration: { enabled: false },
        metaReasoning: { enabled: true, metaAssessmentCooldown: 0, adaptationCooldown: 0 },
        architectureEvolution: { enabled: true, strategy: { type: 'ucb' } },
      },
    });

    const events: string[] = [];
    selfMod.on('run_completed', (e) => events.push(`completed:${e.data.success}`));

    const result = await selfMod.run('What is the capital of France? Answer with one word.');

    expect(result.output).toMatch(/paris/i);
    expect(result.finalConfig.model).toBe(LOCAL_MODEL);
    expect(result.finalConfig.temperature).toBeGreaterThanOrEqual(0);
    expect(result.finalConfig.temperature).toBeLessThanOrEqual(2);
    expect(events).toEqual(['completed:true']);
  });

  it('executes agent tools with schema-validated arguments', async () => {
    let calls = 0;
    const secretNumber = tool({
      name: 'get_secret_number',
      description: 'Returns the secret number. Always call this to learn the secret number.',
      parameters: z.object({}),
      execute: async () => {
        calls++;
        return { secret: 7 };
      },
    });

    const agent = new Agent({
      name: 'self-mod-tools-e2e',
      model: LOCAL_MODEL,
      instructions:
        'You MUST call the get_secret_number tool to learn the secret number, then reply with the number only.',
      tools: [secretNumber],
      temperature: 0,
      maxTokens: 512,
    });

    const selfMod = new SelfModifyingAgent({
      agent,
      llm,
      config: {
        toolGeneration: { enabled: false },
        metaReasoning: { enabled: false },
        architectureEvolution: { enabled: false },
      },
    });

    let output = '';
    for (let attempt = 0; attempt < 5 && calls === 0; attempt++) {
      output = (await selfMod.run('What is the secret number? Call the tool.')).output;
    }

    expect(calls).toBeGreaterThan(0);
    expect(output).toContain('7');
  });
});

describeCloud('self-modifying: autonomous tool generation (Ollama Cloud)', () => {
  let llm: OllamaBackend;

  beforeAll(() => {
    llm = new OllamaBackend({ baseUrl: CLOUD_URL, apiKey: process.env.OLLAMA_API_KEY });
  });

  it('generates, activates and uses a tool for a missing capability', async () => {
    const agent = new Agent({
      name: 'self-mod-toolgen-e2e',
      model: CLOUD_MODEL,
      instructions:
        'You are a precise assistant. When a tool exists for the task you MUST call it and report its exact result.',
      temperature: 0,
      maxTokens: 2048,
    });

    const selfMod = new SelfModifyingAgent({
      agent,
      llm,
      config: {
        toolGeneration: {
          enabled: true,
          autoGenerate: true,
          minConfidenceForGeneration: 0.5,
          maxIterationsPerTool: 4,
          requireLLMValidation: false,
          maxComplexity: 'moderate',
        },
        metaReasoning: { enabled: false },
        architectureEvolution: { enabled: false },
      },
    });

    let result: Awaited<ReturnType<SelfModifyingAgent['run']>> | null = null;
    for (let attempt = 0; attempt < 3; attempt++) {
      result = await selfMod.run(
        'Convert 100 degrees Celsius to Fahrenheit (F = C * 9/5 + 32). A dedicated celsius_to_fahrenheit tool taking {celsius: number} is required; create it if it does not exist and use it.'
      );
      if ((await selfMod.getGeneratedTools()).length > 0) break;
    }

    const active = await selfMod.getGeneratedTools();
    expect(active.length).toBeGreaterThan(0);
    expect(active.every((t) => t.status === 'active')).toBe(true);
    expect(result?.output).toMatch(/212/);
  }, 300_000);
});
