import type { Agent, Cogitator } from '@cogitator-ai/core';
import type {
  AgentConfig,
  Message,
  ReasoningEffort,
  RunResult,
  ToolApprovalDecision,
  ToolCall,
  ToolCallMessage,
  ToolChoice,
  ToolResult,
  ToolResultMessage,
} from '@cogitator-ai/types';
import { isRecord, toJSONValue, type JSONObject, type JSONValue } from './json.js';
import type { CogitatorFinishReasonV3, CogitatorProviderOptions } from './types.js';

export interface PromptPartLike {
  readonly type: string;
  readonly text?: string;
  /** `tool-call` parts: the call */
  readonly toolCallId?: string;
  readonly toolName?: string;
  readonly input?: unknown;
  /** `tool-call` parts of ai@4: the arguments */
  readonly args?: unknown;
  /** `tool-result` parts (ai@5 and later): what the tool returned */
  readonly output?: unknown;
  /** `tool-result` parts of ai@4: what the tool returned, and whether it failed */
  readonly result?: unknown;
  readonly isError?: boolean;
  /** `tool-approval-response` parts: the decision on an approval request */
  readonly approvalId?: string;
  readonly approved?: boolean;
  readonly reason?: string;
}

export interface PromptMessageLike {
  readonly role: 'system' | 'user' | 'assistant' | 'tool';
  readonly content: string | ReadonlyArray<PromptPartLike>;
}

export type AgentCallResponseFormat =
  { type: 'text' } | { type: 'json'; schema?: unknown; name?: string; description?: string };

/** The AI SDK `toolChoice` of a call */
export interface AgentCallToolChoice {
  readonly type: 'auto' | 'none' | 'required' | 'tool';
  readonly toolName?: string;
}

export interface AgentCall {
  prompt: ReadonlyArray<PromptMessageLike>;
  temperature?: number;
  topP?: number;
  maxTokens?: number;
  stopSequences?: string[];
  responseFormat?: AgentCallResponseFormat;
  toolNames: readonly string[];
  toolChoice?: AgentCallToolChoice;
  unsupportedSettings: readonly string[];
  /** Overrides the effort of the agent's `reasoning`, keeping its other settings */
  reasoningEffort?: ReasoningEffort;
  abortSignal?: AbortSignal;
  /** `providerOptions.cogitator` of the call (`providerMetadata.cogitator` on ai@4) */
  providerOptions?: unknown;
}

/** What a call may set in `providerOptions.cogitator` */
export interface CogitatorCallOptions {
  /**
   * The memory thread of the run: its history comes from memory, so the prompt gives only the
   * new turn. Without it, the prompt is the whole conversation
   */
  threadId?: string;
  /** The user the run belongs to: memory, tools (`context.userId`) and resumes see it */
  userId?: string;
  /** Save the turn to memory. Default: `true` with a `threadId`, `false` without */
  saveHistory?: boolean;
}

export type CallWarning =
  | { type: 'setting'; setting: string; details?: string }
  | { type: 'tool'; toolName: string; details?: string }
  | { type: 'other'; message: string };

/** A paused run the prompt answers with `tool-approval-response` parts. */
export interface AgentCallResume {
  threadId: string;
  decisions: Record<string, ToolApprovalDecision>;
  /** The tool calls of earlier responses in the prompt, by id, as `tool-call` content had them */
  priorToolCalls: ReadonlyMap<string, { toolName: string; input: string }>;
}

export interface PreparedAgentCall {
  agent: Agent;
  /** The model the run uses: the agent's own, or the Cogitator's `llm.defaultModel`. */
  model: string;
  input: string;
  warnings: CallWarning[];
  abortSignal?: AbortSignal;
  /**
   * The call asks for JSON (`responseFormat: json`): only the agent's final answer is text of the
   * response, never what it wrote before a tool call
   */
  jsonMode: boolean;
  /** Set when the call continues a paused run instead of starting one */
  resume?: AgentCallResume;
  /** The run's `toolChoice` when the call forces a tool: `'required'` or one of the agent's */
  toolChoice?: ToolChoice;
  /** The conversation before the new turn, when the prompt carries it (no `threadId`) */
  history?: Message[];
  /** The `providerOptions.cogitator` of the call */
  options: CogitatorCallOptions;
}

/** The warning of a model that cannot ask for the tool approvals its agent's run waits on. */
export const PAUSE_WARNING =
  'The agent run paused for tool approvals, which this AI SDK version cannot ask for. ' +
  'providerMetadata.cogitator has the threadId and pendingApprovals: resume the run with ' +
  'cogitator.resume(agent, threadId, { decisions }).';

