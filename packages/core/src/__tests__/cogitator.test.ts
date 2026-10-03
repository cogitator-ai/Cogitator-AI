import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { Cogitator } from '../cogitator';
import { Agent } from '../agent';
import { tool } from '../tool';
import { z } from 'zod';
import type { ChatResponse, ChatStreamChunk, LLMBackend, ToolCall } from '@cogitator-ai/types';

const createMockBackend = () => {
  const responses: ChatResponse[] = [];
  let responseIndex = 0;

  const backend: LLMBackend = {
    provider: 'openai',
    chat: vi.fn(async () => {
      const response = responses[responseIndex] ?? responses[0];
      if (responseIndex < responses.length - 1) {
        responseIndex++;
      }
      return (
        response ?? {
          id: 'mock_response',
          content: 'Hello!',
          finishReason: 'stop' as const,
          usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 },
        }
      );
    }),
    chatStream: vi.fn(async function* (): AsyncGenerator<ChatStreamChunk> {
      yield {
        id: 'stream_1',
        delta: { content: 'Hello' },
      };
      yield {
        id: 'stream_1',
        delta: { content: ' world!' },
        finishReason: 'stop',
        usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 },
      };
    }),
  };

  return {
    backend,
    setResponse(response: ChatResponse) {
      responses.length = 0;
      responses.push(response);
      responseIndex = 0;
    },
    setResponses(newResponses: ChatResponse[]) {
      responses.length = 0;
      responses.push(...newResponses);
      responseIndex = 0;
    },
  };
};

vi.mock('../llm/index', async (importOriginal) => {
  const original = await importOriginal<typeof import('../llm/index')>();
  return {
    ...original,
    createLLMBackend: vi.fn(),
  };
});

