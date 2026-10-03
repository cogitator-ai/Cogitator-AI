/**
 * OpenAI SDK Adapter
 *
 * Implements the OpenAI Assistants API semantics on top of Cogitator.
 */

import { type Cogitator, Agent } from '@cogitator-ai/core';
import {
  CogitatorError,
  type ImageInput,
  type ResponseFormat as AgentResponseFormat,
  type Tool,
} from '@cogitator-ai/types';
import { EventEmitter } from 'events';
import { nanoid } from 'nanoid';
import { z } from 'zod';
import { ThreadManager, type LLMThreadMessage, type StoredAssistant } from './thread-manager';
import type { ThreadStorage } from './storage';
import { InvalidRequestError } from './errors';
import type {
  Assistant,
  AssistantTool,
  CreateMessageRequest,
  FunctionDefinition,
  Run,
  RunStatus,
  RunStep,
  Message,
  MessageDelta,
  CreateRunRequest,
  ResponseFormat,
  SubmitToolOutputsRequest,
  ToolCall,
} from '../types/openai-types';

export type StreamEventType =
  | 'thread.run.created'
  | 'thread.run.queued'
  | 'thread.run.in_progress'
  | 'thread.run.requires_action'
  | 'thread.run.completed'
  | 'thread.run.failed'
  | 'thread.run.cancelling'
  | 'thread.run.cancelled'
  | 'thread.run.expired'
  | 'thread.run.incomplete'
  | 'thread.run.step.created'
  | 'thread.run.step.in_progress'
  | 'thread.run.step.completed'
  | 'thread.message.created'
  | 'thread.message.in_progress'
  | 'thread.message.delta'
  | 'thread.message.completed'
  | 'done'
  | 'error';

export type StreamEventData = Run | RunStep | Message | MessageDelta | string;

export interface StreamEmitterEvents {
  event: [type: StreamEventType, data: StreamEventData];
  error: [error: Error];
  end: [];
}

export interface RunStreamEvent {
  event: StreamEventType;
  data: StreamEventData;
}

export interface OpenAIAdapterOptions {
  /** Server-side Cogitator tools available to every run */
  tools?: Tool[];

  /**
   * Model used when an assistant/run asks for the advertised `cogitator`
   * model id (the one listed by `GET /v1/models`).
   */
  defaultModel?: string;

  /** Maximum number of finished runs kept in memory (default: 10 000) */
  maxStoredRuns?: number;

  /**
   * Persistence for assistants, threads, messages and files (default: in-memory).
   * Runs are not persisted: they live in the memory of the process that
   * created them, whatever the storage.
   */
  storage?: ThreadStorage;
}

export const COGITATOR_MODEL_ID = 'cogitator';

const ACTIVE_STATUSES: readonly RunStatus[] = [
  'queued',
  'in_progress',
  'requires_action',
  'cancelling',
];
const RUN_TTL_SECONDS = 600;
const CHARS_PER_TOKEN = 4;
const TRANSCRIPT_HEADER = 'Conversation so far:\n\n';

interface PendingToolCall {
  call: ToolCall;
  resolve: (output: string) => void;
  reject: (error: Error) => void;
}

interface RunState {
  run: Run;
  abortController: AbortController;
  emitter: EventEmitter<StreamEmitterEvents>;
  events: RunStreamEvent[];
  ended: boolean;
  pendingCalls: PendingToolCall[];
  flushScheduled: boolean;
  expiryTimer?: ReturnType<typeof setTimeout>;
}

class RunTerminatedError extends Error {
  constructor(readonly status: 'cancelled' | 'expired') {
    super(status === 'cancelled' ? 'Run was cancelled' : 'Run expired waiting for tool outputs');
    this.name = 'RunTerminatedError';
  }
}

class PromptBudgetExceededError extends Error {
  constructor(maxPromptTokens: number) {
    super(`The prompt does not fit in max_prompt_tokens (${maxPromptTokens})`);
    this.name = 'PromptBudgetExceededError';
  }
}

function nowSeconds(): number {
  return Math.floor(Date.now() / 1000);
}

