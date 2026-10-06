import type {
  LanguageModelV2,
  LanguageModelV2CallOptions,
  LanguageModelV3,
  LanguageModelV3CallOptions,
  LanguageModelV4,
  LanguageModelV4CallOptions,
} from '@ai-sdk/provider';
import type { Agent, Cogitator } from '@cogitator-ai/core';
import type { ReasoningEffort, RunResult, ToolCall, ToolResult } from '@cogitator-ai/types';
import {
  AgentRunner,
  PAUSE_WARNING,
  approvalIdFor,
  runFinish,
  runMetadata,
  toolCallPreambles,
  serializeToolInput,
  toolResultValue,
  type AgentCallResponseFormat,
  type AgentCallToolChoice,
  type CallWarning,
  type PreparedAgentCall,
  type PromptMessageLike,
} from './agent-runner.js';
import type {
  CogitatorContent,
  CogitatorFinishReasonV2,
  CogitatorFinishReasonV3,
  CogitatorGenerateResult,
  CogitatorLanguageModelV2,
  CogitatorLanguageModelV3,
  CogitatorLanguageModelV4,
  CogitatorProviderOptions,
  CogitatorStreamPart,
  CogitatorStreamResult,
  CogitatorToolApprovalRequestContent,
  CogitatorToolCallContent,
  CogitatorToolResultContent,
  CogitatorUsageV2,
  CogitatorUsageV3,
  CogitatorWarningV2,
  CogitatorWarningV3,
} from './types.js';

interface ModernCallOptions {
  prompt: ReadonlyArray<PromptMessageLike>;
  maxOutputTokens?: number;
  temperature?: number;
  topP?: number;
  topK?: number;
  presencePenalty?: number;
  frequencyPenalty?: number;
  seed?: number;
  stopSequences?: string[];
  responseFormat?: AgentCallResponseFormat;
  tools?: ReadonlyArray<{ name: string }>;
  toolChoice?: AgentCallToolChoice;
  abortSignal?: AbortSignal;
}

const MODERN_UNSUPPORTED_SETTINGS = [
  'topK',
  'presencePenalty',
  'frequencyPenalty',
  'seed',
] as const;

function toolCallContent(call: ToolCall): CogitatorToolCallContent {
  return {
    type: 'tool-call',
    toolCallId: call.id,
    toolName: call.name,
    input: serializeToolInput(call),
    providerExecuted: true,
    dynamic: true,
  };
}

function toolResultContent(result: ToolResult): CogitatorToolResultContent {
  const { value, isError } = toolResultValue(result);
  return {
    type: 'tool-result',
    toolCallId: result.callId,
    toolName: result.name,
    result: value,
    isError,
    providerExecuted: true,
    dynamic: true,
  };
}

abstract class AgentLanguageModel<
  TCallOptions extends ModernCallOptions,
  TWarning,
  TUsage,
  TFinishReason,
  TApproval = never,
