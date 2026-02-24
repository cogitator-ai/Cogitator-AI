import type { Span, RunResult, ToolCall, ToolResult, Message } from '@cogitator-ai/types';

export interface LangfuseConfig {
  publicKey: string;
  secretKey: string;
  baseUrl?: string;
  flushAt?: number;
  flushInterval?: number;
  enabled?: boolean;
}

interface LangfuseClient {
  trace(options: TraceOptions): LangfuseTrace;
  flush(): Promise<void>;
  shutdown(): Promise<void>;
}

interface LangfuseTrace {
  id: string;
  span(options: SpanOptions): LangfuseSpan;
  generation(options: GenerationOptions): LangfuseGeneration;
  update(options: { output?: unknown; metadata?: Record<string, unknown> }): void;
}

interface LangfuseSpan {
  id: string;
  span(options: SpanOptions): LangfuseSpan;
  generation(options: GenerationOptions): LangfuseGeneration;
  end(options?: { output?: unknown }): void;
}

interface LangfuseGeneration {
  id: string;
  end(options?: {
    output?: unknown;
    usage?: { input?: number; output?: number; total?: number };
  }): void;
}

interface TraceOptions {
  id?: string;
  name: string;
  input?: unknown;
  metadata?: Record<string, unknown>;
  userId?: string;
  sessionId?: string;
  tags?: string[];
}

interface SpanOptions {
  name: string;
  input?: unknown;
  metadata?: Record<string, unknown>;
}

interface GenerationOptions {
  name: string;
  model: string;
  input?: unknown;
  metadata?: Record<string, unknown>;
  modelParameters?: Record<string, unknown>;
}

export class LangfuseExporter {
  private client: LangfuseClient | null = null;
  private config: LangfuseConfig;
  private activeTraces = new Map<string, LangfuseTrace>();
  private activeSpans = new Map<string, LangfuseSpan>();
  private activeGenerations = new Map<string, LangfuseGeneration>();

  constructor(config: LangfuseConfig) {
    this.config = config;
  }

  async init(): Promise<void> {
    if (!this.config.enabled) return;

    let Langfuse: new (config: {
      publicKey: string;
      secretKey: string;
      baseUrl?: string;
      flushAt?: number;
      flushInterval?: number;
    }) => LangfuseClient;

    try {
      const langfuse = await import('langfuse');
      Langfuse = langfuse.Langfuse as unknown as typeof Langfuse;
    } catch {
      throw new Error('langfuse not installed. Run: pnpm add langfuse');
    }

    this.client = new Langfuse({
      publicKey: this.config.publicKey,
      secretKey: this.config.secretKey,
      baseUrl: this.config.baseUrl,
      flushAt: this.config.flushAt,
      flushInterval: this.config.flushInterval,
    });
  }

  onRunStart(options: {
    runId: string;
    agentId: string;
    agentName: string;
    input: string;
    threadId?: string;
    model?: string;
  }): void {
    if (!this.client) return;

    const trace = this.client.trace({
      id: options.runId,
      name: options.agentName,
      input: options.input,
      sessionId: options.threadId,
      metadata: {
        agentId: options.agentId,
        model: options.model,
      },
      tags: ['cogitator', options.agentName],
    });

    this.activeTraces.set(options.runId, trace);
  }

  onRunComplete(result: RunResult): void {
    const trace = this.activeTraces.get(result.runId);
    if (!trace) return;

    trace.update({
      output: result.output,
      metadata: {
        usage: result.usage,
        toolCallCount: result.toolCalls.length,
      },
    });

    this.activeTraces.delete(result.runId);
  }

  onSpanStart(runId: string, span: Omit<Span, 'endTime' | 'duration' | 'status'>): void {
    const trace = this.activeTraces.get(runId);
    if (!trace) return;

    const parent = span.parentId ? this.activeSpans.get(span.parentId) : null;
    const target = parent ?? trace;

    const langfuseSpan = target.span({
      name: span.name,
      metadata: span.attributes as Record<string, unknown>,
    });

    this.activeSpans.set(span.id, langfuseSpan);
  }

  onSpanEnd(span: Span): void {
    const langfuseSpan = this.activeSpans.get(span.id);
    if (!langfuseSpan) return;

    langfuseSpan.end({
      output: span.attributes.output,
    });

    this.activeSpans.delete(span.id);
  }

  onLLMCall(options: {
    runId: string;
    spanId?: string;
    model: string;
    messages: Message[];
    temperature?: number;
    maxTokens?: number;
  }): string {
    const trace = this.activeTraces.get(options.runId);
    if (!trace) return '';

    const parent = options.spanId ? this.activeSpans.get(options.spanId) : null;
    const target = parent ?? trace;

    const generation = target.generation({
      name: 'llm-call',
      model: options.model,
      input: options.messages,
      modelParameters: {
        temperature: options.temperature,
        maxTokens: options.maxTokens,
      },
    });

    this.activeGenerations.set(generation.id, generation);
    return generation.id;
  }

  onLLMResponse(options: {
    generationId: string;
    output: string;
    inputTokens?: number;
    outputTokens?: number;
  }): void {
    if (!this.client) return;

    const generation = this.activeGenerations.get(options.generationId);
    if (!generation) return;

    generation.end({
      output: options.output,
      usage: {
        input: options.inputTokens,
        output: options.outputTokens,
        total: (options.inputTokens ?? 0) + (options.outputTokens ?? 0),
      },
    });

    this.activeGenerations.delete(options.generationId);
  }

  onToolCall(runId: string, call: ToolCall): void {
    const trace = this.activeTraces.get(runId);
    if (!trace) return;

    const span = trace.span({
      name: `tool:${call.name}`,
      input: call.arguments,
      metadata: { toolCallId: call.id },
    });

    this.activeSpans.set(`tool:${call.id}`, span);
  }

  onToolResult(_runId: string, result: ToolResult): void {
    const spanKey = `tool:${result.callId}`;
    const span = this.activeSpans.get(spanKey);
    if (span) {
      span.end({ output: result.result });
      this.activeSpans.delete(spanKey);
    }
  }

  async flush(): Promise<void> {
    await this.client?.flush();
  }

  async shutdown(): Promise<void> {
    await this.client?.shutdown();
  }
}

export function createLangfuseExporter(config: LangfuseConfig): LangfuseExporter {
  return new LangfuseExporter(config);
}