function isActive(status: RunStatus): boolean {
  return ACTIVE_STATUSES.includes(status);
}

function toAgentResponseFormat(format: ResponseFormat | undefined): {
  responseFormat?: AgentResponseFormat;
  instructions?: string;
} {
  if (!format || format === 'auto' || format.type === 'text') return {};
  if (format.type === 'json_object') return { responseFormat: { type: 'json' } };
  return {
    responseFormat: { type: 'json' },
    instructions: `Respond with a JSON object that matches this JSON Schema (${format.json_schema.name}):\n${JSON.stringify(format.json_schema.schema)}`,
  };
}

function toZodParameters(schema: Record<string, unknown> | undefined): z.ZodType {
  try {
    return z.fromJSONSchema(schema ?? { type: 'object', properties: {} });
  } catch {
    return z.record(z.string(), z.unknown());
  }
}

function renderMessage(message: LLMThreadMessage): string {
  return `${message.role === 'assistant' ? 'Assistant' : 'User'}: ${message.content}`;
}

function renderInput(prior: LLMThreadMessage[], current: LLMThreadMessage): string {
  if (prior.length === 0) return current.content;
  return `${TRANSCRIPT_HEADER}${prior.map(renderMessage).join('\n\n')}\n\n${renderMessage(current)}`;
}

/** Rough token count (4 characters per token), the estimate the prompt budget is held to. */
function estimateTokens(text: string): number {
  return Math.ceil(text.length / CHARS_PER_TOKEN);
}

/**
 * The most recent part of `prior` that fits in `budget` tokens next to the
 * current message, or null when the current message alone does not fit.
 */
function fitPromptBudget(
  prior: LLMThreadMessage[],
  current: LLMThreadMessage,
  budget: number
): LLMThreadMessage[] | null {
  if (estimateTokens(current.content) > budget) return null;

  const fixedCost = estimateTokens(`${TRANSCRIPT_HEADER}${renderMessage(current)}`);
  const costs = prior.map((message) => estimateTokens(`${renderMessage(message)}\n\n`));
  let total = fixedCost + costs.reduce((sum, cost) => sum + cost, 0);
  let start = 0;
  while (start < prior.length && total > budget) {
    total -= costs[start];
    start++;
  }
  return start < prior.length ? prior.slice(start) : [];
}

function isPositiveInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value > 0;
}

/**
 * OpenAI SDK Adapter
 *
 * Runs execute and are kept in this process: a run is only visible, cancellable
 * and resumable (`submit_tool_outputs`) through the adapter that created it,
 * and is lost when the process exits. Serve one adapter per thread set (a single
 * instance, or sticky routing by thread) when running several processes.
 *
 * @example
 * ```typescript
 * const adapter = createOpenAIAdapter(cogitator, { tools: [calculator] });
 * const assistant = await adapter.createAssistant({ model: 'openai/gpt-6.1-sol' });
 * ```
 */
export class OpenAIAdapter {
  private cogitator: Cogitator;
  private threadManager: ThreadManager;
  private runs = new Map<string, RunState>();
  private activeRunByThread = new Map<string, string>();
  private tools: Tool[];
  private defaultModel?: string;
  private maxStoredRuns: number;

  constructor(cogitator: Cogitator, options?: OpenAIAdapterOptions) {
    this.cogitator = cogitator;
    this.threadManager = new ThreadManager(options?.storage);
    this.tools = options?.tools ?? [];
    this.defaultModel = options?.defaultModel;
    this.maxStoredRuns = options?.maxStoredRuns ?? 10_000;
  }

  /**
   * Get the thread manager for direct access
   */
  getThreadManager(): ThreadManager {
    return this.threadManager;
  }

  async createAssistant(params: {
    model: string;
    name?: string;
    description?: string;
    instructions?: string;
    tools?: AssistantTool[];
    metadata?: Record<string, string>;
    temperature?: number;
    top_p?: number;
    response_format?: ResponseFormat;
  }): Promise<Assistant> {
    const stored = await this.threadManager.createAssistant(params);
    return this.toAssistant(stored);
  }

