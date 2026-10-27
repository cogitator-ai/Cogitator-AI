/**
 * Trigger Manager
 *
 * Central management for all workflow triggers (cron, webhook, event).
 * Coordinates trigger registration, firing, and lifecycle.
 */

import { nanoid } from 'nanoid';
import type {
  WorkflowTrigger,
  TriggerContext,
  TriggerManager as ITriggerManager,
  CronTriggerConfig,
  WebhookTriggerConfig,
  EventTriggerConfig,
  Workflow,
  WorkflowState,
} from '@cogitator-ai/types';
import { type CronTriggerExecutor, createCronTrigger } from './cron-trigger';
import {
  type WebhookTriggerExecutor,
  createWebhookTrigger,
  validateWebhookTriggerConfig,
  type WebhookRequest,
} from './webhook-trigger';

/**
 * Trigger store interface
 */
export interface TriggerStore {
  save(trigger: WorkflowTrigger): Promise<void>;
  get(id: string): Promise<WorkflowTrigger | null>;
  update(id: string, updates: Partial<WorkflowTrigger>): Promise<void>;
  delete(id: string): Promise<void>;
  list(workflowName?: string): Promise<WorkflowTrigger[]>;
  listEnabled(): Promise<WorkflowTrigger[]>;
  listByType(type: 'cron' | 'webhook' | 'event'): Promise<WorkflowTrigger[]>;
}

/**
 * In-memory trigger store
 */
export class InMemoryTriggerStore implements TriggerStore {
  private triggers = new Map<string, WorkflowTrigger>();

  async save(trigger: WorkflowTrigger): Promise<void> {
    this.triggers.set(trigger.id, { ...trigger });
  }

  async get(id: string): Promise<WorkflowTrigger | null> {
    const trigger = this.triggers.get(id);
    return trigger ? { ...trigger } : null;
  }

  async update(id: string, updates: Partial<WorkflowTrigger>): Promise<void> {
    const existing = this.triggers.get(id);
    if (existing) {
      this.triggers.set(id, { ...existing, ...updates });
    }
  }

  async delete(id: string): Promise<void> {
    this.triggers.delete(id);
  }

  async list(workflowName?: string): Promise<WorkflowTrigger[]> {
    const all = Array.from(this.triggers.values()).map((t) => ({ ...t }));
    if (workflowName) {
      return all.filter((t) => t.workflowName === workflowName);
    }
    return all;
  }

  async listEnabled(): Promise<WorkflowTrigger[]> {
    return Array.from(this.triggers.values())
      .filter((t) => t.enabled)
      .map((t) => ({ ...t }));
  }

  async listByType(type: 'cron' | 'webhook' | 'event'): Promise<WorkflowTrigger[]> {
    return Array.from(this.triggers.values())
      .filter((t) => t.type === type)
      .map((t) => ({ ...t }));
  }

  clear(): void {
    this.triggers.clear();
  }
}

/**
 * Event emitter for triggers
 */
export interface TriggerEventEmitter {
  emit(eventType: string, payload: unknown): void;
  on(eventType: string, callback: (payload: unknown) => void): () => void;
}

/**
 * Simple event emitter implementation
 */
export class SimpleTriggerEventEmitter implements TriggerEventEmitter {
  private listeners = new Map<string, Set<(payload: unknown) => void>>();

  emit(eventType: string, payload: unknown): void {
    const callbacks = this.listeners.get(eventType);
    if (callbacks) {
      for (const callback of callbacks) {
        try {
          callback(payload);
        } catch (error) {
          console.warn(`[TriggerEventEmitter] Listener for '${eventType}' failed:`, error);
        }
      }
    }
  }

  on(eventType: string, callback: (payload: unknown) => void): () => void {
    let callbacks = this.listeners.get(eventType);
    if (!callbacks) {
      callbacks = new Set();
      this.listeners.set(eventType, callbacks);
    }
    callbacks.add(callback);

    return () => {
      callbacks?.delete(callback);
      if (callbacks?.size === 0) {
        this.listeners.delete(eventType);
      }
    };
  }

  clear(): void {
    this.listeners.clear();
  }
}

/**
 * Trigger manager configuration
 */