const APPROVAL_ID_PREFIX = 'cogitator:';

/**
 * The `approvalId` of a `tool-approval-request` for a call a paused run waits on. It names the
 * run's thread, so the `tool-approval-response` that comes back in the next prompt resumes it.
 */
export function approvalIdFor(threadId: string, toolCallId: string): string {
  return `${APPROVAL_ID_PREFIX}${encodeURIComponent(threadId)}:${encodeURIComponent(toolCallId)}`;
}

/** The thread and tool call an approval id stands for, or undefined for a foreign id. */
export function parseApprovalId(
  approvalId: string
): { threadId: string; toolCallId: string } | undefined {
  if (!approvalId.startsWith(APPROVAL_ID_PREFIX)) return undefined;
  const parts = approvalId.slice(APPROVAL_ID_PREFIX.length).split(':');
  if (parts.length !== 2 || !parts[0] || !parts[1]) return undefined;
  try {
    return { threadId: decodeURIComponent(parts[0]), toolCallId: decodeURIComponent(parts[1]) };
  } catch {
    return undefined;
  }
}

/**
 * The paused run a prompt answers: its last message is a tool message with
 * `tool-approval-response` parts for Cogitator approval requests.
 *
 * @throws Error when the responses answer runs of several threads
 */
function findResume(prompt: ReadonlyArray<PromptMessageLike>): AgentCallResume | undefined {
  const last = prompt.at(-1);
  if (last?.role !== 'tool' || typeof last.content === 'string') return undefined;

  const decisions: Record<string, ToolApprovalDecision> = {};
  const threads = new Set<string>();
  for (const part of last.content) {
    if (part.type !== 'tool-approval-response' || typeof part.approvalId !== 'string') continue;
    const target = parseApprovalId(part.approvalId);
    if (!target) continue;
    threads.add(target.threadId);
    decisions[target.toolCallId] =
      part.approved === true
        ? { approved: true }
        : { approved: false, ...(part.reason && { reason: part.reason }) };
  }
  if (threads.size === 0) return undefined;
  if (threads.size > 1) {
    throw new Error(
      `The tool approval responses answer ${threads.size} paused Cogitator runs; answer one at a time`
    );
  }

  const priorToolCalls = new Map<string, { toolName: string; input: string }>();
  for (const message of prompt) {
    if (message.role !== 'assistant' || typeof message.content === 'string') continue;
    for (const part of message.content) {
      if (part.type !== 'tool-call' || !part.toolCallId || !part.toolName) continue;
      priorToolCalls.set(part.toolCallId, {
        toolName: part.toolName,
        input: typeof part.input === 'string' ? part.input : JSON.stringify(part.input ?? {}),
      });
    }
  }
  return { threadId: [...threads][0], decisions, priorToolCalls };
}

export interface AgentRunListener {
  onRunStart?(runId: string): void;
  onTextDelta?(delta: string): void;
  onReasoningDelta?(delta: string): void;
  onToolCall?(call: ToolCall): void;
  onToolResult?(result: ToolResult): void;
}

const SYSTEM_PROMPT_WARNING =
  'System messages are not forwarded: the agent instructions are its system prompt.';

const FOREIGN_TOOL_DETAILS =
  'Cogitator agents only call their own tools; register the tool on the agent instead.';

const FOREIGN_TOOL_CHOICE_DETAILS =
  'Only a tool of the agent can be forced, so the agent decides which of its tools to call.';

const RESUME_TOOL_CHOICE_DETAILS =
  'toolChoice "none" does not apply to a paused run the prompt resumes: it continues with its tools.';

const COGITATOR_TOOLS_DETAILS =
  'toolChoice "none" removes the agent\'s tools, but tools registered on the Cogitator itself stay callable.';

export class AgentRunner {
  constructor(
    private readonly cogitator: Cogitator,
    private readonly agent: Agent,
    private readonly defaults: CogitatorProviderOptions
  ) {}

