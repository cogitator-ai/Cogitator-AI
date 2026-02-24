import { describe, it, expect, beforeEach, vi } from 'vitest';
import { LangfuseExporter, createLangfuseExporter } from '../observability/langfuse';
import type { RunResult, Span, ToolCall, ToolResult } from '@cogitator-ai/types';

function createMockGeneration() {
  return {
    id: `gen_${Math.random().toString(36).slice(2, 8)}`,
    end: vi.fn(),
  };
}

function createMockSpan(): {
  id: string;
  span: ReturnType<typeof vi.fn>;
  generation: ReturnType<typeof vi.fn>;
  end: ReturnType<typeof vi.fn>;
} {
  return {
    id: `span_${Math.random().toString(36).slice(2, 8)}`,
    span: vi.fn(),
    generation: vi.fn(() => createMockGeneration()),
    end: vi.fn(),
  };
}

function createMockTrace() {
  const mockSpan = createMockSpan();
  const mockGeneration = createMockGeneration();

  return {
    id: `trace_${Math.random().toString(36).slice(2, 8)}`,
    span: vi.fn(() => mockSpan),
    generation: vi.fn(() => mockGeneration),
    update: vi.fn(),
    _mockSpan: mockSpan,
    _mockGeneration: mockGeneration,
  };
}

function createMockClient() {
  const mockTrace = createMockTrace();
  return {
    trace: vi.fn(() => mockTrace),
    flush: vi.fn().mockResolvedValue(undefined),
    shutdown: vi.fn().mockResolvedValue(undefined),
    _mockTrace: mockTrace,
  };
}

