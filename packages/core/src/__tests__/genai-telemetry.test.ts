import { describe, it, expect, vi, afterEach } from 'vitest';
import { z } from 'zod';
import type {
  ChatRequest,
  ChatResponse,
  ChatStreamChunk,
  DecisionBackend,
  LLMBackend,
  RunObserver,
  Span,
} from '@cogitator-ai/types';
import { Cogitator } from '../cogitator';
import { Agent } from '../agent';
import { tool } from '../tool';
import { toolContent } from '../tool-content';
import { AgentOptimizer } from '../learning/agent-optimizer';
import { InMemoryTraceStore } from '../learning/trace-store';
import { registerTelemetry } from '../observability/telemetry';
import {
  currentTraceContext,
  formatTraceparent,
  withTraceContext,
  isSpanId,
  isTraceId,
  newSpanId,
  newTraceId,
  parseTraceparent,
} from '../observability/trace-context';
import { GEN_AI, genAiProviderName, genAiSpanName, safeJson } from '../observability/genai';
import { OTLPExporter } from '../observability/opentelemetry';

/** A backend that answers with a call of `lookup` first when the input asks for it, then text. */
function backend(provider = 'anthropic'): LLMBackend & { requests: ChatRequest[] } {
  const requests: ChatRequest[] = [];
  const answer = (request: ChatRequest): ChatResponse => {
    requests.push(request);
    const asked = request.messages.some(
      (message) => typeof message.content === 'string' && message.content.includes('look it up')
    );
    const answered = request.messages.some((message) => message.role === 'tool');
    if (asked && !answered) {
      return {
        id: 'resp_tool',
        content: '',
        toolCalls: [{ id: 'call_1', name: 'lookup', arguments: { term: 'otel' } }],
        finishReason: 'tool_calls',
        usage: { inputTokens: 10, outputTokens: 4, totalTokens: 14 },
      };
    }
    return {
      id: 'resp_text',
      content: 'the answer',
      finishReason: 'stop',
      usage: {
        inputTokens: 12,
        outputTokens: 3,
        totalTokens: 15,
        cachedInputTokens: 5,
        reasoningTokens: 1,
      },
    };
  };
  return {
    provider,
    requests,
    chat: vi.fn(async (request: ChatRequest) => answer(request)),
    chatStream: vi.fn(async function* (request: ChatRequest): AsyncGenerator<ChatStreamChunk> {
      const response = answer(request);
      await new Promise((resolve) => setTimeout(resolve, 15));
      yield { id: response.id, delta: { content: response.content } };
      yield {
        id: response.id,
        delta: {},
        finishReason: response.finishReason,
        usage: response.usage,
      };
    }),
  };
}

const runtimes: Cogitator[] = [];
const unregister: Array<() => void> = [];

function runtime(options: { observers?: RunObserver[]; captureContent?: boolean } = {}) {
  const llm = backend();
  const cog = new Cogitator({
    llm: { backends: { test: llm } },
    observers: options.observers ?? [],
    ...(options.captureContent !== undefined && {
      telemetry: { captureContent: options.captureContent },
    }),
  });
  runtimes.push(cog);
  return { cog, llm };
}

afterEach(async () => {
  for (const off of unregister.splice(0)) off();
  for (const cog of runtimes.splice(0)) await cog.close();
  vi.restoreAllMocks();
});

const lookup = tool({
  name: 'lookup',
  description: 'Looks a term up',
  parameters: z.object({ term: z.string() }),
  execute: async ({ term }) => `found ${term}`,
});

const agent = new Agent({
  name: 'researcher',
  description: 'Finds things out',
  model: 'test/model-1',
  instructions: 'Answer briefly.',
  tools: [lookup],
  temperature: 0.3,
  maxTokens: 256,
});

const byName = (spans: readonly Span[], name: string) => spans.filter((s) => s.name === name);

