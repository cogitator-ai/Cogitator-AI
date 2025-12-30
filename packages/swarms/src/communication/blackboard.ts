/**
 * Blackboard for shared state between agents
 */

import type {
  Blackboard,
  BlackboardConfig,
  BlackboardSection,
  BlackboardHistoryEntry,
} from '@cogitator/types';

export class InMemoryBlackboard implements Blackboard {
  private sections = new Map<string, BlackboardSection>();
  private history = new Map<string, BlackboardHistoryEntry[]>();
  private subscriptions = new Map<string, Set<(data: unknown, agentName: string) => void>>();
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
    const sec = this.sections.get(section);
    if (!sec) {
      throw new Error(`Blackboard section '${section}' not found`);
    }
    return sec.data as T;
  }

  write<T>(section: string, data: T, agentName: string): void {
    if (!this.config.enabled) {
      throw new Error('Blackboard is not enabled');
    }

    const existing = this.sections.get(section);
    const version = existing ? existing.version + 1 : 1;
    const timestamp = Date.now();

    const newSection: BlackboardSection<T> = {
      name: section,
      data,
      lastModified: timestamp,
      modifiedBy: agentName,
      version,
    };

    this.sections.set(section, newSection as BlackboardSection);

    if (this.config.trackHistory) {
      if (!this.history.has(section)) {
        this.history.set(section, []);
      }
      this.history.get(section)!.push({
        value: data,
        writtenBy: agentName,
        timestamp,
        version,
      });
    }

    this.notifySubscribers(section, data, agentName);
  }

  append<T>(section: string, item: T, agentName: string): void {
    const current = this.sections.get(section);

    if (!current) {
      this.write(section, [item], agentName);
      return;
    }

    if (!Array.isArray(current.data)) {
      throw new Error(`Section '${section}' is not an array, cannot append`);
    }

    const newData = [...current.data, item];
    this.write(section, newData, agentName);
  }

  has(section: string): boolean {
    return this.sections.has(section);
  }

  delete(section: string): void {
    this.sections.delete(section);
    this.history.delete(section);
    this.subscriptions.delete(section);
  }

  subscribe(
    section: string,
    handler: (data: unknown, agentName: string) => void
  ): () => void {
    if (!this.subscriptions.has(section)) {
      this.subscriptions.set(section, new Set());
    }
    this.subscriptions.get(section)!.add(handler);

    return () => {
      const handlers = this.subscriptions.get(section);
      if (handlers) {
        handlers.delete(handler);
        if (handlers.size === 0) {
          this.subscriptions.delete(section);
        }
      }
    };
  }

  getSections(): string[] {
    return Array.from(this.sections.keys());
  }

  getSection<T = unknown>(section: string): BlackboardSection<T> | undefined {
    return this.sections.get(section) as BlackboardSection<T> | undefined;
  }

  getHistory(section: string): BlackboardHistoryEntry[] {
    return this.history.get(section) ?? [];
  }

  clear(): void {
    this.sections.clear();
    this.history.clear();
  }

  private notifySubscribers(section: string, data: unknown, agentName: string): void {
    const handlers = this.subscriptions.get(section);
    if (handlers) {
      for (const handler of handlers) {
        try {
          handler(data, agentName);
        } catch {
        }
      }
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
