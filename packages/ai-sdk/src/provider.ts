import type {
  LanguageModelV1,
  LanguageModelV1CallOptions,
  LanguageModelV1CallWarning,
  LanguageModelV1FinishReason,
  LanguageModelV1StreamPart,
  LanguageModelV1FunctionToolCall,
} from '@ai-sdk/provider';
import type { Cogitator, Agent } from '@cogitator-ai/core';
import type { ToolCall } from '@cogitator-ai/types';
import type {
  CogitatorProviderOptions,
  CogitatorProviderConfig,
  CogitatorProvider,
} from './types.js';

function convertMessagesToPrompt(options: LanguageModelV1CallOptions): {
  systemPrompt: string | undefined;
  userMessage: string;
} {
  let systemPrompt: string | undefined;
  let userMessage = '';

  const prompt = options.prompt;

  for (const msg of prompt) {
    if (msg.role === 'system') {
      systemPrompt = msg.content;
    } else if (msg.role === 'user') {
      for (const part of msg.content) {
        if (part.type === 'text') {
          userMessage += part.text;
        }
      }
    } else if (msg.role === 'assistant') {
      for (const part of msg.content) {
        if (part.type === 'text') {
          userMessage += `\n\nAssistant: ${part.text}`;
        }
      }
    }
  }

  return { systemPrompt, userMessage };
}

function convertToolCallsToAISDK(
  toolCalls: readonly ToolCall[]
): LanguageModelV1FunctionToolCall[] {
  return toolCalls.map((tc) => ({
    toolCallType: 'function' as const,
    toolCallId: tc.id,
    toolName: tc.name,
    args: JSON.stringify(tc.arguments),
  }));
}

class CogitatorLanguageModel implements LanguageModelV1 {
  readonly specificationVersion = 'v1' as const;
  readonly provider: string;
  readonly modelId: string;
  readonly defaultObjectGenerationMode = 'tool' as const;

  private cogitator: Cogitator;
  private agent: Agent;
  private options: CogitatorProviderOptions;

  constructor(
    cogitator: Cogitator,
    agent: Agent,
    agentName: string,
    options: CogitatorProviderOptions = {}
  ) {
    this.cogitator = cogitator;
    this.agent = agent;
    this.provider = 'cogitator';
    this.modelId = agentName;
    this.options = options;
  }

  async doGenerate(options: LanguageModelV1CallOptions): Promise<{
    text?: string;
    toolCalls?: LanguageModelV1FunctionToolCall[];
    finishReason: LanguageModelV1FinishReason;
    usage: { promptTokens: number; completionTokens: number };
    rawCall: { rawPrompt: unknown; rawSettings: Record<string, unknown> };
    rawResponse?: { headers?: Record<string, string> };
    warnings?: LanguageModelV1CallWarning[];
    logprobs?: undefined;
  }> {
    const { userMessage } = convertMessagesToPrompt(options);

    const agent =
      this.options.temperature !== undefined || this.options.maxTokens !== undefined
        ? this.agent.clone({
            temperature: this.options.temperature ?? this.agent.config.temperature,
            maxTokens: this.options.maxTokens ?? this.agent.config.maxTokens,
          })
        : this.agent;

    const result = await this.cogitator.run(agent, {
      input: userMessage,
      stream: false,
    });

    const hasToolCalls = result.toolCalls && result.toolCalls.length > 0;

    return {
      text: result.output,
      toolCalls: hasToolCalls ? convertToolCallsToAISDK(result.toolCalls!) : undefined,
      finishReason: hasToolCalls ? 'tool-calls' : 'stop',
      usage: {
        promptTokens: result.usage.inputTokens,
        completionTokens: result.usage.outputTokens,
      },
      rawCall: {
        rawPrompt: userMessage,
        rawSettings: {
          temperature: agent.config.temperature,
          maxTokens: agent.config.maxTokens,
        },
      },
    };
  }

  async doStream(options: LanguageModelV1CallOptions): Promise<{
    stream: ReadableStream<LanguageModelV1StreamPart>;
    rawCall: { rawPrompt: unknown; rawSettings: Record<string, unknown> };
    rawResponse?: { headers?: Record<string, string> };
    warnings?: LanguageModelV1CallWarning[];
  }> {
    const { userMessage } = convertMessagesToPrompt(options);

    const agent =
      this.options.temperature !== undefined || this.options.maxTokens !== undefined
        ? this.agent.clone({
            temperature: this.options.temperature ?? this.agent.config.temperature,
            maxTokens: this.options.maxTokens ?? this.agent.config.maxTokens,
          })
        : this.agent;

    const cogitator = this.cogitator;
    let totalInputTokens = 0;
    let totalOutputTokens = 0;
    const collectedToolCalls: ToolCall[] = [];

    const stream = new ReadableStream<LanguageModelV1StreamPart>({
      async start(controller) {
        try {
          const result = await cogitator.run(agent, {
            input: userMessage,
            stream: true,
            onToken: (token: string) => {
              controller.enqueue({
                type: 'text-delta',
                textDelta: token,
              });
            },
            onToolCall: (toolCall: ToolCall) => {
              collectedToolCalls.push(toolCall);
              controller.enqueue({
                type: 'tool-call',
                toolCallType: 'function',
                toolCallId: toolCall.id,
                toolName: toolCall.name,
                args: JSON.stringify(toolCall.arguments),
              });
            },
          });

          totalInputTokens = result.usage.inputTokens;
          totalOutputTokens = result.usage.outputTokens;

          const hasToolCalls = collectedToolCalls.length > 0;

          controller.enqueue({
            type: 'finish',
            finishReason: hasToolCalls ? 'tool-calls' : 'stop',
            usage: {
              promptTokens: totalInputTokens,
              completionTokens: totalOutputTokens,
            },
          });

          controller.close();
        } catch (error) {
          controller.enqueue({
            type: 'error',
            error: error instanceof Error ? error : new Error(String(error)),
          });
          controller.close();
        }
      },
    });

    return {
      stream,
      rawCall: {
        rawPrompt: userMessage,
        rawSettings: {
          temperature: agent.config.temperature,
          maxTokens: agent.config.maxTokens,
        },
      },
    };
  }
}

function buildAgentMap(
  agents: Agent[] | Map<string, Agent> | Record<string, Agent>
): Map<string, Agent> {
  if (agents instanceof Map) return agents;
  if (Array.isArray(agents)) {
    const map = new Map<string, Agent>();
    for (const agent of agents) {
      map.set(agent.name, agent);
    }
    return map;
  }
  return new Map(Object.entries(agents));
}

export function createCogitatorProvider(
  cogitator: Cogitator,
  config: CogitatorProviderConfig
): CogitatorProvider {
  const agentMap = buildAgentMap(config.agents);

  function getAgent(name: string): Agent {
    const agent = agentMap.get(name);
    if (!agent) {
      throw new Error(
        `Agent "${name}" not found. Available agents: ${[...agentMap.keys()].join(', ')}`
      );
    }
    return agent;
  }

  const provider = function (
    agentName: string,
    options: CogitatorProviderOptions = {}
  ): LanguageModelV1 {
    const agent = getAgent(agentName);
    return new CogitatorLanguageModel(cogitator, agent, agentName, options);
  } as CogitatorProvider;

  provider.languageModel = provider;

  return provider;
}

export function cogitatorModel(
  cogitator: Cogitator,
  agent: Agent,
  options: CogitatorProviderOptions = {}
): LanguageModelV1 {
  return new CogitatorLanguageModel(cogitator, agent, agent.name, options);
}
