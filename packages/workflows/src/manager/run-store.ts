/**
 * Workflow Run Store implementations
 *
 * Features:
 * - In-memory store for development/testing
 * - File-based store for persistence
 * - Query filtering and pagination
 * - Statistics aggregation
 */

import type {
  RunStore,
  WorkflowRun,
  WorkflowRunFilters,
  WorkflowRunStats,
  WorkflowRunStatus,
} from '@cogitator/types';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';

/**
 * In-memory run store for development and testing
 */
export class InMemoryRunStore implements RunStore {
  private runs = new Map<string, WorkflowRun>();

  async save(run: WorkflowRun): Promise<void> {
    this.runs.set(run.id, { ...run });
  }

  async get(id: string): Promise<WorkflowRun | null> {
    return this.runs.get(id) ?? null;
  }

  async list(filters?: WorkflowRunFilters): Promise<WorkflowRun[]> {
    let runs = Array.from(this.runs.values());

    if (filters) {
      runs = this.applyFilters(runs, filters);
    }

    return runs;
  }

  async count(filters?: WorkflowRunFilters): Promise<number> {
    let runs = Array.from(this.runs.values());

    if (filters) {
      const countFilters = { ...filters };
      delete countFilters.limit;
      delete countFilters.offset;
      runs = this.applyFilters(runs, countFilters);
    }

    return runs.length;
  }

  async update(id: string, updates: Partial<WorkflowRun>): Promise<void> {
    const run = this.runs.get(id);
    if (run) {
      this.runs.set(id, { ...run, ...updates });
    }
  }

  async delete(id: string): Promise<void> {
    this.runs.delete(id);
  }

  async getStats(workflowName?: string): Promise<WorkflowRunStats> {
    let runs = Array.from(this.runs.values());

    if (workflowName) {
      runs = runs.filter((r) => r.workflowName === workflowName);
    }

    return this.calculateStats(runs);
  }

  async cleanup(olderThan: number): Promise<number> {
    const threshold = Date.now() - olderThan;
    let deleted = 0;

    for (const [id, run] of this.runs) {
      const timestamp = run.completedAt ?? run.startedAt ?? 0;
      if (timestamp < threshold && this.isTerminal(run.status)) {
        this.runs.delete(id);
        deleted++;
      }
    }

    return deleted;
  }

  private applyFilters(
    runs: WorkflowRun[],
    filters: WorkflowRunFilters
  ): WorkflowRun[] {
    let result = runs;

    if (filters.status) {
      const statuses = Array.isArray(filters.status)
        ? filters.status
        : [filters.status];
      result = result.filter((r) => statuses.includes(r.status));
    }

    if (filters.workflowName) {
      result = result.filter((r) => r.workflowName === filters.workflowName);
    }

    if (filters.tags && filters.tags.length > 0) {
      result = result.filter((r) =>
        filters.tags!.some((tag) => r.tags.includes(tag))
      );
    }

    if (filters.triggerId) {
      result = result.filter((r) => r.triggerId === filters.triggerId);
    }

    if (filters.parentRunId) {
      result = result.filter((r) => r.parentRunId === filters.parentRunId);
    }

    if (filters.startedAfter) {
      result = result.filter(
        (r) => r.startedAt && r.startedAt >= filters.startedAfter!
      );
    }
    if (filters.startedBefore) {
      result = result.filter(
        (r) => r.startedAt && r.startedAt <= filters.startedBefore!
      );
    }
    if (filters.completedAfter) {
      result = result.filter(
        (r) => r.completedAt && r.completedAt >= filters.completedAfter!
      );
    }
    if (filters.completedBefore) {
      result = result.filter(
        (r) => r.completedAt && r.completedAt <= filters.completedBefore!
      );
    }

    if (filters.hasError !== undefined) {
      result = result.filter((r) => Boolean(r.error) === filters.hasError);
    }

    const orderBy = filters.orderBy ?? 'startedAt';
    const direction = filters.orderDirection ?? 'desc';
    result.sort((a, b) => {
      const aVal = a[orderBy] ?? 0;
      const bVal = b[orderBy] ?? 0;
      return direction === 'asc'
        ? (aVal as number) - (bVal as number)
        : (bVal as number) - (aVal as number);
    });

    const offset = filters.offset ?? 0;
    const limit = filters.limit ?? Infinity;
    result = result.slice(offset, offset + limit);

    return result;
  }

