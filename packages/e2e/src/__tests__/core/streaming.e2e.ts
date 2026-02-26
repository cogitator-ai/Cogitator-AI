import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import {
  createTestCogitator,
  createTestAgent,
  createTestTools,
  createOllamaBackend,
  isOllamaRunning,
  getTestModel,
} from '../../helpers/setup';
import type { Cogitator, RunResult } from '@cogitator-ai/core';
import type { OllamaBackend } from '@cogitator-ai/core';

const describeE2E = process.env.TEST_OLLAMA === 'true' ? describe : describe.skip;

describeE2E('Core: Streaming', () => {
  let backend: OllamaBackend;
  let cogitator: Cogitator;

  beforeAll(async () => {
    const available = await isOllamaRunning();
    if (!available) throw new Error('Ollama not running');
    backend = createOllamaBackend();
    cogitator = createTestCogitator();
  });

  afterAll(async () => {
    await cogitator.close();
  });

  it('delivers chunks incrementally', async () => {
    const chunks: string[] = [];

    for await (const chunk of backend.chatStream({
      model: getTestModel(),
      messages: [{ role: 'user', content: 'Count from 1 to 5.' }],
      maxTokens: 256,
    })) {
      if (chunk.delta.content) {
        chunks.push(chunk.delta.content);
      }
    }

    expect(chunks.length).toBeGreaterThan(1);
    const fullText = chunks.join('');
    expect(fullText.length).toBeGreaterThan(0);
    expect(fullText).toContain('1');
  });

  it('onToken callback receives all chunks that form the final output', async () => {
    const tokens: string[] = [];
    const agent = createTestAgent({
      instructions: 'Reply briefly.',
    });

    const result = await cogitator.run(agent, {
      input: 'Count from 1 to 3.',
      stream: true,
      onToken: (token) => tokens.push(token),
    });

    expect(tokens.length).toBeGreaterThan(0);
    const concatenated = tokens.join('');
    expect(concatenated).toBe(result.output);
  });

  it('streams with tool calls', async () => {
    const tools = createTestTools();
    const agent = createTestAgent({
      instructions:
        'You are a calculator. You CANNOT do math. You MUST call the multiply tool for ANY multiplication. Always call the tool.',
      tools: [tools.multiply],
    });

    let result: RunResult | undefined;
    let tokens: string[] = [];
    for (let attempt = 0; attempt < 8; attempt++) {
      const attemptTokens: string[] = [];
      result = await cogitator.run(agent, {
        input: 'Call the multiply tool with a=3, b=5. Do NOT answer without using the tool.',
        stream: true,
        onToken: (token) => attemptTokens.push(token),
      });
      if (result.toolCalls.length > 0) {
        tokens = attemptTokens;
        break;
      }
    }

    expect(result).toBeDefined();
    expect(result!.toolCalls.length).toBeGreaterThan(0);
    expect(result!.toolCalls.some((tc) => tc.name === 'multiply')).toBe(true);

    const finalOutput = result!.output;
    const concatenated = tokens.join('');
    expect(concatenated).toBe(finalOutput);
  });

  it('reports usage in final chunk', async () => {
    let lastUsage: { inputTokens: number; outputTokens: number } | undefined;

    for await (const chunk of backend.chatStream({
      model: getTestModel(),
      messages: [{ role: 'user', content: 'Say hello.' }],
      maxTokens: 50,
    })) {
      if (chunk.usage) {
        lastUsage = chunk.usage;
      }
    }

    expect(lastUsage).toBeDefined();
    expect(lastUsage!.inputTokens).toBeGreaterThan(0);
    expect(lastUsage!.outputTokens).toBeGreaterThan(0);
  });
});
