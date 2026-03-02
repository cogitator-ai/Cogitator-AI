import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import {
  createTestCogitator,
  createTestAgent,
  createTestTools,
  isOllamaRunning,
} from '../../helpers/setup';
import type { Cogitator, RunResult, Span, ToolCall, ToolResult } from '@cogitator-ai/core';
import { tool } from '@cogitator-ai/core';
import { z } from 'zod';

const describeE2E = process.env.TEST_OLLAMA === 'true' ? describe : describe.skip;

describeE2E('Core: Callbacks & Run Metadata', () => {
  let cogitator: Cogitator;
  const tools = createTestTools();

  beforeAll(async () => {
    const available = await isOllamaRunning();
    if (!available) throw new Error('Ollama not running');
    cogitator = createTestCogitator();
  });

  afterAll(async () => {
    await cogitator.close();
  });

  describe('lifecycle callbacks', () => {
    it('fires onRunStart with correct metadata', { timeout: 120_000 }, async () => {
      const captured: Array<{ runId: string; agentId: string; input: string; threadId: string }> =
        [];

      const agent = createTestAgent({ instructions: 'Say hello.' });

      const result = await cogitator.run(agent, {
        input: 'Hello',
        onRunStart: (data) => captured.push(data),
      });

      expect(captured.length).toBe(1);
      expect(captured[0].runId).toBe(result.runId);
      expect(captured[0].agentId).toBe(result.agentId);
      expect(captured[0].input).toBe('Hello');
      expect(captured[0].threadId).toBe(result.threadId);
    });

    it('fires onRunComplete with RunResult', { timeout: 120_000 }, async () => {
      let capturedResult: RunResult | null = null;

      const agent = createTestAgent({ instructions: 'Say hi.' });

      const result = await cogitator.run(agent, {
        input: 'Hi',
        onRunComplete: (r) => {
          capturedResult = r;
        },
      });

      expect(capturedResult).not.toBeNull();
      expect(capturedResult!.runId).toBe(result.runId);
      expect(capturedResult!.output).toBe(result.output);
    });

    it(
      'fires onToolCall and onToolResult for tool interactions',
      { timeout: 120_000 },
      async () => {
        const toolCallsCaptured: ToolCall[] = [];
        const toolResultsCaptured: ToolResult[] = [];

        const agent = createTestAgent({
          instructions: 'Use the multiply tool for any multiplication. Never calculate manually.',
          tools: [tools.multiply],
        });

        let result: RunResult | undefined;
        for (let attempt = 0; attempt < 5; attempt++) {
          result = await cogitator.run(agent, {
            input: 'Multiply 3 by 4 using the multiply tool.',
            onToolCall: (call) => toolCallsCaptured.push(call),
            onToolResult: (res) => toolResultsCaptured.push(res),
          });
          if (result.toolCalls.length > 0) break;
          toolCallsCaptured.length = 0;
          toolResultsCaptured.length = 0;
        }

        expect(toolCallsCaptured.length).toBeGreaterThan(0);
        expect(toolCallsCaptured[0].name).toBe('multiply');
        expect(toolResultsCaptured.length).toBeGreaterThan(0);
        expect(JSON.stringify(toolResultsCaptured[0].result)).toContain('12');
      }
    );

    it('fires onSpan during execution', { timeout: 120_000 }, async () => {
      const spans: Span[] = [];

      const agent = createTestAgent({ instructions: 'Reply briefly.' });

      await cogitator.run(agent, {
        input: 'What is 1+1?',
        onSpan: (span) => spans.push(span),
      });

      expect(spans.length).toBeGreaterThan(0);
      const llmSpan = spans.find((s) => s.name.includes('llm') || s.name.includes('chat'));
      expect(llmSpan).toBeDefined();
      expect(llmSpan!.duration).toBeGreaterThan(0);
      expect(llmSpan!.status).toBe('ok');
    });
  });

  describe('tool context', () => {
    it('provides correct agentId and runId to tool execute', { timeout: 120_000 }, async () => {
      let capturedAgentId = '';
      let capturedRunId = '';
      let capturedSignal: AbortSignal | null = null;

      const contextTool = tool({
        name: 'context_check',
        description: 'A tool that captures its execution context. Always call this tool.',
        parameters: z.object({
          dummy: z.string().describe('Any string'),
        }),
        execute: async ({ dummy: _dummy }, context) => {
          capturedAgentId = context.agentId;
          capturedRunId = context.runId;
          capturedSignal = context.signal;
          return { captured: true };
        },
      });

      const agent = createTestAgent({
        instructions: 'You MUST call the context_check tool with dummy="test". Always.',
        tools: [contextTool],
      });

      let result: RunResult | undefined;
      for (let i = 0; i < 5; i++) {
        result = await cogitator.run(agent, {
          input: 'Call the context_check tool with dummy="test".',
        });
        if (result.toolCalls.length > 0) break;
      }

      expect(result).toBeDefined();
      if (result!.toolCalls.length > 0) {
        expect(capturedAgentId).toBe(agent.id);
        expect(capturedRunId).toBe(result!.runId);
        expect(capturedSignal).not.toBeNull();
        expect(capturedSignal).toBeInstanceOf(AbortSignal);
      }
    });
  });

  describe('RunResult structure', () => {
    it('contains all required fields with correct types', { timeout: 120_000 }, async () => {
      const agent = createTestAgent({
        instructions: 'Use the multiply tool for multiplication.',
        tools: [tools.multiply],
      });

      let result: RunResult | undefined;
      for (let attempt = 0; attempt < 5; attempt++) {
        result = await cogitator.run(agent, {
          input: 'Multiply 2 by 3 using the multiply tool.',
        });
        if (result.toolCalls.length > 0) break;
      }

      expect(result).toBeDefined();

      expect(typeof result!.output).toBe('string');
      expect(result!.output.length).toBeGreaterThan(0);

      expect(typeof result!.runId).toBe('string');
      expect(result!.runId).toMatch(/^run_/);

      expect(typeof result!.agentId).toBe('string');
      expect(result!.agentId).toBe(agent.id);

      expect(typeof result!.threadId).toBe('string');

      expect(result!.usage.inputTokens).toBeGreaterThan(0);
      expect(result!.usage.outputTokens).toBeGreaterThan(0);
      expect(result!.usage.totalTokens).toBeGreaterThanOrEqual(
        result!.usage.inputTokens + result!.usage.outputTokens
      );
      expect(result!.usage.duration).toBeGreaterThan(0);
      expect(typeof result!.usage.cost).toBe('number');

      expect(Array.isArray(result!.toolCalls)).toBe(true);
      expect(Array.isArray(result!.messages)).toBe(true);
      expect(result!.messages.length).toBeGreaterThan(0);

      expect(typeof result!.trace.traceId).toBe('string');
      expect(Array.isArray(result!.trace.spans)).toBe(true);
      expect(result!.trace.spans.length).toBeGreaterThan(0);

      const span = result!.trace.spans[0];
      expect(typeof span.id).toBe('string');
      expect(typeof span.name).toBe('string');
      expect(typeof span.duration).toBe('number');
      expect(['ok', 'error', 'unset']).toContain(span.status);
    });
  });

  describe('custom threadId', () => {
    it('uses provided threadId in result', { timeout: 120_000 }, async () => {
      const agent = createTestAgent({ instructions: 'Say hi.' });

      const result = await cogitator.run(agent, {
        input: 'Hello',
        threadId: 'custom-thread-12345',
      });

      expect(result.threadId).toBe('custom-thread-12345');
    });
  });

  describe('timeout enforcement', () => {
    it('aborts run when timeout is exceeded', { timeout: 30_000 }, async () => {
      const slowTool = tool({
        name: 'slow_operation',
        description: 'A very slow operation. Always call this tool.',
        parameters: z.object({ input: z.string() }),
        execute: async (_params, context) => {
          await new Promise<void>((resolve, reject) => {
            const timer = setTimeout(resolve, 30_000);
            context.signal.addEventListener('abort', () => {
              clearTimeout(timer);
              reject(new Error('Aborted'));
            });
          });
          return { done: true };
        },
      });

      const agent = createTestAgent({
        instructions: 'Call the slow_operation tool immediately.',
        tools: [slowTool],
        maxIterations: 1,
      });

      const start = Date.now();
      try {
        await cogitator.run(agent, {
          input: 'Call slow_operation with input="test".',
          timeout: 3_000,
        });
      } catch {
        const elapsed = Date.now() - start;
        expect(elapsed).toBeLessThan(15_000);
        return;
      }

      const elapsed = Date.now() - start;
      expect(elapsed).toBeLessThan(15_000);
    });
  });
});