describe('trace context', () => {
  it('makes W3C ids and reads and writes traceparent headers', () => {
    const traceId = newTraceId();
    const spanId = newSpanId();
    expect(isTraceId(traceId)).toBe(true);
    expect(isSpanId(spanId)).toBe(true);
    expect(parseTraceparent(formatTraceparent(traceId, spanId))).toEqual({
      traceId,
      parentSpanId: spanId,
    });
    expect(parseTraceparent(`00-${'0'.repeat(32)}-${spanId}-01`)).toBeUndefined();
    expect(parseTraceparent(`00-${traceId}-${spanId}`)).toBeUndefined();
    expect(parseTraceparent(`ff-${traceId}-${spanId}-01`)).toBeUndefined();
    expect(parseTraceparent(`00-${traceId}-${spanId}-01-extra`)).toBeUndefined();
    expect(parseTraceparent(`01-${traceId}-${spanId}-01-extra`)).toEqual({
      traceId,
      parentSpanId: spanId,
    });
  });
});

describe('GenAI semantic conventions on run spans', () => {
  it('records chat, execute_tool and invoke_agent attributes next to the old ones', async () => {
    const { cog } = runtime();
    const result = await cog.run(agent, { input: 'please look it up', threadId: 'thread-1' });
    const spans = result.trace.spans;

    expect(isTraceId(result.trace.traceId)).toBe(true);
    const [root] = byName(spans, 'agent.run');
    expect(root.kind).toBe('internal');
    expect(root.parentId).toBeUndefined();
    expect(root.attributes).toMatchObject({
      'agent.name': 'researcher',
      [GEN_AI.operationName]: 'invoke_agent',
      [GEN_AI.agentName]: 'researcher',
      [GEN_AI.agentDescription]: 'Finds things out',
      [GEN_AI.conversationId]: 'thread-1',
      [GEN_AI.usageInputTokens]: 22,
      [GEN_AI.usageOutputTokens]: 7,
      [GEN_AI.usageCacheReadInputTokens]: 5,
    });

    const chats = byName(spans, 'llm.chat');
    expect(chats).toHaveLength(2);
    expect(chats[1].attributes).toMatchObject({
      'llm.model': 'model-1',
      [GEN_AI.operationName]: 'chat',
      [GEN_AI.providerName]: 'anthropic',
      [GEN_AI.requestModel]: 'model-1',
      [GEN_AI.requestTemperature]: 0.3,
      [GEN_AI.requestMaxTokens]: 256,
      [GEN_AI.responseId]: 'resp_text',
      [GEN_AI.responseFinishReasons]: ['stop'],
      [GEN_AI.usageInputTokens]: 12,
      [GEN_AI.usageCacheReadInputTokens]: 5,
      [GEN_AI.usageReasoningOutputTokens]: 1,
      [GEN_AI.conversationId]: 'thread-1',
    });
    expect(chats[0].attributes[GEN_AI.responseFinishReasons]).toEqual(['tool_call']);
    expect(chats.every((span) => span.parentId === root.id)).toBe(true);

    const [toolSpan] = byName(spans, 'tool.lookup');
    expect(toolSpan.attributes).toMatchObject({
      [GEN_AI.operationName]: 'execute_tool',
      [GEN_AI.toolName]: 'lookup',
      [GEN_AI.toolCallId]: 'call_1',
      [GEN_AI.toolType]: 'function',
    });
    expect(isSpanId(toolSpan.id)).toBe(true);
    expect(spans.every((span) => span.traceId === result.trace.traceId)).toBe(true);
  });

  it('records no content unless asked to', async () => {
    const { cog } = runtime();
    const result = await cog.run(agent, { input: 'please look it up' });
    for (const span of result.trace.spans) {
      expect(span.attributes[GEN_AI.inputMessages]).toBeUndefined();
      expect(span.attributes[GEN_AI.toolCallArguments]).toBeUndefined();
    }
  });

  it('records content in the convention shapes when the runtime opts in', async () => {
    const { cog } = runtime({ captureContent: true });
    const result = await cog.run(agent, { input: 'please look it up' });
    const [first, second] = byName(result.trace.spans, 'llm.chat');

    expect(JSON.parse(String(first.attributes[GEN_AI.systemInstructions]))).toEqual([
      { type: 'text', content: expect.stringContaining('Answer briefly.') },
    ]);
    expect(JSON.parse(String(first.attributes[GEN_AI.inputMessages]))).toEqual([
      { role: 'user', parts: [{ type: 'text', content: 'please look it up' }] },
    ]);
    expect(JSON.parse(String(first.attributes[GEN_AI.outputMessages]))).toEqual([
      {
        role: 'assistant',
        parts: [{ type: 'tool_call', id: 'call_1', name: 'lookup', arguments: { term: 'otel' } }],
        finish_reason: 'tool_call',
      },
    ]);
    expect(JSON.parse(String(first.attributes[GEN_AI.toolDefinitions]))).toEqual([
      expect.objectContaining({ type: 'function', name: 'lookup', description: 'Looks a term up' }),
    ]);
    const input = JSON.parse(String(second.attributes[GEN_AI.inputMessages])) as Array<{
      role: string;
      parts: Array<Record<string, unknown>>;
    }>;
    expect(input.at(-1)).toEqual({
      role: 'tool',
      parts: [{ type: 'tool_call_response', id: 'call_1', response: expect.any(String) }],
    });

    const [toolSpan] = byName(result.trace.spans, 'tool.lookup');
    expect(JSON.parse(String(toolSpan.attributes[GEN_AI.toolCallArguments]))).toEqual({
      term: 'otel',
    });
    expect(JSON.parse(String(toolSpan.attributes[GEN_AI.toolCallResult]))).toBe('found otel');
  });

  it('gives content only to the observer that asked for it', async () => {
    const plain: Span[] = [];
    const curious: Span[] = [];
    const { cog } = runtime({
      observers: [
        { onSpan: (span) => plain.push(span) },
        { captureContent: true, onSpan: (span) => curious.push(span) },
      ],
    });
    const runSpans: Span[] = [];
    const result = await cog.run(agent, {
      input: 'please look it up',
      onSpan: (span) => runSpans.push(span),
    });

    const has = (spans: Span[]) => spans.some((s) => GEN_AI.inputMessages in s.attributes);
    expect(has(curious)).toBe(true);
    expect(has(plain)).toBe(false);
    expect(has(runSpans)).toBe(false);
    expect(has([...result.trace.spans])).toBe(false);
  });

  it('measures the time to the first chunk of a streamed answer', async () => {
    const { cog } = runtime();
    const result = await cog.run(agent, { input: 'hello', stream: true, onToken: () => {} });
    const [chat] = byName(result.trace.spans, 'llm.chat');
    expect(chat.attributes[GEN_AI.requestStream]).toBe(true);
    const ttft = chat.attributes[GEN_AI.responseTimeToFirstChunk];
    expect(typeof ttft).toBe('number');
    expect(ttft as number).toBeGreaterThanOrEqual(0.01);
    expect(ttft as number).toBeLessThan(5);

    const plain = await cog.run(agent, { input: 'hello' });
    const [plainChat] = byName(plain.trace.spans, 'llm.chat');
    expect(plainChat.attributes[GEN_AI.responseTimeToFirstChunk]).toBeUndefined();
    expect(plainChat.attributes[GEN_AI.requestStream]).toBeUndefined();
  });

  it('records the error type of a failed run', async () => {
    const failing: LLMBackend = {
      provider: 'openai',
      chat: vi.fn(async () => {
        throw new TypeError('boom');
      }),
      chatStream: vi.fn(async function* (): AsyncGenerator<ChatStreamChunk> {
        yield* [];
        throw new TypeError('boom');
      }),
    };
    const spans: Span[] = [];
    const cog = new Cogitator({
      llm: { backends: { test: failing }, retry: false },
      observers: [{ onSpan: (span) => spans.push(span) }],
    });
    runtimes.push(cog);
    await expect(cog.run(agent, { input: 'hello' })).rejects.toThrow();
    const [root] = byName(spans, 'agent.run');
    expect(root.status).toBe('error');
    expect(root.attributes[GEN_AI.operationName]).toBe('invoke_agent');
    expect(root.attributes[GEN_AI.errorType]).toBe('TypeError');
  });
});

