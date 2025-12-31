import { nanoid } from 'nanoid';
import type {
  ExecutionCheckpoint,
  TimeTravelCheckpointStore,
  CheckpointQuery,
  Message,
  RunResult,
  ExecutionTrace,
} from '@cogitator-ai/types';

export class InMemoryCheckpointStore implements TimeTravelCheckpointStore {
  private checkpoints = new Map<string, ExecutionCheckpoint>();
  private traceIndex = new Map<string, Set<string>>();
  private agentIndex = new Map<string, Set<string>>();
  private runIdIndex = new Map<string, Set<string>>();
  private labelIndex = new Map<string, Set<string>>();

  async save(checkpoint: ExecutionCheckpoint): Promise<void> {
    this.checkpoints.set(checkpoint.id, checkpoint);
    this.addToIndex(this.traceIndex, checkpoint.traceId, checkpoint.id);
    this.addToIndex(this.agentIndex, checkpoint.agentId, checkpoint.id);
    this.addToIndex(this.runIdIndex, checkpoint.runId, checkpoint.id);

    if (checkpoint.label) {
      this.addToIndex(this.labelIndex, checkpoint.label, checkpoint.id);
    }
  }

  async load(id: string): Promise<ExecutionCheckpoint | null> {
    return this.checkpoints.get(id) ?? null;
  }

  async list(query: CheckpointQuery): Promise<ExecutionCheckpoint[]> {
    let candidates: ExecutionCheckpoint[] = [];

    if (query.traceId) {
      const traceCheckpoints = this.traceIndex.get(query.traceId);
      if (!traceCheckpoints) return [];
      for (const id of traceCheckpoints) {
        const cp = this.checkpoints.get(id);
        if (cp) candidates.push(cp);
      }
    } else if (query.agentId) {
      const agentCheckpoints = this.agentIndex.get(query.agentId);
      if (!agentCheckpoints) return [];
      for (const id of agentCheckpoints) {
        const cp = this.checkpoints.get(id);
        if (cp) candidates.push(cp);
      }
    } else if (query.runId) {
      const runCheckpoints = this.runIdIndex.get(query.runId);
      if (!runCheckpoints) return [];
      for (const id of runCheckpoints) {
        const cp = this.checkpoints.get(id);
        if (cp) candidates.push(cp);
      }
    } else if (query.label) {
      const labelCheckpoints = this.labelIndex.get(query.label);
      if (!labelCheckpoints) return [];
      for (const id of labelCheckpoints) {
        const cp = this.checkpoints.get(id);
        if (cp) candidates.push(cp);
      }
    } else {
      candidates = Array.from(this.checkpoints.values());
    }

    if (query.before) {
      candidates = candidates.filter((cp) => cp.createdAt < query.before!);
    }

    if (query.after) {
      candidates = candidates.filter((cp) => cp.createdAt > query.after!);
    }

    candidates.sort((a, b) => a.stepIndex - b.stepIndex);

    if (query.limit) {
      candidates = candidates.slice(0, query.limit);
    }

    return candidates;
  }

  async delete(id: string): Promise<boolean> {
    const checkpoint = this.checkpoints.get(id);
    if (!checkpoint) return false;

    this.checkpoints.delete(id);
    this.removeFromIndex(this.traceIndex, checkpoint.traceId, id);
    this.removeFromIndex(this.agentIndex, checkpoint.agentId, id);
    this.removeFromIndex(this.runIdIndex, checkpoint.runId, id);

    if (checkpoint.label) {
      this.removeFromIndex(this.labelIndex, checkpoint.label, id);
    }

    return true;
  }

  async getByTrace(traceId: string): Promise<ExecutionCheckpoint[]> {
    return this.list({ traceId });
  }

  async getByAgent(agentId: string, limit?: number): Promise<ExecutionCheckpoint[]> {
    return this.list({ agentId, limit });
  }

  async getByLabel(label: string): Promise<ExecutionCheckpoint[]> {
    return this.list({ label });
  }

  async clear(agentId?: string): Promise<void> {
    if (agentId) {
      const agentCheckpoints = this.agentIndex.get(agentId);
      if (!agentCheckpoints) return;

      for (const id of Array.from(agentCheckpoints)) {
        await this.delete(id);
      }
    } else {
      this.checkpoints.clear();
      this.traceIndex.clear();
      this.agentIndex.clear();
      this.runIdIndex.clear();
      this.labelIndex.clear();
    }
  }

