import { nanoid } from 'nanoid';
import type {
  ExecutionCheckpoint,
  ForkOptions,
  ForkResult,
  Message,
  TimeTravelCheckpointStore,
} from '@cogitator-ai/types';
import type { Agent } from '../agent';
import type { Cogitator } from '../runtime';
import { ExecutionReplayer } from './replayer';

export interface ExecutionForkerOptions {
  checkpointStore: TimeTravelCheckpointStore;
  replayer: ExecutionReplayer;
}

export class ExecutionForker {
  private checkpointStore: TimeTravelCheckpointStore;
  private replayer: ExecutionReplayer;

  constructor(options: ExecutionForkerOptions) {
    this.checkpointStore = options.checkpointStore;
    this.replayer = options.replayer;
  }

  async fork(cogitator: Cogitator, agent: Agent, options: ForkOptions): Promise<ForkResult> {
    const checkpoint = await this.checkpointStore.load(options.checkpointId);
    if (!checkpoint) {
      throw new Error(`Checkpoint not found: ${options.checkpointId}`);
    }

    const forkedCheckpoint = this.createForkedCheckpoint(checkpoint, options);
    await this.checkpointStore.save(forkedCheckpoint);

    const modifiedMessages = options.additionalContext
      ? this.injectContext(forkedCheckpoint.messages, options.additionalContext)
      : options.input
        ? this.replaceInput(forkedCheckpoint.messages, options.input)
        : undefined;

    const result = await this.replayer.replay(cogitator, agent, {
      fromCheckpoint: forkedCheckpoint.id,
      mode: 'live',
      modifiedMessages,
      modifiedToolResults: options.mockToolResults,
    });

    return {
      forkId: forkedCheckpoint.id,
      checkpoint: forkedCheckpoint,
      result,
    };
  }

  async forkMultiple(
    cogitator: Cogitator,
    agent: Agent,
    checkpointId: string,
    variants: Array<Partial<ForkOptions>>
  ): Promise<ForkResult[]> {
    const results: ForkResult[] = [];

    for (const variant of variants) {
      const result = await this.fork(cogitator, agent, {
        checkpointId,
        ...variant,
      });
      results.push(result);
    }

    return results;
  }

  async forkWithContext(
    cogitator: Cogitator,
    agent: Agent,
    checkpointId: string,
    additionalContext: string,
    label?: string
  ): Promise<ForkResult> {
    return this.fork(cogitator, agent, {
      checkpointId,
      additionalContext,
      label: label ?? `fork_context_${nanoid(6)}`,
    });
  }

  async forkWithMockedTools(
    cogitator: Cogitator,
    agent: Agent,
    checkpointId: string,
    mockResults: Record<string, unknown>,
    label?: string
  ): Promise<ForkResult> {
    return this.fork(cogitator, agent, {
      checkpointId,
      mockToolResults: mockResults,
      label: label ?? `fork_mocked_${nanoid(6)}`,
    });
  }

  async forkWithNewInput(
    cogitator: Cogitator,
    agent: Agent,
    checkpointId: string,
    newInput: string,
    label?: string
  ): Promise<ForkResult> {
    return this.fork(cogitator, agent, {
      checkpointId,
      input: newInput,
      label: label ?? `fork_input_${nanoid(6)}`,
    });
  }

  private createForkedCheckpoint(
    original: ExecutionCheckpoint,
    options: ForkOptions
  ): ExecutionCheckpoint {
    return {
      id: `ckpt_fork_${nanoid(12)}`,
      traceId: original.traceId,
      runId: original.runId,
      agentId: original.agentId,
      stepIndex: original.stepIndex,
      messages: [...original.messages],
      toolResults: { ...original.toolResults },
      pendingToolCalls: [...original.pendingToolCalls],
      label: options.label ?? `fork_of_${original.id}`,
      createdAt: new Date(),
      metadata: {
        ...original.metadata,
        forkedFrom: original.id,
        forkType: options.additionalContext
          ? 'context'
          : options.input
            ? 'input'
            : options.mockToolResults
              ? 'mocked'
              : 'plain',
      },
    };
  }

  private injectContext(messages: Message[], context: string): Message[] {
    const result = [...messages];
    const systemIndex = result.findIndex((m) => m.role === 'system');

    if (systemIndex >= 0) {
      const existing = result[systemIndex].content;
      if (typeof existing === 'string') {
        result[systemIndex] = {
          ...result[systemIndex],
          content: `${existing}\n\n---\nAdditional Context:\n${context}`,
        };
      } else {
        result[systemIndex] = {
          ...result[systemIndex],
          content: [
            ...existing,
            { type: 'text' as const, text: `\n\n---\nAdditional Context:\n${context}` },
          ],
        };
      }
    } else {
      result.unshift({
        role: 'system',
        content: `Context:\n${context}`,
      });
    }

    return result;
  }

  private replaceInput(messages: Message[], newInput: string): Message[] {
    const result = [...messages];

    for (let i = result.length - 1; i >= 0; i--) {
      if (result[i].role === 'user') {
        result[i] = { ...result[i], content: newInput };
        break;
      }
    }

    return result;
  }
}