export interface TriggerManagerConfig {
  store?: TriggerStore;
  eventEmitter?: TriggerEventEmitter;
  onTriggerFire?: (trigger: WorkflowTrigger, context: TriggerContext) => Promise<string>;
}

/**
 * Default trigger manager implementation
 */
export class DefaultTriggerManager implements ITriggerManager {
  private store: TriggerStore;
  private eventEmitter: TriggerEventEmitter;
  private cronExecutor: CronTriggerExecutor;
  private webhookExecutor: WebhookTriggerExecutor;
  private triggerCallbacks = new Set<(trigger: WorkflowTrigger, context: TriggerContext) => void>();
  private eventListeners = new Map<string, () => void>();
  private config: TriggerManagerConfig;
  private _started = false;
  private restoring?: Promise<void>;
  /** Changes with every `start()` and `stop()`: a restore of an earlier start stops there */
  private generation = 0;

  constructor(config: TriggerManagerConfig = {}) {
    this.config = config;
    this.store = config.store ?? new InMemoryTriggerStore();
    this.eventEmitter = config.eventEmitter ?? new SimpleTriggerEventEmitter();

    const onFire = async (trigger: WorkflowTrigger, context: TriggerContext): Promise<string> => {
      for (const callback of this.triggerCallbacks) {
        try {
          callback(trigger, context);
        } catch (error) {
          console.warn(`[TriggerManager] onTrigger callback failed for '${trigger.id}':`, error);
        }
      }

      const fresh = await this.store.get(trigger.id);
      await this.store.update(trigger.id, {
        lastTriggered: context.timestamp,
        triggerCount: (fresh?.triggerCount ?? trigger.triggerCount) + 1,
      });

      if (config.onTriggerFire) {
        return config.onTriggerFire(trigger, context);
      }

      return nanoid();
    };

    this.cronExecutor = createCronTrigger({ onFire });
    this.webhookExecutor = createWebhookTrigger({ onFire });
  }

  /**
   * Starts the manager and brings back the triggers of its store: cron triggers are scheduled
   * again, webhooks answered and event triggers listen, disabled ones stay disabled. A trigger
   * that cannot come back is skipped with its error recorded on it. Resolves once they are back
   */
  start(): Promise<void> {
    if (this._started && this.restoring) return this.restoring;
    this._started = true;
    const generation = ++this.generation;
    this.restoring = this.restore(generation);
    return this.restoring;
  }

  /** Brings back the stored triggers, unless `stop()` came while the store was read */
  private async restore(generation: number): Promise<void> {
    const stored = await this.store.list();
    for (const trigger of stored) {
      if (generation !== this.generation) return;
      try {
        this.activate(trigger);
        if (!trigger.enabled) this.deactivate(trigger);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        console.warn(`[TriggerManager] Trigger '${trigger.id}' could not be restored:`, message);
        await this.store.update(trigger.id, {
          lastError: message,
          errorCount: trigger.errorCount + 1,
        });
      }
    }
  }

  /** Hands a stored trigger to its executor or event listener */
  private activate(trigger: WorkflowTrigger): void {
    switch (trigger.type) {
      case 'cron':
        this.cronExecutor.unregister(trigger.id);
        this.cronExecutor.register(
          trigger.workflowName,
          { ...(trigger.config as CronTriggerConfig), enabled: trigger.enabled },
          trigger.id
        );
        break;
      case 'webhook': {
        const config = trigger.config as WebhookTriggerConfig;
        const errors = validateWebhookTriggerConfig(config);
        if (errors.length > 0) {
          throw new Error(`Invalid webhook trigger config: ${errors.join('; ')}`);
        }
        this.webhookExecutor.unregister(trigger.id);
        this.webhookExecutor.register(trigger.workflowName, config, trigger.id);
        break;
      }
      case 'event':
        this.registerEventTrigger(
          trigger.id,
          trigger.workflowName,
          trigger.config as EventTriggerConfig
        );
        break;
    }
  }

  private deactivate(trigger: WorkflowTrigger): void {
    switch (trigger.type) {
      case 'cron':
        this.cronExecutor.disable(trigger.id);
        break;
      case 'webhook':
        this.webhookExecutor.disable(trigger.id);
        break;
      case 'event': {
        const unsubscribe = this.eventListeners.get(trigger.id);
        unsubscribe?.();
        this.eventListeners.delete(trigger.id);
        break;
      }
    }
  }

