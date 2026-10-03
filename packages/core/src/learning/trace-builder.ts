import type {
  ExecutionStep,
  ExecutionTrace,
  Message,
  RunResult,
  TraceMetrics,
} from '@cogitator-ai/types';

export interface BuildTraceOptions {
  /** Trace id; defaults to the run's own trace id. */
  id?: string;
  /** Model recorded on the trace when the run does not say which it used. */
  model?: string;
  expected?: unknown;
  labels?: string[];
}

/**
 * Turns a run into an `ExecutionTrace`: its tool and model calls as steps, with
 * the tool results the run saw, and quick metrics. The score is left at 0 for an
 * evaluator to fill in.
 */
export function buildExecutionTrace(
  runResult: RunResult,
  input: string,
  options: BuildTraceOptions = {}
): ExecutionTrace {
  const steps = extractSteps(runResult);
  return {
    id: options.id ?? runResult.trace.traceId,
    runId: runResult.runId,
    agentId: runResult.agentId,
    threadId: runResult.threadId,
    input,
    output: runResult.output,
    steps,
    toolCalls: [...runResult.toolCalls],
    reflections: runResult.reflections ? [...runResult.reflections] : [],
    metrics: computeQuickMetrics(runResult, steps),
    score: 0,
    model: runResult.modelUsed ?? options.model ?? '',
    createdAt: new Date(),
    duration: runResult.usage.duration,
    usage: {
      inputTokens: runResult.usage.inputTokens,
      outputTokens: runResult.usage.outputTokens,
      cost: runResult.usage.cost,
    },
    labels: options.labels,
    isDemo: false,
    expected: options.expected,
  };
}

/** The input a run answered: its first user message. */
export function runInput(runResult: RunResult): string {
  const user = runResult.messages.find((message) => message.role === 'user');
  if (!user) return '';
  return typeof user.content === 'string'
    ? user.content
    : user.content
        .filter((part): part is { type: 'text'; text: string } => part.type === 'text')
        .map((part) => part.text)
        .join(' ');
}

/** Results of a run's tool calls by call id, read back from its tool messages. */
export function toolResultsByCallId(messages: readonly Message[]): Map<string, unknown> {
  const results = new Map<string, unknown>();
  for (const message of messages) {
    if (message.role !== 'tool' || !message.toolCallId) continue;
    const content = typeof message.content === 'string' ? message.content : '';
    results.set(message.toolCallId, parseToolContent(content));
  }
  return results;
}

function parseToolContent(content: string): unknown {
  try {
    return JSON.parse(content) as unknown;
  } catch {
    return content;
  }
}

function extractSteps(runResult: RunResult): ExecutionStep[] {
  const steps: ExecutionStep[] = [];
  const toolResults = toolResultsByCallId(runResult.messages);
  let index = 0;

  for (const span of runResult.trace.spans) {
    const toolName =
      stringAttribute(span.attributes, 'tool.name') ??
      stringAttribute(span.attributes, 'toolName') ??
      (span.name.startsWith('tool.') ? span.name.slice('tool.'.length) : undefined);

    if (span.name.startsWith('tool.') || span.name.includes('tool_call') || toolName) {
      const callId =
        stringAttribute(span.attributes, 'tool.call_id') ??
        stringAttribute(span.attributes, 'call_id');
      const toolCall =
        (callId ? runResult.toolCalls.find((tc) => tc.id === callId) : undefined) ??
        (toolName ? runResult.toolCalls.find((tc) => tc.name === toolName) : undefined);
      const resultCallId = callId ?? toolCall?.id;
      const resultName = toolCall?.name ?? toolName;
      const error =
        span.status === 'error' || span.attributes['tool.success'] === false
          ? String(span.attributes['tool.error'] ?? span.attributes.error ?? 'Unknown error')
          : undefined;

      steps.push({
        index: index++,
        type: 'tool_call',
        timestamp: span.startTime,
        duration: span.duration,
        toolCall,
        toolResult:
          resultCallId && resultName
            ? {
                callId: resultCallId,
                name: resultName,
                result: toolResults.get(resultCallId) ?? span.attributes.result,
                error,
              }
            : undefined,
      });
    } else if (span.name.includes('llm') || span.name.includes('chat')) {
      steps.push({
        index: index++,
        type: 'llm_call',
        timestamp: span.startTime,
        duration: span.duration,
        tokensUsed: {
          input:
            numberAttribute(span.attributes, 'llm.input_tokens') ??
            numberAttribute(span.attributes, 'inputTokens') ??
            0,
          output:
            numberAttribute(span.attributes, 'llm.output_tokens') ??
            numberAttribute(span.attributes, 'outputTokens') ??
            0,
        },
      });
    }
  }

  if (runResult.reflections) {
    for (const reflection of runResult.reflections) {
      steps.push({
        index: index++,
        type: 'reflection',
        timestamp: reflection.timestamp.getTime(),
        duration: 0,
        reflection,
      });
    }
  }

  steps.sort((a, b) => a.timestamp - b.timestamp);
  return steps;
}

function computeQuickMetrics(runResult: RunResult, steps: ExecutionStep[]): TraceMetrics {
  const toolSteps = steps.filter((s) => s.type === 'tool_call');
  const successfulTools = toolSteps.filter((s) => !s.toolResult?.error);

  const hasErrors = steps.some((s) => s.toolResult?.error);
  const toolAccuracy = toolSteps.length > 0 ? successfulTools.length / toolSteps.length : 1;

  const totalTokens = runResult.usage.inputTokens + runResult.usage.outputTokens;
  const efficiency = Math.min(1, 10000 / Math.max(totalTokens, 1));

  const completeness = runResult.output.length > 50 ? 0.8 : 0.5;

  return {
    success: !hasErrors,
    toolAccuracy,
    efficiency,
    completeness,
    coherence: 0.5,
  };
}

function stringAttribute(attributes: Record<string, unknown>, key: string): string | undefined {
  const value = attributes[key];
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function numberAttribute(attributes: Record<string, unknown>, key: string): number | undefined {
  const value = attributes[key];
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string') {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : undefined;
  }
  return undefined;
}
