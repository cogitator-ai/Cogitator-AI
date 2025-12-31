/**
 * Cron Trigger
 *
 * Cron-based workflow scheduling with timezone support,
 * catch-up for missed runs, and concurrency control.
 */

import { nanoid } from 'nanoid';
import type {
  CronTriggerConfig,
  TriggerContext,
  WorkflowTrigger,
} from '@cogitator-ai/types';
import {
  parseCronExpression,
  getNextCronOccurrence,
  isValidCronExpression,
} from '../timers/cron-parser';

/**
 * Cron trigger state
 */
export interface CronTriggerState {
  triggerId: string;
  workflowName: string;
  config: CronTriggerConfig;
  lastRun?: number;
  nextRun?: number;
  runCount: number;
  errorCount: number;
  lastError?: string;
  activeRuns: number;
  enabled: boolean;
}

/**
 * Cron trigger handler result
 */
export interface CronTriggerResult {
  triggered: boolean;
  runId?: string;
  skipped?: boolean;
  reason?: string;
  nextRun?: number;
}

/**
 * Cron trigger executor
 */
export class CronTriggerExecutor {
  private triggers = new Map<string, CronTriggerState>();
  private intervals = new Map<string, ReturnType<typeof setInterval>>();
  private onFire?: (trigger: WorkflowTrigger, context: TriggerContext) => Promise<string>;

  constructor(options: {
    onFire?: (trigger: WorkflowTrigger, context: TriggerContext) => Promise<string>;
  } = {}) {
    this.onFire = options.onFire;
  }

  /**
   * Register a cron trigger
   */
  register(
    workflowName: string,
    config: CronTriggerConfig,
    externalId?: string
  ): string {
    const triggerId = externalId ?? nanoid();

    if (!isValidCronExpression(config.expression)) {
      throw new Error(`Invalid cron expression: ${config.expression}`);
    }

    const nextRun = this.calculateNextRun(config);

    const state: CronTriggerState = {
      triggerId,
      workflowName,
      config,
      nextRun,
      runCount: 0,
      errorCount: 0,
      activeRuns: 0,
      enabled: config.enabled,
    };

    this.triggers.set(triggerId, state);

    if (config.enabled) {
      this.scheduleNext(triggerId);

      if (config.runImmediately) {
        this.fire(triggerId).catch(() => {
        });
      }
    }

    return triggerId;
  }

  /**
   * Unregister a trigger
   */
  unregister(triggerId: string): void {
    const interval = this.intervals.get(triggerId);
    if (interval) {
      clearInterval(interval);
      this.intervals.delete(triggerId);
    }
    this.triggers.delete(triggerId);
  }

  /**
   * Enable a trigger
   */
  enable(triggerId: string): void {
    const state = this.triggers.get(triggerId);
    if (!state) throw new Error(`Trigger not found: ${triggerId}`);

    state.enabled = true;
    state.config.enabled = true;
    state.nextRun = this.calculateNextRun(state.config);
    this.scheduleNext(triggerId);
  }

  /**
   * Disable a trigger
   */
  disable(triggerId: string): void {
    const state = this.triggers.get(triggerId);
    if (!state) throw new Error(`Trigger not found: ${triggerId}`);

    state.enabled = false;
    state.config.enabled = false;

    const interval = this.intervals.get(triggerId);
    if (interval) {
      clearInterval(interval);
      this.intervals.delete(triggerId);
    }
  }

  /**
   * Get trigger state
   */
  getState(triggerId: string): CronTriggerState | undefined {
    return this.triggers.get(triggerId);
  }

  /**
   * Get all triggers for a workflow
   */
  getTriggersForWorkflow(workflowName: string): CronTriggerState[] {
    return Array.from(this.triggers.values()).filter(
      t => t.workflowName === workflowName
    );
  }

  /**
   * Get all enabled triggers
   */
  getEnabledTriggers(): CronTriggerState[] {
    return Array.from(this.triggers.values()).filter(t => t.enabled);
  }

  /**
   * Manually fire a trigger
   */
  async fire(triggerId: string): Promise<CronTriggerResult> {
    const state = this.triggers.get(triggerId);
    if (!state) {
      return {
        triggered: false,
        reason: 'Trigger not found',
      };
    }

    const now = Date.now();

    if (state.config.maxConcurrent !== undefined &&
        state.activeRuns >= state.config.maxConcurrent) {
      return {
        triggered: false,
        skipped: true,
        reason: `Max concurrent runs reached: ${state.config.maxConcurrent}`,
        nextRun: state.nextRun,
      };
    }

    const context: TriggerContext = {
      triggerId,
      triggerType: 'cron',
      timestamp: now,
      metadata: {
        expression: state.config.expression,
        timezone: state.config.timezone,
        scheduled: state.nextRun,
      },
    };

    if (state.config.condition && !state.config.condition(context)) {
      return {
        triggered: false,
        skipped: true,
        reason: 'Condition not met',
        nextRun: state.nextRun,
      };
    }

    const input = typeof state.config.input === 'function'
      ? state.config.input(context)
      : state.config.input;

    if (input) {
      context.payload = input;
    }

    state.activeRuns++;
    state.lastRun = now;

    try {
      const trigger = this.toWorkflowTrigger(state);
      const runId = await this.onFire?.(trigger, context);

      state.runCount++;
      state.activeRuns--;

      state.nextRun = this.calculateNextRun(state.config);

      return {
        triggered: true,
        runId,
        nextRun: state.nextRun,
      };
    } catch (error) {
      state.errorCount++;
      state.activeRuns--;
      state.lastError = error instanceof Error ? error.message : String(error);

      return {
        triggered: false,
        reason: state.lastError,
        nextRun: state.nextRun,
      };
    }
  }