  prepare(call: AgentCall): PreparedAgentCall {
    const options = callOptions(call.providerOptions);
    const { input, history, warnings } = splitPrompt(call.prompt);
    const resume = findResume(call.prompt);
    if (input === undefined && !resume) {
      throw new Error(
        'The prompt must end with a user message: it is the turn the Cogitator agent answers'
      );
    }

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
    if (call.reasoningEffort !== undefined) {
      overrides.reasoning = { ...this.agent.config.reasoning, effort: call.reasoningEffort };
    }

    let finalInput = input ?? '';
    const jsonMode = call.responseFormat?.type === 'json';
    if (call.responseFormat?.type === 'json') {
      overrides.responseFormat = { type: 'json' };
      finalInput = `${finalInput}\n\n${jsonInstruction(call.responseFormat.schema)}`;
    }

    const toolChoice = call.toolChoice?.type;
    let forcedToolChoice: ToolChoice | undefined;
    if (toolChoice === 'required') {
      forcedToolChoice = 'required';
    } else if (toolChoice === 'tool') {
      const toolName = call.toolChoice?.toolName;
      if (toolName && agentToolNames.has(toolName)) {
        forcedToolChoice = { type: 'function', function: { name: toolName } };
      } else {
        warnings.push({
          type: 'setting',
          setting: 'toolChoice',
          details: `toolChoice names "${toolName ?? ''}", which the agent does not have. ${FOREIGN_TOOL_CHOICE_DETAILS}`,
        });
      }
    } else if (toolChoice === 'none' && resume) {
      warnings.push({
        type: 'setting',
        setting: 'toolChoice',
        details: RESUME_TOOL_CHOICE_DETAILS,
      });
    } else if (toolChoice === 'none') {
      overrides.tools = [];
      overrides.handoffs = [];
      if (this.cogitator.tools.getAll().length > 0) {
        warnings.push({ type: 'setting', setting: 'toolChoice', details: COGITATOR_TOOLS_DETAILS });
      }
    }

    const agent = Object.keys(overrides).length > 0 ? this.agent.clone(overrides) : this.agent;
    return {
      agent,
      model: this.cogitator.resolveModel(agent),
      input: finalInput,
      warnings,
      abortSignal: call.abortSignal,
      jsonMode,
      ...(resume && { resume }),
      ...(forcedToolChoice && { toolChoice: forcedToolChoice }),
      ...(options.threadId === undefined && history.length > 0 && { history }),
      options,
    };
  }

  /**
   * Run the agent, or resume the run the prompt's tool approval responses answer. A resumed run
   * reports the calls it continues with before their results, as the AI SDK needs a `tool-call`
   * for every `tool-result` of a step; a call the user declined reports no result, since the AI
   * SDK records the denial itself.
   */
  run(
    prepared: PreparedAgentCall,
    listener: AgentRunListener,
    options: { stream: boolean; signal?: AbortSignal }
  ): Promise<RunResult> {
    const callbacks = {
      stream: options.stream,
      signal: options.signal ?? prepared.abortSignal,
      onRunStart:
        listener.onRunStart && ((data: { runId: string }) => listener.onRunStart?.(data.runId)),
      onToken: options.stream ? listener.onTextDelta : undefined,
      onReasoning: options.stream ? listener.onReasoningDelta : undefined,
      onToolCall: listener.onToolCall,
      onToolResult: listener.onToolResult,
    };
    const resume = prepared.resume;
    const { threadId, userId, saveHistory } = prepared.options;
    if (!resume) {
      return this.cogitator.run(prepared.agent, {
        ...callbacks,
        input: prepared.input,
        ...(prepared.toolChoice && { toolChoice: prepared.toolChoice }),
        ...(prepared.history && { history: prepared.history }),
        ...(threadId !== undefined && { threadId }),
        ...(userId !== undefined && { userId }),
        saveHistory: saveHistory ?? threadId !== undefined,
      });
    }

    const reported = new Set<string>();
    return this.cogitator.resume(prepared.agent, resume.threadId, {
      ...callbacks,
      ...(userId !== undefined && { userId }),
      decisions: resume.decisions,
      onToolCall: (call) => {
        reported.add(call.id);
        listener.onToolCall?.(call);
      },
      onToolResult: (result) => {
        if (resume.decisions[result.callId]?.approved === false) return;
        if (!reported.has(result.callId)) {
          reported.add(result.callId);
          const prior = resume.priorToolCalls.get(result.callId);
          listener.onToolCall?.({
            id: result.callId,
            name: prior?.toolName ?? result.name,
            arguments: parseArguments(prior?.input),
          });
        }
        listener.onToolResult?.(result);
      },
    });
  }
}

/**
 * The `providerOptions.cogitator` of a call, checked
 *
 * @throws Error when a field has the wrong type, or `threadId` is empty
 */