  async getAssistant(id: string): Promise<Assistant | undefined> {
    const stored = await this.threadManager.getAssistant(id);
    return stored ? this.toAssistant(stored) : undefined;
  }

  async updateAssistant(
    id: string,
    updates: Partial<{
      model: string;
      name: string;
      description: string;
      instructions: string;
      tools: AssistantTool[];
      metadata: Record<string, string>;
      temperature: number;
      top_p: number;
      response_format: ResponseFormat;
    }>
  ): Promise<Assistant | undefined> {
    const stored = await this.threadManager.updateAssistant(id, updates);
    return stored ? this.toAssistant(stored) : undefined;
  }

  async deleteAssistant(id: string): Promise<boolean> {
    return this.threadManager.deleteAssistant(id);
  }

  async listAssistants(): Promise<Assistant[]> {
    const assistants = await this.threadManager.listAssistants();
    return assistants.map((s) => this.toAssistant(s));
  }

  private toAssistant(stored: StoredAssistant): Assistant {
    return {
      id: stored.id,
      object: 'assistant',
      created_at: stored.created_at,
      name: stored.name,
      description: stored.description ?? null,
      model: stored.model,
      instructions: stored.instructions,
      tools: stored.tools,
      metadata: stored.metadata,
      temperature: stored.temperature,
      top_p: stored.top_p,
      response_format: stored.response_format,
    };
  }

  async createThread(metadata?: Record<string, string>) {
    return this.threadManager.createThread(metadata);
  }

  async getThread(id: string) {
    return this.threadManager.getThread(id);
  }

  async updateThread(id: string, updates: { metadata?: Record<string, string> }) {
    return this.threadManager.updateThread(id, updates);
  }

  async deleteThread(id: string) {
    return this.threadManager.deleteThread(id);
  }

  async addMessage(threadId: string, params: CreateMessageRequest) {
    return this.threadManager.addMessage(threadId, params);
  }

  async getMessage(threadId: string, messageId: string) {
    return this.threadManager.getMessage(threadId, messageId);
  }

  async listMessages(
    threadId: string,
    options?: {
      limit?: number;
      order?: 'asc' | 'desc';
      after?: string;
      before?: string;
      run_id?: string;
    }
  ) {
    return this.threadManager.listMessages(threadId, options);
  }

  /**
   * Create a run and start executing it in the background.
   *
   * Rejects when the assistant or thread does not exist, or when the thread
   * already has an active run.
   */
  async createRun(threadId: string, request: CreateRunRequest): Promise<Run> {
    const assistant = await this.threadManager.getAssistant(request.assistant_id);
    if (!assistant) {
      throw new InvalidRequestError(`Assistant ${request.assistant_id} not found`, 'assistant_id');
    }

    const thread = await this.threadManager.getThread(threadId);
    if (!thread) {
      throw new InvalidRequestError(`Thread ${threadId} not found`);
    }

    const activeRunId = this.activeRunByThread.get(threadId);
    if (activeRunId) {
      throw new InvalidRequestError(`Thread ${threadId} already has an active run ${activeRunId}.`);
    }
    if (request.max_prompt_tokens !== undefined && !isPositiveInteger(request.max_prompt_tokens)) {
      throw new InvalidRequestError(
        'max_prompt_tokens must be a positive integer',
        'max_prompt_tokens'
      );
    }

    const runId = `run_${nanoid()}`;
    const now = nowSeconds();

    const run: Run = {
      id: runId,
      object: 'thread.run',
      created_at: now,
      thread_id: threadId,
      assistant_id: request.assistant_id,
      status: 'queued',
      required_action: null,
      last_error: null,
      expires_at: now + RUN_TTL_SECONDS,
      started_at: null,
      cancelled_at: null,
      failed_at: null,
      completed_at: null,
      incomplete_details: null,
      model: request.model ?? assistant.model,
      instructions: request.instructions ?? assistant.instructions,
      tools: request.tools ?? assistant.tools,
      metadata: request.metadata ?? {},
      usage: null,
      temperature: request.temperature ?? assistant.temperature,
      top_p: request.top_p ?? assistant.top_p,
      max_prompt_tokens: request.max_prompt_tokens,
      max_completion_tokens: request.max_completion_tokens,
      truncation_strategy: request.truncation_strategy,
      response_format: request.response_format ?? assistant.response_format,
      tool_choice: request.tool_choice,
      parallel_tool_calls: request.parallel_tool_calls,
    };

    const state: RunState = {
      run,
      abortController: new AbortController(),
      emitter: new EventEmitter<StreamEmitterEvents>(),
      events: [],
      ended: false,
      pendingCalls: [],
      flushScheduled: false,
    };
    this.runs.set(runId, state);
    this.activeRunByThread.set(threadId, runId);
    this.evictFinishedRuns();

    try {
      for (const msg of request.additional_messages ?? []) {
        await this.threadManager.addMessage(threadId, msg);
      }
    } catch (error) {
      this.runs.delete(runId);
      this.activeRunByThread.delete(threadId);
      throw error;
    }

    this.emit(state, 'thread.run.created', run);
    this.emit(state, 'thread.run.queued', run);

    void this.executeRun(state, assistant, request);

    return structuredClone(run);
  }