  /**
   * Check for catch-up runs (missed scheduled runs)
   */
  async catchUp(triggerId: string, since: number): Promise<CronTriggerResult[]> {
    const state = this.triggers.get(triggerId);
    if (!state?.config.catchUp) {
      return [];
    }

    const results: CronTriggerResult[] = [];
    const now = Date.now();
    let currentTime = since;

    while (currentTime < now) {
      const nextRun = getNextCronOccurrence(
        state.config.expression,
        { timezone: state.config.timezone, currentDate: new Date(currentTime) }
      );

      if (!nextRun || nextRun.getTime() >= now) {
        break;
      }

      const result = await this.fire(triggerId);
      results.push(result);

      currentTime = nextRun.getTime() + 1;
    }

    return results;
  }

  /**
   * Get all triggers
   */
  getAll(): CronTriggerState[] {
    return Array.from(this.triggers.values());
  }

  /**
   * Dispose all triggers
   */
  dispose(): void {
    for (const interval of this.intervals.values()) {
      clearInterval(interval);
    }
    this.intervals.clear();
    this.triggers.clear();
  }

  private scheduleNext(triggerId: string): void {
    const state = this.triggers.get(triggerId);
    if (!state?.enabled) return;

    const existingInterval = this.intervals.get(triggerId);
    if (existingInterval) {
      clearInterval(existingInterval);
    }

    const now = Date.now();
    const nextRun = state.nextRun ?? this.calculateNextRun(state.config);

    if (!nextRun) return;

    const delay = Math.max(0, nextRun - now);

    const timeoutId = setTimeout(async () => {
      if (!this.triggers.has(triggerId)) return;

      await this.fire(triggerId);

      const checkInterval = this.calculateCheckInterval(state.config);
      const interval = setInterval(async () => {
        const currentState = this.triggers.get(triggerId);
        if (!currentState?.enabled) {
          clearInterval(interval);
          return;
        }

        const currentNow = Date.now();
        if (currentState.nextRun && currentNow >= currentState.nextRun) {
          await this.fire(triggerId);
        }
      }, checkInterval);

      this.intervals.set(triggerId, interval);
    }, delay);

    this.intervals.set(triggerId, timeoutId as unknown as ReturnType<typeof setInterval>);
  }

  private calculateNextRun(config: CronTriggerConfig): number | undefined {
    try {
      const next = getNextCronOccurrence(config.expression, {
        timezone: config.timezone,
      });
      return next?.getTime();
    } catch {
      return undefined;
    }
  }

  private calculateCheckInterval(config: CronTriggerConfig): number {
    const parsed = parseCronExpression(config.expression);

    if (parsed.fields.second && parsed.fields.second.length < 60) {
      return 1000;
    }

    return 60000;
  }

  private toWorkflowTrigger(state: CronTriggerState): WorkflowTrigger {
    return {
      id: state.triggerId,
      workflowName: state.workflowName,
      type: 'cron',
      config: state.config,
      enabled: state.enabled,
      createdAt: Date.now(),
      lastTriggered: state.lastRun,
      nextTrigger: state.nextRun,
      triggerCount: state.runCount,
      errorCount: state.errorCount,
      lastError: state.lastError,
    };
  }
}

/**
 * Create a cron trigger executor
 */
export function createCronTrigger(options: {
  onFire?: (trigger: WorkflowTrigger, context: TriggerContext) => Promise<string>;
} = {}): CronTriggerExecutor {
  return new CronTriggerExecutor(options);
}

/**
 * Validate a cron trigger config
 */
export function validateCronTriggerConfig(config: CronTriggerConfig): string[] {
  const errors: string[] = [];

  if (!config.expression) {
    errors.push('Cron expression is required');
  } else if (!isValidCronExpression(config.expression)) {
    errors.push(`Invalid cron expression: ${config.expression}`);
  }

  if (config.timezone) {
    try {
      Intl.DateTimeFormat(undefined, { timeZone: config.timezone });
    } catch {
      errors.push(`Invalid timezone: ${config.timezone}`);
    }
  }

  if (config.maxConcurrent !== undefined && config.maxConcurrent < 1) {
    errors.push('maxConcurrent must be at least 1');
  }

  return errors;
}