function callOptions(raw: unknown): CogitatorCallOptions {
  if (raw === undefined) return {};
  if (!isRecord(raw)) throw new Error('providerOptions.cogitator must be an object');
  const { threadId, userId, saveHistory } = raw;
  if (threadId !== undefined && (typeof threadId !== 'string' || !threadId.trim())) {
    throw new Error('providerOptions.cogitator.threadId must be a non-empty string');
  }
  if (userId !== undefined && typeof userId !== 'string') {
    throw new Error('providerOptions.cogitator.userId must be a string');
  }
  if (saveHistory !== undefined && typeof saveHistory !== 'boolean') {
    throw new Error('providerOptions.cogitator.saveHistory must be a boolean');
  }
  return {
    ...(threadId !== undefined && { threadId }),
    ...(userId !== undefined && { userId }),
    ...(saveHistory !== undefined && { saveHistory }),
  };
}

/**
 * The prompt as the agent's turn and the conversation before it: the trailing user messages
 * are the input, and everything before them becomes run history as messages, tool calls and
 * their results included. System messages are left out, the agent's instructions being its
 * system prompt, and so is user content other than text.
 */
function splitPrompt(prompt: ReadonlyArray<PromptMessageLike>): {
  input: string | undefined;
  history: Message[];
  warnings: CallWarning[];
} {
  const warnings: CallWarning[] = [];
  const droppedUserParts = new Set<string>();
  let hasSystem = false;
  const messages = prompt.filter((message) => {
    if (message.role !== 'system') return true;
    if (textOf(message.content).trim()) hasSystem = true;
    return false;
  });

  let turnStart = messages.length;
  while (turnStart > 0 && messages[turnStart - 1]?.role === 'user') turnStart--;

  const history: Message[] = [];
  for (const message of messages.slice(0, turnStart)) {
    history.push(...historyMessages(message, droppedUserParts));
  }
  const turn = messages.slice(turnStart).map((message) => {
    collectDroppedParts(message, droppedUserParts);
    return textOf(message.content);
  });

  if (hasSystem) warnings.push({ type: 'other', message: SYSTEM_PROMPT_WARNING });
  if (droppedUserParts.size > 0) {
    warnings.push({
      type: 'other',
      message: `Only text is forwarded to the agent; dropped ${[...droppedUserParts].join(', ')} content.`,
    });
  }

  return {
    input: turn.length === 0 ? undefined : turn.join('\n\n'),
    history,
    warnings,
  };
}

function collectDroppedParts(message: PromptMessageLike, dropped: Set<string>): void {
  if (message.role !== 'user' || typeof message.content === 'string') return;
  for (const part of message.content) {
    if (part.type !== 'text') dropped.add(part.type);
  }
}

/** A tool result part of the prompt as a Cogitator tool message, an error as core writes one */
function toolMessage(part: PromptPartLike): ToolResultMessage | undefined {
  if (!part.toolCallId || !part.toolName) return undefined;
  const { text, failed } = toolOutputText(part);
  return {
    role: 'tool',
    content: failed ? JSON.stringify({ error: text }) : text,
    toolCallId: part.toolCallId,
    name: part.toolName,
  };
}

/**
 * An assistant message of the prompt as Cogitator messages, in the order of its parts: text and
 * tool calls up to a result make one assistant message, each result of a call the provider ran
 * is a tool message, and text after it starts the next assistant message
 */
function assistantMessages(content: ReadonlyArray<PromptPartLike>): Message[] {
  const messages: Message[] = [];
  let text = '';
  let toolCalls: ToolCall[] = [];
  const flush = () => {
    if (!text && toolCalls.length === 0) return;
    const message: Message | ToolCallMessage =
      toolCalls.length === 0
        ? { role: 'assistant', content: text }
        : { role: 'assistant', content: text, toolCalls };
    messages.push(message);
    text = '';
    toolCalls = [];
  };
  for (const part of content) {
    if (part.type === 'text' && typeof part.text === 'string') {
      if (toolCalls.length > 0) flush();
      text += part.text;
    } else if (part.type === 'tool-call' && part.toolCallId && part.toolName) {
      toolCalls.push({
        id: part.toolCallId,
        name: part.toolName,
        arguments: parseArguments(inputText(part.input ?? part.args)),
      });
    } else if (part.type === 'tool-result') {
      const result = toolMessage(part);
      if (!result) continue;
      flush();
      messages.push(result);
    }
  }
  flush();
  return messages;
}