describe('LangfuseExporter', () => {
  let exporter: LangfuseExporter;
  let mockClient: ReturnType<typeof createMockClient>;

  beforeEach(() => {
    mockClient = createMockClient();
    exporter = new LangfuseExporter({
      publicKey: 'pk-test',
      secretKey: 'sk-test',
      enabled: true,
    });
    (exporter as unknown as { client: unknown }).client = mockClient;
  });

  describe('onRunStart', () => {
    it('creates a trace', () => {
      exporter.onRunStart({
        runId: 'run-1',
        agentId: 'agent-1',
        agentName: 'TestAgent',
        input: 'Hello',
        threadId: 'thread-1',
        model: 'gpt-4',
      });

      expect(mockClient.trace).toHaveBeenCalledWith(
        expect.objectContaining({
          id: 'run-1',
          name: 'TestAgent',
          input: 'Hello',
          sessionId: 'thread-1',
          tags: ['cogitator', 'TestAgent'],
        })
      );
    });

    it('does nothing without client', () => {
      const noClient = new LangfuseExporter({
        publicKey: 'pk',
        secretKey: 'sk',
        enabled: false,
      });

      noClient.onRunStart({
        runId: 'run-1',
        agentId: 'agent-1',
        agentName: 'Test',
        input: 'Hello',
      });
    });
  });

  describe('onRunComplete', () => {
    it('updates trace with output', () => {
      exporter.onRunStart({
        runId: 'run-1',
        agentId: 'agent-1',
        agentName: 'Test',
        input: 'Hello',
      });

      const result: RunResult = {
        runId: 'run-1',
        agentId: 'agent-1',
        threadId: 'thread-1',
        output: 'Response here',
        toolCalls: [],
        usage: { inputTokens: 100, outputTokens: 50, totalTokens: 150, cost: 0.01, duration: 500 },
        model: 'gpt-4',
        trace: { runId: 'run-1', spans: [], startTime: 0, endTime: 100 },
      };

      exporter.onRunComplete(result);

      const trace = mockClient._mockTrace;
      expect(trace.update).toHaveBeenCalledWith(
        expect.objectContaining({
          output: 'Response here',
        })
      );
    });

    it('ignores unknown run id', () => {
      const result: RunResult = {
        runId: 'unknown',
        agentId: 'agent-1',
        threadId: 'thread-1',
        output: 'Response',
        toolCalls: [],
        usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0, cost: 0, duration: 0 },
        model: 'gpt-4',
        trace: { runId: 'unknown', spans: [], startTime: 0, endTime: 0 },
      };

      exporter.onRunComplete(result);
    });
  });

  describe('onSpanStart / onSpanEnd', () => {
    it('creates and ends spans', () => {
      exporter.onRunStart({
        runId: 'run-1',
        agentId: 'agent-1',
        agentName: 'Test',
        input: 'Hello',
      });

      const span: Omit<Span, 'endTime' | 'duration' | 'status'> = {
        id: 'span-1',
        name: 'processing',
        startTime: Date.now(),
        attributes: { foo: 'bar' },
      };

      exporter.onSpanStart('run-1', span);
      expect(mockClient._mockTrace.span).toHaveBeenCalledWith(
        expect.objectContaining({ name: 'processing' })
      );

      const fullSpan: Span = {
        ...span,
        endTime: Date.now() + 100,
        duration: 100,
        status: 'ok',
        attributes: { foo: 'bar', output: 'result' },
      };

      exporter.onSpanEnd(fullSpan);

      const langfuseSpan = mockClient._mockTrace._mockSpan;
      expect(langfuseSpan.end).toHaveBeenCalledWith({ output: 'result' });
    });

    it('supports nested spans via parentId', () => {
      exporter.onRunStart({
        runId: 'run-1',
        agentId: 'agent-1',
        agentName: 'Test',
        input: 'Hello',
      });

      const parentSpan: Omit<Span, 'endTime' | 'duration' | 'status'> = {
        id: 'parent-1',
        name: 'parent',
        startTime: Date.now(),
        attributes: {},
      };

      exporter.onSpanStart('run-1', parentSpan);

      const childSpan: Omit<Span, 'endTime' | 'duration' | 'status'> = {
        id: 'child-1',
        name: 'child',
        parentId: 'parent-1',
        startTime: Date.now(),
        attributes: {},
      };

      exporter.onSpanStart('run-1', childSpan);

      expect(mockClient._mockTrace._mockSpan.span).toHaveBeenCalledWith(
        expect.objectContaining({ name: 'child' })
      );
    });
  });

  describe('onLLMCall / onLLMResponse', () => {
    it('creates generation and finalizes with usage', () => {
      exporter.onRunStart({
        runId: 'run-1',
        agentId: 'agent-1',
        agentName: 'Test',
        input: 'Hello',
      });

      const genId = exporter.onLLMCall({
        runId: 'run-1',
        model: 'gpt-4',
        messages: [{ role: 'user', content: 'Hello' }],
        temperature: 0.7,
        maxTokens: 1000,
      });

      expect(genId).toBeTruthy();
      expect(mockClient._mockTrace.generation).toHaveBeenCalledWith(
        expect.objectContaining({
          name: 'llm-call',
          model: 'gpt-4',
        })
      );

      exporter.onLLMResponse({
        generationId: genId,
        output: 'Hi there!',
        inputTokens: 10,
        outputTokens: 20,
      });

      const gen = mockClient._mockTrace._mockGeneration;
      expect(gen.end).toHaveBeenCalledWith({
        output: 'Hi there!',
        usage: { input: 10, output: 20, total: 30 },
      });
    });

    it('returns empty string for unknown run', () => {
      const genId = exporter.onLLMCall({
        runId: 'unknown',
        model: 'gpt-4',
        messages: [],
      });

      expect(genId).toBe('');
    });

    it('ignores response for unknown generation', () => {
      exporter.onLLMResponse({
        generationId: 'unknown',
        output: 'Hello',
      });
    });

    it('handles missing token counts', () => {
      exporter.onRunStart({
        runId: 'run-1',
        agentId: 'agent-1',
        agentName: 'Test',
        input: 'Hello',
      });

      const genId = exporter.onLLMCall({
        runId: 'run-1',
        model: 'gpt-4',
        messages: [],
      });

      exporter.onLLMResponse({
        generationId: genId,
        output: 'Result',
      });

      const gen = mockClient._mockTrace._mockGeneration;
      expect(gen.end).toHaveBeenCalledWith({
        output: 'Result',
        usage: { input: undefined, output: undefined, total: 0 },
      });
    });
  });

  describe('onToolCall / onToolResult', () => {
    it('creates span for tool and ends on result', () => {
      exporter.onRunStart({
        runId: 'run-1',
        agentId: 'agent-1',
        agentName: 'Test',
        input: 'Hello',
      });

      const toolCall: ToolCall = {
        id: 'call-1',
        name: 'calculator',
        arguments: { expression: '2+2' },
      };

      exporter.onToolCall('run-1', toolCall);

      expect(mockClient._mockTrace.span).toHaveBeenCalledWith(
        expect.objectContaining({
          name: 'tool:calculator',
          input: { expression: '2+2' },
        })
      );

      const toolResult: ToolResult = {
        callId: 'call-1',
        name: 'calculator',
        result: '4',
      };

      exporter.onToolResult('run-1', toolResult);
    });

    it('ignores tool call for unknown run', () => {
      const toolCall: ToolCall = {
        id: 'call-1',
        name: 'test',
        arguments: {},
      };

      exporter.onToolCall('unknown', toolCall);
    });
  });

  describe('flush / shutdown', () => {
    it('delegates to client', async () => {
      await exporter.flush();
      expect(mockClient.flush).toHaveBeenCalled();

      await exporter.shutdown();
      expect(mockClient.shutdown).toHaveBeenCalled();
    });

    it('handles no client gracefully', async () => {
      const noClient = new LangfuseExporter({
        publicKey: 'pk',
        secretKey: 'sk',
      });

      await noClient.flush();
      await noClient.shutdown();
    });
  });

  describe('createLangfuseExporter', () => {
    it('creates an instance', () => {
      const exp = createLangfuseExporter({
        publicKey: 'pk',
        secretKey: 'sk',
        enabled: true,
      });

      expect(exp).toBeInstanceOf(LangfuseExporter);
    });
  });
});
