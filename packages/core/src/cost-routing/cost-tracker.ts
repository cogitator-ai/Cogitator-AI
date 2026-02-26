import type { CostRecord, CostSummary } from '@cogitator-ai/types';

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;
const MAX_RECORDS = 10_000;

export interface CostFilter {
  agentId?: string;
  runId?: string;
  since?: Date;
}

export class CostTracker {
  private records: CostRecord[] = [];
  private hourlyWindow: CostRecord[] = [];
  private dailyWindow: CostRecord[] = [];

  record(record: Omit<CostRecord, 'timestamp'>): void {
    const entry: CostRecord = { ...record, timestamp: new Date() };
    this.records.push(entry);
    if (this.records.length > MAX_RECORDS) {
      this.records.splice(0, this.records.length - MAX_RECORDS);
    }
    this.hourlyWindow.push(entry);
    this.dailyWindow.push(entry);
    this.pruneWindows();
  }

  getRunCost(runId: string): number {
    return this.records.filter((r) => r.runId === runId).reduce((sum, r) => sum + r.cost, 0);
  }

  getHourlyCost(): number {
    this.pruneWindows();
    return this.hourlyWindow.reduce((sum, r) => sum + r.cost, 0);
  }

  getDailyCost(): number {
    this.pruneWindows();
    return this.dailyWindow.reduce((sum, r) => sum + r.cost, 0);
  }

  getSummary(filter?: CostFilter): CostSummary {
    let filtered = this.records;

    if (filter?.agentId) {
      filtered = filtered.filter((r) => r.agentId === filter.agentId);
    }
    if (filter?.runId) {
      filtered = filtered.filter((r) => r.runId === filter.runId);
    }
    if (filter?.since) {
      const since = filter.since.getTime();
      filtered = filtered.filter((r) => r.timestamp.getTime() >= since);
    }

    const byModel: Record<string, number> = {};
    const byAgent: Record<string, number> = {};
    const runIds = new Set<string>();

    let totalCost = 0;
    let totalInputTokens = 0;
    let totalOutputTokens = 0;

    for (const record of filtered) {
      totalCost += record.cost;
      totalInputTokens += record.inputTokens;
      totalOutputTokens += record.outputTokens;
      runIds.add(record.runId);

      byModel[record.model] = (byModel[record.model] ?? 0) + record.cost;
      byAgent[record.agentId] = (byAgent[record.agentId] ?? 0) + record.cost;
    }

    return {
      totalCost,
      totalInputTokens,
      totalOutputTokens,
      byModel,
      byAgent,
      runCount: runIds.size,
    };
  }

  getRecords(filter?: CostFilter): CostRecord[] {
    let filtered = [...this.records];

    if (filter?.agentId) {
      filtered = filtered.filter((r) => r.agentId === filter.agentId);
    }
    if (filter?.runId) {
      filtered = filtered.filter((r) => r.runId === filter.runId);
    }
    if (filter?.since) {
      const since = filter.since.getTime();
      filtered = filtered.filter((r) => r.timestamp.getTime() >= since);
    }

    return filtered;
  }

  clear(): void {
    this.records = [];
    this.hourlyWindow = [];
    this.dailyWindow = [];
  }

  private pruneWindows(): void {
    const now = Date.now();
    this.hourlyWindow = this.hourlyWindow.filter((r) => now - r.timestamp.getTime() < HOUR_MS);
    this.dailyWindow = this.dailyWindow.filter((r) => now - r.timestamp.getTime() < DAY_MS);
  }
}
