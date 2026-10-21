import { describe, it, expect, vi, afterEach } from 'vitest';
import { z } from 'zod';
import type {
  ChatRequest,
  ChatResponse,
  ChatStreamChunk,
  LLMBackend,
  RunObserver,
  Span,
} from '@cogitator-ai/types';
import { Cogitator } from '../cogitator';
import { Agent } from '../agent';
import { tool } from '../tool';
import { registerTelemetry } from '../observability/telemetry';
import {
  currentTraceContext,
  formatTraceparent,
  isSpanId,
  isTraceId,
  newSpanId,
  newTraceId,
  parseTraceparent,
} from '../observability/trace-context';
import { GEN_AI, genAiProviderName, genAiSpanName } from '../observability/genai';
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
    expect(typeof root.attributes[GEN_AI.errorType]).toBe('string');
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
    cog.recordSpan(span, { runId: 'swarm-1' });
    expect(seen).toHaveLength(1);
    expect(seen[0].attributes[GEN_AI.inputMessages]).toBeUndefined();
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
  });
});
