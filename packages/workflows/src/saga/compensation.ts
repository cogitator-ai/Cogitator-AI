/**
 * Compensation Manager for Saga pattern
 *
 * Features:
 * - Automatic compensation on failure
 * - Reverse-order execution
 * - Partial compensation (only completed steps)
 * - Compensation condition checking
 * - Compensation result tracking
 */

import type {
  CompensationConfig,
  CompensationOrder,
  WorkflowState,
} from '@cogitator-ai/types';

/**
 * Compensation step definition
 */
export interface CompensationStep<S = WorkflowState> {
  nodeId: string;
  compensationFn: (state: S, originalResult: unknown) => Promise<void>;
  condition?: (state: S, error: Error) => boolean;
  order?: CompensationOrder;
  timeout?: number;
  retries?: number;
}

/**
 * Compensation execution result
 */
export interface CompensationResult {
  nodeId: string;
  success: boolean;
  error?: Error;
  duration: number;
  skipped: boolean;
  skipReason?: string;
}

/**
 * Full compensation execution report
 */
export interface CompensationReport {
  triggeredBy: {
    nodeId: string;
    error: Error;
  };
  compensated: CompensationResult[];
  totalDuration: number;
  allSuccessful: boolean;
  partialFailures: string[];
}

/**
 * Compensation Manager class
 */
export class CompensationManager<S = WorkflowState> {
  private steps = new Map<string, CompensationStep<S>>();
  private completedNodes = new Map<string, unknown>();
  private executionOrder: string[] = [];

  /**
   * Register a compensation step for a node
   */
  registerCompensation(
    nodeId: string,
    compensationFn: (state: S, originalResult: unknown) => Promise<void>,
    options: Partial<Omit<CompensationStep<S>, 'nodeId' | 'compensationFn'>> = {}
  ): void {
    this.steps.set(nodeId, {
      nodeId,
      compensationFn,
      condition: options.condition,
      order: options.order ?? 'reverse',
      timeout: options.timeout,
      retries: options.retries ?? 0,
    });
  }

  /**
   * Register compensation from config
   */
  registerFromConfig(nodeId: string, config: CompensationConfig<S>): void {
    if (!config.compensate) return;

    this.registerCompensation(nodeId, config.compensate, {
      condition: config.compensateCondition,
      order: config.compensateOrder,
    });
  }

  /**
   * Mark a node as completed with its result
   */
  markCompleted(nodeId: string, result: unknown): void {
    this.completedNodes.set(nodeId, result);
    this.executionOrder.push(nodeId);
  }

  /**
   * Clear a node's completion status (for retries)
   */
  clearCompleted(nodeId: string): void {
    this.completedNodes.delete(nodeId);
    const idx = this.executionOrder.indexOf(nodeId);
    if (idx !== -1) {
      this.executionOrder.splice(idx, 1);
    }
  }

  /**
   * Check if a node has a compensation step
   */
  hasCompensation(nodeId: string): boolean {
    return this.steps.has(nodeId);
  }

  /**
   * Get nodes that need compensation (completed nodes with compensation steps)
   */
  getCompensableNodes(): string[] {
    return this.executionOrder.filter(
      (nodeId) => this.steps.has(nodeId) && this.completedNodes.has(nodeId)
    );
  }

  /**
   * Execute compensation for all completed nodes
   */
  async compensate(
    state: S,
    failedNodeId: string,
    error: Error
  ): Promise<CompensationReport> {
    const startTime = Date.now();
    const compensated: CompensationResult[] = [];
    const partialFailures: string[] = [];

    const nodesToCompensate = this.getCompensableNodes();

    const sortedNodes = this.sortByCompensationOrder(nodesToCompensate);

    for (const nodeId of sortedNodes) {
      const step = this.steps.get(nodeId)!;
      const originalResult = this.completedNodes.get(nodeId);
      const stepStart = Date.now();

      if (step.condition && !step.condition(state, error)) {
        compensated.push({
          nodeId,
          success: true,
          duration: 0,
          skipped: true,
          skipReason: 'Condition not met',
        });
        continue;
      }

      let lastError: Error | undefined;
      let success = false;

      for (let attempt = 0; attempt <= (step.retries ?? 0); attempt++) {
        try {
          if (step.timeout) {
            await this.withTimeout(
              step.compensationFn(state, originalResult),
              step.timeout
            );
          } else {
            await step.compensationFn(state, originalResult);
          }
          success = true;
          break;
        } catch (err) {
          lastError = err instanceof Error ? err : new Error(String(err));
        }
      }

      compensated.push({
        nodeId,
        success,
        error: lastError,
        duration: Date.now() - stepStart,
        skipped: false,
      });

      if (!success) {
        partialFailures.push(nodeId);
      }
    }

    return {
      triggeredBy: {
        nodeId: failedNodeId,
        error,
      },
      compensated,
      totalDuration: Date.now() - startTime,
      allSuccessful: partialFailures.length === 0,
      partialFailures,
    };
  }