describe('telemetry edge cases', () => {
  const approve = tool({
    name: 'lookup',
    description: 'Looks a term up after approval',
    parameters: z.object({ term: z.string() }),
    requiresApproval: true,
    execute: async ({ term }) => `found ${term}`,
  });
  const careful = new Agent({
    name: 'careful',
    model: 'test/model-1',
    instructions: 'Answer.',
    tools: [approve],
  });

  it('keeps content out of a paused run and continues its trace when it resumes', async () => {
    const plain: Span[] = [];
    const curious: Span[] = [];
    const { cog } = runtime({
      observers: [
        { onSpan: (span) => plain.push(span) },
        { captureContent: true, onSpan: (span) => curious.push(span) },
      ],
    });
    const paused = await cog.run(careful, {
      input: 'please look it up, my card is 4111',
      threadId: 'thread-paused',
    });
    expect(paused.status).toBe('paused');
    const has = (spans: readonly Span[]) =>
      spans.some((span) => GEN_AI.inputMessages in span.attributes);
    expect(has(paused.trace.spans)).toBe(false);
    expect(has(plain)).toBe(false);
    expect(has(curious)).toBe(true);
    const [pausedRoot] = byName(paused.trace.spans, 'agent.run');
    expect(pausedRoot.status).toBe('unset');
    expect(pausedRoot.attributes['run.status']).toBe('paused');
    expect(paused.checkpoint?.trace).toEqual({
      traceId: paused.trace.traceId,
      rootSpanId: pausedRoot.id,
    });
    expect(byName(paused.trace.spans, 'llm.chat')[0].parentId).toBe(pausedRoot.id);

    const resumed = await cog.resume(careful, paused.checkpoint!, {
      decisions: { call_1: { approved: true } },
    });
    expect(resumed.trace.traceId).toBe(paused.trace.traceId);
    expect(byName(resumed.trace.spans, 'agent.run')[0].parentId).toBe(pausedRoot.id);
  });

  it('starts a trace of its own for a parent that is not text or far too long', async () => {
    const { cog } = runtime();
    for (const traceId of [123 as unknown as string, 'a'.repeat(10_000_000)]) {
      const result = await cog.run(agent, { input: 'hello', trace: { traceId } });
      expect(isTraceId(result.trace.traceId)).toBe(true);
      expect(byName(result.trace.spans, 'agent.run')[0].parentId).toBeUndefined();
    }
  });

  it('keeps the error text of a failed call out of the spans', async () => {
    const leaky: LLMBackend = {
      provider: 'openai',
      chat: vi.fn(async () => {
        throw new Error('upstream said: the user wrote my card is 4111');
      }),
      chatStream: vi.fn(async function* (): AsyncGenerator<ChatStreamChunk> {
        yield* [];
        throw new Error('upstream said: the user wrote my card is 4111');
      }),
    };
    const spans: Span[] = [];
    const cog = new Cogitator({
      llm: { backends: { test: leaky }, retry: false },
      observers: [{ onSpan: (span) => spans.push(span) }],
    });
    runtimes.push(cog);
    await expect(cog.run(agent, { input: 'hello' })).rejects.toThrow();
    expect(JSON.stringify(spans.filter((span) => span.name === 'llm.chat'))).not.toContain('4111');
  });

  it('continues the paused trace on resume unless the resume is given a parent of its own', async () => {
    const { cog } = runtime();
    const paused = await cog.run(careful, { input: 'please look it up', threadId: 'thread-ctx' });
    const [pausedRoot] = byName(paused.trace.spans, 'agent.run');
    const elsewhere = { traceId: newTraceId(), parentSpanId: newSpanId() };
    const inContext = await withTraceContext(elsewhere, () =>
      cog.resume(careful, paused.checkpoint!, { decisions: { call_1: { approved: true } } })
    );
    expect(inContext.trace.traceId).toBe(paused.trace.traceId);
    expect(byName(inContext.trace.spans, 'agent.run')[0].parentId).toBe(pausedRoot.id);

    const again = await cog.run(careful, { input: 'please look it up', threadId: 'thread-ctx2' });
    const explicit = { traceId: newTraceId(), parentSpanId: newSpanId() };
    const moved = await cog.resume(careful, again.checkpoint!, {
      decisions: { call_1: { approved: true } },
      trace: explicit,
    });
    expect(moved.trace.traceId).toBe(explicit.traceId);
    expect(byName(moved.trace.spans, 'agent.run')[0].parentId).toBe(explicit.parentSpanId);
  });

  it('ends the context of a tool with it, so a timer the tool left behind starts no run in it', async () => {
    let later: ReturnType<typeof currentTraceContext> | 'unset' = 'unset';
    let during: ReturnType<typeof currentTraceContext>;
    const scheduled = new Promise<void>((resolve) => {
      void withTraceContext({ traceId: newTraceId(), parentSpanId: newSpanId() }, async () => {
        during = currentTraceContext();
        setTimeout(() => {
          later = currentTraceContext();
          resolve();
        }, 5);
      });
    });
    await scheduled;
    expect(during).toBeDefined();
    expect(later).toBeUndefined();
  });

  it('ignores a parent it cannot name and lowercases one it can', async () => {
    const { cog } = runtime();
    const lost = await cog.run(agent, {
      input: 'hello',
      trace: { traceId: '', parentSpanId: newSpanId() },
    });
    expect(byName(lost.trace.spans, 'agent.run')[0].parentId).toBeUndefined();
    const traceId = newTraceId();
    const loud = await cog.run(agent, {
      input: 'hello',
      trace: { traceId: traceId.toUpperCase(), parentSpanId: 'not-a-span' },
    });
    expect(loud.trace.traceId).toBe(traceId);
    expect(byName(loud.trace.spans, 'agent.run')[0].parentId).toBeUndefined();
  });

  it('names a conversation only when the run has a thread of its own', async () => {
    const { cog } = runtime();
    const result = await cog.run(agent, { input: 'please look it up' });
    for (const span of result.trace.spans) {
      expect(span.attributes[GEN_AI.conversationId]).toBeUndefined();
    }
  });

  it('records a failed model call as a chat span with its error type', async () => {
    const failing: LLMBackend = {
      provider: 'openai',
      chat: vi.fn(async () => {
        throw new TypeError('socket hang up');
      }),
      chatStream: vi.fn(async function* (): AsyncGenerator<ChatStreamChunk> {
        yield* [];
        throw new TypeError('socket hang up');
      }),
    };
    const spans: Span[] = [];
    const cog = new Cogitator({
      llm: { backends: { test: failing }, retry: false },
      observers: [{ onSpan: (span) => spans.push(span) }],
    });
    runtimes.push(cog);
    await expect(cog.run(agent, { input: 'hello' })).rejects.toThrow();
    const [chat] = byName(spans, 'llm.chat');
    expect(chat.status).toBe('error');
    expect(chat.kind).toBe('client');
    expect(chat.attributes).toMatchObject({
      [GEN_AI.operationName]: 'chat',
      [GEN_AI.providerName]: 'openai',
      [GEN_AI.errorType]: 'TypeError',
    });
  });

  it('names the agent on tool spans and records no result for a failed tool', async () => {
    const broken = tool({
      name: 'lookup',
      description: 'Fails',
      parameters: z.object({ term: z.string() }),
      execute: async () => {
        throw new Error('index offline');
      },
    });
    const { cog } = runtime({ captureContent: true });
    const result = await cog.run(
      new Agent({
        name: 'unlucky',
        model: 'test/model-1',
        instructions: 'Answer.',
        tools: [broken],
      }),
      { input: 'please look it up' }
    );
    const [toolSpan] = byName(result.trace.spans, 'tool.lookup');
    expect(toolSpan.attributes[GEN_AI.agentName]).toBe('unlucky');
    expect(toolSpan.attributes[GEN_AI.errorType]).toBe('tool_error');
    expect(toolSpan.attributes[GEN_AI.toolCallArguments]).toBeDefined();
    expect(toolSpan.attributes[GEN_AI.toolCallResult]).toBeUndefined();
  });

  it('never fails a run over content it cannot serialize', async () => {
    const odd = tool({
      name: 'lookup',
      description: 'Returns odd values',
      parameters: z.object({ term: z.string() }),
      execute: async () => {
        const node: Record<string, unknown> = { size: 10n };
        node.self = node;
        return toolContent({ type: 'json', value: node });
      },
    });
    const { cog } = runtime({ captureContent: true });
    const result = await cog.run(
      new Agent({ name: 'odd', model: 'test/model-1', instructions: 'Answer.', tools: [odd] }),
      { input: 'please look it up' }
    );
    expect(result.output).toBe('the answer');
    const [toolSpan] = byName(result.trace.spans, 'tool.lookup');
    const recordedResult = JSON.parse(String(toolSpan.attributes[GEN_AI.toolCallResult]));
    const [, second] = byName(result.trace.spans, 'llm.chat');
    const sent = JSON.parse(String(second.attributes[GEN_AI.inputMessages])) as Array<{
      role: string;
      parts: Array<{ response?: unknown }>;
    }>;
    expect(recordedResult).toBe(sent.find((m) => m.role === 'tool')?.parts[0].response);
    expect(safeJson({ a: { shared: 1 }, b: 2n })).toBe('{"a":{"shared":1},"b":"2"}');
    const shared = { x: 1 };
    expect(JSON.parse(safeJson({ one: shared, two: shared, big: 1n }))).toEqual({
      one: { x: 1 },
      two: { x: 1 },
      big: '1',
    });
  });

  it('keeps every part of a tool answer with an image in the recorded prompt', async () => {
    const shot = tool({
      name: 'lookup',
      description: 'Takes a screenshot',
      parameters: z.object({ term: z.string() }),
      execute: async () =>
        toolContent(
          { type: 'text', text: 'the page' },
          { type: 'image', data: 'iVBORw0KGgo=', mediaType: 'image/png' }
        ),
    });
    const { cog } = runtime({ captureContent: true });
    const result = await cog.run(
      new Agent({ name: 'eyes', model: 'test/model-1', instructions: 'Answer.', tools: [shot] }),
      { input: 'please look it up' }
    );
    const [, second] = byName(result.trace.spans, 'llm.chat');
    const input = JSON.parse(String(second.attributes[GEN_AI.inputMessages])) as Array<{
      role: string;
      parts: Array<{ type: string; response?: unknown }>;
    }>;
    const response = input.find((message) => message.role === 'tool')?.parts[0].response;
    expect(JSON.stringify(response)).toContain('the page');
    const [toolSpan] = byName(result.trace.spans, 'tool.lookup');
    const recorded = String(toolSpan.attributes[GEN_AI.toolCallResult]);
    expect(recorded).toContain('the page');
    expect(recorded).not.toContain('iVBORw0KGgo=');
  });

  it('records a JSON output type for structured answers', async () => {
    const { cog } = runtime();
    const structured = new Agent({
      name: 'structured',
      model: 'test/model-1',
      instructions: 'Answer.',
      responseFormat: { type: 'json' },
    });
    const result = await cog.run(structured, { input: 'hello' });
    expect(byName(result.trace.spans, 'llm.chat')[0].attributes[GEN_AI.outputType]).toBe('json');
  });
});