> {
  readonly provider = 'cogitator';
  readonly modelId: string;
  readonly supportedUrls: Record<string, RegExp[]> = {};

  private readonly runner: AgentRunner;

  constructor(
    cogitator: Cogitator,
    agent: Agent,
    agentName: string,
    options: CogitatorProviderOptions
  ) {
    this.modelId = agentName;
    this.runner = new AgentRunner(cogitator, agent, options);
  }

  protected abstract toWarning(warning: CallWarning): TWarning;
  protected abstract toUsage(result: RunResult): TUsage;
  /** Why the turn ended, from how the agent's run ended (see `runFinish`) */
  protected abstract finishReason(result: RunResult): TFinishReason;

  /**
   * The approval requests of a paused run, for specifications that can ask for them; the others
   * report the pause with a warning and their finish reason for it.
   */
  protected approvalRequests(_result: RunResult): TApproval[] {
    return [];
  }

  protected exposesToolCall(_toolName: string, _options: TCallOptions): boolean {
    return true;
  }

  protected unsupportedSettings(options: TCallOptions): string[] {
    return MODERN_UNSUPPORTED_SETTINGS.filter((setting) => options[setting] !== undefined);
  }

  protected reasoningEffort(_options: TCallOptions): ReasoningEffort | undefined {
    return undefined;
  }

  async doGenerate(
    options: TCallOptions
  ): Promise<
    CogitatorGenerateResult<TWarning, TUsage, TFinishReason, CogitatorContent | TApproval>
  > {
    const prepared = this.prepare(options);
    const content: (CogitatorContent | TApproval)[] = [];
    const events: ({ call: ToolCall } | { result: ToolResult })[] = [];

    const toolResults = new Map<string, ToolResult>();

    const result = await this.runner.run(
      prepared,
      {
        onToolCall: (call) => {
          if (this.exposesToolCall(call.name, options)) events.push({ call });
        },
        onToolResult: (toolResult) => {
          toolResults.set(toolResult.callId, toolResult);
          if (this.exposesToolCall(toolResult.name, options)) events.push({ result: toolResult });
        },
      },
      { stream: false }
    );

    const preambles =
      prepared.jsonMode || prepared.resume ? new Map<string, string>() : toolCallPreambles(result);
    for (const event of events) {
      if ('call' in event) {
        const preamble = preambles.get(event.call.id);
        if (preamble) content.push({ type: 'text', text: preamble });
        content.push(toolCallContent(event.call));
      } else {
        content.push(toolResultContent(event.result));
      }
    }

    if (result.reasoning) content.push({ type: 'reasoning', text: result.reasoning });
    if (result.output) content.push({ type: 'text', text: result.output });
    const approvals = this.approvalRequests(result);
    content.push(...approvals);
    const warnings = prepared.warnings.map((warning) => this.toWarning(warning));
    if (result.status === 'paused' && approvals.length === 0) {
      warnings.push(this.toWarning({ type: 'other', message: PAUSE_WARNING }));
    }

    return {
      content,
      finishReason: this.finishReason(result),
      usage: this.toUsage(result),
      providerMetadata: runMetadata(result, prepared.model, toolResults),
      request: { body: { input: prepared.input } },
      response: {
        id: result.runId,
        timestamp: new Date(),
        modelId: result.modelUsed ?? prepared.model,
      },
      warnings,
    };
  }

  async doStream(
    options: TCallOptions
  ): Promise<CogitatorStreamResult<TWarning, TUsage, TFinishReason, TApproval>> {
    const prepared = this.prepare(options);
    const warnings = prepared.warnings.map((warning) => this.toWarning(warning));
    const abortController = new AbortController();
    const signal = prepared.abortSignal
      ? AbortSignal.any([prepared.abortSignal, abortController.signal])
      : abortController.signal;
    let closed = false;

    const stream = new ReadableStream<
      CogitatorStreamPart<TWarning, TUsage, TFinishReason, TApproval>
    >({
      start: (controller) => {
        let openPart: { kind: 'text' | 'reasoning'; id: string } | undefined;
        let blocks = 0;
        const toolResults = new Map<string, ToolResult>();

        const emit = (part: CogitatorStreamPart<TWarning, TUsage, TFinishReason, TApproval>) => {
          if (!closed) controller.enqueue(part);
        };
        const closePart = () => {
          if (openPart === undefined) return;
          const { kind, id } = openPart;
          openPart = undefined;
          emit(kind === 'text' ? { type: 'text-end', id } : { type: 'reasoning-end', id });
        };
        const openPartOf = (kind: 'text' | 'reasoning'): string => {
          if (openPart?.kind === kind) return openPart.id;
          closePart();
          const id = `${kind}-${blocks++}`;
          openPart = { kind, id };
          emit(kind === 'text' ? { type: 'text-start', id } : { type: 'reasoning-start', id });
          return id;
        };

        emit({ type: 'stream-start', warnings });

        void this.runner
          .run(
            prepared,
            {
              onRunStart: (runId) =>
                emit({
                  type: 'response-metadata',
                  id: runId,
                  timestamp: new Date(),
                  modelId: prepared.model,
                }),
              onTextDelta: (delta) => {
                if (!delta || prepared.jsonMode) return;
                emit({ type: 'text-delta', id: openPartOf('text'), delta });
              },
              onReasoningDelta: (delta) => {
                if (!delta) return;
                emit({ type: 'reasoning-delta', id: openPartOf('reasoning'), delta });
              },
              onToolCall: (call) => {
                if (!this.exposesToolCall(call.name, options)) return;
                closePart();
                const part = toolCallContent(call);
                emit({
                  type: 'tool-input-start',
                  id: call.id,
                  toolName: call.name,
                  providerExecuted: true,
                  dynamic: true,
                });
                emit({ type: 'tool-input-delta', id: call.id, delta: part.input });
                emit({ type: 'tool-input-end', id: call.id });
                emit(part);
              },
              onToolResult: (toolResult) => {
                toolResults.set(toolResult.callId, toolResult);
                if (!this.exposesToolCall(toolResult.name, options)) return;
                closePart();
                emit(toolResultContent(toolResult));
              },
            },
            { stream: true, signal }
          )
          .then(
            (result) => {
              if (prepared.jsonMode && result.output) {
                emit({ type: 'text-delta', id: openPartOf('text'), delta: result.output });
              }
              closePart();
              for (const approval of this.approvalRequests(result)) emit(approval);
              emit({
                type: 'finish',
                usage: this.toUsage(result),
                finishReason: this.finishReason(result),
                providerMetadata: runMetadata(result, prepared.model, toolResults),
              });
            },
            (error: unknown) => {
              closePart();
              emit({ type: 'error', error });
            }
          )
          .finally(() => {
            if (closed) return;
            closed = true;
            controller.close();
          });
      },
      cancel: () => {
        closed = true;
        abortController.abort();
      },
    });

    return { stream, request: { body: { input: prepared.input } } };
  }

  private prepare(options: TCallOptions): PreparedAgentCall {
    return this.runner.prepare({
      prompt: options.prompt,
      temperature: options.temperature,
      topP: options.topP,
      maxTokens: options.maxOutputTokens,
      stopSequences: options.stopSequences,
      responseFormat: options.responseFormat,
      toolNames: (options.tools ?? []).map((tool) => tool.name),
      toolChoice: options.toolChoice,
      unsupportedSettings: this.unsupportedSettings(options),
      reasoningEffort: this.reasoningEffort(options),
      abortSignal: options.abortSignal,
    });
  }
}