  /**
   * Get a run by ID
   */
  getRun(threadId: string, runId: string): Run | undefined {
    const state = this.runs.get(runId);
    if (state?.run.thread_id === threadId) {
      return structuredClone(state.run);
    }
    return undefined;
  }

  /**
   * List runs of a thread, newest first
   */
  listRuns(threadId: string): Run[] {
    return Array.from(this.runs.values())
      .filter((state) => state.run.thread_id === threadId)
      .map((state) => structuredClone(state.run))
      .reverse();
  }

  /**
   * Cancel a run. Throws when the run already finished.
   */
  cancelRun(threadId: string, runId: string): Run | undefined {
    const state = this.runs.get(runId);
    if (state?.run.thread_id !== threadId) {
      return undefined;
    }
    if (!isActive(state.run.status) || state.run.status === 'cancelling') {
      throw new InvalidRequestError(`Cannot cancel run with status '${state.run.status}'.`);
    }

    state.run.status = 'cancelling';
    this.emit(state, 'thread.run.cancelling', state.run);
    this.terminate(state, new RunTerminatedError('cancelled'));
    return structuredClone(state.run);
  }

  /**
   * Submit outputs for the tool calls of a run that requires action.
   * Outputs for every pending tool call must be provided.
   */
  async submitToolOutputs(
    threadId: string,
    runId: string,
    request: SubmitToolOutputsRequest
  ): Promise<Run | undefined> {
    const state = this.runs.get(runId);
    if (state?.run.thread_id !== threadId) {
      return undefined;
    }

    if (state.run.status !== 'requires_action') {
      throw new InvalidRequestError(
        `Run is not waiting for tool outputs (status: '${state.run.status}').`
      );
    }

    const outputs = new Map(
      (request.tool_outputs ?? []).map((output) => [output.tool_call_id, output.output])
    );
    const missing = state.pendingCalls.filter((pending) => !outputs.has(pending.call.id));
    if (missing.length > 0) {
      throw new InvalidRequestError(
        `Missing tool outputs for tool calls: ${missing.map((p) => p.call.id).join(', ')}`,
        'tool_outputs'
      );
    }
    const unknown = [...outputs.keys()].filter(
      (id) => !state.pendingCalls.some((pending) => pending.call.id === id)
    );
    if (unknown.length > 0) {
      throw new InvalidRequestError(`Unknown tool call ids: ${unknown.join(', ')}`, 'tool_outputs');
    }

    const pending = state.pendingCalls;
    state.pendingCalls = [];
    this.clearExpiry(state);
    state.run.status = 'in_progress';
    state.run.required_action = null;
    this.emit(state, 'thread.run.in_progress', state.run);

    for (const call of pending) {
      call.resolve(outputs.get(call.call.id) ?? '');
    }

    return structuredClone(state.run);
  }

  /**
   * Get the event emitter of a run (all runs have one)
   */
  getStreamEmitter(runId: string): EventEmitter<StreamEmitterEvents> | undefined {
    return this.runs.get(runId)?.emitter;
  }