  /**
   * Stop the trigger manager
   */
  stop(): void {
    this._started = false;
    this.generation++;
    this.restoring = undefined;
    this.cronExecutor.dispose();
    this.webhookExecutor.dispose();
  }

  /**
   * Check if the manager is running
   */
  get isRunning(): boolean {
    return this._started;
  }

  /**
   * Registers a trigger and returns its id. A trigger of the store with the same workflow, type
   * and config (what `start()` brought back after a restart) is taken over instead of added
   * again: it keeps its id and counts, takes the `enabled` given, and a program that registers
   * its triggers on every boot does not get one more each time. It is not started a second
   * time, so a cron trigger with `runImmediately` fires once per start, not once more for the
   * registration
   */
  async register(
    trigger: Omit<WorkflowTrigger, 'id' | 'createdAt' | 'triggerCount' | 'errorCount'>
  ): Promise<string> {
    if (!this._started) throw new Error('TriggerManager is not started');
    await this.restoring;
    const key = definitionKey(trigger);
    const existing = (await this.store.list(trigger.workflowName)).find(
      (stored) => definitionKey(stored) === key
    );
    if (existing) {
      const updated: WorkflowTrigger = {
        ...existing,
        config: trigger.config,
        enabled: trigger.enabled,
      };
      if (existing.type === 'webhook') {
        const errors = validateWebhookTriggerConfig(updated.config as WebhookTriggerConfig);
        if (errors.length > 0) {
          throw new Error(`Invalid webhook trigger config: ${errors.join('; ')}`);
        }
      }
      await this.store.save(updated);
      if (existing.enabled !== updated.enabled) {
        if (updated.enabled) await this.enable(existing.id);
        else await this.disable(existing.id);
      }
      return existing.id;
    }
    const id = nanoid();
    const now = Date.now();

    const fullTrigger: WorkflowTrigger = {
      ...trigger,
      id,
      createdAt: now,
      triggerCount: 0,
      errorCount: 0,
    };

    await this.store.save(fullTrigger);

    switch (trigger.type) {
      case 'cron': {
        const config = trigger.config as CronTriggerConfig;
        this.cronExecutor.register(trigger.workflowName, config, id);
        break;
      }

      case 'webhook': {
        const config = trigger.config as WebhookTriggerConfig;
        const errors = validateWebhookTriggerConfig(config);
        if (errors.length > 0) {
          throw new Error(`Invalid webhook trigger config: ${errors.join('; ')}`);
        }
        this.webhookExecutor.register(trigger.workflowName, config, id);
        break;
      }

      case 'event': {
        const config = trigger.config as EventTriggerConfig;
        this.registerEventTrigger(id, trigger.workflowName, config);
        break;
      }
    }

    return id;
  }

  /**
   * Unregister a trigger
   */
  async unregister(id: string): Promise<void> {
    const trigger = await this.store.get(id);
    if (!trigger) return;

    switch (trigger.type) {
      case 'cron':
        this.cronExecutor.unregister(id);
        break;
      case 'webhook':
        this.webhookExecutor.unregister(id);
        break;
      case 'event': {
        const unsubscribe = this.eventListeners.get(id);
        if (unsubscribe) {
          unsubscribe();
          this.eventListeners.delete(id);
        }
        break;
      }
    }

    await this.store.delete(id);
  }

  /**
   * Enable a trigger
   */
  async enable(id: string): Promise<void> {
    const trigger = await this.store.get(id);
    if (!trigger) throw new Error(`Trigger not found: ${id}`);

    await this.store.update(id, { enabled: true });

    switch (trigger.type) {
      case 'cron':
        this.cronExecutor.enable(id);
        break;
      case 'webhook':
        this.webhookExecutor.enable(id);
        break;
      case 'event':
        this.registerEventTrigger(id, trigger.workflowName, trigger.config as EventTriggerConfig);
        break;
    }
  }

