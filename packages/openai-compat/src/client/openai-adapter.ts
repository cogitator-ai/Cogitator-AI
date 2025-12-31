/**
 * OpenAI SDK Adapter
 *
 * Allows using the OpenAI SDK to interact with Cogitator.
 * Creates an in-process adapter that can be used with the SDK's baseURL.
 */

import { type Cogitator, Agent } from '@cogitator-ai/core';
import type { Tool } from '@cogitator-ai/types';
import { ThreadManager, type StoredAssistant } from './thread-manager';
import { nanoid } from 'nanoid';
import type {
  Assistant,
  Run,
  CreateRunRequest,
  SubmitToolOutputsRequest,
} from '../types/openai-types';

interface RunState {
  run: Run;
  toolOutputs?: Map<string, string>;
  abortController: AbortController;
}

/**
 * OpenAI SDK Adapter
 *
 * @example
 * ```typescript
 * import OpenAI from 'openai';
 * import { createOpenAIAdapter } from '@cogitator-ai/openai-compat';
 *
 * const adapter = createOpenAIAdapter(cogitator, {
 *   tools: [calculator, datetime],
 * });
 *
 * const openai = new OpenAI({
 *   apiKey: 'not-needed',
 *   baseURL: adapter.baseURL,
 * });
 *
 * // Use OpenAI SDK as normal
 * const assistant = await openai.beta.assistants.create({
 *   model: 'gpt-4o',
 *   name: 'My Assistant',
 * });
 * ```
 */
export class OpenAIAdapter {
  private cogitator: Cogitator;
  private threadManager: ThreadManager;
  private runs = new Map<string, RunState>();
  private tools: Tool[];

  constructor(cogitator: Cogitator, options?: { tools?: Tool[] }) {
    this.cogitator = cogitator;
    this.threadManager = new ThreadManager();
    this.tools = options?.tools ?? [];
  }

  /**
   * Get the thread manager for direct access
   */
  getThreadManager(): ThreadManager {
    return this.threadManager;
  }

  createAssistant(params: {
    model: string;
    name?: string;
    instructions?: string;
    tools?: unknown[];
    metadata?: Record<string, string>;
    temperature?: number;
  }): Assistant {
    const stored = this.threadManager.createAssistant(params);
    return this.toAssistant(stored);
  }

  getAssistant(id: string): Assistant | undefined {
    const stored = this.threadManager.getAssistant(id);
    return stored ? this.toAssistant(stored) : undefined;
  }

  updateAssistant(id: string, updates: Partial<{
    model: string;
    name: string;
    instructions: string;
    tools: unknown[];
    metadata: Record<string, string>;
    temperature: number;
  }>): Assistant | undefined {
    const stored = this.threadManager.updateAssistant(id, updates);
    return stored ? this.toAssistant(stored) : undefined;
  }

  deleteAssistant(id: string): boolean {
    return this.threadManager.deleteAssistant(id);
  }

  listAssistants(): Assistant[] {
    return this.threadManager.listAssistants().map((s) => this.toAssistant(s));
  }

  private toAssistant(stored: StoredAssistant): Assistant {
    return {
      id: stored.id,
      object: 'assistant',
      created_at: stored.created_at,
      name: stored.name,
      description: null,
      model: stored.model,
      instructions: stored.instructions,
      tools: stored.tools as Assistant['tools'],
      metadata: stored.metadata,
      temperature: stored.temperature,
    };
  }

  createThread(metadata?: Record<string, string>) {
    return this.threadManager.createThread(metadata);
  }

  getThread(id: string) {
    return this.threadManager.getThread(id);
  }

  deleteThread(id: string) {
    return this.threadManager.deleteThread(id);
  }

  addMessage(threadId: string, params: { role: 'user' | 'assistant'; content: string; metadata?: Record<string, string> }) {
    return this.threadManager.addMessage(threadId, params);
  }

  getMessage(threadId: string, messageId: string) {
    return this.threadManager.getMessage(threadId, messageId);
  }

  listMessages(threadId: string, options?: {
    limit?: number;
    order?: 'asc' | 'desc';
    after?: string;
    before?: string;
    run_id?: string;
  }) {
    return this.threadManager.listMessages(threadId, options);
  }

