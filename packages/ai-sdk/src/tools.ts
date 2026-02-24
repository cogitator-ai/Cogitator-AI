import type { Tool, ToolContext, ToolSchema } from '@cogitator-ai/types';

interface AISDKCoreTool {
  description?: string;
  parameters?: unknown;
  execute?: (
    params: unknown,
    options: { toolCallId: string; messages: unknown[]; abortSignal?: AbortSignal }
  ) => Promise<unknown>;
}

export function fromAISDKTool<TParams = unknown, TResult = unknown>(
  aiTool: AISDKCoreTool & { name?: string },
  toolName?: string
): Tool<TParams, TResult> {
  if (!aiTool.parameters) {
    throw new Error('AI SDK tool must have parameters defined');
  }

  const execute = async (params: TParams, context: ToolContext): Promise<TResult> => {
    if (!aiTool.execute) {
      throw new Error(`Tool "${name}" has no execute function`);
    }
    return aiTool.execute(params, {
      toolCallId: context.runId,
      messages: [],
      abortSignal: context.signal,
    }) as Promise<TResult>;
  };

  const name = toolName ?? aiTool.name ?? 'unnamed_tool';
  const description = aiTool.description ?? 'AI SDK tool';
  const parameters = aiTool.parameters;

  return {
    name,
    description,
    parameters,
    execute,
    toJSON(): ToolSchema {
      return {
        name: this.name,
        description: this.description,
        parameters: parameters as ToolSchema['parameters'],
      };
    },
  } as Tool<TParams, TResult>;
}

export function toAISDKTool<TParams = unknown, TResult = unknown>(
  cogTool: Tool<TParams, TResult>
): AISDKCoreTool {
  return {
    description: cogTool.description,
    parameters: cogTool.parameters,
    execute: async (
      params: unknown,
      options: { toolCallId: string; messages: unknown[]; abortSignal?: AbortSignal }
    ): Promise<unknown> => {
      const context: ToolContext = {
        agentId: 'ai-sdk',
        runId: options.toolCallId,
        signal: options.abortSignal ?? new AbortController().signal,
      };
      return cogTool.execute(params as TParams, context);
    },
  };
}

export function convertToolsFromAISDK(aiTools: Record<string, AISDKCoreTool>): Tool[] {
  return Object.entries(aiTools).map(([name, aiTool]) => {
    return fromAISDKTool(aiTool, name);
  });
}

export function convertToolsToAISDK(cogTools: Tool[]): Record<string, AISDKCoreTool> {
  const result: Record<string, AISDKCoreTool> = {};
  for (const tool of cogTools) {
    result[tool.name] = toAISDKTool(tool);
  }
  return result;
}