  /**
   * Disable a trigger
   */
  async disable(id: string): Promise<void> {
    const trigger = await this.store.get(id);
    if (!trigger) throw new Error(`Trigger not found: ${id}`);

    await this.store.update(id, { enabled: false });

    switch (trigger.type) {
      case 'cron':
        this.cronExecutor.disable(id);
        break;
      case 'webhook':
        this.webhookExecutor.disable(id);
        break;
      case 'event': {
        const unsubscribe = this.eventListeners.get(id);
        if (unsubscribe) {
          unsubscribe();
          this.eventListeners.delete(id);
        }
        break;
      }
    }
  }

  /**
   * Get a trigger
   */
  async get(id: string): Promise<WorkflowTrigger | null> {
    return this.store.get(id);
  }

  /**
   * List triggers
   */
  async list(workflowName?: string): Promise<WorkflowTrigger[]> {
    return this.store.list(workflowName);
  }

  /**
   * List enabled triggers
   */
  async listEnabled(): Promise<WorkflowTrigger[]> {
    return this.store.listEnabled();
  }

  /**
   * Manually fire a trigger
   */
  async fire(id: string, partialContext?: Partial<TriggerContext>): Promise<string> {
    if (!this._started) throw new Error('TriggerManager is not started');
    const trigger = await this.store.get(id);
    if (!trigger) throw new Error(`Trigger not found: ${id}`);

    const context: TriggerContext = {
      triggerId: id,
      triggerType: partialContext?.triggerType ?? 'manual',
      timestamp: Date.now(),
      ...partialContext,
    };

    for (const callback of this.triggerCallbacks) {
      try {
        callback(trigger, context);
      } catch (error) {
        console.warn(`[TriggerManager] onTrigger callback failed for '${trigger.id}':`, error);
      }
    }

    const fresh = await this.store.get(id);
    await this.store.update(id, {
      lastTriggered: context.timestamp,
      triggerCount: (fresh?.triggerCount ?? trigger.triggerCount) + 1,
    });

    if (this.config.onTriggerFire) {
      return this.config.onTriggerFire(trigger, context);
    }

    return nanoid();
  }

  /**
   * Subscribe to trigger events
   */
  onTrigger(callback: (trigger: WorkflowTrigger, context: TriggerContext) => void): () => void {
    this.triggerCallbacks.add(callback);
    return () => {
      this.triggerCallbacks.delete(callback);
    };
  }

  /**
   * Handle incoming webhook request
   */
  async handleWebhook(request: WebhookRequest) {
    if (!this._started) throw new Error('TriggerManager is not started');
    return this.webhookExecutor.handle(request);
  }

  /**
   * Emit an event (for event triggers)
   */
  emitEvent(eventType: string, payload: unknown): void {
    this.eventEmitter.emit(eventType, payload);
  }

  /**
   * Register a workflow with triggers
   */
  async registerWorkflow<S extends WorkflowState>(
    workflow: Workflow<S>,
    triggers: {
      type: 'cron' | 'webhook' | 'event';
      config: CronTriggerConfig | WebhookTriggerConfig | EventTriggerConfig;
    }[]
  ): Promise<string[]> {
    const ids: string[] = [];

    for (const trigger of triggers) {
      const id = await this.register({
        workflowName: workflow.name,
        type: trigger.type,
        config: trigger.config,
        enabled: true,
      });
      ids.push(id);
    }

    return ids;
  }

  /**
   * Get trigger stats
   */
  async getStats(): Promise<{
    total: number;
    enabled: number;
    byType: Record<string, number>;
    totalFired: number;
    totalErrors: number;
  }> {
    const all = await this.store.list();
    const enabled = all.filter((t) => t.enabled);

    const byType: Record<string, number> = { cron: 0, webhook: 0, event: 0 };
    let totalFired = 0;
    let totalErrors = 0;

    for (const trigger of all) {
      byType[trigger.type] = (byType[trigger.type] ?? 0) + 1;
      totalFired += trigger.triggerCount;
      totalErrors += trigger.errorCount;
    }

    return {
      total: all.length,
      enabled: enabled.length,
      byType,
      totalFired,
      totalErrors,
    };
  }

  /**
   * Dispose the manager
   */
  dispose(): void {
    this.stop();
    this.triggerCallbacks.clear();

    for (const unsubscribe of this.eventListeners.values()) {
      unsubscribe();
    }
    this.eventListeners.clear();

    if (this.eventEmitter instanceof SimpleTriggerEventEmitter) {
      this.eventEmitter.clear();
    }
  }