  /**
   * Create and execute a run
   */
  async createRun(threadId: string, request: CreateRunRequest): Promise<Run> {
    const assistant = this.threadManager.getAssistant(request.assistant_id);
    if (!assistant) {
      throw new Error(`Assistant ${request.assistant_id} not found`);
    }

    const thread = this.threadManager.getThread(threadId);
    if (!thread) {
      throw new Error(`Thread ${threadId} not found`);
    }

    const runId = `run_${nanoid()}`;
    const now = Math.floor(Date.now() / 1000);

    const run: Run = {
      id: runId,
      object: 'thread.run',
      created_at: now,
      thread_id: threadId,
      assistant_id: request.assistant_id,
      status: 'queued',
      required_action: null,
      last_error: null,
      expires_at: now + 600,
      started_at: null,
      cancelled_at: null,
      failed_at: null,
      completed_at: null,
      incomplete_details: null,
      model: request.model ?? assistant.model,
      instructions: request.instructions ?? assistant.instructions,
      tools: (request.tools ?? assistant.tools) as Run['tools'],
      metadata: request.metadata ?? {},
      usage: null,
      temperature: request.temperature ?? assistant.temperature,
      top_p: request.top_p,
      max_prompt_tokens: request.max_prompt_tokens,
      max_completion_tokens: request.max_completion_tokens,
      truncation_strategy: request.truncation_strategy,
      response_format: request.response_format,
      tool_choice: request.tool_choice,
      parallel_tool_calls: request.parallel_tool_calls,
    };

    const abortController = new AbortController();
    this.runs.set(runId, { run, abortController });

    if (request.additional_messages) {
      for (const msg of request.additional_messages) {
        this.threadManager.addMessage(threadId, msg);
      }
    }

    this.executeRun(runId, threadId, assistant, request).catch((error) => {
      const state = this.runs.get(runId);
      if (state) {
        state.run.status = 'failed';
        state.run.failed_at = Math.floor(Date.now() / 1000);
        state.run.last_error = {
          code: 'server_error',
          message: error instanceof Error ? error.message : String(error),
        };
      }
    });

    return run;
  }

  /**
   * Get a run by ID
   */
  getRun(threadId: string, runId: string): Run | undefined {
    const state = this.runs.get(runId);
    if (state?.run.thread_id === threadId) {
      return state.run;
    }
    return undefined;
  }

  /**
   * Cancel a run
   */
  cancelRun(threadId: string, runId: string): Run | undefined {
    const state = this.runs.get(runId);
    if (state?.run.thread_id === threadId) {
      state.abortController.abort();
      state.run.status = 'cancelled';
      state.run.cancelled_at = Math.floor(Date.now() / 1000);
      return state.run;
    }
    return undefined;
  }

  /**
   * Submit tool outputs for a run that requires action
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
      throw new Error('Run is not waiting for tool outputs');
    }

    if (!state.toolOutputs) {
      state.toolOutputs = new Map();
    }
    for (const output of request.tool_outputs) {
      state.toolOutputs.set(output.tool_call_id, output.output);
    }

    state.run.status = 'in_progress';
    state.run.required_action = null;

    return state.run;
  }

  private async executeRun(
    runId: string,
    threadId: string,
    assistant: StoredAssistant,
    request: CreateRunRequest
  ): Promise<void> {
    const state = this.runs.get(runId);
    if (!state) return;

    state.run.status = 'in_progress';
    state.run.started_at = Math.floor(Date.now() / 1000);

    try {
      const messages = this.threadManager.getMessagesForLLM(threadId);

      const agent = new Agent({
        name: assistant.name ?? 'assistant',
        model: request.model ?? assistant.model,
        instructions: request.instructions ?? assistant.instructions ?? '',
        temperature: request.temperature ?? assistant.temperature,
        tools: this.tools,
      });

      const lastUserMessage = messages.filter((m) => m.role === 'user').pop();
      if (!lastUserMessage) {
        throw new Error('No user message found');
      }

      const result = await this.cogitator.run(agent, {
        input: lastUserMessage.content,
        threadId,
      });

      if (state.abortController.signal.aborted) {
        return;
      }

      if (result.output) {
        this.threadManager.addAssistantMessage(
          threadId,
          result.output,
          assistant.id,
          runId
        );
      }

      state.run.status = 'completed';
      state.run.completed_at = Math.floor(Date.now() / 1000);
      state.run.usage = result.usage
        ? {
            prompt_tokens: result.usage.inputTokens,
            completion_tokens: result.usage.outputTokens,
            total_tokens: result.usage.totalTokens,
          }
        : null;
    } catch (error) {
      if (state.abortController.signal.aborted) {
        return;
      }

      state.run.status = 'failed';
      state.run.failed_at = Math.floor(Date.now() / 1000);
      state.run.last_error = {
        code: 'server_error',
        message: error instanceof Error ? error.message : String(error),
      };
    }
  }
}

/**
 * Create an OpenAI adapter for Cogitator
 */
export function createOpenAIAdapter(
  cogitator: Cogitator,
  options?: { tools?: Tool[] }
): OpenAIAdapter {
  return new OpenAIAdapter(cogitator, options);
}
