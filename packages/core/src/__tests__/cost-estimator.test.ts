import { describe, it, expect, beforeEach } from 'vitest';
import { TokenEstimator } from '../cost-routing/token-estimator';
import { CostEstimator } from '../cost-routing/cost-estimator';
import { Agent } from '../agent';
import { tool } from '../tool';
import { z } from 'zod';

describe('TokenEstimator', () => {
  let estimator: TokenEstimator;

  beforeEach(() => {
    estimator = new TokenEstimator();
  });

  describe('estimateFromText', () => {
    it('estimates tokens based on character count', () => {
      const text = 'Hello world';
      expect(estimator.estimateFromText(text)).toBe(3);
    });

    it('handles empty string', () => {
      expect(estimator.estimateFromText('')).toBe(0);
    });

    it('rounds up', () => {
      const text = 'Hi';
      expect(estimator.estimateFromText(text)).toBe(1);
    });
  });

  describe('estimateInputTokens', () => {
    it('estimates basic input tokens', () => {
      const result = estimator.estimateInputTokens({
        systemPrompt: 'You are a helpful assistant.',
        userInput: 'What is 2+2?',
        iterations: 1,
        includeMemory: false,
      });

      expect(result.min).toBeGreaterThan(0);
      expect(result.max).toBeGreaterThanOrEqual(result.min);
      expect(result.expected).toBeGreaterThanOrEqual(result.min);
      expect(result.expected).toBeLessThanOrEqual(result.max);
    });

    it('scales with iterations', () => {
      const single = estimator.estimateInputTokens({
        systemPrompt: 'Test',
        userInput: 'Test',
        iterations: 1,
        includeMemory: false,
      });

      const double = estimator.estimateInputTokens({
        systemPrompt: 'Test',
        userInput: 'Test',
        iterations: 2,
        includeMemory: false,
      });

      expect(double.expected).toBe(single.expected * 2);
    });

    it('includes memory tokens by default', () => {
      const withMemory = estimator.estimateInputTokens({
        systemPrompt: 'Test',
        userInput: 'Test',
        iterations: 1,
      });

      const withoutMemory = estimator.estimateInputTokens({
        systemPrompt: 'Test',
        userInput: 'Test',
        iterations: 1,
        includeMemory: false,
      });

      expect(withMemory.expected).toBeGreaterThan(withoutMemory.expected);
    });

    it('uses provided memory estimate', () => {
      const result = estimator.estimateInputTokens({
        systemPrompt: 'Test',
        userInput: 'Test',
        iterations: 1,
        includeMemory: true,
        memoryTokenEstimate: 500,
      });

      const baseResult = estimator.estimateInputTokens({
        systemPrompt: 'Test',
        userInput: 'Test',
        iterations: 1,
        includeMemory: false,
      });

      expect(result.expected).toBe(baseResult.expected + 500);
    });

    it('includes tool schema tokens', () => {
      const withTools = estimator.estimateInputTokens({
        systemPrompt: 'Test',
        userInput: 'Test',
        iterations: 1,
        includeMemory: false,
        toolSchemas: [
          {
            type: 'function',
            function: {
              name: 'search',
              description: 'Search the web',
              parameters: { type: 'object', properties: { query: { type: 'string' } } },
            },
          },
        ],
      });

      const withoutTools = estimator.estimateInputTokens({
        systemPrompt: 'Test',
        userInput: 'Test',
        iterations: 1,
        includeMemory: false,
      });

      expect(withTools.expected).toBeGreaterThan(withoutTools.expected);
    });
  });

  describe('estimateOutputTokens', () => {
    it('returns higher estimates for complex tasks', () => {
      const simple = estimator.estimateOutputTokens({
        complexity: 'simple',
        hasTools: false,
        toolCallCount: 0,
        iterations: 1,
      });

      const complex = estimator.estimateOutputTokens({
        complexity: 'complex',
        hasTools: false,
        toolCallCount: 0,
        iterations: 1,
      });

      expect(complex.expected).toBeGreaterThan(simple.expected);
    });

    it('adds tokens for tool calls', () => {
      const withoutTools = estimator.estimateOutputTokens({
        complexity: 'moderate',
        hasTools: false,
        toolCallCount: 0,
        iterations: 1,
      });

      const withTools = estimator.estimateOutputTokens({
        complexity: 'moderate',
        hasTools: true,
        toolCallCount: 3,
        iterations: 1,
      });

      expect(withTools.expected).toBeGreaterThan(withoutTools.expected);
    });

    it('scales with iterations', () => {
      const single = estimator.estimateOutputTokens({
        complexity: 'moderate',
        hasTools: false,
        toolCallCount: 0,
        iterations: 1,
      });

      const triple = estimator.estimateOutputTokens({
        complexity: 'moderate',
        hasTools: false,
        toolCallCount: 0,
        iterations: 3,
      });

      expect(triple.expected).toBe(single.expected * 3);
    });
  });

  describe('estimateIterations', () => {
    it('returns 1 for simple tasks without tools', () => {
      expect(estimator.estimateIterations('simple', false)).toBe(1);
    });

    it('increases with complexity', () => {
      const simple = estimator.estimateIterations('simple', false);
      const complex = estimator.estimateIterations('complex', false);

      expect(complex).toBeGreaterThan(simple);
    });

    it('increases with tools', () => {
      const withoutTools = estimator.estimateIterations('moderate', false);
      const withTools = estimator.estimateIterations('moderate', true);

      expect(withTools).toBeGreaterThan(withoutTools);
    });
  });

  describe('estimateToolCalls', () => {
    it('returns 0 when no tools available', () => {
      expect(estimator.estimateToolCalls('complex', 0)).toBe(0);
    });

    it('returns more calls for complex tasks', () => {
      const simple = estimator.estimateToolCalls('simple', 5);
      const complex = estimator.estimateToolCalls('complex', 5);

      expect(complex).toBeGreaterThan(simple);
    });

    it('limits calls based on available tools', () => {
      const result = estimator.estimateToolCalls('complex', 1);
      expect(result).toBeLessThanOrEqual(2);
    });
  });
});