  createFromRunResult(
    result: RunResult,
    stepIndex: number,
    options?: { label?: string; metadata?: Record<string, unknown> }
  ): ExecutionCheckpoint {
    const messagesUpToStep = this.extractMessagesUpToStep(result.messages as Message[], stepIndex);
    const toolResultsUpToStep = this.extractToolResultsUpToStep(result, stepIndex);
    const pendingToolCalls = this.extractPendingToolCalls(result, stepIndex);

    const checkpoint: ExecutionCheckpoint = {
      id: `ckpt_${nanoid(12)}`,
      traceId: result.trace.traceId,
      runId: result.runId,
      agentId: result.agentId,
      stepIndex,
      messages: messagesUpToStep,
      toolResults: toolResultsUpToStep,
      pendingToolCalls,
      label: options?.label,
      createdAt: new Date(),
      metadata: options?.metadata,
    };

    return checkpoint;
  }

  createFromTrace(
    trace: ExecutionTrace,
    stepIndex: number,
    options?: { label?: string; metadata?: Record<string, unknown> }
  ): ExecutionCheckpoint {
    const stepsUpToIndex = trace.steps.slice(0, stepIndex + 1);

    const messages: Message[] = [];
    messages.push({ role: 'user', content: trace.input });

    const toolResults: Record<string, unknown> = {};

    for (const step of stepsUpToIndex) {
      if (step.type === 'tool_call' && step.toolResult) {
        toolResults[step.toolResult.callId] = step.toolResult.result;
      }
    }

    const pendingStep = trace.steps[stepIndex];
    const pendingToolCalls =
      pendingStep?.type === 'tool_call' && pendingStep.toolCall ? [pendingStep.toolCall] : [];

    const checkpoint: ExecutionCheckpoint = {
      id: `ckpt_${nanoid(12)}`,
      traceId: trace.id,
      runId: trace.runId,
      agentId: trace.agentId,
      stepIndex,
      messages,
      toolResults,
      pendingToolCalls,
      label: options?.label,
      createdAt: new Date(),
      metadata: options?.metadata,
    };

    return checkpoint;
  }

  async createAllFromRunResult(
    result: RunResult,
    options?: { labelPrefix?: string }
  ): Promise<ExecutionCheckpoint[]> {
    const checkpoints: ExecutionCheckpoint[] = [];
    const stepCount = this.countStepsFromSpans(result);

    for (let i = 0; i < stepCount; i++) {
      const checkpoint = this.createFromRunResult(result, i, {
        label: options?.labelPrefix ? `${options.labelPrefix}_step_${i}` : undefined,
      });
      await this.save(checkpoint);
      checkpoints.push(checkpoint);
    }

    return checkpoints;
  }

  private addToIndex(index: Map<string, Set<string>>, key: string, id: string): void {
    let set = index.get(key);
    if (!set) {
      set = new Set();
      index.set(key, set);
    }
    set.add(id);
  }

  private removeFromIndex(index: Map<string, Set<string>>, key: string, id: string): void {
    index.get(key)?.delete(id);
  }

  private extractMessagesUpToStep(messages: Message[], stepIndex: number): Message[] {
    let toolCallCount = 0;
    const result: Message[] = [];

    for (const msg of messages) {
      result.push(msg);
      if (msg.role === 'tool') {
        toolCallCount++;
        if (toolCallCount > stepIndex) break;
      }
    }

    return result;
  }

  private extractToolResultsUpToStep(
    result: RunResult,
    stepIndex: number
  ): Record<string, unknown> {
    const toolResults: Record<string, unknown> = {};
    let count = 0;

    for (const span of result.trace.spans) {
      if (span.name.startsWith('tool.')) {
        if (count < stepIndex && span.attributes?.result !== undefined) {
          const callId = span.attributes?.call_id as string;
          if (callId) {
            toolResults[callId] = span.attributes.result;
          }
        }
        count++;
      }
    }

    return toolResults;
  }

  private extractPendingToolCalls(
    result: RunResult,
    stepIndex: number
  ): (typeof result.toolCalls)[number][] {
    let count = 0;

    for (const span of result.trace.spans) {
      if (span.name.startsWith('tool.')) {
        if (count === stepIndex) {
          const toolName = span.name.replace('tool.', '');
          const toolCall = result.toolCalls.find((tc) => tc.name === toolName);
          return toolCall ? [toolCall] : [];
        }
        count++;
      }
    }

    return [];
  }

  private countStepsFromSpans(result: RunResult): number {
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
}
