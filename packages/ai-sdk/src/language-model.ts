import type {
  LanguageModelV2,
  LanguageModelV2CallOptions,
  LanguageModelV3,
  LanguageModelV3CallOptions,
  LanguageModelV4,
  LanguageModelV4CallOptions,
} from '@ai-sdk/provider';
import type { Agent, Cogitator } from '@cogitator-ai/core';
import type { RunResult, ToolCall, ToolResult } from '@cogitator-ai/types';
import {
  AgentRunner,
  runMetadata,
  serializeToolInput,
  toolResultValue,
  type AgentCallResponseFormat,
  type CallWarning,
  type PreparedAgentCall,
  type PromptMessageLike,
} from './agent-runner.js';
import type {
  CogitatorFinishReasonV3,
  CogitatorGenerateResult,
  CogitatorLanguageModelV2,
  CogitatorLanguageModelV3,
  CogitatorLanguageModelV4,
  CogitatorProviderOptions,
  CogitatorStreamPart,
  CogitatorStreamResult,
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
  reasoning?: string;
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
  protected abstract stopReason(): TFinishReason;

  protected exposesToolCall(_toolName: string, _options: TCallOptions): boolean {
    return true;
  }

  protected unsupportedSettings(options: TCallOptions): string[] {
    return MODERN_UNSUPPORTED_SETTINGS.filter((setting) => options[setting] !== undefined);
  }

  async doGenerate(
    options: TCallOptions
  ): Promise<CogitatorGenerateResult<TWarning, TUsage, TFinishReason>> {
    const prepared = this.prepare(options);
    const content: CogitatorGenerateResult<TWarning, TUsage, TFinishReason>['content'] = [];

    const toolResults = new Map<string, ToolResult>();

    const result = await this.runner.run(
      prepared,
      {
        onToolCall: (call) => {
          if (this.exposesToolCall(call.name, options)) content.push(toolCallContent(call));
        },
        onToolResult: (toolResult) => {
          toolResults.set(toolResult.callId, toolResult);
          if (this.exposesToolCall(toolResult.name, options)) {
            content.push(toolResultContent(toolResult));
          }
        },
      },
      { stream: false }
    );

    if (result.output) content.push({ type: 'text', text: result.output });

    return {
      content,
      finishReason: this.stopReason(),
      usage: this.toUsage(result),
      providerMetadata: runMetadata(result, prepared.agent, toolResults),
      request: { body: { input: prepared.input } },
      response: {
        id: result.runId,
        timestamp: new Date(),
        modelId: result.modelUsed ?? prepared.agent.model,
      },
      warnings: prepared.warnings.map((warning) => this.toWarning(warning)),
    };
  }

  async doStream(
    options: TCallOptions
  ): Promise<CogitatorStreamResult<TWarning, TUsage, TFinishReason>> {
    const prepared = this.prepare(options);
    const warnings = prepared.warnings.map((warning) => this.toWarning(warning));
    const abortController = new AbortController();
    const signal = prepared.abortSignal
      ? AbortSignal.any([prepared.abortSignal, abortController.signal])
      : abortController.signal;
    let closed = false;

    const stream = new ReadableStream<CogitatorStreamPart<TWarning, TUsage, TFinishReason>>({
      start: (controller) => {
        let textId: string | undefined;
        let textBlocks = 0;
        const toolResults = new Map<string, ToolResult>();

        const emit = (part: CogitatorStreamPart<TWarning, TUsage, TFinishReason>) => {
          if (!closed) controller.enqueue(part);
        };
        const closeText = () => {
          if (textId === undefined) return;
          emit({ type: 'text-end', id: textId });
          textId = undefined;
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
                  modelId: prepared.agent.model,
                }),
              onTextDelta: (delta) => {
                if (!delta) return;
                if (textId === undefined) {
                  textId = `text-${textBlocks++}`;
                  emit({ type: 'text-start', id: textId });
                }
                emit({ type: 'text-delta', id: textId, delta });
              },
              onToolCall: (call) => {
                if (!this.exposesToolCall(call.name, options)) return;
                closeText();
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
                closeText();
                emit(toolResultContent(toolResult));
              },
            },
            { stream: true, signal }
          )
          .then(
            (result) => {
              closeText();
              emit({
                type: 'finish',
                usage: this.toUsage(result),
                finishReason: this.stopReason(),
                providerMetadata: runMetadata(result, prepared.agent, toolResults),
              });
            },
            (error: unknown) => {
              closeText();
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
      unsupportedSettings: this.unsupportedSettings(options),
      abortSignal: options.abortSignal,
    });
  }
}

function v3Usage(result: RunResult): CogitatorUsageV3 {
  return {
    inputTokens: {
      total: result.usage.inputTokens,
      noCache: undefined,
      cacheRead: undefined,
      cacheWrite: undefined,
    },
    outputTokens: { total: result.usage.outputTokens, text: undefined, reasoning: undefined },
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

const V3_STOP: CogitatorFinishReasonV3 = { unified: 'stop', raw: 'stop' };

export class AgentLanguageModelV2
  extends AgentLanguageModel<
    LanguageModelV2CallOptions,
    CogitatorWarningV2,
    CogitatorUsageV2,
    'stop'
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
    };
  }

  protected stopReason(): 'stop' {
    return 'stop';
  }
}

export class AgentLanguageModelV3
  extends AgentLanguageModel<
    LanguageModelV3CallOptions,
    CogitatorWarningV3,
    CogitatorUsageV3,
    CogitatorFinishReasonV3
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

  protected stopReason(): CogitatorFinishReasonV3 {
    return V3_STOP;
  }
}

export class AgentLanguageModelV4
  extends AgentLanguageModel<
    LanguageModelV4CallOptions,
    CogitatorWarningV3,
    CogitatorUsageV3,
    CogitatorFinishReasonV3
  >
  implements CogitatorLanguageModelV4, LanguageModelV4
{
  readonly specificationVersion = 'v4';

  protected unsupportedSettings(options: LanguageModelV4CallOptions): string[] {
    const settings = super.unsupportedSettings(options);
    if (options.reasoning !== undefined && options.reasoning !== 'provider-default') {
      settings.push('reasoning');
    }
    return settings;
  }

  protected toWarning(warning: CallWarning): CogitatorWarningV3 {
    return v3Warning(warning);
  }

  protected toUsage(result: RunResult): CogitatorUsageV3 {
    return v3Usage(result);
  }

  protected stopReason(): CogitatorFinishReasonV3 {
    return V3_STOP;
  }
}