describe('one trace across runs', () => {
  it('puts a run under the parent it is given', async () => {
    const { cog } = runtime();
    const traceId = newTraceId();
    const parentSpanId = newSpanId();
    const result = await cog.run(agent, { input: 'hello', trace: { traceId, parentSpanId } });
    expect(result.trace.traceId).toBe(traceId);
    const [root] = byName(result.trace.spans, 'agent.run');
    expect(root.parentId).toBe(parentSpanId);
    expect(result.trace.spans.every((span) => span.traceId === traceId)).toBe(true);
  });

  it('puts a run started inside a tool under that tool span of the outer run', async () => {
    const llm = backend();
    const cog = new Cogitator({ llm: { backends: { test: llm } } });
    runtimes.push(cog);
    const inner = new Agent({ name: 'inner', model: 'test/model-1', instructions: 'Answer.' });
    let innerTrace: { traceId: string; root?: Span } | undefined;
    let seenInTool: ReturnType<typeof currentTraceContext>;
    const delegate = tool({
      name: 'lookup',
      description: 'Asks the inner agent',
      parameters: z.object({ term: z.string() }),
      execute: async ({ term }) => {
        seenInTool = currentTraceContext();
        const result = await cog.run(inner, { input: term });
        innerTrace = {
          traceId: result.trace.traceId,
          root: byName(result.trace.spans, 'agent.run')[0],
        };
        return result.output;
      },
    });
    const outer = new Agent({
      name: 'outer',
      model: 'test/model-1',
      instructions: 'Answer.',
      tools: [delegate],
    });

    const result = await cog.run(outer, { input: 'please look it up' });
    const [toolSpan] = byName(result.trace.spans, 'tool.lookup');
    expect(seenInTool).toEqual({ traceId: result.trace.traceId, parentSpanId: toolSpan.id });
    expect(innerTrace?.traceId).toBe(result.trace.traceId);
    expect(innerTrace?.root?.parentId).toBe(toolSpan.id);
    expect(currentTraceContext()).toBeUndefined();
  });
});

