import type { Agent, Cogitator } from '@cogitator-ai/core';
import type { ToolResult } from '@cogitator-ai/types';
import {
  AgentRunner,
  runMetadata,
  type AgentCall,
  type CallWarning,
  type PreparedAgentCall,
} from './agent-runner.js';
import type { CogitatorProviderOptions } from './types.js';
import type {
  LanguageModelV1,
  LanguageModelV1CallOptions,
  LanguageModelV1CallWarning,
  LanguageModelV1FunctionTool,
  LanguageModelV1GenerateResult,
  LanguageModelV1StreamPart,
  LanguageModelV1StreamResult,
} from './v1-types.js';

const V1_UNSUPPORTED_SETTINGS = ['topK', 'presencePenalty', 'frequencyPenalty', 'seed'] as const;

type V1UnsupportedSetting = (typeof V1_UNSUPPORTED_SETTINGS)[number];

function isV1UnsupportedSetting(setting: string): setting is V1UnsupportedSetting {
  return (V1_UNSUPPORTED_SETTINGS as readonly string[]).includes(setting);
}

interface V1Call {
  call: AgentCall;
  objectTool?: LanguageModelV1FunctionTool;
}

function toV1Call(options: LanguageModelV1CallOptions): V1Call {
  const base: AgentCall = {
    prompt: options.prompt,
    temperature: options.temperature,
    topP: options.topP,
    maxTokens: options.maxTokens,
    stopSequences: options.stopSequences,
    responseFormat: options.responseFormat,
    toolNames: [],
    unsupportedSettings: V1_UNSUPPORTED_SETTINGS.filter(
      (setting) => options[setting] !== undefined
    ),
    abortSignal: options.abortSignal,
  };

  switch (options.mode.type) {
    case 'regular':
      return {
        call: { ...base, toolNames: (options.mode.tools ?? []).map((tool) => tool.name) },
      };
    case 'object-json':
      return {
        call: {
          ...base,
          responseFormat: {
            type: 'json',
            schema: options.mode.schema,
            name: options.mode.name,
            description: options.mode.description,
          },
        },
      };
    case 'object-tool':
      return {
        call: {
          ...base,
          responseFormat: {
            type: 'json',
            schema: options.mode.tool.parameters,
            name: options.mode.tool.name,
            description: options.mode.tool.description,
          },
        },
        objectTool: options.mode.tool,
      };
  }
}

function toV1Warning(
  warning: CallWarning,
  options: LanguageModelV1CallOptions
): LanguageModelV1CallWarning {
  switch (warning.type) {
    case 'setting': {
      const setting: string = warning.setting;
      return isV1UnsupportedSetting(setting)
        ? { type: 'unsupported-setting', setting, details: warning.details }
        : { type: 'other', message: `Unsupported setting "${setting}"` };
    }
    case 'tool': {
      const tool =
        options.mode.type === 'regular'
          ? options.mode.tools?.find((candidate) => candidate.name === warning.toolName)
          : undefined;
      return tool
        ? { type: 'unsupported-tool', tool, details: warning.details }
        : { type: 'other', message: `Unsupported tool "${warning.toolName}"` };
    }
    case 'other':
      return warning;
  }
}

function rawSettings(agent: Agent): Record<string, unknown> {
  return {
    temperature: agent.config.temperature,
    maxTokens: agent.config.maxTokens,
    topP: agent.config.topP,
  };
}

export class AgentLanguageModelV1 implements LanguageModelV1 {
  readonly specificationVersion = 'v1';
  readonly provider = 'cogitator';
  readonly modelId: string;
  readonly defaultObjectGenerationMode = 'json';

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

  async doGenerate(options: LanguageModelV1CallOptions): Promise<LanguageModelV1GenerateResult> {
    const { call, objectTool } = toV1Call(options);
    const prepared = this.runner.prepare(call);
    const results = new Map<string, ToolResult>();

    const result = await this.runner.run(
      prepared,
      { onToolResult: (toolResult) => results.set(toolResult.callId, toolResult) },
      { stream: false }
    );

    return {
      text: objectTool ? undefined : result.output,
      toolCalls: objectTool
        ? [
            {
              toolCallType: 'function',
              toolCallId: result.runId,
              toolName: objectTool.name,
              args: result.output,
            },
          ]
        : undefined,
      finishReason: 'stop',
      usage: {
        promptTokens: result.usage.inputTokens,
        completionTokens: result.usage.outputTokens,
      },
      rawCall: { rawPrompt: prepared.input, rawSettings: rawSettings(prepared.agent) },
      response: {
        id: result.runId,
        timestamp: new Date(),
        modelId: result.modelUsed ?? prepared.agent.model,
      },
      warnings: this.warnings(prepared, options),
      providerMetadata: runMetadata(result, prepared.agent, results),
    };
  }

  async doStream(options: LanguageModelV1CallOptions): Promise<LanguageModelV1StreamResult> {
    const { call, objectTool } = toV1Call(options);
    const prepared = this.runner.prepare(call);
    const abortController = new AbortController();
    const signal = prepared.abortSignal
      ? AbortSignal.any([prepared.abortSignal, abortController.signal])
      : abortController.signal;
    let closed = false;
    let runId = `cogitator-${Date.now()}`;

    const stream = new ReadableStream<LanguageModelV1StreamPart>({
      start: (controller) => {
        const results = new Map<string, ToolResult>();
        let output = '';

        const emit = (part: LanguageModelV1StreamPart) => {
          if (!closed) controller.enqueue(part);
        };

        void this.runner
          .run(
            prepared,
            {
              onRunStart: (id) => {
                runId = id;
                emit({
                  type: 'response-metadata',
                  id,
                  timestamp: new Date(),
                  modelId: prepared.agent.model,
                });
              },
              onTextDelta: (delta) => {
                if (!delta) return;
                output += delta;
                emit(
                  objectTool
                    ? {
                        type: 'tool-call-delta',
                        toolCallType: 'function',
                        toolCallId: runId,
                        toolName: objectTool.name,
                        argsTextDelta: delta,
                      }
                    : { type: 'text-delta', textDelta: delta }
                );
              },
              onToolResult: (toolResult) => results.set(toolResult.callId, toolResult),
            },
            { stream: true, signal }
          )
          .then(
            (result) => {
              if (objectTool) {
                emit({
                  type: 'tool-call',
                  toolCallType: 'function',
                  toolCallId: runId,
                  toolName: objectTool.name,
                  args: output || result.output,
                });
              }
              emit({
                type: 'finish',
                finishReason: 'stop',
                usage: {
                  promptTokens: result.usage.inputTokens,
                  completionTokens: result.usage.outputTokens,
                },
                providerMetadata: runMetadata(result, prepared.agent, results),
              });
            },
            (error: unknown) => emit({ type: 'error', error })
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

    return {
      stream,
      rawCall: { rawPrompt: prepared.input, rawSettings: rawSettings(prepared.agent) },
      warnings: this.warnings(prepared, options),
    };
  }

  private warnings(
    prepared: PreparedAgentCall,
    options: LanguageModelV1CallOptions
  ): LanguageModelV1CallWarning[] {
    return prepared.warnings.map((warning) => toV1Warning(warning, options));
  }
}