function v3Usage(result: RunResult): CogitatorUsageV3 {
  const { inputTokens, outputTokens, cachedInputTokens, cacheWriteTokens, reasoningTokens } =
    result.usage;
  const cached = cachedInputTokens !== undefined || cacheWriteTokens !== undefined;
  return {
    inputTokens: {
      total: inputTokens,
      noCache: cached
        ? inputTokens - (cachedInputTokens ?? 0) - (cacheWriteTokens ?? 0)
        : undefined,
      cacheRead: cachedInputTokens,
      cacheWrite: cacheWriteTokens,
    },
    outputTokens: {
      total: outputTokens,
      text: reasoningTokens !== undefined ? outputTokens - reasoningTokens : undefined,
      reasoning: reasoningTokens,
    },
  };
}

function v3Warning(warning: CallWarning): CogitatorWarningV3 {
  switch (warning.type) {
    case 'setting':
      return { type: 'unsupported', feature: warning.setting, details: warning.details };
    case 'tool':
      return {
        type: 'unsupported',
        feature: `tool "${warning.toolName}"`,
        details: warning.details,
      };
    case 'other':
      return warning;
  }
}

/** The `tool-approval-request` parts of a paused run, one per waiting call. */
function v3ApprovalRequests(result: RunResult): CogitatorToolApprovalRequestContent[] {
  if (result.status !== 'paused') return [];
  return (result.pendingApprovals ?? []).map((approval) => ({
    type: 'tool-approval-request',
    approvalId: approvalIdFor(result.threadId, approval.toolCallId),
    toolCallId: approval.toolCallId,
  }));
}

