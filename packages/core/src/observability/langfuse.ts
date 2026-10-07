import type {
  Span,
  RunObserver,
  RunResult,
  ToolCall,
  ToolResult,
  Message,
} from '@cogitator-ai/types';
import type {
  Langfuse,
  LangfuseGenerationClient,
  LangfuseSpanClient,
  LangfuseTraceClient,
} from 'langfuse';

export interface LangfuseConfig {
  publicKey: string;
  secretKey: string;
  baseUrl?: string;
  flushAt?: number;
  flushInterval?: number;
  /** Export traces only when `true`; off by default, so the exporter can be built unconditionally */
  enabled?: boolean;
}

/**
 * The part of the Langfuse client the exporter uses, taken from the real `langfuse` types so a
 * change in the client is a compile error here.
 */
type LangfuseClient = Pick<Langfuse, 'trace' | 'flushAsync' | 'shutdownAsync'>;

export class LangfuseExporter {
  private client: LangfuseClient | null = null;
  private config: LangfuseConfig;
  private activeTraces = new Map<string, LangfuseTraceClient>();
  private activeSpans = new Map<string, LangfuseSpanClient>();
  private activeGenerations = new Map<string, LangfuseGenerationClient>();
  private spanRunIds = new Map<string, string>();
  private generationRunIds = new Map<string, string>();

  constructor(config: LangfuseConfig) {
    this.config = config;
  }

  async init(): Promise<void> {
    if (!this.config.enabled) return;

    let LangfuseClass: typeof Langfuse;
    try {
      LangfuseClass = (await import('langfuse')).Langfuse;
    } catch {
      throw new Error('langfuse not installed. Run: pnpm add langfuse');
    }

    this.client = new LangfuseClass({
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

    this.cleanupRun(result.runId);
  }

  /**
   * Traces every run of a runtime: pass it in `observers` of the Cogitator
   * config, after `await init()`. Spans arrive finished, so each is opened and
   * closed at once under its run's trace.
   */
  observer(): RunObserver {
    return {
      onRunStart: (event) => this.onRunStart(event),
      onSpan: (span, run) => {
        this.onSpanStart(run.runId, span);
        this.onSpanEnd(span);
      },
      onRunComplete: (result) => this.onRunComplete(result),
      close: () => this.shutdown(),
    };
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
    this.spanRunIds.set(span.id, runId);
  }

  onSpanEnd(span: Span): void {
    const langfuseSpan = this.activeSpans.get(span.id);
    if (!langfuseSpan) return;

    langfuseSpan.end({
      output: span.attributes.output,
    });

    this.activeSpans.delete(span.id);
    this.spanRunIds.delete(span.id);
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
        ...(options.temperature !== undefined && { temperature: options.temperature }),
        ...(options.maxTokens !== undefined && { maxTokens: options.maxTokens }),
      },
    });

    this.activeGenerations.set(generation.id, generation);
    this.generationRunIds.set(generation.id, options.runId);
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
    this.generationRunIds.delete(options.generationId);
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
    this.spanRunIds.set(`tool:${call.id}`, runId);
  }

  onToolResult(_runId: string, result: ToolResult): void {
    const spanKey = `tool:${result.callId}`;
    const span = this.activeSpans.get(spanKey);
    if (span) {
      span.end({ output: result.result });
      this.activeSpans.delete(spanKey);
      this.spanRunIds.delete(spanKey);
    }
  }

  private cleanupRun(runId: string): void {
    this.activeTraces.delete(runId);

    for (const [spanId, ownerRunId] of this.spanRunIds.entries()) {
      if (ownerRunId === runId) {
        this.activeSpans.delete(spanId);
        this.spanRunIds.delete(spanId);
      }
    }

    for (const [generationId, ownerRunId] of this.generationRunIds.entries()) {
      if (ownerRunId === runId) {
        this.activeGenerations.delete(generationId);
        this.generationRunIds.delete(generationId);
      }
    }
  }

  /** Sends every queued event and resolves once Langfuse has received them. */
  async flush(): Promise<void> {
    await this.client?.flushAsync();
  }

  /** Flushes queued events and stops the client; resolves when both are done. */
  async shutdown(): Promise<void> {
    await this.client?.shutdownAsync();
  }
}

export function createLangfuseExporter(config: LangfuseConfig): LangfuseExporter {
  return new LangfuseExporter(config);
}