describe('Cogitator', () => {
  let mockBackendHelper: ReturnType<typeof createMockBackend>;

  beforeEach(async () => {
    mockBackendHelper = createMockBackend();

    const { createLLMBackend } = await import('../llm/index');
    vi.mocked(createLLMBackend).mockReturnValue(mockBackendHelper.backend);
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  const createTestAgent = (overrides?: Partial<ConstructorParameters<typeof Agent>[0]>) =>
    new Agent({
      name: 'test-agent',
      model: 'openai/gpt-4o-mini',
      instructions: 'You are a helpful assistant.',
      ...overrides,
    });

  describe('constructor', () => {
    it('creates with default config', () => {
      const cog = new Cogitator();
      expect(cog).toBeInstanceOf(Cogitator);
      expect(cog.tools).toBeDefined();
    });

    it('accepts custom config', () => {
      const cog = new Cogitator({
        llm: { defaultProvider: 'anthropic' },
      });
      expect(cog).toBeInstanceOf(Cogitator);
    });
  });

  describe('run()', () => {
    describe('basic execution', () => {
      it('executes agent with simple input', async () => {
        const cog = new Cogitator();
        const agent = createTestAgent();

        mockBackendHelper.setResponse({
          id: 'resp_1',
          content: 'Hello, I am your assistant!',
          finishReason: 'stop',
          usage: { inputTokens: 20, outputTokens: 10, totalTokens: 30 },
        });

        const result = await cog.run(agent, { input: 'Hello' });

        expect(result.output).toBe('Hello, I am your assistant!');
        expect(mockBackendHelper.backend.chat).toHaveBeenCalledTimes(1);

        await cog.close();
      });

      it('rejects pre-aborted runs before calling the backend', async () => {
        const cog = new Cogitator();
        const agent = createTestAgent();
        const controller = new AbortController();
        controller.abort(new Error('Parent run cancelled'));

        await expect(cog.run(agent, { input: 'Hello', signal: controller.signal })).rejects.toThrow(
          'Parent run cancelled'
        );
        expect(mockBackendHelper.backend.chat).not.toHaveBeenCalled();

        await cog.close();
      });

      it('passes the run abort signal to backend chat requests', async () => {
        const cog = new Cogitator();
        const agent = createTestAgent();

        mockBackendHelper.setResponse({
          id: 'resp_1',
          content: 'Signal-aware response',
          finishReason: 'stop',
          usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 },
        });

        await cog.run(agent, { input: 'Hello' });

        expect(mockBackendHelper.backend.chat).toHaveBeenCalledWith(
          expect.objectContaining({
            signal: expect.any(AbortSignal),
          })
        );

        await cog.close();
      });

      it('aborts pending backend chat when the run times out', async () => {
        const cog = new Cogitator();
        const agent = createTestAgent();
        vi.mocked(mockBackendHelper.backend.chat).mockImplementation(
          () => new Promise<ChatResponse>(() => {})
        );

        await expect(cog.run(agent, { input: 'Hang', timeout: 5 })).rejects.toThrow(
          'Run timed out after 5ms'
        );

        await cog.close();
      });

      it('returns correct RunResult structure', async () => {
        const cog = new Cogitator();
        const agent = createTestAgent();

        mockBackendHelper.setResponse({
          id: 'resp_1',
          content: 'Test response',
          finishReason: 'stop',
          usage: { inputTokens: 15, outputTokens: 8, totalTokens: 23 },
        });

        const result = await cog.run(agent, { input: 'Test' });

        expect(result).toMatchObject({
          output: 'Test response',
          agentId: agent.id,
        });
        expect(result.runId).toMatch(/^run_/);
        expect(result.threadId).toMatch(/^thread_/);
        expect(result.usage).toMatchObject({
          inputTokens: 15,
          outputTokens: 8,
          totalTokens: 23,
        });
        expect(result.trace.traceId).toMatch(/^trace_/);
        expect(result.trace.spans.length).toBeGreaterThan(0);

        await cog.close();
      });

      it('generates unique runId and threadId', async () => {
        const cog = new Cogitator();
        const agent = createTestAgent();

        mockBackendHelper.setResponse({
          id: 'resp_1',
          content: 'Response',
          finishReason: 'stop',
          usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 },
        });

        const result1 = await cog.run(agent, { input: 'Test 1' });
        const result2 = await cog.run(agent, { input: 'Test 2' });

        expect(result1.runId).not.toBe(result2.runId);
        expect(result1.threadId).not.toBe(result2.threadId);

        await cog.close();
      });

      it('uses provided threadId', async () => {
        const cog = new Cogitator();
        const agent = createTestAgent();

        mockBackendHelper.setResponse({
          id: 'resp_1',
          content: 'Response',
          finishReason: 'stop',
          usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 },
        });

        const result = await cog.run(agent, {
          input: 'Test',
          threadId: 'my-custom-thread',
        });

        expect(result.threadId).toBe('my-custom-thread');

        await cog.close();
      });
    });

    describe('tool execution', () => {
      it('executes single tool call', async () => {
        const cog = new Cogitator();

        const calculatorTool = tool({
          name: 'calculator',
          description: 'Perform calculations',
          parameters: z.object({ expression: z.string() }),
          execute: async ({ expression }) => ({ result: eval(expression) }),
        });

        const agent = createTestAgent({ tools: [calculatorTool] });

        const toolCallResponse: ChatResponse = {
          id: 'resp_1',
          content: '',
          finishReason: 'tool_calls',
          toolCalls: [{ id: 'call_1', name: 'calculator', arguments: { expression: '2 + 2' } }],
          usage: { inputTokens: 20, outputTokens: 15, totalTokens: 35 },
        };

        const finalResponse: ChatResponse = {
          id: 'resp_2',
          content: 'The result is 4',
          finishReason: 'stop',
          usage: { inputTokens: 30, outputTokens: 10, totalTokens: 40 },
        };

        mockBackendHelper.setResponses([toolCallResponse, finalResponse]);

        const result = await cog.run(agent, { input: 'Calculate 2 + 2' });

        expect(result.output).toBe('The result is 4');
        expect(result.toolCalls).toHaveLength(1);
        expect(result.toolCalls[0].name).toBe('calculator');

        await cog.close();
      });

      it('executes multiple tool calls in sequence', async () => {
        const cog = new Cogitator();
        const executionOrder: string[] = [];

        const tool1 = tool({
          name: 'tool_a',
          description: 'Tool A',
          parameters: z.object({}),
          execute: async () => {
            executionOrder.push('tool_a');
            return { result: 'A' };
          },
        });

        const tool2 = tool({
          name: 'tool_b',
          description: 'Tool B',
          parameters: z.object({}),
          execute: async () => {
            executionOrder.push('tool_b');
            return { result: 'B' };
          },
        });

        const agent = createTestAgent({ tools: [tool1, tool2] });

        mockBackendHelper.setResponses([
          {
            id: 'resp_1',
            content: '',
            finishReason: 'tool_calls',
            toolCalls: [
              { id: 'call_1', name: 'tool_a', arguments: {} },
              { id: 'call_2', name: 'tool_b', arguments: {} },
            ],
            usage: { inputTokens: 20, outputTokens: 15, totalTokens: 35 },
          },
          {
            id: 'resp_2',
            content: 'Done with both tools',
            finishReason: 'stop',
            usage: { inputTokens: 30, outputTokens: 10, totalTokens: 40 },
          },
        ]);

        const result = await cog.run(agent, { input: 'Use both tools' });

        expect(executionOrder).toEqual(['tool_a', 'tool_b']);
        expect(result.toolCalls).toHaveLength(2);

        await cog.close();
      });

      it('executes parallel tool calls when parallelToolCalls=true', async () => {
        const cog = new Cogitator();
        const startTimes: number[] = [];

        const slowTool = tool({
          name: 'slow_tool',
          description: 'Slow tool',
          parameters: z.object({ id: z.number() }),
          execute: async ({ id }) => {
            startTimes.push(Date.now());
            await new Promise((r) => setTimeout(r, 50));
            return { result: `done_${id}` };
          },
        });

        const agent = createTestAgent({ tools: [slowTool] });

        mockBackendHelper.setResponses([
          {
            id: 'resp_1',
            content: '',
            finishReason: 'tool_calls',
            toolCalls: [
              { id: 'call_1', name: 'slow_tool', arguments: { id: 1 } },
              { id: 'call_2', name: 'slow_tool', arguments: { id: 2 } },
            ],
            usage: { inputTokens: 20, outputTokens: 15, totalTokens: 35 },
          },
          {
            id: 'resp_2',
            content: 'Done',
            finishReason: 'stop',
            usage: { inputTokens: 30, outputTokens: 10, totalTokens: 40 },
          },
        ]);

        await cog.run(agent, { input: 'Run parallel', parallelToolCalls: true });

        const timeDiff = Math.abs(startTimes[1] - startTimes[0]);
        expect(timeDiff).toBeLessThan(30);

        await cog.close();
      });

      it('handles tool errors gracefully', async () => {
        const cog = new Cogitator();

        const failingTool = tool({
          name: 'failing_tool',
          description: 'A tool that fails',
          parameters: z.object({}),
          execute: async () => {
            throw new Error('Tool execution failed');
          },
        });

        const agent = createTestAgent({ tools: [failingTool] });

        mockBackendHelper.setResponses([
          {
            id: 'resp_1',
            content: '',
            finishReason: 'tool_calls',
            toolCalls: [{ id: 'call_1', name: 'failing_tool', arguments: {} }],
            usage: { inputTokens: 20, outputTokens: 15, totalTokens: 35 },
          },
          {
            id: 'resp_2',
            content: 'The tool failed, but I can continue',
            finishReason: 'stop',
            usage: { inputTokens: 30, outputTokens: 10, totalTokens: 40 },
          },
        ]);

        const result = await cog.run(agent, { input: 'Use failing tool' });

        expect(result.output).toBe('The tool failed, but I can continue');

        await cog.close();
      });

      it('respects maxIterations limit', async () => {
        const cog = new Cogitator();

        const infiniteTool = tool({
          name: 'infinite_tool',
          description: 'Keeps calling itself',
          parameters: z.object({}),
          execute: async () => ({ result: 'call me again' }),
        });

        const agent = createTestAgent({
          tools: [infiniteTool],
          maxIterations: 3,
        });

        const toolCallResponse: ChatResponse = {
          id: 'resp_tool',
          content: '',
          finishReason: 'tool_calls',
          toolCalls: [{ id: 'call', name: 'infinite_tool', arguments: {} }],
          usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 },
        };

        mockBackendHelper.setResponses([
          toolCallResponse,
          toolCallResponse,
          toolCallResponse,
          {
            id: 'resp_final',
            content: 'Max iterations reached',
            finishReason: 'stop',
            usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 },
          },
        ]);

        const result = await cog.run(agent, { input: 'Loop forever' });

        expect(mockBackendHelper.backend.chat).toHaveBeenCalledTimes(3);
        expect(result.toolCalls.length).toBeLessThanOrEqual(3);

        await cog.close();
      });
    });

    describe('callbacks', () => {
      it('calls onRunStart at beginning', async () => {
        const cog = new Cogitator();
        const agent = createTestAgent();
        const onRunStart = vi.fn();

        mockBackendHelper.setResponse({
          id: 'resp_1',
          content: 'Response',
          finishReason: 'stop',
          usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 },
        });

        await cog.run(agent, { input: 'Test', onRunStart });

        expect(onRunStart).toHaveBeenCalledTimes(1);
        expect(onRunStart).toHaveBeenCalledWith(
          expect.objectContaining({
            runId: expect.stringMatching(/^run_/),
            agentId: agent.id,
            input: 'Test',
            threadId: expect.stringMatching(/^thread_/),
          })
        );

        await cog.close();
      });

      it('routes onRunStart failures through run error handling', async () => {
        const cog = new Cogitator();
        const agent = createTestAgent();
        const onRunError = vi.fn();
        const startError = new Error('start callback failed');

        await expect(
          cog.run(agent, {
            input: 'Test',
            timeout: 100,
            onRunStart: () => {
              throw startError;
            },
            onRunError,
          })
        ).rejects.toThrow('start callback failed');

        expect(onRunError).toHaveBeenCalledWith(startError, expect.stringMatching(/^run_/));
        expect(mockBackendHelper.backend.chat).not.toHaveBeenCalled();

        await cog.close();
      });

      it('calls onRunComplete on success', async () => {
        const cog = new Cogitator();
        const agent = createTestAgent();
        const onRunComplete = vi.fn();

        mockBackendHelper.setResponse({
          id: 'resp_1',
          content: 'Response',
          finishReason: 'stop',
          usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 },
        });

        await cog.run(agent, { input: 'Test', onRunComplete });

        expect(onRunComplete).toHaveBeenCalledTimes(1);
        expect(onRunComplete).toHaveBeenCalledWith(
          expect.objectContaining({
            output: 'Response',
            runId: expect.stringMatching(/^run_/),
          })
        );

        await cog.close();
      });

      it('calls onRunError on failure', async () => {
        const cog = new Cogitator();
        const agent = createTestAgent();
        const onRunError = vi.fn();

        vi.mocked(mockBackendHelper.backend.chat).mockRejectedValueOnce(new Error('API Error'));

        await expect(cog.run(agent, { input: 'Test', onRunError })).rejects.toThrow('API Error');

        expect(onRunError).toHaveBeenCalledTimes(1);
        expect(onRunError).toHaveBeenCalledWith(expect.any(Error), expect.stringMatching(/^run_/));

        await cog.close();
      });

      it('calls onToolCall during tool execution', async () => {
        const cog = new Cogitator();
        const onToolCall = vi.fn();

        const testTool = tool({
          name: 'test_tool',
          description: 'Test',
          parameters: z.object({}),
          execute: async () => ({ result: 'done' }),
        });

        const agent = createTestAgent({ tools: [testTool] });

        mockBackendHelper.setResponses([
          {
            id: 'resp_1',
            content: '',
            finishReason: 'tool_calls',
            toolCalls: [{ id: 'call_1', name: 'test_tool', arguments: {} }],
            usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 },
          },
          {
            id: 'resp_2',
            content: 'Done',
            finishReason: 'stop',
            usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 },
          },
        ]);

        await cog.run(agent, { input: 'Use tool', onToolCall });

        expect(onToolCall).toHaveBeenCalledTimes(1);
        expect(onToolCall).toHaveBeenCalledWith(
          expect.objectContaining({
            id: 'call_1',
            name: 'test_tool',
          })
        );

        await cog.close();
      });

      it('calls onToolResult after tool execution', async () => {
        const cog = new Cogitator();
        const onToolResult = vi.fn();

        const testTool = tool({
          name: 'test_tool',
          description: 'Test',
          parameters: z.object({}),
          execute: async () => ({ value: 42 }),
        });

        const agent = createTestAgent({ tools: [testTool] });

        mockBackendHelper.setResponses([
          {
            id: 'resp_1',
            content: '',
            finishReason: 'tool_calls',
            toolCalls: [{ id: 'call_1', name: 'test_tool', arguments: {} }],
            usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 },
          },
          {
            id: 'resp_2',
            content: 'Done',
            finishReason: 'stop',
            usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 },
          },
        ]);

        await cog.run(agent, { input: 'Use tool', onToolResult });

        expect(onToolResult).toHaveBeenCalledTimes(1);
        expect(onToolResult).toHaveBeenCalledWith(
          expect.objectContaining({
            callId: 'call_1',
            name: 'test_tool',
            result: { value: 42 },
          })
        );

        await cog.close();
      });

      it('calls onSpan for observability', async () => {
        const cog = new Cogitator();
        const agent = createTestAgent();
        const onSpan = vi.fn();

        mockBackendHelper.setResponse({
          id: 'resp_1',
          content: 'Response',
          finishReason: 'stop',
          usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 },
        });

        await cog.run(agent, { input: 'Test', onSpan });

        expect(onSpan).toHaveBeenCalled();
        const spans = onSpan.mock.calls.map((call) => call[0]);
        expect(spans.some((s) => s.name === 'llm.chat')).toBe(true);
        expect(spans.some((s) => s.name === 'agent.run')).toBe(true);

        await cog.close();
      });
    });

    describe('timeout', () => {
      it('aborts run after timeout between iterations', async () => {
        const cog = new Cogitator();

        const slowTool = tool({
          name: 'slow_tool',
          description: 'A slow tool',
          parameters: z.object({}),
          execute: async () => {
            await new Promise((r) => setTimeout(r, 100));
            return { result: 'done' };
          },
        });

        const agent = createTestAgent({
          tools: [slowTool],
          timeout: 50,
          maxIterations: 10,
        });

        mockBackendHelper.setResponses([
          {
            id: 'resp_1',
            content: '',
            finishReason: 'tool_calls',
            toolCalls: [{ id: 'call_1', name: 'slow_tool', arguments: {} }],
            usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 },
          },
          {
            id: 'resp_2',
            content: '',
            finishReason: 'tool_calls',
            toolCalls: [{ id: 'call_2', name: 'slow_tool', arguments: {} }],
            usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 },
          },
          {
            id: 'resp_3',
            content: 'Final',
            finishReason: 'stop',
            usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 },
          },
        ]);

        await expect(cog.run(agent, { input: 'Test' })).rejects.toThrow(/timed out|aborted/);

        await cog.close();
      });

      it('respects options.timeout override', async () => {
        const cog = new Cogitator();

        const slowTool = tool({
          name: 'slow_tool',
          description: 'A slow tool',
          parameters: z.object({}),
          execute: async () => {
            await new Promise((r) => setTimeout(r, 100));
            return { result: 'done' };
          },
        });

        const agent = createTestAgent({
          tools: [slowTool],
          timeout: 5000,
          maxIterations: 10,
        });

        mockBackendHelper.setResponses([
          {
            id: 'resp_1',
            content: '',
            finishReason: 'tool_calls',
            toolCalls: [{ id: 'call_1', name: 'slow_tool', arguments: {} }],
            usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 },
          },
          {
            id: 'resp_2',
            content: '',
            finishReason: 'tool_calls',
            toolCalls: [{ id: 'call_2', name: 'slow_tool', arguments: {} }],
            usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 },
          },
          {
            id: 'resp_3',
            content: 'Final',
            finishReason: 'stop',
            usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 },
          },
        ]);

        await expect(cog.run(agent, { input: 'Test', timeout: 50 })).rejects.toThrow(
          /timed out|aborted/
        );

        await cog.close();
      });

      it('completes successfully before timeout', async () => {
        const cog = new Cogitator();
        const agent = createTestAgent({ timeout: 5000 });

        mockBackendHelper.setResponse({
          id: 'resp_1',
          content: 'Quick response',
          finishReason: 'stop',
          usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 },
        });

        const result = await cog.run(agent, { input: 'Test' });

        expect(result.output).toBe('Quick response');

        await cog.close();
      });
    });

    describe('streaming', () => {
      it('streams tokens via onToken callback', async () => {
        const cog = new Cogitator();
        const agent = createTestAgent();
        const tokens: string[] = [];

        vi.mocked(mockBackendHelper.backend.chatStream).mockImplementation(async function* () {
          yield { id: 'stream', delta: { content: 'Hello' } };
          yield { id: 'stream', delta: { content: ' ' } };
          yield { id: 'stream', delta: { content: 'world' } };
          yield {
            id: 'stream',
            delta: { content: '!' },
            finishReason: 'stop',
            usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 },
          };
        });

        await cog.run(agent, {
          input: 'Test',
          stream: true,
          onToken: (token) => tokens.push(token),
        });

        expect(tokens).toEqual(['Hello', ' ', 'world', '!']);

        await cog.close();
      });

      it('streams tool calls', async () => {
        const cog = new Cogitator();
        const onToolCall = vi.fn();

        const testTool = tool({
          name: 'test_tool',
          description: 'Test',
          parameters: z.object({ query: z.string() }),
          execute: async () => ({ result: 'done' }),
        });

        const agent = createTestAgent({ tools: [testTool] });

        const toolCall: ToolCall = {
          id: 'call_1',
          name: 'test_tool',
          arguments: { query: 'test' },
        };

        vi.mocked(mockBackendHelper.backend.chatStream)
          .mockImplementationOnce(async function* () {
            yield {
              id: 'stream',
              delta: { toolCalls: [toolCall] },
              finishReason: 'tool_calls',
              usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 },
            };
          })
          .mockImplementationOnce(async function* () {
            yield {
              id: 'stream',
              delta: { content: 'Done' },
              finishReason: 'stop',
              usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 },
            };
          });

        await cog.run(agent, {
          input: 'Test',
          stream: true,
          onToken: () => {},
          onToolCall,
        });

        expect(onToolCall).toHaveBeenCalledWith(expect.objectContaining({ name: 'test_tool' }));

        await cog.close();
      });
    });
  });

  describe('initialization', () => {
    it('retries after an initialization failure', async () => {
      const { createLLMBackend } = await import('../llm/index');
      const cog = new Cogitator({
        reflection: { enabled: true },
      });
      const agent = createTestAgent();

      vi.mocked(createLLMBackend).mockImplementationOnce(() => {
        throw new Error('init failed');
      });

      await expect(cog.run(agent, { input: 'First attempt' })).rejects.toThrow('init failed');

      mockBackendHelper.setResponse({
        id: 'resp_1',
        content: 'Recovered',
        finishReason: 'stop',
        usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 },
      });

      const result = await cog.run(agent, { input: 'Second attempt' });

      expect(result.output).toBe('Recovered');

      await cog.close();
    });
  });

  describe('estimateCost()', () => {
    it('returns cost estimate for agent', async () => {
      const cog = new Cogitator();
      const agent = createTestAgent({ model: 'openai/gpt-4o' });

      const estimate = await cog.estimateCost({
        agent,
        input: 'Hello world',
      });

      expect(estimate).toMatchObject({
        minCost: expect.any(Number),
        maxCost: expect.any(Number),
        expectedCost: expect.any(Number),
        confidence: expect.any(Number),
      });
      expect(estimate.expectedCost).toBeGreaterThanOrEqual(estimate.minCost);
      expect(estimate.expectedCost).toBeLessThanOrEqual(estimate.maxCost);

      await cog.close();
    });
  });

  describe('close()', () => {
    it('clears backends', async () => {
      const cog = new Cogitator();
      const agent = createTestAgent();

      mockBackendHelper.setResponse({
        id: 'resp_1',
        content: 'Response',
        finishReason: 'stop',
        usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 },
      });

      await cog.run(agent, { input: 'Test' });
      await cog.close();

      expect(true).toBe(true);
    });
  });

  describe('tools registry', () => {
    it('exposes tools registry', () => {
      const cog = new Cogitator();
      expect(cog.tools).toBeDefined();
      expect(typeof cog.tools.register).toBe('function');
    });

    it('uses globally registered tools during runs', async () => {
      const cog = new Cogitator();
      const globalTool = tool({
        name: 'global_lookup',
        description: 'Global lookup tool',
        parameters: z.object({ query: z.string() }),
        execute: async ({ query }) => ({ source: 'global', query }),
      });
      const onToolResult = vi.fn();
      const agent = createTestAgent();

      cog.tools.register(globalTool);
      mockBackendHelper.setResponses([
        {
          id: 'resp_1',
          content: '',
          finishReason: 'tool_calls',
          toolCalls: [{ id: 'call_1', name: 'global_lookup', arguments: { query: 'status' } }],
          usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 },
        },
        {
          id: 'resp_2',
          content: 'Global lookup complete',
          finishReason: 'stop',
          usage: { inputTokens: 12, outputTokens: 6, totalTokens: 18 },
        },
      ]);

      const result = await cog.run(agent, { input: 'Lookup status', onToolResult });

      expect(result.output).toBe('Global lookup complete');
      expect(result.toolCalls).toHaveLength(1);
      expect(onToolResult).toHaveBeenCalledWith(
        expect.objectContaining({
          callId: 'call_1',
          name: 'global_lookup',
          result: { source: 'global', query: 'status' },
        })
      );

      await cog.close();
    });

    it('lets agent tools override global tools with the same name', async () => {
      const cog = new Cogitator();
      const globalTool = tool({
        name: 'shared_tool',
        description: 'Global shared tool',
        parameters: z.object({}),
        execute: async () => ({ source: 'global' }),
      });
      const agentTool = tool({
        name: 'shared_tool',
        description: 'Agent shared tool',
        parameters: z.object({}),
        execute: async () => ({ source: 'agent' }),
      });
      const onToolResult = vi.fn();
      const agent = createTestAgent({ tools: [agentTool] });

      cog.tools.register(globalTool);
      mockBackendHelper.setResponses([
        {
          id: 'resp_1',
          content: '',
          finishReason: 'tool_calls',
          toolCalls: [{ id: 'call_1', name: 'shared_tool', arguments: {} }],
          usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 },
        },
        {
          id: 'resp_2',
          content: 'Agent tool complete',
          finishReason: 'stop',
          usage: { inputTokens: 12, outputTokens: 6, totalTokens: 18 },
        },
      ]);

      await cog.run(agent, { input: 'Use shared tool', onToolResult });

      expect(onToolResult).toHaveBeenCalledWith(
        expect.objectContaining({
          callId: 'call_1',
          name: 'shared_tool',
          result: { source: 'agent' },
        })
      );

      await cog.close();
    });
  });

  describe('audit regressions', () => {
    it('links child spans to the emitted root span', async () => {
      const cog = new Cogitator();
      const echo = tool({
        name: 'echo',
        description: 'Echo',
        parameters: z.object({ text: z.string() }),
        execute: async ({ text }) => text,
      });
      mockBackendHelper.setResponses([
        {
          id: 'r1',
          content: '',
          finishReason: 'tool_calls',
          toolCalls: [{ id: 'c1', name: 'echo', arguments: { text: 'hi' } }],
          usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
        },
        {
          id: 'r2',
          content: 'done',
          finishReason: 'stop',
          usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
        },
      ]);

      const result = await cog.run(createTestAgent({ tools: [echo] }), { input: 'echo hi' });

      const [root, ...children] = result.trace.spans;
      expect(root.name).toBe('agent.run');
      expect(root.parentId).toBeUndefined();
      expect(children.length).toBeGreaterThanOrEqual(3);
      for (const child of children) {
        expect(child.parentId).toBe(root.id);
      }

      await cog.close();
    });

    it('persists duplicate-call errors so stored history keeps tool pairs intact', async () => {
      const cog = new Cogitator({ memory: { adapter: 'memory' } });
      const echo = tool({
        name: 'echo',
        description: 'Echo',
        parameters: z.object({ text: z.string() }),
        execute: async ({ text }) => text,
      });
      const repeated: ChatResponse = {
        id: 'r',
        content: '',
        finishReason: 'tool_calls',
        toolCalls: [{ id: 'c1', name: 'echo', arguments: { text: 'hi' } }],
        usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
      };
      mockBackendHelper.setResponses([
        repeated,
        { ...repeated, toolCalls: [{ id: 'c2', name: 'echo', arguments: { text: 'hi' } }] },
        {
          id: 'r3',
          content: 'done',
          finishReason: 'stop',
          usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
        },
      ]);

      await cog.run(createTestAgent({ tools: [echo] }), {
        input: 'echo hi twice',
        threadId: 'thread_dup',
      });

      const entries = await cog.memory!.getEntries({ threadId: 'thread_dup' });
      expect(entries.success).toBe(true);
      const toolMessages = entries.success
        ? entries.data.map((e) => e.message).filter((m) => m.role === 'tool')
        : [];
      expect(toolMessages.map((m) => m.toolCallId)).toEqual(['c1', 'c2']);
      expect(toolMessages[1].content).toContain('Duplicate tool call detected');

      await cog.close();
    });

    it('does not send orphaned tool results from loaded history', async () => {
      const cog = new Cogitator({ memory: { adapter: 'memory' } });
      const agent = createTestAgent();
      await cog.run(agent, { input: 'warm up', threadId: 'thread_orphan' });
      await cog.memory!.addEntry({
        threadId: 'thread_orphan',
        message: { role: 'tool', content: '"stale"', toolCallId: 'missing', name: 'echo' },
        tokenCount: 3,
      });
      vi.mocked(mockBackendHelper.backend.chat).mockClear();

      await cog.run(agent, { input: 'again', threadId: 'thread_orphan' });

      const sent = vi.mocked(mockBackendHelper.backend.chat).mock.calls[0][0].messages;
      expect(sent.some((m) => m.role === 'tool')).toBe(false);
      expect(sent.filter((m) => m.role === 'user').pop()).toEqual({
        role: 'user',
        content: 'again',
      });

      await cog.close();
    });

    it('sends provider-stripped model ids to reflection and defaults to the agent model', async () => {
      const reflectionCalls = () =>
        vi
          .mocked(mockBackendHelper.backend.chat)
          .mock.calls.map(([request]) => request)
          .filter((request) => {
            const system = request.messages[0];
            return (
              system?.role === 'system' &&
              typeof system.content === 'string' &&
              system.content.startsWith('You are a reflection assistant')
            );
          });

      const explicit = new Cogitator({
        reflection: { enabled: true, reflectAtEnd: true, reflectionModel: 'openai/gpt-4o-mini' },
      });
      await explicit.run(createTestAgent(), { input: 'Hi' });
      expect(reflectionCalls().map((r) => r.model)).toEqual(['gpt-4o-mini']);
      await explicit.close();

      vi.mocked(mockBackendHelper.backend.chat).mockClear();

      const inherited = new Cogitator({ reflection: { enabled: true, reflectAtEnd: true } });
      await inherited.run(createTestAgent({ model: 'openai/gpt-4.1' }), { input: 'Hi' });
      expect(reflectionCalls().map((r) => r.model)).toEqual(['gpt-4.1']);
      await inherited.close();
    });

    it('runs the LLM injection classifier with the agent model when llmModel is unset', async () => {
      const cog = new Cogitator({
        security: {
          promptInjection: {
            detectInjection: true,
            detectJailbreak: true,
            detectRoleplay: true,
            detectEncoding: true,
            detectContextManipulation: true,
            classifier: 'llm',
            action: 'block',
            threshold: 0.7,
          },
        },
      });
      vi.mocked(mockBackendHelper.backend.chat).mockImplementationOnce(async () => ({
        id: 'sec',
        content: '{"threats": []}',
        finishReason: 'stop',
        usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
      }));

      const result = await cog.run(createTestAgent({ model: 'openai/gpt-4.1-mini' }), {
        input: 'What is the capital of France?',
      });

      const classifierRequest = vi.mocked(mockBackendHelper.backend.chat).mock.calls[0][0];
      expect(classifierRequest.model).toBe('gpt-4.1-mini');
      expect(result.output).toBe('Hello!');

      await cog.close();
    });

    it('sends the routed model id to the routed provider even when the agent pins a provider', async () => {
      const { createLLMBackend } = await import('../llm/index');
      const cog = new Cogitator({ costRouting: { enabled: true, autoSelectModel: true } });

      const result = await cog.run(
        createTestAgent({ model: 'meta-llama/llama-3-70b', provider: 'openai' }),
        { input: 'Say hello' }
      );

      const [routedProvider, ...rest] = result.modelUsed!.split('/');
      const routedModelId = rest.join('/');
      const chatRequest = vi.mocked(mockBackendHelper.backend.chat).mock.calls[0][0];
      expect(chatRequest.model).toBe(routedModelId);
      expect(vi.mocked(createLLMBackend).mock.calls.at(-1)?.[0]).toBe(routedProvider);

      await cog.close();
    });

    describe('audio inputs', () => {
      const originalFetch = globalThis.fetch;
      const originalKey = process.env.OPENAI_API_KEY;

      afterEach(() => {
        globalThis.fetch = originalFetch;
        if (originalKey === undefined) {
          delete process.env.OPENAI_API_KEY;
        } else {
          process.env.OPENAI_API_KEY = originalKey;
        }
      });

      it('transcribes audio and prepends the transcript to the input', async () => {
        const fetchMock = vi.fn(
          async () => new Response(JSON.stringify({ text: 'meeting notes' }))
        );
        globalThis.fetch = fetchMock as typeof fetch;
        const cog = new Cogitator({ llm: { providers: { openai: { apiKey: 'sk-test' } } } });

        await cog.run(createTestAgent(), {
          input: 'Summarize this',
          audio: [{ data: Buffer.from('fake audio').toString('base64'), format: 'wav' }],
        });

        expect(fetchMock).toHaveBeenCalledWith(
          'https://api.openai.com/v1/audio/transcriptions',
          expect.objectContaining({
            method: 'POST',
            headers: { Authorization: 'Bearer sk-test' },
          })
        );
        const sent = vi.mocked(mockBackendHelper.backend.chat).mock.calls[0][0].messages;
        expect(sent.filter((m) => m.role === 'user').pop()).toEqual({
          role: 'user',
          content: '[Audio transcription]: meeting notes\n\nSummarize this',
        });

        await cog.close();
      });

      it('fails clearly when audio is passed without an OpenAI key', async () => {
        delete process.env.OPENAI_API_KEY;
        const cog = new Cogitator();

        await expect(
          cog.run(createTestAgent(), {
            input: 'Summarize this',
            audio: [{ data: 'AAAA', format: 'mp3' }],
          })
        ).rejects.toThrow('Audio inputs require an OpenAI API key');
        expect(mockBackendHelper.backend.chat).not.toHaveBeenCalled();

        await cog.close();
      });
    });
  });
});