/** A message of the prompt as Cogitator messages */
function historyMessages(message: PromptMessageLike, dropped: Set<string>): Message[] {
  const { content } = message;
  switch (message.role) {
    case 'user':
      collectDroppedParts(message, dropped);
      return [{ role: 'user', content: textOf(content) }];
    case 'assistant':
      return typeof content === 'string'
        ? [{ role: 'assistant', content }]
        : assistantMessages(content);
    case 'tool':
      return typeof content === 'string'
        ? []
        : content.flatMap((part) => {
            const result = part.type === 'tool-result' ? toolMessage(part) : undefined;
            return result ? [result] : [];
          });
    default:
      return [];
  }
}

function inputText(input: unknown): string {
  return typeof input === 'string' ? input : JSON.stringify(input ?? {});
}

/** The text of a tool result part: its output (ai@5 and later) or result (ai@4). */
function toolOutputText(part: PromptPartLike): { text: string; failed: boolean } {
  if (part.output === undefined) {
    return { text: valueText(part.result), failed: part.isError === true };
  }
  if (!isRecord(part.output)) return { text: valueText(part.output), failed: false };
  const { type, value, reason } = part.output;
  switch (type) {
    case 'text':
      return { text: valueText(value), failed: false };
    case 'error-text':
    case 'error-json':
      return { text: valueText(value), failed: true };
    case 'execution-denied':
      return {
        text: `the user denied the call${typeof reason === 'string' ? `: ${reason}` : ''}`,
        failed: true,
      };
    case 'content':
      return { text: contentOutputText(value), failed: false };
    default:
      return { text: valueText(value), failed: false };
  }
}

function contentOutputText(value: unknown): string {
  if (!Array.isArray(value)) return valueText(value);
  return value
    .map((item: unknown) => {
      if (!isRecord(item)) return '';
      if (item.type === 'text' && typeof item.text === 'string') return item.text;
      const mediaType = typeof item.mediaType === 'string' ? item.mediaType : 'media';
      return `[${mediaType}]`;
    })
    .filter((text) => text.length > 0)
    .join('\n');
}

function valueText(value: unknown): string {
  if (typeof value === 'string') return value;
  return JSON.stringify(value ?? null) ?? String(value);
}

function parseArguments(input: string | undefined): Record<string, unknown> {
  if (input === undefined) return {};
  try {
    const parsed: unknown = JSON.parse(input);
    return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
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

/**
 * Why a run's answer ended, as the AI SDK finish reasons name it: `tool-calls` when it waits for
 * tool approvals, `content-filter` when the answer was withheld (`raw` says whether by a filter
 * or a refusal), `length` when it stopped at the token limit, `other` when tool calls used up
 * the agent's iterations, `stop` otherwise.
 */
export function runFinish(result: RunResult): CogitatorFinishReasonV3 {
  if (result.status === 'paused') return { unified: 'tool-calls', raw: 'paused' };
  if (result.blocked) return { unified: 'content-filter', raw: result.blocked };
  if (result.truncated) return { unified: 'length', raw: 'length' };
  if (result.iterationLimitReached) return { unified: 'other', raw: 'iteration-limit' };
  return { unified: 'stop', raw: 'stop' };
}

/**
 * What the agent wrote before its tool calls, by the id of the first call of each turn ("Let me
 * check."). A streamed response carries this text before the calls, so a generated one does too.
 */
export function toolCallPreambles(result: RunResult): Map<string, string> {
  const runCalls = new Set(result.toolCalls.map((call) => call.id));
  const preambles = new Map<string, string>();
  for (const message of result.messages) {
    if (message.role !== 'assistant') continue;
    const calls = (message as Message & { toolCalls?: ToolCall[] }).toolCalls ?? [];
    const first = calls[0];
    if (!first || !runCalls.has(first.id)) continue;
    const text = textOf(message.content as string | ReadonlyArray<PromptPartLike>);
    if (text.trim()) preambles.set(first.id, text);
  }
  return preambles;
}

export function runMetadata(
  result: RunResult,
  model: string,
  toolResults: ReadonlyMap<string, ToolResult>
): { cogitator: JSONObject } {
  const metadata: JSONObject = {
    runId: result.runId,
    threadId: result.threadId,
    agentId: result.agentId,
    model: result.modelUsed ?? model,
    cost: result.usage.cost,
    duration: result.usage.duration,
  };
  if (result.status === 'paused') {
    metadata.status = 'paused';
    metadata.pendingApprovals = toJSONValue(result.pendingApprovals ?? []) ?? [];
  }
  if (result.truncated) metadata.truncated = true;
  if (result.blocked) metadata.blocked = result.blocked;
  if (result.iterationLimitReached) metadata.iterationLimitReached = true;
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