export class AgentLanguageModelV2
  extends AgentLanguageModel<
    LanguageModelV2CallOptions,
    CogitatorWarningV2,
    CogitatorUsageV2,
    CogitatorFinishReasonV2
  >
  implements CogitatorLanguageModelV2, LanguageModelV2
{
  readonly specificationVersion = 'v2';

  protected exposesToolCall(toolName: string, options: LanguageModelV2CallOptions): boolean {
    return options.tools?.some((tool) => tool.name === toolName) ?? false;
  }

  protected toWarning(warning: CallWarning): CogitatorWarningV2 {
    switch (warning.type) {
      case 'setting':
        return { type: 'unsupported-setting', setting: warning.setting, details: warning.details };
      case 'tool':
        return {
          type: 'other',
          message: `Unsupported tool "${warning.toolName}": ${warning.details ?? ''}`.trim(),
        };
      case 'other':
        return warning;
    }
  }

  protected toUsage(result: RunResult): CogitatorUsageV2 {
    return {
      inputTokens: result.usage.inputTokens,
      outputTokens: result.usage.outputTokens,
      totalTokens: result.usage.totalTokens,
      ...(result.usage.reasoningTokens !== undefined && {
        reasoningTokens: result.usage.reasoningTokens,
      }),
      ...(result.usage.cachedInputTokens !== undefined && {
        cachedInputTokens: result.usage.cachedInputTokens,
      }),
    };
  }

  protected finishReason(result: RunResult): CogitatorFinishReasonV2 {
    const { unified } = runFinish(result);
    return unified === 'tool-calls' ? 'other' : unified;
  }
}

export class AgentLanguageModelV3
  extends AgentLanguageModel<
    LanguageModelV3CallOptions,
    CogitatorWarningV3,
    CogitatorUsageV3,
    CogitatorFinishReasonV3,
    CogitatorToolApprovalRequestContent
  >
  implements CogitatorLanguageModelV3, LanguageModelV3
{
  readonly specificationVersion = 'v3';

  protected toWarning(warning: CallWarning): CogitatorWarningV3 {
    return v3Warning(warning);
  }

  protected toUsage(result: RunResult): CogitatorUsageV3 {
    return v3Usage(result);
  }

  protected finishReason(result: RunResult): CogitatorFinishReasonV3 {
    return runFinish(result);
  }

  protected approvalRequests(result: RunResult): CogitatorToolApprovalRequestContent[] {
    return v3ApprovalRequests(result);
  }
}

export class AgentLanguageModelV4
  extends AgentLanguageModel<
    LanguageModelV4CallOptions,
    CogitatorWarningV3,
    CogitatorUsageV3,
    CogitatorFinishReasonV3,
    CogitatorToolApprovalRequestContent
  >
  implements CogitatorLanguageModelV4, LanguageModelV4
{
  readonly specificationVersion = 'v4';

  protected reasoningEffort(options: LanguageModelV4CallOptions): ReasoningEffort | undefined {
    return options.reasoning === 'provider-default' ? undefined : options.reasoning;
  }

  protected toWarning(warning: CallWarning): CogitatorWarningV3 {
    return v3Warning(warning);
  }

  protected toUsage(result: RunResult): CogitatorUsageV3 {
    return v3Usage(result);
  }

  protected finishReason(result: RunResult): CogitatorFinishReasonV3 {
    return runFinish(result);
  }

  protected approvalRequests(result: RunResult): CogitatorToolApprovalRequestContent[] {
    return v3ApprovalRequests(result);
  }
}
