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

import type { CompensationConfig, CompensationOrder, WorkflowState } from '@cogitator-ai/types';

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
      timeout: config.compensateTimeout,
    });
  }

  /**
   * Mark a node as completed with its result
   */
  markCompleted(nodeId: string, result: unknown): void {
    this.completedNodes.set(nodeId, result);
    if (!this.executionOrder.includes(nodeId)) {
      this.executionOrder.push(nodeId);
    }
  }

  /**
   * Clear a node's completion status (for retries)
   */
  clearCompleted(nodeId: string): void {
    this.completedNodes.delete(nodeId);
    this.executionOrder = this.executionOrder.filter((id) => id !== nodeId);
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
  async compensate(state: S, failedNodeId: string, error: Error): Promise<CompensationReport> {
    const startTime = Date.now();
    const compensated: CompensationResult[] = [];
    const partialFailures: string[] = [];

    const nodesToCompensate = this.getCompensableNodes().filter(
      (nodeId) => nodeId !== failedNodeId
    );

    const groups = this.buildCompensationGroups(nodesToCompensate);

    const executeStep = async (nodeId: string): Promise<void> => {
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
        return;
      }

      let lastError: Error | undefined;
      let success = false;

      for (let attempt = 0; attempt <= (step.retries ?? 0); attempt++) {
        try {
          if (step.timeout) {
            await this.withTimeout(step.compensationFn(state, originalResult), step.timeout);
          } else {
            await step.compensationFn(state, originalResult);
          }
          success = true;
          break;
        } catch (err) {
          lastError = err instanceof Error ? err : new Error(String(err));
          if (attempt < (step.retries ?? 0)) {
            await this.delay(100 * Math.pow(2, attempt));
          }
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
    };

    for (const group of groups) {
      if (group.length === 1) {
        await executeStep(group[0]);
      } else {
        await Promise.all(group.map(executeStep));
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
   * Build ordered compensation groups respecting execution order.
   * Consecutive parallel nodes are grouped and run concurrently at their
   * correct position. Forward-order nodes run individually in forward order.
   */
  private buildCompensationGroups(nodes: string[]): string[][] {
    const nodeSet = new Set(nodes);
    const groups: string[][] = [];
    const forwardNodes: string[] = [];
    let currentParallelGroup: string[] = [];

    const flushParallel = (): void => {
      if (currentParallelGroup.length > 0) {
        groups.push(currentParallelGroup);
        currentParallelGroup = [];
      }
    };

    for (const nodeId of [...this.executionOrder].reverse()) {
      if (!nodeSet.has(nodeId)) continue;

      const order = this.steps.get(nodeId)?.order ?? 'reverse';

      if (order === 'forward') {
        forwardNodes.push(nodeId);
        continue;
      }

      if (order === 'parallel') {
        currentParallelGroup.push(nodeId);
      } else {
        flushParallel();
        groups.push([nodeId]);
      }
    }

    flushParallel();

    const forwardOrdered = this.executionOrder.filter((n) => forwardNodes.includes(n));
    for (const nodeId of forwardOrdered) {
      groups.push([nodeId]);
    }

    return groups;
  }

  private delay(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  /**
   * Execute with timeout
   */
  private async withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
    let timer: ReturnType<typeof setTimeout>;
    const timeoutPromise = new Promise<T>((_, reject) => {
      timer = setTimeout(() => reject(new Error('Compensation timeout')), timeoutMs);
    });
    try {
      return await Promise.race([promise, timeoutPromise]);
    } finally {
      clearTimeout(timer!);
    }
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