describe('decisions and learning in a shared trace', () => {
  it('puts a decision made inside a tool under that tool span', async () => {
    const decisions: DecisionBackend = {
      provider: 'acme',
      decide: vi.fn(async (request) => ({
        model: request.model,
        answers: { spam: { type: 'noul' as const, noul: 0.1 } },
        usage: { inputTokens: 5, outputTokens: 0 },
      })),
    };
    const spans: Span[] = [];
    const cog = new Cogitator({
      llm: { backends: { test: backend() }, decisionBackends: { acme: decisions } },
      observers: [{ onSpan: (span) => spans.push(span) }],
    });
    runtimes.push(cog);
    const judge = tool({
      name: 'lookup',
      description: 'Asks a decision model',
      parameters: z.object({ term: z.string() }),
      execute: async ({ term }) => {
        const verdict = await cog.decide({
          model: 'acme/judge-1',
          state: term,
          questions: {
            spam: {
              type: 'noul',
              instructions: 'Is it spam?',
              criteria: { true: 'Advertising', false: 'A real message' },
            },
          },
        });
        return verdict.answers;
      },
    });
    const result = await cog.run(
      new Agent({
        name: 'judging',
        model: 'test/model-1',
        instructions: 'Answer.',
        tools: [judge],
      }),
      { input: 'please look it up' }
    );
    const [toolSpan] = byName(result.trace.spans, 'tool.lookup');
    const decide = spans.find((span) => span.name === 'llm.decide');
    expect(decide?.traceId).toBe(result.trace.traceId);
    expect(decide?.parentId).toBe(toolSpan.id);
    expect(decide?.attributes[GEN_AI.providerName]).toBe('acme');
  });

  it('stores the learning traces of runs that share a trace apart', async () => {
    const { cog } = runtime();
    const store = new InMemoryTraceStore();
    const optimizer = new AgentOptimizer({ llm: backend(), model: 'model-1', traceStore: store });
    const trace = { traceId: newTraceId(), parentSpanId: newSpanId() };
    const one = await cog.run(agent, { input: 'hello', trace });
    const two = await cog.run(agent, { input: 'hello', trace });
    await optimizer.captureTrace(one, 'hello');
    await optimizer.captureTrace(two, 'hello');
    const stored = await store.query({ traceId: trace.traceId });
    expect(stored.map((t) => t.runId).sort()).toEqual([one.runId, two.runId].sort());
  });
});