  private calculateStats(runs: WorkflowRun[]): WorkflowRunStats {
    const byStatus: Record<WorkflowRunStatus, number> = {
      pending: 0,
      scheduled: 0,
      running: 0,
      paused: 0,
      waiting: 0,
      completed: 0,
      failed: 0,
      cancelled: 0,
      timeout: 0,
    };

    let totalDuration = 0;
    let durationCount = 0;
    let successCount = 0;
    let failureCount = 0;

    for (const run of runs) {
      byStatus[run.status]++;

      if (run.startedAt && run.completedAt) {
        totalDuration += run.completedAt - run.startedAt;
        durationCount++;
      }

      if (run.status === 'completed') {
        successCount++;
      } else if (run.status === 'failed' || run.status === 'timeout') {
        failureCount++;
      }
    }

    const terminalCount = successCount + failureCount;

    return {
      total: runs.length,
      byStatus,
      avgDuration: durationCount > 0 ? totalDuration / durationCount : 0,
      successRate: terminalCount > 0 ? successCount / terminalCount : 0,
      failureRate: terminalCount > 0 ? failureCount / terminalCount : 0,
    };
  }

  private isTerminal(status: WorkflowRunStatus): boolean {
    return ['completed', 'failed', 'cancelled', 'timeout'].includes(status);
  }

  /**
   * Clear all data (for testing)
   */
  clear(): void {
    this.runs.clear();
  }

  /**
   * Get all runs (for debugging)
   */
  getAll(): WorkflowRun[] {
    return Array.from(this.runs.values());
  }
}

/**
 * File-based run store for persistence
 */
export class FileRunStore implements RunStore {
  private readonly directory: string;
  private cache = new Map<string, WorkflowRun>();
  private cacheExpiry = new Map<string, number>();
  private readonly cacheTTL: number;

  constructor(options: {
    directory: string;
    cacheTTL?: number;
  }) {
    this.directory = options.directory;
    this.cacheTTL = options.cacheTTL ?? 60000;
  }

  private getRunPath(id: string): string {
    return path.join(this.directory, `${id}.json`);
  }

  private isCacheValid(id: string): boolean {
    const expiry = this.cacheExpiry.get(id);
    return expiry !== undefined && expiry > Date.now();
  }

  async save(run: WorkflowRun): Promise<void> {
    await fs.mkdir(this.directory, { recursive: true });
    await fs.writeFile(
      this.getRunPath(run.id),
      JSON.stringify(run, null, 2),
      'utf-8'
    );

    this.cache.set(run.id, run);
    this.cacheExpiry.set(run.id, Date.now() + this.cacheTTL);
  }

  async get(id: string): Promise<WorkflowRun | null> {
    if (this.isCacheValid(id)) {
      return this.cache.get(id) ?? null;
    }

    try {
      const content = await fs.readFile(this.getRunPath(id), 'utf-8');
      const run = JSON.parse(content) as WorkflowRun;

      this.cache.set(id, run);
      this.cacheExpiry.set(id, Date.now() + this.cacheTTL);

      return run;
    } catch {
      return null;
    }
  }

  async list(filters?: WorkflowRunFilters): Promise<WorkflowRun[]> {
    const runs = await this.loadAllRuns();
    return this.applyFilters(runs, filters);
  }

  async count(filters?: WorkflowRunFilters): Promise<number> {
    const runs = await this.loadAllRuns();
    const countFilters = filters ? { ...filters } : undefined;
    if (countFilters) {
      delete countFilters.limit;
      delete countFilters.offset;
    }
    return this.applyFilters(runs, countFilters).length;
  }

  async update(id: string, updates: Partial<WorkflowRun>): Promise<void> {
    const run = await this.get(id);
    if (run) {
      await this.save({ ...run, ...updates });
    }
  }

  async delete(id: string): Promise<void> {
    try {
      await fs.unlink(this.getRunPath(id));
    } catch {
    }

    this.cache.delete(id);
    this.cacheExpiry.delete(id);
  }

  async getStats(workflowName?: string): Promise<WorkflowRunStats> {
    let runs = await this.loadAllRuns();

    if (workflowName) {
      runs = runs.filter((r) => r.workflowName === workflowName);
    }

    return this.calculateStats(runs);
  }

  async cleanup(olderThan: number): Promise<number> {
    const threshold = Date.now() - olderThan;
    const runs = await this.loadAllRuns();
    let deleted = 0;

    for (const run of runs) {
      const timestamp = run.completedAt ?? run.startedAt ?? 0;
      if (timestamp < threshold && this.isTerminal(run.status)) {
        await this.delete(run.id);
        deleted++;
      }
    }

    return deleted;
  }