  private registerEventTrigger(
    id: string,
    _workflowName: string,
    config: EventTriggerConfig
  ): void {
    const existing = this.eventListeners.get(id);
    if (existing) {
      existing();
    }

    const unsubscribe = this.eventEmitter.on(config.eventType, (payload) => {
      void (async () => {
        if (config.source) {
          const eventSource = (payload as { source?: string })?.source;
          if (eventSource !== config.source) return;
        }

        if (config.filter && !config.filter(payload)) {
          return;
        }

        const transformedPayload = config.transform ? config.transform(payload) : payload;

        const trigger = await this.store.get(id);
        if (!trigger?.enabled) return;

        const context: TriggerContext = {
          triggerId: id,
          triggerType: 'event',
          timestamp: Date.now(),
          payload: transformedPayload,
          metadata: {
            eventType: config.eventType,
            source: config.source,
          },
        };

        for (const callback of this.triggerCallbacks) {
          try {
            callback(trigger, context);
          } catch (error) {
            console.warn(`[TriggerManager] onTrigger callback failed for '${trigger.id}':`, error);
          }
        }

        const fresh = await this.store.get(id);
        await this.store.update(id, {
          lastTriggered: context.timestamp,
          triggerCount: (fresh?.triggerCount ?? trigger.triggerCount) + 1,
        });

        if (this.config.onTriggerFire) {
          await this.config.onTriggerFire(trigger, context);
        }
      })().catch((error: unknown) => {
        console.warn(`[TriggerManager] Event trigger '${id}' failed to fire:`, error);
      });
    });

    this.eventListeners.set(id, unsubscribe);
  }
}

/**
 * Create a trigger manager
 */
export function createTriggerManager(config: TriggerManagerConfig = {}): DefaultTriggerManager {
  return new DefaultTriggerManager(config);
}

/**
 * Helper to create a cron trigger config
 */
export function cronTrigger(
  expression: string,
  options: Partial<Omit<CronTriggerConfig, 'expression'>> = {}
): CronTriggerConfig {
  return {
    expression,
    enabled: true,
    ...options,
  };
}

/**
 * Helper to create a webhook trigger config
 */
export function webhookTrigger(
  path: string,
  method: WebhookTriggerConfig['method'] = 'POST',
  options: Partial<Omit<WebhookTriggerConfig, 'path' | 'method'>> = {}
): WebhookTriggerConfig {
  return {
    path,
    method,
    ...options,
  };
}

/**
 * Helper to create an event trigger config
 */
export function eventTrigger(
  eventType: string,
  options: Partial<Omit<EventTriggerConfig, 'eventType'>> = {}
): EventTriggerConfig {
  return {
    eventType,
    ...options,
  };
}

/**
 * What tells two trigger definitions apart: the workflow, the type and the config as JSON with
 * its keys in order, `enabled` left out (it is state, not what the trigger is). A function of the
 * config (an event trigger's `filter` or `transform`) counts by identity: two definitions with
 * different functions are two triggers, and one brought back from a store that cannot keep
 * functions is not taken over by a definition that has them
 */
function definitionKey(trigger: Pick<WorkflowTrigger, 'workflowName' | 'type' | 'config'>): string {
  return JSON.stringify([trigger.workflowName, trigger.type, sortedJson(trigger.config)]);
}

const FUNCTION_IDS = new WeakMap<object, number>();
let nextFunctionId = 0;

/** A stable token of a function's identity */
function functionId(fn: object): string {
  let id = FUNCTION_IDS.get(fn);
  if (id === undefined) {
    id = ++nextFunctionId;
    FUNCTION_IDS.set(fn, id);
  }
  return `function#${id}`;
}

function sortedJson(value: unknown): unknown {
  if (typeof value === 'function') return functionId(value);
  if (Array.isArray(value)) return value.map(sortedJson);
  if (typeof value !== 'object' || value === null) return value;
  return Object.fromEntries(
    Object.entries(value)
      .filter(([key]) => key !== 'enabled')
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([key, entry]) => [key, sortedJson(entry)])
  );
}