  /**
   * Position in the run's event log; pass it to {@link streamRunEvents} to
   * stream only events emitted after this point.
   */
  getRunEventCursor(runId: string): number {
    return this.runs.get(runId)?.events.length ?? 0;
  }

  /**
   * Stream run events as server-sent-event payloads, starting at `fromIndex`
   * of the run's event log (0 replays the whole run). The stream ends after the
   * next `done` event, which follows a terminal status or `requires_action`.
   */
  async *streamRunEvents(runId: string, fromIndex = 0): AsyncGenerator<RunStreamEvent> {
    const state = this.runs.get(runId);
    if (!state) return;

    let index = fromIndex;
    let wake: (() => void) | null = null;
    const onEvent = () => {
      if (wake) {
        wake();
        wake = null;
      }
    };
    state.emitter.on('event', onEvent);
    state.emitter.on('end', onEvent);

    try {
      while (true) {
        if (index < state.events.length) {
          const event = state.events[index++];
          yield event;
          if (event.event === 'done') return;
          continue;
        }
        if (state.ended) return;
        await new Promise<void>((resolve) => {
          wake = resolve;
        });
      }
    } finally {
      state.emitter.off('event', onEvent);
      state.emitter.off('end', onEvent);
    }
  }

  private emit(state: RunState, event: StreamEventType, data: StreamEventData): void {
    const payload: RunStreamEvent = {
      event,
      data: typeof data === 'string' ? data : structuredClone(data),
    };
    state.events.push(payload);
    state.emitter.emit('event', payload.event, payload.data);
  }

  private end(state: RunState): void {
    if (state.ended) return;
    state.ended = true;
    this.clearExpiry(state);
    if (this.activeRunByThread.get(state.run.thread_id) === state.run.id) {
      this.activeRunByThread.delete(state.run.thread_id);
    }
    state.emitter.emit('end');
  }

  private clearExpiry(state: RunState): void {
    if (state.expiryTimer !== undefined) {
      clearTimeout(state.expiryTimer);
      state.expiryTimer = undefined;
    }
  }

  private terminate(state: RunState, reason: RunTerminatedError): void {
    this.clearExpiry(state);
    const pending = state.pendingCalls;
    state.pendingCalls = [];
    for (const call of pending) call.reject(reason);
    state.abortController.abort(reason);
  }

  private evictFinishedRuns(): void {
    if (this.runs.size <= this.maxStoredRuns) return;
    for (const [id, state] of this.runs) {
      if (this.runs.size <= this.maxStoredRuns) return;
      if (state.ended) this.runs.delete(id);
    }
  }

  /**
   * What the client learns of a failed run: the message of an
   * `InvalidRequestError` or a `CogitatorError`; any other error is logged
   * and reported as a generic server error.
   */
  private clientErrorMessage(run: Run, error: unknown): string {
    if (error instanceof InvalidRequestError || CogitatorError.isCogitatorError(error)) {
      return error.message;
    }
    console.error(`[CogitatorOpenAI] Run ${run.id} failed:`, error);
    return 'Internal server error';
  }

  private resolveModel(model: string): string {
    if (model !== COGITATOR_MODEL_ID) return model;
    if (!this.defaultModel) {
      throw new InvalidRequestError(
        `Model '${COGITATOR_MODEL_ID}' requires the server to be configured with a defaultModel`,
        'model'
      );
    }
    return this.defaultModel;
  }