  private async loadAllRuns(): Promise<WorkflowRun[]> {
    const runs: WorkflowRun[] = [];

    try {
      await fs.mkdir(this.directory, { recursive: true });
      const files = await fs.readdir(this.directory);

      for (const file of files) {
        if (!file.endsWith('.json')) continue;

        const id = file.replace('.json', '');
        const run = await this.get(id);
        if (run) {
          runs.push(run);
        }
      }
    } catch {
    }

    return runs;
  }

  private applyFilters(
    runs: WorkflowRun[],
    filters?: WorkflowRunFilters
  ): WorkflowRun[] {
    if (!filters) return runs;

    let result = runs;

    if (filters.status) {
      const statuses = Array.isArray(filters.status)
        ? filters.status
        : [filters.status];
      result = result.filter((r) => statuses.includes(r.status));
    }

    if (filters.workflowName) {
      result = result.filter((r) => r.workflowName === filters.workflowName);
    }

    if (filters.tags && filters.tags.length > 0) {
      result = result.filter((r) =>
        filters.tags!.some((tag) => r.tags.includes(tag))
      );
    }

    if (filters.triggerId) {
      result = result.filter((r) => r.triggerId === filters.triggerId);
    }

    if (filters.parentRunId) {
      result = result.filter((r) => r.parentRunId === filters.parentRunId);
    }

    if (filters.startedAfter) {
      result = result.filter(
        (r) => r.startedAt && r.startedAt >= filters.startedAfter!
      );
    }
    if (filters.startedBefore) {
      result = result.filter(
        (r) => r.startedAt && r.startedAt <= filters.startedBefore!
      );
    }
    if (filters.completedAfter) {
      result = result.filter(
        (r) => r.completedAt && r.completedAt >= filters.completedAfter!
      );
    }
    if (filters.completedBefore) {
      result = result.filter(
        (r) => r.completedAt && r.completedAt <= filters.completedBefore!
      );
    }

    if (filters.hasError !== undefined) {
      result = result.filter((r) => Boolean(r.error) === filters.hasError);
    }

    const orderBy = filters.orderBy ?? 'startedAt';
    const direction = filters.orderDirection ?? 'desc';
    result.sort((a, b) => {
      const aVal = a[orderBy] ?? 0;
      const bVal = b[orderBy] ?? 0;
      return direction === 'asc'
        ? (aVal as number) - (bVal as number)
        : (bVal as number) - (aVal as number);
    });

    const offset = filters.offset ?? 0;
    const limit = filters.limit ?? Infinity;
    result = result.slice(offset, offset + limit);

    return result;
  }

  private calculateStats(runs: WorkflowRun[]): WorkflowRunStats {
    const byStatus: Record<WorkflowRunStatus, number> = {
      pending: 0,
      scheduled: 0,
      running: 0,
      paused: 0,
      waiting: 0,
      completed: 0,
      failed: 0,
      cancelled: 0,
      timeout: 0,
    };

    let totalDuration = 0;
    let durationCount = 0;
    let successCount = 0;
    let failureCount = 0;

    for (const run of runs) {
      byStatus[run.status]++;

      if (run.startedAt && run.completedAt) {
        totalDuration += run.completedAt - run.startedAt;
        durationCount++;
      }

      if (run.status === 'completed') {
        successCount++;
      } else if (run.status === 'failed' || run.status === 'timeout') {
        failureCount++;
      }
    }

    const terminalCount = successCount + failureCount;

    return {
      total: runs.length,
      byStatus,
      avgDuration: durationCount > 0 ? totalDuration / durationCount : 0,
      successRate: terminalCount > 0 ? successCount / terminalCount : 0,
      failureRate: terminalCount > 0 ? failureCount / terminalCount : 0,
    };
  }

  private isTerminal(status: WorkflowRunStatus): boolean {
    return ['completed', 'failed', 'cancelled', 'timeout'].includes(status);
  }

  /**
   * Clear cache
   */
  clearCache(): void {
    this.cache.clear();
    this.cacheExpiry.clear();
  }
}

/**
 * Create an in-memory run store
 */
export function createInMemoryRunStore(): InMemoryRunStore {
  return new InMemoryRunStore();
}

/**
 * Create a file-based run store
 */
export function createFileRunStore(options: {
  directory: string;
  cacheTTL?: number;
}): FileRunStore {
  return new FileRunStore(options);
}
