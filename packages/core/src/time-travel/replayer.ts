import { nanoid } from 'nanoid';
import type {
  ExecutionCheckpoint,
  ReplayOptions,
  ReplayResult,
  Message,
  MessageContent,
  Span,
  TimeTravelCheckpointStore,
  RunResult,
  Tool,
} from '@cogitator-ai/types';
import type { Agent } from '../agent';
import type { Cogitator } from '../runtime';
import { countToolCallSteps } from './checkpoint-store';

export interface ExecutionReplayerOptions {
  checkpointStore: TimeTravelCheckpointStore;
}

export class ExecutionReplayer {
  private checkpointStore: TimeTravelCheckpointStore;

  constructor(options: ExecutionReplayerOptions) {
    this.checkpointStore = options.checkpointStore;
  }

  async replay(cogitator: Cogitator, agent: Agent, options: ReplayOptions): Promise<ReplayResult> {
    const checkpoint = await this.checkpointStore.load(options.fromCheckpoint);
    if (!checkpoint) {
      throw new Error(`Checkpoint not found: ${options.fromCheckpoint}`);
    }

    if (options.mode === 'deterministic') {
      return this.replayDeterministic(cogitator, agent, checkpoint, options);
    } else {
      return this.replayLive(cogitator, agent, checkpoint, options);
    }
  }

  private async replayDeterministic(
    _cogitator: Cogitator,
    agent: Agent,
    checkpoint: ExecutionCheckpoint,
    options: ReplayOptions
  ): Promise<ReplayResult> {
    const messages = this.buildMessagesForReplay(checkpoint, options.modifiedMessages);

    const stepsReplayed = checkpoint.stepIndex;
    const stepsExecuted = 0;
    const divergedAt: number | undefined = undefined;

    const runId = `replay_${nanoid(12)}`;
    const traceId = `trace_${nanoid(16)}`;
    const startTime = Date.now();
    const spans: Span[] = [];

    const lastAssistant = messages.filter((m) => m.role === 'assistant').pop();
    const output = lastAssistant ? this.getTextContent(lastAssistant.content) : '';

    const result: ReplayResult = {
      output,
      runId,
      agentId: agent.id,
      threadId: checkpoint.runId,
      usage: {
        inputTokens: 0,
        outputTokens: 0,
        totalTokens: 0,
        cost: 0,
        duration: Date.now() - startTime,
      },
      toolCalls: checkpoint.pendingToolCalls,
      messages: this.applyToolResultsToMessages(
        messages,
        checkpoint.toolResults,
        options.modifiedToolResults ?? {}
      ),
      trace: {
        traceId,
        spans,
      },
      replayedFrom: checkpoint.id,
      originalTraceId: checkpoint.traceId,
      divergedAt,
      stepsReplayed,
      stepsExecuted,
    };

    return result;
  }

  private async replayLive(
    cogitator: Cogitator,
    agent: Agent,
    checkpoint: ExecutionCheckpoint,
    options: ReplayOptions
  ): Promise<ReplayResult> {
    const initialMessages = this.buildMessagesForReplay(checkpoint, options.modifiedMessages);

    const input = this.extractUserInput(initialMessages);

    const modifiedAgent = this.createReplayAgent(agent, initialMessages, options);

    const runResult = await cogitator.run(modifiedAgent, {
      input,
      threadId: `replay_${checkpoint.runId}`,
    });

    const stepsReplayed = checkpoint.stepIndex;
    const stepsExecuted = countToolCallSteps(runResult);
    const divergedAt = this.findDivergencePoint(checkpoint, runResult);

    const replayResult: ReplayResult = {
      ...runResult,
      replayedFrom: checkpoint.id,
      originalTraceId: checkpoint.traceId,
      divergedAt,
      stepsReplayed,
      stepsExecuted,
    };

    return replayResult;
  }

  private buildMessagesForReplay(
    checkpoint: ExecutionCheckpoint,
    modifications?: Message[]
  ): Message[] {
    if (modifications && modifications.length > 0) {
      return modifications;
    }
    return [...checkpoint.messages];
  }