  /**
   * Turn assistant `function` tools into Cogitator tools whose execution is
   * delegated to the API client through `requires_action`.
   */
  private createClientTools(state: RunState, definitions: FunctionDefinition[]): Tool[] {
    return definitions.map((definition) => {
      const parameters = toZodParameters(definition.parameters);
      return {
        name: definition.name,
        description: definition.description ?? definition.name,
        parameters,
        execute: (args: unknown) =>
          new Promise<string>((resolve, reject) => {
            if (state.abortController.signal.aborted) {
              reject(new RunTerminatedError('cancelled'));
              return;
            }
            state.pendingCalls.push({
              call: {
                id: `call_${nanoid()}`,
                type: 'function',
                function: { name: definition.name, arguments: JSON.stringify(args ?? {}) },
              },
              resolve,
              reject,
            });
            this.scheduleRequiresAction(state);
          }),
        toJSON: () => {
          const schema = (definition.parameters ?? {}) as {
            properties?: Record<string, unknown>;
            required?: string[];
          };
          return {
            name: definition.name,
            description: definition.description ?? definition.name,
            parameters: {
              type: 'object',
              properties: schema.properties ?? {},
              required: schema.required,
            },
          };
        },
      } satisfies Tool<unknown, string>;
    });
  }

  private scheduleRequiresAction(state: RunState): void {
    if (state.flushScheduled) return;
    state.flushScheduled = true;
    setImmediate(() => {
      state.flushScheduled = false;
      if (state.pendingCalls.length === 0 || state.abortController.signal.aborted) return;

      state.run.status = 'requires_action';
      state.run.required_action = {
        type: 'submit_tool_outputs',
        submit_tool_outputs: { tool_calls: state.pendingCalls.map((pending) => pending.call) },
      };
      state.run.expires_at = nowSeconds() + RUN_TTL_SECONDS;
      this.emit(state, 'thread.run.requires_action', state.run);
      this.emit(state, 'done', '[DONE]');

      this.clearExpiry(state);
      state.expiryTimer = setTimeout(() => {
        this.terminate(state, new RunTerminatedError('expired'));
      }, RUN_TTL_SECONDS * 1000);
    });
  }

  /**
   * The input of a run: the last user message, preceded by the transcript of
   * the thread before it. With `max_prompt_tokens` the oldest messages are
   * left out until the input fits next to `instructions`; when even the last
   * user message does not fit, it throws `PromptBudgetExceededError`.
   */
  private async buildRunInput(
    threadId: string,
    request: CreateRunRequest,
    instructions: string
  ): Promise<{ input: string; images?: ImageInput[]; hasHistory: boolean }> {
    let messages = await this.threadManager.getMessagesForLLM(threadId);
    const truncation = request.truncation_strategy;
    if (truncation?.type === 'last_messages' && truncation.last_messages) {
      messages = messages.slice(-truncation.last_messages);
    }

    let lastUserIndex = -1;
    for (let i = messages.length - 1; i >= 0; i--) {
      if (messages[i].role === 'user') {
        lastUserIndex = i;
        break;
      }
    }
    if (lastUserIndex === -1) {
      throw new InvalidRequestError('No user message found');
    }

    const current = messages[lastUserIndex];
    const prior = messages.slice(0, lastUserIndex);
    let replayed = prior;
    const maxPromptTokens = request.max_prompt_tokens;
    if (maxPromptTokens !== undefined) {
      const fitted = fitPromptBudget(
        prior,
        current,
        maxPromptTokens - estimateTokens(instructions)
      );
      if (!fitted) throw new PromptBudgetExceededError(maxPromptTokens);
      replayed = fitted;
    }

    return {
      input: renderInput(replayed, current),
      images: current.images,
      hasHistory: prior.length > 0,
    };
  }

