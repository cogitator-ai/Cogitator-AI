import { type Cogitator, isPausedRun } from '@cogitator-ai/core';
import type {
  Agent,
  AgentConfig,
  ImageInput,
  ResponseFormat as AgentResponseFormat,
  RunCheckpoint,
  RunResult,
  Tool,
  ToolApprovalDecision,
  ToolApprovalRequest,
  ToolChoice,
} from '@cogitator-ai/types';
import { nanoid } from 'nanoid';
import { toZodParameters } from '../../client/openai-adapter';
import { InvalidRequestError } from '../../client/errors';

/** One entry of a conversation, as Chat Completions and Responses both describe it. */
export type ConversationItem =
  | { kind: 'system'; text: string }
  | { kind: 'user'; text: string; images: ImageInput[] }
  | { kind: 'assistant'; text: string }
  | { kind: 'function_call'; callId: string; name: string; arguments: string }
  | { kind: 'function_call_output'; callId: string; output: string };

/** A function the API client runs itself. */
export interface ClientFunction {
  name: string;
  description?: string;
  parameters?: Record<string, unknown>;
}

export type TurnToolChoice = 'auto' | 'none' | 'required' | { name: string };

export interface AgentTurnRequest {
  /** The registered agent the request's `model` names */
  agent: Agent;
  items: ConversationItem[];
  functions: ClientFunction[];
  toolChoice: TurnToolChoice;
  parallelToolCalls?: boolean;
  temperature?: number;
  topP?: number;
  maxTokens?: number;
  stop?: string[];
  responseFormat?: { responseFormat?: AgentResponseFormat; instructions?: string };
  signal: AbortSignal;
  /** Called with every token of the answer while the agent writes it */
  onToken?: (token: string) => void;
}

/** A call of a client function the agent made; `callId` is what the client answers with. */
export interface ClientFunctionCall {
  callId: string;
  name: string;
  arguments: string;
}

export interface AgentTurnUsage {
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  cachedInputTokens: number;
  reasoningTokens: number;
}

export interface AgentTurnResult {
  /** The agent's answer, or what it said before it called client functions */
  text: string;
  /** The client functions to run before the conversation goes on */
  functionCalls: ClientFunctionCall[];
  /**
   * Why the turn ended: `stop` with an answer, `tool_calls` with function calls for the client,
   * `length` when the answer hit the token limit, `content_filter` when the provider withheld it
   */
  finishReason: 'stop' | 'length' | 'content_filter' | 'tool_calls';
  /** True when the model declined to answer; `text` is its explanation */
  refusal: boolean;
  usage: AgentTurnUsage;
}

/** A turn paused on client function calls, kept until the client sends their outputs. */
interface PausedTurn {
  agent: Agent;
  checkpoint: RunCheckpoint;
  /** Model tool call id by the call id the client got */
  callIds: Map<string, string>;
  /** Outputs the client functions return when the run resumes, by model tool call id */
  outputs: Map<string, string>;
  clientFunctions: ReadonlySet<string>;
  expiresAt: number;
}

export interface AgentTurnRunnerOptions {
  /** How long a turn paused on client function calls waits for their outputs (default: 10 minutes) */
  pausedTurnTtlMs?: number;
  /** How many paused turns are kept at most (default: 1000) */
  maxPausedTurns?: number;
}

const TRANSCRIPT_HEADER = 'Conversation so far:\n\n';
const NO_APPROVAL_OVER_API =
  'This tool needs an approval, which nobody can give through this API: it was not run.';

function emptyUsage(): AgentTurnUsage {
  return {
    inputTokens: 0,
    outputTokens: 0,
    totalTokens: 0,
    cachedInputTokens: 0,
    reasoningTokens: 0,
  };
}

function addUsage(total: AgentTurnUsage, result: RunResult): AgentTurnUsage {
  const usage = result.usage;
  return {
    inputTokens: total.inputTokens + usage.inputTokens,
    outputTokens: total.outputTokens + usage.outputTokens,
    totalTokens: total.totalTokens + usage.totalTokens,
    cachedInputTokens: total.cachedInputTokens + (usage.cachedInputTokens ?? 0),
    reasoningTokens: total.reasoningTokens + (usage.reasoningTokens ?? 0),
  };
}