describe('registerTelemetry', () => {
  it('sees runs of every runtime until it is unregistered, once each', async () => {
    const seen: string[] = [];
    const observer: RunObserver = {
      onSpan: (span, run) => {
        if (span.name === 'agent.run') seen.push(run.runId);
      },
    };
    const off = registerTelemetry(observer);
    unregister.push(off);
    const one = runtime({ observers: [observer] }).cog;
    const two = runtime().cog;

    const first = await one.run(agent, { input: 'hello' });
    const second = await two.run(agent, { input: 'hello' });
    off();
    await two.run(agent, { input: 'hello' });

    expect(seen).toEqual([first.runId, second.runId]);
  });

  it('receives spans recorded for an orchestration', () => {
    const seen: Span[] = [];
    unregister.push(registerTelemetry({ onSpan: (span) => seen.push(span) }));
    const { cog } = runtime();
    const span: Span = {
      id: newSpanId(),
      traceId: newTraceId(),
      name: 'swarm.run',
      kind: 'internal',
      status: 'ok',
      startTime: 1,
      endTime: 2,
      duration: 1,
      attributes: { [GEN_AI.operationName]: 'invoke_workflow', [GEN_AI.inputMessages]: '[]' },
    };
    const curious: Span[] = [];
    unregister.push(registerTelemetry({ captureContent: true, onSpan: (s) => curious.push(s) }));
    unregister.push(
      registerTelemetry({
        onSpan: () => {
          throw new Error('broken observer');
        },
      })
    );
    cog.recordSpan(span, { runId: 'swarm-1' });
    expect(seen).toHaveLength(1);
    expect(seen[0].attributes[GEN_AI.inputMessages]).toBeUndefined();
    expect(curious[0].attributes[GEN_AI.inputMessages]).toBe('[]');

    const open = runtime({ captureContent: true }).cog;
    const all: Span[] = [];
    unregister.push(registerTelemetry({ onSpan: (s) => all.push(s) }));
    open.recordSpan(span, { runId: 'swarm-2' });
    expect(all[0].attributes[GEN_AI.inputMessages]).toBe('[]');
  });

  it('turns capture on for a registered observer that asks, and gives content only to it', async () => {
    const curious: Span[] = [];
    const plain: Span[] = [];
    unregister.push(registerTelemetry({ captureContent: true, onSpan: (s) => curious.push(s) }));
    unregister.push(registerTelemetry({ onSpan: (s) => plain.push(s) }));
    const { cog } = runtime();
    await cog.run(agent, { input: 'hello' });
    const has = (spans: Span[]) => spans.some((s) => GEN_AI.inputMessages in s.attributes);
    expect(has(curious)).toBe(true);
    expect(has(plain)).toBe(false);
  });
});