  /**
   * Puts tool results into the replayed tool messages: a modified result, keyed
   * by call id or tool name, wins over the result cached in the checkpoint.
   */
  private applyToolResultsToMessages(
    messages: Message[],
    cached: Record<string, unknown>,
    modified: Record<string, unknown>
  ): Message[] {
    const pick = (record: Record<string, unknown>, keys: Array<string | undefined>) =>
      keys.find((key): key is string => key !== undefined && Object.hasOwn(record, key));

    return messages.map((msg) => {
      if (msg.role !== 'tool') return msg;
      const modifiedKey = pick(modified, [msg.toolCallId, msg.name]);
      if (modifiedKey !== undefined) {
        return { ...msg, content: toolContent(modified[modifiedKey]) };
      }
      const cachedKey = pick(cached, [msg.toolCallId]);
      return cachedKey === undefined ? msg : { ...msg, content: toolContent(cached[cachedKey]) };
    });
  }

  private extractUserInput(messages: Message[]): string {
    const userMessages = messages.filter((m) => m.role === 'user');
    const lastUserMessage = userMessages[userMessages.length - 1];
    return lastUserMessage ? this.getTextContent(lastUserMessage.content) : '';
  }

  /**
   * The agent a live replay runs: the original with the checkpoint's history in
   * its instructions, tools in `skipTools` removed, and tools named in
   * `modifiedToolResults` answering with the given value instead of running.
   */
  private createReplayAgent(
    agent: Agent,
    preloadedMessages: Message[],
    options: ReplayOptions
  ): Agent {
    const systemMessage = preloadedMessages.find((m) => m.role === 'system');
    const contextFromHistory = preloadedMessages
      .filter((m) => m.role === 'assistant' || m.role === 'tool')
      .map((m) => `[${m.role}]: ${this.getTextContent(m.content)}`)
      .join('\n');

    const baseInstructions = systemMessage
      ? this.getTextContent(systemMessage.content)
      : agent.instructions;
    const newInstructions = contextFromHistory
      ? `${baseInstructions}\n\n---\nReplay Context (conversation history up to checkpoint):\n${contextFromHistory}`
      : baseInstructions;

    return new (agent.constructor as typeof Agent)({
      ...agent.config,
      name: `${agent.name}_replay`,
      instructions: newInstructions,
      tools: replayTools(agent.tools, options),
    });
  }

  private findDivergencePoint(
    checkpoint: ExecutionCheckpoint,
    result: RunResult
  ): number | undefined {
    const originalToolCalls = checkpoint.pendingToolCalls;
    const newToolCalls = result.toolCalls;

    for (let i = 0; i < Math.min(originalToolCalls.length, newToolCalls.length); i++) {
      const orig = originalToolCalls[i];
      const curr = newToolCalls[i];

      if (orig.name !== curr.name) {
        return checkpoint.stepIndex + i;
      }

      const origArgs = JSON.stringify(orig.arguments);
      const currArgs = JSON.stringify(curr.arguments);
      if (origArgs !== currArgs) {
        return checkpoint.stepIndex + i;
      }
    }

    if (originalToolCalls.length !== newToolCalls.length) {
      return checkpoint.stepIndex + Math.min(originalToolCalls.length, newToolCalls.length);
    }

    return undefined;
  }

  private getTextContent(content: MessageContent): string {
    if (typeof content === 'string') {
      return content;
    }
    return content
      .filter((part): part is { type: 'text'; text: string } => part.type === 'text')
      .map((part) => part.text)
      .join(' ');
  }
}

function replayTools(tools: readonly Tool[], options: ReplayOptions): Tool[] {
  const skipped = new Set(options.skipTools ?? []);
  const mocks = options.modifiedToolResults ?? {};
  return tools
    .filter((tool) => !skipped.has(tool.name))
    .map((tool) => (Object.hasOwn(mocks, tool.name) ? mockedTool(tool, mocks[tool.name]) : tool));
}

function mockedTool(tool: Tool, result: unknown): Tool {
  const mocked = Object.create(Object.getPrototypeOf(tool) as object | null) as Tool;
  return Object.assign(mocked, tool, {
    execute: async () => result,
    sandbox: undefined,
    requiresApproval: undefined,
  });
}

function toolContent(value: unknown): string {
  return typeof value === 'string' ? value : JSON.stringify(value);
}