  /**
   * Sort nodes by their compensation order
   */
  private sortByCompensationOrder(nodes: string[]): string[] {
    const result: string[] = [];
    const parallel: string[] = [];
    const reverse: string[] = [];
    const forward: string[] = [];

    for (const nodeId of nodes) {
      const step = this.steps.get(nodeId);
      const order = step?.order ?? 'reverse';

      switch (order) {
        case 'parallel':
          parallel.push(nodeId);
          break;
        case 'forward':
          forward.push(nodeId);
          break;
        case 'reverse':
        default:
          reverse.push(nodeId);
          break;
      }
    }

    result.push(...parallel);

    const reverseOrder = [...this.executionOrder]
      .reverse()
      .filter((n) => reverse.includes(n));
    result.push(...reverseOrder);

    const forwardOrder = this.executionOrder.filter((n) => forward.includes(n));
    result.push(...forwardOrder);

    return result;
  }

  /**
   * Execute with timeout
   */
  private async withTimeout<T>(
    promise: Promise<T>,
    timeoutMs: number
  ): Promise<T> {
    return Promise.race([
      promise,
      new Promise<T>((_, reject) =>
        setTimeout(() => reject(new Error('Compensation timeout')), timeoutMs)
      ),
    ]);
  }

  /**
   * Reset manager state
   */
  reset(): void {
    this.completedNodes.clear();
    this.executionOrder = [];
  }

  /**
   * Get current state summary
   */
  getSummary(): CompensationManagerSummary {
    return {
      registeredSteps: this.steps.size,
      completedNodes: this.completedNodes.size,
      compensableNodes: this.getCompensableNodes().length,
      executionOrder: [...this.executionOrder],
    };
  }
}

/**
 * Compensation manager summary
 */
export interface CompensationManagerSummary {
  registeredSteps: number;
  completedNodes: number;
  compensableNodes: number;
  executionOrder: string[];
}

/**
 * Create a compensation manager
 */
export function createCompensationManager<S = WorkflowState>(): CompensationManager<S> {
  return new CompensationManager<S>();
}

/**
 * Compensation builder for fluent API
 */
export class CompensationBuilder<S = WorkflowState> {
  private steps: {
    nodeId: string;
    fn: (state: S, result: unknown) => Promise<void>;
    options: Partial<CompensationStep<S>>;
  }[] = [];

  /**
   * Add a compensation step
   */
  addStep(
    nodeId: string,
    fn: (state: S, result: unknown) => Promise<void>,
    options: Partial<Omit<CompensationStep<S>, 'nodeId' | 'compensationFn'>> = {}
  ): this {
    this.steps.push({ nodeId, fn, options });
    return this;
  }

  /**
   * Add conditional compensation
   */
  addConditionalStep(
    nodeId: string,
    fn: (state: S, result: unknown) => Promise<void>,
    condition: (state: S, error: Error) => boolean,
    options: Partial<Omit<CompensationStep<S>, 'nodeId' | 'compensationFn' | 'condition'>> = {}
  ): this {
    this.steps.push({
      nodeId,
      fn,
      options: { ...options, condition },
    });
    return this;
  }

  /**
   * Build the compensation manager
   */
  build(): CompensationManager<S> {
    const manager = new CompensationManager<S>();

    for (const step of this.steps) {
      manager.registerCompensation(step.nodeId, step.fn, step.options);
    }

    return manager;
  }
}

/**
 * Create a compensation builder
 */
export function compensationBuilder<S = WorkflowState>(): CompensationBuilder<S> {
  return new CompensationBuilder<S>();
}