describe('GenAI names', () => {
  it('maps providers to the convention and names spans by operation and target', () => {
    expect(genAiProviderName('google')).toBe('gcp.gemini');
    expect(genAiProviderName('azure')).toBe('azure.ai.openai');
    expect(genAiProviderName('bedrock')).toBe('aws.bedrock');
    expect(genAiProviderName('ollama')).toBe('ollama');
    expect(genAiSpanName({ [GEN_AI.operationName]: 'chat', [GEN_AI.requestModel]: 'gpt-5' })).toBe(
      'chat gpt-5'
    );
    expect(
      genAiSpanName({ [GEN_AI.operationName]: 'execute_tool', [GEN_AI.toolName]: 'search' })
    ).toBe('execute_tool search');
    expect(genAiSpanName({ [GEN_AI.operationName]: 'invoke_agent' })).toBe('invoke_agent');
    expect(genAiSpanName({ 'llm.model': 'x' })).toBeUndefined();
  });

  it('exports convention names, W3C ids as they are, and arrays as arrays', async () => {
    const bodies: string[] = [];
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (_url, init) => {
      bodies.push(String(init?.body));
      return new Response('{}', { status: 200 });
    });
    const exporter = new OTLPExporter({ endpoint: 'http://collector', enabled: true });
    const { cog } = runtime({ observers: [exporter.observer()] });
    const result = await cog.run(agent, { input: 'hello' });
    await exporter.flush();

    const payload = JSON.parse(bodies[0]) as {
      resourceSpans: Array<{
        scopeSpans: Array<{
          spans: Array<{
            traceId: string;
            name: string;
            attributes: Array<{ key: string; value: Record<string, unknown> }>;
          }>;
        }>;
      }>;
    };
    const spans = payload.resourceSpans[0].scopeSpans[0].spans;
    expect(spans.map((span) => span.name).sort()).toEqual([
      'chat model-1',
      'invoke_agent researcher',
    ]);
    expect(spans.every((span) => span.traceId === result.trace.traceId)).toBe(true);
    const chat = spans.find((span) => span.name === 'chat model-1');
    expect(chat?.attributes.find((a) => a.key === GEN_AI.responseFinishReasons)?.value).toEqual({
      arrayValue: { values: [{ stringValue: 'stop' }] },
    });
    expect(chat?.attributes.find((a) => a.key === 'cogitator.span_name')?.value).toEqual({
      stringValue: 'llm.chat',
    });
    expect(chat?.attributes.find((a) => a.key === GEN_AI.requestTemperature)?.value).toEqual({
      doubleValue: 0.3,
    });

    exporter.exportSpan('run-1', {
      id: newSpanId(),
      traceId: newTraceId(),
      name: 'llm.chat',
      kind: 'client',
      status: 'ok',
      startTime: 0,
      endTime: 1,
      duration: 1,
      attributes: {
        [GEN_AI.operationName]: 'chat',
        [GEN_AI.requestTemperature]: 1,
        [GEN_AI.responseTimeToFirstChunk]: 2,
        [GEN_AI.usageInputTokens]: 7,
      },
    });
    await exporter.flush();
    const [whole] = (JSON.parse(bodies[1]) as typeof payload).resourceSpans[0].scopeSpans[0].spans;
    const valueOf = (key: string) => whole.attributes.find((a) => a.key === key)?.value;
    expect(valueOf(GEN_AI.requestTemperature)).toEqual({ doubleValue: 1 });
    expect(valueOf(GEN_AI.responseTimeToFirstChunk)).toEqual({ doubleValue: 2 });
    expect(valueOf(GEN_AI.usageInputTokens)).toEqual({ intValue: '7' });
  });
});
