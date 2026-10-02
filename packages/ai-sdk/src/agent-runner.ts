import type { Agent, Cogitator } from '@cogitator-ai/core';
import type { AgentConfig, RunResult, ToolCall, ToolResult } from '@cogitator-ai/types';
import { toJSONValue, type JSONObject, type JSONValue } from './json.js';
import type { CogitatorProviderOptions } from './types.js';

export interface PromptPartLike {
  readonly type: string;
  readonly text?: string;
}

export interface PromptMessageLike {
  readonly role: 'system' | 'user' | 'assistant' | 'tool';
  readonly content: string | ReadonlyArray<PromptPartLike>;
}

export type AgentCallResponseFormat =
  { type: 'text' } | { type: 'json'; schema?: unknown; name?: string; description?: string };

export interface AgentCall {
  prompt: ReadonlyArray<PromptMessageLike>;
  temperature?: number;
  topP?: number;
  maxTokens?: number;
  stopSequences?: string[];
  responseFormat?: AgentCallResponseFormat;
  toolNames: readonly string[];
  unsupportedSettings: readonly string[];
  abortSignal?: AbortSignal;
}

export type CallWarning =
  | { type: 'setting'; setting: string; details?: string }
  | { type: 'tool'; toolName: string; details?: string }
  | { type: 'other'; message: string };

export interface PreparedAgentCall {
  agent: Agent;
  input: string;
  warnings: CallWarning[];
  abortSignal?: AbortSignal;
}

export interface AgentRunListener {
  onRunStart?(runId: string): void;
  onTextDelta?(delta: string): void;
  onToolCall?(call: ToolCall): void;
  onToolResult?(result: ToolResult): void;
}

const SYSTEM_PROMPT_WARNING =
  'System messages are not forwarded: the agent instructions are its system prompt.';

const FOREIGN_TOOL_DETAILS =
  'Cogitator agents only call their own tools; register the tool on the agent instead.';

export class AgentRunner {
  constructor(
    private readonly cogitator: Cogitator,
    private readonly agent: Agent,
    private readonly defaults: CogitatorProviderOptions
  ) {}

  prepare(call: AgentCall): PreparedAgentCall {
    const { input, warnings } = buildAgentInput(call.prompt);

    for (const setting of call.unsupportedSettings) {
      warnings.push({ type: 'setting', setting });
    }

    const agentToolNames = new Set(this.agent.tools.map((tool) => tool.name));
    for (const toolName of call.toolNames) {
      if (!agentToolNames.has(toolName)) {
        warnings.push({ type: 'tool', toolName, details: FOREIGN_TOOL_DETAILS });
      }
    }

    const overrides: Partial<AgentConfig> = {};
    const temperature = call.temperature ?? this.defaults.temperature;
    const topP = call.topP ?? this.defaults.topP;
    const maxTokens = call.maxTokens ?? this.defaults.maxTokens;
    if (temperature !== undefined) overrides.temperature = temperature;
    if (topP !== undefined) overrides.topP = topP;
    if (maxTokens !== undefined) overrides.maxTokens = maxTokens;
    if (call.stopSequences && call.stopSequences.length > 0) {
      overrides.stopSequences = call.stopSequences;
    }

    let finalInput = input;
    if (call.responseFormat?.type === 'json') {
      overrides.responseFormat = { type: 'json' };
      finalInput = `${input}\n\n${jsonInstruction(call.responseFormat.schema)}`;
    }

    return {
      agent: Object.keys(overrides).length > 0 ? this.agent.clone(overrides) : this.agent,
      input: finalInput,
      warnings,
      abortSignal: call.abortSignal,
    };
  }

  run(
    prepared: PreparedAgentCall,
    listener: AgentRunListener,
    options: { stream: boolean; signal?: AbortSignal }
  ): Promise<RunResult> {
    return this.cogitator.run(prepared.agent, {
      input: prepared.input,
      stream: options.stream,
      signal: options.signal ?? prepared.abortSignal,
      onRunStart: listener.onRunStart && ((data) => listener.onRunStart?.(data.runId)),
      onToken: options.stream ? listener.onTextDelta : undefined,
      onToolCall: listener.onToolCall,
      onToolResult: listener.onToolResult,
    });
  }
}

function buildAgentInput(prompt: ReadonlyArray<PromptMessageLike>): {
  input: string;
  warnings: CallWarning[];
} {
  const warnings: CallWarning[] = [];
  const turns: { role: 'user' | 'assistant'; text: string }[] = [];
  const droppedUserParts = new Set<string>();
  let hasSystem = false;

  for (const message of prompt) {
    if (message.role === 'system') {
      if (textOf(message.content).trim()) hasSystem = true;
      continue;
    }
    if (message.role === 'tool') continue;

    if (message.role === 'user' && typeof message.content !== 'string') {
      for (const part of message.content) {
        if (part.type !== 'text') droppedUserParts.add(part.type);
      }
    }

    const text = textOf(message.content);
    if (text.trim()) turns.push({ role: message.role, text });
  }

  if (hasSystem) warnings.push({ type: 'other', message: SYSTEM_PROMPT_WARNING });
  if (droppedUserParts.size > 0) {
    warnings.push({
      type: 'other',
      message: `Only text is forwarded to the agent; dropped ${[...droppedUserParts].join(', ')} content.`,
    });
  }

  const input =
    turns.length === 1 && turns[0].role === 'user'
      ? turns[0].text
      : turns
          .map((turn) => `${turn.role === 'user' ? 'User' : 'Assistant'}: ${turn.text}`)
          .join('\n\n');

  return { input, warnings };
}

function textOf(content: string | ReadonlyArray<PromptPartLike>): string {
  if (typeof content === 'string') return content;
  return content
    .filter((part) => part.type === 'text' && typeof part.text === 'string')
    .map((part) => part.text)
    .join('');
}

function jsonInstruction(schema: unknown): string {
  return schema === undefined
    ? 'Respond only with valid JSON.'
    : `Respond only with valid JSON that matches this JSON schema:\n${JSON.stringify(schema)}`;
}

export function serializeToolInput(call: ToolCall): string {
  return JSON.stringify(call.arguments ?? {});
}

export function toolResultValue(result: ToolResult): {
  value: NonNullable<JSONValue>;
  isError: boolean;
} {
  if (result.error !== undefined) {
    return { value: result.error, isError: true };
  }
  const value = toJSONValue(result.result);
  return { value: value ?? 'null', isError: false };
}

export function runMetadata(
  result: RunResult,
  agent: Agent,
  toolResults: ReadonlyMap<string, ToolResult>
): { cogitator: JSONObject } {
  const metadata: JSONObject = {
    runId: result.runId,
    threadId: result.threadId,
    agentId: result.agentId,
    model: result.modelUsed ?? agent.model,
    cost: result.usage.cost,
    duration: result.usage.duration,
  };
  if (result.toolCalls.length > 0) {
    metadata.toolCalls = toolCallSummaries(result.toolCalls, toolResults);
  }
  return { cogitator: metadata };
}

function toolCallSummaries(
  calls: readonly ToolCall[],
  results: ReadonlyMap<string, ToolResult>
): JSONValue[] {
  return calls.map((call) => {
    const result = results.get(call.id);
    return {
      id: call.id,
      name: call.name,
      arguments: toJSONValue(call.arguments),
      ...(result
        ? { result: toolResultValue(result).value, isError: result.error !== undefined }
        : {}),
    };
  });
}