describe('CostEstimator', () => {
  let estimator: CostEstimator;

  beforeEach(() => {
    estimator = new CostEstimator();
  });

  describe('estimate', () => {
    it('returns zero cost for local models', async () => {
      const agent = new Agent({
        name: 'local-agent',
        model: 'ollama/llama3.2',
        instructions: 'Test',
      });

      const result = await estimator.estimate({
        agent,
        input: 'Hello',
      });

      expect(result.expectedCost).toBe(0);
      expect(result.minCost).toBe(0);
      expect(result.maxCost).toBe(0);
      expect(result.confidence).toBe(1.0);
      expect(result.warnings).toContain('Local model (Ollama) - no API cost');
    });

    it('estimates cost for cloud models', async () => {
      const agent = new Agent({
        name: 'cloud-agent',
        model: 'openai/gpt-4o',
        instructions: 'You are a helpful assistant.',
      });

      const result = await estimator.estimate({
        agent,
        input: 'What is the meaning of life?',
      });

      expect(result.expectedCost).toBeGreaterThan(0);
      expect(result.minCost).toBeLessThanOrEqual(result.expectedCost);
      expect(result.maxCost).toBeGreaterThanOrEqual(result.expectedCost);
      expect(result.confidence).toBeGreaterThan(0);
      expect(result.confidence).toBeLessThanOrEqual(1);
    });

    it('provides breakdown information', async () => {
      const agent = new Agent({
        name: 'test-agent',
        model: 'openai/gpt-4o-mini',
        instructions: 'Test instructions',
      });

      const result = await estimator.estimate({
        agent,
        input: 'Simple question',
      });

      expect(result.breakdown).toBeDefined();
      expect(result.breakdown.inputTokens).toBeDefined();
      expect(result.breakdown.outputTokens).toBeDefined();
      expect(result.breakdown.model).toBe('gpt-4o-mini');
      expect(result.breakdown.provider).toBe('openai');
      expect(result.breakdown.pricePerMInputTokens).toBeGreaterThan(0);
      expect(result.breakdown.pricePerMOutputTokens).toBeGreaterThan(0);
    });

    it('respects assumeIterations option', async () => {
      const agent = new Agent({
        name: 'test-agent',
        model: 'openai/gpt-4o-mini',
        instructions: 'Test',
      });

      const auto = await estimator.estimate({
        agent,
        input: 'Simple task',
      });

      const forced = await estimator.estimate({
        agent,
        input: 'Simple task',
        options: { assumeIterations: 5 },
      });

      expect(forced.breakdown.iterationCount).toBe(5);
      expect(forced.expectedCost).toBeGreaterThan(auto.expectedCost);
    });

    it('respects assumeToolCalls option', async () => {
      const searchTool = tool({
        name: 'search',
        description: 'Search the web',
        parameters: z.object({ query: z.string() }),
        execute: async () => 'result',
      });

      const agent = new Agent({
        name: 'test-agent',
        model: 'openai/gpt-4o-mini',
        instructions: 'Test',
        tools: [searchTool],
      });

      const auto = await estimator.estimate({
        agent,
        input: 'Search for something',
      });

      const forced = await estimator.estimate({
        agent,
        input: 'Search for something',
        options: { assumeToolCalls: 10 },
      });

      expect(forced.breakdown.toolCallCount).toBe(10);
      expect(forced.expectedCost).toBeGreaterThan(auto.expectedCost);
    });

    it('excludes memory when requested', async () => {
      const agent = new Agent({
        name: 'test-agent',
        model: 'openai/gpt-4o-mini',
        instructions: 'Test',
      });

      const withMemory = await estimator.estimate({
        agent,
        input: 'Test',
        options: { includeMemory: true },
      });

      const withoutMemory = await estimator.estimate({
        agent,
        input: 'Test',
        options: { includeMemory: false },
      });

      expect(withMemory.expectedCost).toBeGreaterThan(withoutMemory.expectedCost);
    });

    it('warns about complex tasks', async () => {
      const agent = new Agent({
        name: 'test-agent',
        model: 'openai/gpt-4o',
        instructions: 'You are an expert analyst.',
      });

      const complexInput = Array(30)
        .fill(
          'Analyze this data thoroughly. Compare all aspects. ' +
            'Synthesize the findings. Create a comprehensive report.'
        )
        .join(' ');

      const result = await estimator.estimate({
        agent,
        input: complexInput,
      });

      expect(result.warnings.some((w) => w.includes('Complex task'))).toBe(true);
    });

    it('warns about many tool calls', async () => {
      const tools = Array(5)
        .fill(null)
        .map((_, i) =>
          tool({
            name: `tool${i}`,
            description: 'A tool',
            parameters: z.object({ x: z.string() }),
            execute: async () => 'ok',
          })
        );

      const agent = new Agent({
        name: 'test-agent',
        model: 'openai/gpt-4o',
        instructions: 'Use tools extensively.',
        tools,
      });

      const result = await estimator.estimate({
        agent,
        input: 'Complex task requiring many tool calls',
        options: { assumeToolCalls: 10 },
      });

      expect(result.warnings.some((w) => w.includes('Tool calls are unpredictable'))).toBe(true);
    });

    it('calculates reasonable confidence scores', async () => {
      const simpleAgent = new Agent({
        name: 'simple',
        model: 'openai/gpt-4o-mini',
        instructions: 'Be brief.',
      });

      const simpleResult = await estimator.estimate({
        agent: simpleAgent,
        input: 'Hi',
        options: { includeMemory: false },
      });

      expect(simpleResult.confidence).toBeGreaterThan(0.7);

      const complexAgent = new Agent({
        name: 'complex',
        model: 'openai/gpt-4o',
        instructions: 'Analyze everything in detail.',
        tools: [
          tool({
            name: 'analyze',
            description: 'Analyze data',
            parameters: z.object({ data: z.string() }),
            execute: async () => 'result',
          }),
        ],
      });

      const complexResult = await estimator.estimate({
        agent: complexAgent,
        input:
          'Analyze this comprehensive dataset and provide detailed insights across multiple dimensions',
        options: { assumeToolCalls: 5 },
      });

      expect(complexResult.confidence).toBeLessThan(simpleResult.confidence);
    });

    it('handles unknown models with fallback pricing', async () => {
      const agent = new Agent({
        name: 'unknown-model-agent',
        model: 'openai/some-future-model',
        instructions: 'Test',
      });

      const result = await estimator.estimate({
        agent,
        input: 'Test input',
      });

      expect(result.expectedCost).toBeGreaterThan(0);
      expect(result.warnings.some((w) => w.includes('pricing not available'))).toBe(true);
    });
  });
});
