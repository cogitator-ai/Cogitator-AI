/**
 * Blackboard for shared state between agents
 */

import type {
  Blackboard,
  BlackboardConfig,
  BlackboardSection,
  BlackboardHistoryEntry,
} from '@cogitator-ai/types';
import { invokeSafely } from '../utils/invoke.js';

export type BlackboardSectionHandler = (data: unknown, agentName: string) => void;

export interface BlackboardWrite {
  section: string;
  data: unknown;
  agentName: string;
  version: number;
  deleted?: boolean;
}

export type BlackboardWriteListener = (write: BlackboardWrite) => void;

/**
 * Blackboard that exposes a bus-wide write listener (used for swarm observability).
 */
export interface ObservableBlackboard extends Blackboard {
  onWrite(listener: BlackboardWriteListener): () => void;
}

export function isObservableBlackboard(blackboard: Blackboard): blackboard is ObservableBlackboard {
  return typeof (blackboard as Partial<ObservableBlackboard>).onWrite === 'function';
}

export class BlackboardListeners {
  private sectionHandlers = new Map<string, Set<BlackboardSectionHandler>>();
  private writeListeners = new Set<BlackboardWriteListener>();

  constructor(private readonly label: string) {}

  subscribe(section: string, handler: BlackboardSectionHandler): () => void {
    let handlers = this.sectionHandlers.get(section);
    if (!handlers) {
      handlers = new Set();
      this.sectionHandlers.set(section, handlers);
    }
    handlers.add(handler);

    return () => {
      const current = this.sectionHandlers.get(section);
      if (!current) return;
      current.delete(handler);
      if (current.size === 0) {
        this.sectionHandlers.delete(section);
      }
    };
  }

  onWrite(listener: BlackboardWriteListener): () => void {
    this.writeListeners.add(listener);
    return () => {
      this.writeListeners.delete(listener);
    };
  }

  notify(write: BlackboardWrite): void {
    if (!write.deleted) {
      for (const handler of [...(this.sectionHandlers.get(write.section) ?? [])]) {
        invokeSafely(handler, [write.data, write.agentName], `${this.label} Handler error`);
      }
    }
    for (const listener of [...this.writeListeners]) {
      invokeSafely(listener, [write], `${this.label} Write listener error`);
    }
  }
}

export class InMemoryBlackboard implements ObservableBlackboard {
  private sections = new Map<string, BlackboardSection>();
  private history = new Map<string, BlackboardHistoryEntry[]>();
  private listeners = new BlackboardListeners('[Blackboard]');
  private config: BlackboardConfig;

  constructor(config: BlackboardConfig) {
    this.config = config;

    for (const [name, initialData] of Object.entries(config.sections)) {
      this.sections.set(name, {
        name,
        data: initialData,
        lastModified: Date.now(),
        modifiedBy: 'system',
        version: 1,
      });

      if (config.trackHistory) {
        this.history.set(name, [
          {
            value: initialData,
            writtenBy: 'system',
            timestamp: Date.now(),
            version: 1,
          },
        ]);
      }
    }
  }

  read<T = unknown>(section: string): T {
    this.assertEnabled();
    const sec = this.sections.get(section);
    if (!sec) {
      throw new Error(`Blackboard section '${section}' not found`);
    }
    return sec.data as T;
  }

  write<T>(section: string, data: T, agentName: string): void {
    this.assertEnabled();

    const existing = this.sections.get(section);
    const version = existing ? existing.version + 1 : 1;
    const timestamp = Date.now();

    this.sections.set(section, {
      name: section,
      data,
      lastModified: timestamp,
      modifiedBy: agentName,
      version,
    });

    if (this.config.trackHistory) {
      let entries = this.history.get(section);
      if (!entries) {
        entries = [];
        this.history.set(section, entries);
      }
      entries.push({ value: data, writtenBy: agentName, timestamp, version });
    }

    this.listeners.notify({ section, data, agentName, version });
  }

  append<T>(section: string, item: T, agentName: string): void {
    this.assertEnabled();
    const current = this.sections.get(section);

    if (!current) {
      this.write(section, [item], agentName);
      return;
    }

    if (!Array.isArray(current.data)) {
      throw new Error(`Section '${section}' is not an array, cannot append`);
    }

    this.write(section, [...current.data, item], agentName);
  }

  has(section: string): boolean {
    return this.sections.has(section);
  }

  delete(section: string): void {
    const existing = this.sections.get(section);
    this.sections.delete(section);
    this.history.delete(section);
    if (existing) {
      this.listeners.notify({
        section,
        data: undefined,
        agentName: 'system',
        version: existing.version,
        deleted: true,
      });
    }
  }

  subscribe(section: string, handler: BlackboardSectionHandler): () => void {
    return this.listeners.subscribe(section, handler);
  }

  onWrite(listener: BlackboardWriteListener): () => void {
    return this.listeners.onWrite(listener);
  }

  getSections(): string[] {
    return Array.from(this.sections.keys());
  }

  getSection<T = unknown>(section: string): BlackboardSection<T> | undefined {
    return this.sections.get(section) as BlackboardSection<T> | undefined;
  }

  getHistory(section: string): BlackboardHistoryEntry[] {
    return [...(this.history.get(section) ?? [])];
  }

  /**
   * Remove all sections and history. Subscriptions are preserved so listeners
   * keep working across swarm resets.
   */
  clear(): void {
    this.sections.clear();
    this.history.clear();
  }

  private assertEnabled(): void {
    if (!this.config.enabled) {
      throw new Error('Blackboard is not enabled');
    }
  }
}

export function createBlackboard(config?: Partial<BlackboardConfig>): Blackboard {
  return new InMemoryBlackboard({
    enabled: true,
    sections: {},
    trackHistory: false,
    ...config,
  });
}
