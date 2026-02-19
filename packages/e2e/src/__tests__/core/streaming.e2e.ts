import { describe, it, expect, beforeAll } from 'vitest';
import { createOllamaBackend, isOllamaRunning, getTestModel } from '../../helpers/setup';
import type { OllamaBackend } from '@cogitator-ai/core';

const describeE2E = process.env.TEST_OLLAMA === 'true' ? describe : describe.skip;

describeE2E('Core: Streaming', () => {
  let backend: OllamaBackend;

  beforeAll(async () => {
    const available = await isOllamaRunning();
    if (!available) throw new Error('Ollama not running');
    backend = createOllamaBackend();
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

  it('streams with tool calls', async () => {
    const chunks: Array<{ content?: string; toolCalls?: unknown[] }> = [];

    for await (const chunk of backend.chatStream({
      model: getTestModel(),
      messages: [{ role: 'user', content: 'What is 5 + 3? Use the calculator tool.' }],
      tools: [
        {
          name: 'calculator',
          description: 'Perform arithmetic',
          parameters: {
            type: 'object',
            properties: {
              expression: { type: 'string' },
            },
            required: ['expression'],
          },
        },
      ],
      maxTokens: 256,
    })) {
      chunks.push({
        content: chunk.delta.content,
        toolCalls: chunk.delta.toolCalls,
      });
    }

    expect(chunks.length).toBeGreaterThan(0);
    const hasToolCall = chunks.some((c) => c.toolCalls && c.toolCalls.length > 0);
    const hasContent = chunks.some((c) => c.content && c.content.length > 0);
    expect(hasToolCall || hasContent).toBe(true);
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