  private async executeRun(
    state: RunState,
    assistant: StoredAssistant,
    request: CreateRunRequest
  ): Promise<void> {
    const { run } = state;
    const threadId = run.thread_id;
    const signal = state.abortController.signal;

    try {
      run.status = 'in_progress';
      run.started_at = nowSeconds();
      this.emit(state, 'thread.run.in_progress', run);

      const format = toAgentResponseFormat(run.response_format);
      const instructions = [
        run.instructions ?? '',
        request.additional_instructions ?? '',
        format.instructions ?? '',
      ]
        .filter((part) => part.length > 0)
        .join('\n\n');

      const { input, images, hasHistory } = await this.buildRunInput(
        threadId,
        request,
        instructions
      );

      const serverToolNames = new Set(this.tools.map((t) => t.name));
      const functionDefinitions = run.tools.flatMap((t) =>
        t.type === 'function' && !serverToolNames.has(t.function.name) ? [t.function] : []
      );
      let tools: Tool[] = [...this.tools, ...this.createClientTools(state, functionDefinitions)];
      const toolChoice = run.tool_choice;
      if (toolChoice === 'none') {
        tools = [];
      } else if (typeof toolChoice === 'object') {
        tools = tools.filter((t) => t.name === toolChoice.function.name);
      }

      const agent = new Agent({
        name: assistant.name ?? 'assistant',
        model: this.resolveModel(run.model),
        instructions,
        temperature: run.temperature,
        topP: run.top_p,
        maxTokens: run.max_completion_tokens,
        responseFormat: format.responseFormat,
        tools,
      });

      const messageId = `msg_${nanoid()}`;
      let messageAnnounced = false;
      const announceMessage = () => {
        if (messageAnnounced) return;
        messageAnnounced = true;
        const inProgress: Message = {
          id: messageId,
          object: 'thread.message',
          created_at: nowSeconds(),
          thread_id: threadId,
          status: 'in_progress',
          completed_at: null,
          incomplete_at: null,
          role: 'assistant',
          content: [],
          assistant_id: assistant.id,
          run_id: run.id,
          attachments: [],
          metadata: {},
        };
        this.emit(state, 'thread.message.created', inProgress);
        this.emit(state, 'thread.message.in_progress', inProgress);
      };

      let accumulated = '';
      const result = await this.cogitator.run(agent, {
        input,
        images,
        threadId,
        signal,
        stream: !!request.stream,
        parallelToolCalls: run.parallel_tool_calls,
        ...(hasHistory && { loadHistory: false }),
        onToken: (token: string) => {
          if (signal.aborted) return;
          announceMessage();
          accumulated += token;
          const delta: MessageDelta = {
            id: messageId,
            object: 'thread.message.delta',
            delta: { content: [{ index: 0, type: 'text', text: { value: token } }] },
          };
          this.emit(state, 'thread.message.delta', delta);
        },
      });

      if (signal.aborted) {
        throw signal.reason instanceof Error ? signal.reason : new RunTerminatedError('cancelled');
      }

      const finalContent = result.output || accumulated;
      if (finalContent) {
        announceMessage();
        const message = await this.threadManager.addAssistantMessage(
          threadId,
          finalContent,
          assistant.id,
          run.id,
          messageId
        );
        if (message) {
          this.emit(state, 'thread.message.completed', message);
        }
      }

      run.status = 'completed';
      run.completed_at = nowSeconds();
      run.usage = result.usage
        ? {
            prompt_tokens: result.usage.inputTokens,
            completion_tokens: result.usage.outputTokens,
            total_tokens: result.usage.totalTokens,
          }
        : null;
      this.emit(state, 'thread.run.completed', run);
    } catch (error) {
      const reason = signal.aborted ? signal.reason : error;
      if (reason instanceof RunTerminatedError) {
        if (reason.status === 'cancelled') {
          run.status = 'cancelled';
          run.cancelled_at = nowSeconds();
          this.emit(state, 'thread.run.cancelled', run);
        } else {
          run.status = 'expired';
          this.emit(state, 'thread.run.expired', run);
        }
      } else if (reason instanceof PromptBudgetExceededError) {
        run.status = 'incomplete';
        run.incomplete_details = { reason: 'max_prompt_tokens' };
        this.emit(state, 'thread.run.incomplete', run);
      } else {
        run.status = 'failed';
        run.failed_at = nowSeconds();
        run.last_error = { code: 'server_error', message: this.clientErrorMessage(run, error) };
        this.emit(state, 'thread.run.failed', run);
      }
    } finally {
      run.required_action = null;
      this.terminate(state, new RunTerminatedError('cancelled'));
      this.emit(state, 'done', '[DONE]');
      this.end(state);
    }
  }
}

/**
 * Create an OpenAI adapter for Cogitator
 */
export function createOpenAIAdapter(
  cogitator: Cogitator,
  options?: OpenAIAdapterOptions
): OpenAIAdapter {
  return new OpenAIAdapter(cogitator, options);
}