function renderItem(item: ConversationItem): string {
  switch (item.kind) {
    case 'system':
      return '';
    case 'user':
      return `User: ${item.text}${item.images.length > 0 ? ` [${item.images.length} image(s)]` : ''}`;
    case 'assistant':
      return `Assistant: ${item.text}`;
    case 'function_call':
      return `Assistant called function ${item.name} (call ${item.callId}) with arguments: ${item.arguments}`;
    case 'function_call_output':
      return `Function result for call ${item.callId}: ${item.output}`;
  }
}

/**
 * The input of a run that replays the conversation: the last user message, preceded by the
 * transcript of what came before it, or the transcript ending with function results when the
 * client answered function calls this server no longer waits on.
 */
export function renderConversation(items: readonly ConversationItem[]): {
  input: string;
  images: ImageInput[];
  hasHistory: boolean;
} {
  const conversation = items.filter((item) => item.kind !== 'system');
  const last = conversation.at(-1);
  if (!last) {
    throw new InvalidRequestError('The conversation has no message to answer');
  }
  if (last.kind === 'user') {
    const prior = conversation.slice(0, -1);
    if (prior.length === 0) return { input: last.text, images: last.images, hasHistory: false };
    return {
      input: `${TRANSCRIPT_HEADER}${prior.map(renderItem).join('\n\n')}\n\nUser: ${last.text}`,
      images: last.images,
      hasHistory: true,
    };
  }
  return {
    input: `${TRANSCRIPT_HEADER}${conversation.map(renderItem).join('\n\n')}\n\nContinue the conversation.`,
    images: [],
    hasHistory: true,
  };
}

/**
 * Refuses a `tool_choice` that names neither a tool of the agent nor a function of the client,
 * so the request fails before any output is sent.
 */
/**
 * The run's `toolChoice` for a request's `tool_choice`, when it obliges the model to call a
 * function: `'required'` or one function by name. The run forces it until the model makes a
 * call. `'none'` and `'auto'` need none, the tools the turn offers already say it.
 */
function mandatoryToolChoice(choice: TurnToolChoice): ToolChoice | undefined {
  if (choice === 'required') return 'required';
  if (typeof choice === 'object') return { type: 'function', function: { name: choice.name } };
  return undefined;
}

export function assertToolChoice(
  agent: Agent,
  functions: readonly ClientFunction[],
  toolChoice: TurnToolChoice
): void {
  if (typeof toolChoice !== 'object') return;
  const known =
    agent.tools.some((tool) => tool.name === toolChoice.name) ||
    functions.some((fn) => fn.name === toolChoice.name);
  if (!known) {
    throw new InvalidRequestError(
      `tool_choice names an unknown function: ${toolChoice.name}`,
      'tool_choice'
    );
  }
}

/**
 * Runs one turn of a registered agent for the stateless OpenAI APIs (Chat Completions and
 * Responses). The client sends the conversation, the agent answers with its own instructions and
 * tools, and functions the client declares become tools whose calls end the turn with
 * `tool_calls`. The paused run is kept for a while, so when the client sends the function
 * outputs back, the same run goes on from where it stopped instead of replaying the conversation.
 */
export class AgentTurnRunner {
  private paused = new Map<string, PausedTurn>();
  private readonly ttlMs: number;
  private readonly maxPaused: number;

  constructor(
    private readonly cogitator: Cogitator,
    options: AgentTurnRunnerOptions = {}
  ) {
    this.ttlMs = options.pausedTurnTtlMs ?? 10 * 60 * 1000;
    this.maxPaused = options.maxPausedTurns ?? 1000;
  }

  async run(request: AgentTurnRequest): Promise<AgentTurnResult> {
    this.evictExpired();
    const resumable = this.takePausedTurn(request.items);
    if (resumable) return this.resume(resumable, request);

    const outputs = new Map<string, string>();
    const { agent, clientFunctions } = this.turnAgent(request, outputs);
    const { input, images, hasHistory } = renderConversation(request.items);
    const toolChoice = mandatoryToolChoice(request.toolChoice);
    const result = await this.cogitator.run(agent, {
      input,
      ...(images.length > 0 && { images }),
      threadId: `turn_${nanoid()}`,
      useMemory: false,
      signal: request.signal,
      stream: !!request.onToken,
      onToken: request.onToken,
      ...(request.parallelToolCalls !== undefined && {
        parallelToolCalls: request.parallelToolCalls,
      }),
      onApproval: (approval) => this.decideApproval(approval, clientFunctions),
      ...(hasHistory && { loadHistory: false }),
      ...(toolChoice && { toolChoice }),
    });
    return this.settle(agent, result, outputs, clientFunctions, request, emptyUsage());
  }

