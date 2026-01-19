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
} from '@cogitator-ai/types';
import type { Agent } from '../agent';
import type { Cogitator } from '../cogitator';

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
    this.mergeToolResults(checkpoint.toolResults, options.modifiedToolResults);

    const stepsReplayed = checkpoint.stepIndex + 1;
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
      messages,
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

    const modifiedAgent = this.createReplayAgent(agent, initialMessages);

    const runResult = await cogitator.run(modifiedAgent, {
      input,
      threadId: `replay_${checkpoint.runId}`,
      onToolCall: (toolCall) => {
        if (options.skipTools?.includes(toolCall.name)) {
          return;
        }
      },
      onToolResult: (result) => {
        if (options.modifiedToolResults?.[result.callId]) {
          (result as { result: unknown }).result = options.modifiedToolResults[result.callId];
        }
      },
    });

    const stepsReplayed = checkpoint.stepIndex + 1;
    const stepsExecuted = this.countSteps(runResult);
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

  private mergeToolResults(
    cached: Record<string, unknown>,
    modified?: Record<string, unknown>
  ): Record<string, unknown> {
    return { ...cached, ...modified };
  }

  private extractUserInput(messages: Message[]): string {
    const userMessages = messages.filter((m) => m.role === 'user');
    const lastUserMessage = userMessages[userMessages.length - 1];
    return lastUserMessage ? this.getTextContent(lastUserMessage.content) : '';
  }

  private createReplayAgent(agent: Agent, preloadedMessages: Message[]): Agent {
    const systemMessage = preloadedMessages.find((m) => m.role === 'system');
    const contextFromHistory = preloadedMessages
      .filter((m) => m.role === 'assistant' || m.role === 'tool')
      .map((m) => `[${m.role}]: ${this.getTextContent(m.content)}`)
      .join('\n');

    const newInstructions = systemMessage
      ? `${this.getTextContent(systemMessage.content)}\n\n---\nReplay Context (conversation history up to checkpoint):\n${contextFromHistory}`
      : agent.instructions;

    return new (agent.constructor as typeof Agent)({
      ...agent.config,
      name: `${agent.name}_replay`,
      instructions: newInstructions,
    });
  }

  private countSteps(result: RunResult): number {
    let count = 0;
    for (const span of result.trace.spans) {
      if (
        span.name.startsWith('tool.') ||
        span.name.includes('llm') ||
        span.name.includes('chat')
      ) {
        count++;
      }
    }
    return count;
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
        return checkpoint.stepIndex + i + 1;
      }

      const origArgs = JSON.stringify(orig.arguments);
      const currArgs = JSON.stringify(curr.arguments);
      if (origArgs !== currArgs) {
        return checkpoint.stepIndex + i + 1;
      }
    }

    if (originalToolCalls.length !== newToolCalls.length) {
      return checkpoint.stepIndex + Math.min(originalToolCalls.length, newToolCalls.length) + 1;
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