  private async resume(turn: PausedTurn, request: AgentTurnRequest): Promise<AgentTurnResult> {
    const decisions: Record<string, ToolApprovalDecision> = {};
    for (const [clientCallId, modelCallId] of turn.callIds) {
      const output = request.items.find(
        (item): item is Extract<ConversationItem, { kind: 'function_call_output' }> =>
          item.kind === 'function_call_output' && item.callId === clientCallId
      );
      turn.outputs.set(modelCallId, output?.output ?? '');
      decisions[modelCallId] = { approved: true };
    }
    const result = await this.cogitator.resume(turn.agent, turn.checkpoint, {
      decisions,
      useMemory: false,
      signal: request.signal,
      stream: !!request.onToken,
      onToken: request.onToken,
      onApproval: (approval) => this.decideApproval(approval, turn.clientFunctions),
    });
    return this.settle(
      turn.agent,
      result,
      turn.outputs,
      turn.clientFunctions,
      request,
      emptyUsage()
    );
  }

  /**
   * The result of a run: an answer, or the client function calls it paused on. Calls of server
   * tools that wait for an approval nobody can give over this API are declined, and the run goes
   * on.
   */
  private async settle(
    agent: Agent,
    initial: RunResult,
    outputs: Map<string, string>,
    clientFunctions: ReadonlySet<string>,
    request: AgentTurnRequest,
    initialUsage: AgentTurnUsage
  ): Promise<AgentTurnResult> {
    let result = initial;
    let usage = addUsage(initialUsage, result);
    while (isPausedRun(result)) {
      const serverCalls = result.pendingApprovals.filter((p) => !clientFunctions.has(p.toolName));
      if (serverCalls.length === 0) {
        return this.pause(agent, result, outputs, clientFunctions, usage);
      }
      if (!result.checkpoint) {
        throw new Error('The run paused without a checkpoint to resume from');
      }
      result = await this.cogitator.resume(agent, result.checkpoint, {
        decisions: Object.fromEntries(
          serverCalls.map((call) => [
            call.toolCallId,
            { approved: false, reason: NO_APPROVAL_OVER_API },
          ])
        ),
        useMemory: false,
        signal: request.signal,
        stream: !!request.onToken,
        onToken: request.onToken,
        onApproval: (approval) => this.decideApproval(approval, clientFunctions),
      });
      usage = addUsage(usage, result);
    }

    return {
      text: result.output,
      functionCalls: [],
      finishReason: result.truncated
        ? 'length'
        : result.blocked === 'content_filter'
          ? 'content_filter'
          : 'stop',
      refusal: result.blocked === 'refusal',
      usage,
    };
  }

  private pause(
    agent: Agent,
    result: RunResult & { pendingApprovals: readonly ToolApprovalRequest[] },
    outputs: Map<string, string>,
    clientFunctions: ReadonlySet<string>,
    usage: AgentTurnUsage
  ): AgentTurnResult {
    if (!result.checkpoint) {
      throw new Error('The run paused without a checkpoint to resume from');
    }
    const callIds = new Map<string, string>();
    const functionCalls = result.pendingApprovals.map((approval) => {
      const callId = `call_${nanoid(24)}`;
      callIds.set(callId, approval.toolCallId);
      return {
        callId,
        name: approval.toolName,
        arguments: JSON.stringify(approval.arguments),
      };
    });
    this.keep({
      agent,
      checkpoint: result.checkpoint,
      callIds,
      outputs,
      clientFunctions,
      expiresAt: Date.now() + this.ttlMs,
    });
    return {
      text: result.output,
      functionCalls,
      finishReason: 'tool_calls',
      refusal: false,
      usage,
    };
  }

  /**
   * The agent of the turn: the registered agent with the client's instructions after its own,
   * the request's sampling settings, and the client functions next to its tools.
   */
  private turnAgent(
    request: AgentTurnRequest,
    outputs: Map<string, string>
  ): { agent: Agent; clientFunctions: ReadonlySet<string> } {
    const base = request.agent;
    const serverToolNames = new Set(base.tools.map((tool) => tool.name));
    const functions = request.functions.filter((fn) => !serverToolNames.has(fn.name));
    let tools: Tool[] = [...base.tools, ...functions.map((fn) => this.clientTool(fn, outputs))];
    if (request.toolChoice === 'none') {
      tools = [];
    } else {
      assertToolChoice(request.agent, request.functions, request.toolChoice);
    }

    const clientInstructions = request.items
      .filter(
        (item): item is Extract<ConversationItem, { kind: 'system' }> => item.kind === 'system'
      )
      .map((item) => item.text);
    const instructions = [
      base.instructions,
      ...clientInstructions,
      request.responseFormat?.instructions ?? '',
    ]
      .filter((part) => part.length > 0)
      .join('\n\n');

    const overrides: Partial<AgentConfig> = { instructions, tools };
    if (request.temperature !== undefined) overrides.temperature = request.temperature;
    if (request.topP !== undefined) overrides.topP = request.topP;
    if (request.maxTokens !== undefined) overrides.maxTokens = request.maxTokens;
    if (request.stop !== undefined) overrides.stopSequences = request.stop;
    if (request.responseFormat?.responseFormat) {
      overrides.responseFormat = request.responseFormat.responseFormat;
    }
    return {
      agent: base.clone(overrides),
      clientFunctions: new Set(functions.map((fn) => fn.name)),
    };
  }

  private clientTool(fn: ClientFunction, outputs: Map<string, string>): Tool<unknown, string> {
    return {
      name: fn.name,
      description: fn.description ?? fn.name,
      parameters: toZodParameters(fn.parameters),
      requiresApproval: true,
      execute: async (_args: unknown, context) => {
        const output =
          context.toolCallId !== undefined ? outputs.get(context.toolCallId) : undefined;
        if (output === undefined) {
          throw new Error(
            `Function "${fn.name}" runs on the API client, which sent no output for this call`
          );
        }
        return output;
      },
      toJSON: () => {
        const schema = (fn.parameters ?? {}) as {
          properties?: Record<string, unknown>;
          required?: string[];
        };
        return {
          name: fn.name,
          description: fn.description ?? fn.name,
          parameters: {
            type: 'object',
            properties: schema.properties ?? {},
            required: schema.required,
          },
        };
      },
    };
  }

  /** Client function calls pause the run; anything else is left to the runtime's guardrails. */
  private decideApproval(
    approval: ToolApprovalRequest,
    clientFunctions: ReadonlySet<string>
  ): 'pause' | undefined {
    return clientFunctions.has(approval.toolName) ? 'pause' : undefined;
  }

  /**
   * The paused turn the conversation answers: its last items are the outputs of every call of a
   * kept turn. The turn is taken out, so it resumes once.
   */
  private takePausedTurn(items: readonly ConversationItem[]): PausedTurn | undefined {
    const trailing: string[] = [];
    for (let i = items.length - 1; i >= 0; i--) {
      const item = items[i];
      if (item.kind !== 'function_call_output') break;
      trailing.push(item.callId);
    }
    if (trailing.length === 0) return undefined;
    const turn = this.paused.get(trailing[0]);
    if (!turn || turn.expiresAt <= Date.now()) return undefined;
    const answered = new Set(trailing);
    for (const callId of turn.callIds.keys()) {
      if (!answered.has(callId)) return undefined;
    }
    for (const callId of turn.callIds.keys()) this.paused.delete(callId);
    return turn;
  }

  private keep(turn: PausedTurn): void {
    for (const callId of turn.callIds.keys()) this.paused.set(callId, turn);
    while (this.paused.size > this.maxPaused) {
      const oldest = this.paused.keys().next().value;
      if (oldest === undefined) break;
      this.paused.delete(oldest);
    }
  }

  private evictExpired(): void {
    const now = Date.now();
    for (const [callId, turn] of this.paused) {
      if (turn.expiresAt <= now) this.paused.delete(callId);
    }
  }
}
