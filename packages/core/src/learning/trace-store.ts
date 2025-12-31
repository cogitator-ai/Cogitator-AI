import type {
  ExecutionTrace,
  TraceStore,
  TraceQuery,
  TraceStoreStats,
} from '@cogitator-ai/types';

export class InMemoryTraceStore implements TraceStore {
  private traces = new Map<string, ExecutionTrace>();
  private agentIndex = new Map<string, Set<string>>();
  private demoIndex = new Map<string, Set<string>>();
  private runIdIndex = new Map<string, string>();

  async store(trace: ExecutionTrace): Promise<void> {
    this.traces.set(trace.id, trace);
    this.runIdIndex.set(trace.runId, trace.id);

    let agentTraces = this.agentIndex.get(trace.agentId);
    if (!agentTraces) {
      agentTraces = new Set();
      this.agentIndex.set(trace.agentId, agentTraces);
    }
    agentTraces.add(trace.id);

    if (trace.isDemo) {
      let agentDemos = this.demoIndex.get(trace.agentId);
      if (!agentDemos) {
        agentDemos = new Set();
        this.demoIndex.set(trace.agentId, agentDemos);
      }
      agentDemos.add(trace.id);
    }
  }

  async storeMany(traces: ExecutionTrace[]): Promise<void> {
    for (const trace of traces) {
      await this.store(trace);
    }
  }

  async get(id: string): Promise<ExecutionTrace | null> {
    return this.traces.get(id) ?? null;
  }

  async getByRunId(runId: string): Promise<ExecutionTrace | null> {
    const traceId = this.runIdIndex.get(runId);
    if (!traceId) return null;
    return this.traces.get(traceId) ?? null;
  }

  async query(query: TraceQuery): Promise<ExecutionTrace[]> {
    let candidates: ExecutionTrace[] = [];

    if (query.agentId) {
      const agentTraces = this.agentIndex.get(query.agentId);
      if (!agentTraces) return [];
      for (const id of agentTraces) {
        const trace = this.traces.get(id);
        if (trace) candidates.push(trace);
      }
    } else {
      candidates = Array.from(this.traces.values());
    }

    if (query.isDemo !== undefined) {
      candidates = candidates.filter(t => t.isDemo === query.isDemo);
    }

    if (query.minScore !== undefined) {
      candidates = candidates.filter(t => t.score >= query.minScore!);
    }

    if (query.labels && query.labels.length > 0) {
      candidates = candidates.filter(t =>
        query.labels!.some(label => t.labels?.includes(label))
      );
    }

    if (query.fromDate) {
      candidates = candidates.filter(t => t.createdAt >= query.fromDate!);
    }

    if (query.toDate) {
      candidates = candidates.filter(t => t.createdAt <= query.toDate!);
    }

    candidates.sort((a, b) => b.score - a.score);

    if (query.limit) {
      candidates = candidates.slice(0, query.limit);
    }

    return candidates;
  }

  async getAll(agentId: string): Promise<ExecutionTrace[]> {
    const agentTraces = this.agentIndex.get(agentId);
    if (!agentTraces) return [];

    const result: ExecutionTrace[] = [];
    for (const id of agentTraces) {
      const trace = this.traces.get(id);
      if (trace) result.push(trace);
    }

    result.sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
    return result;
  }

  async getDemos(agentId: string, limit = 10): Promise<ExecutionTrace[]> {
    const agentDemos = this.demoIndex.get(agentId);
    if (!agentDemos) return [];

    const demos: ExecutionTrace[] = [];
    for (const id of agentDemos) {
      const trace = this.traces.get(id);
      if (trace) demos.push(trace);
    }

    demos.sort((a, b) => b.score - a.score);
    return demos.slice(0, limit);
  }

  async markAsDemo(id: string): Promise<void> {
    const trace = this.traces.get(id);
    if (!trace) return;

    trace.isDemo = true;

    let agentDemos = this.demoIndex.get(trace.agentId);
    if (!agentDemos) {
      agentDemos = new Set();
      this.demoIndex.set(trace.agentId, agentDemos);
    }
    agentDemos.add(id);
  }

  async unmarkAsDemo(id: string): Promise<void> {
    const trace = this.traces.get(id);
    if (!trace) return;

    trace.isDemo = false;
    this.demoIndex.get(trace.agentId)?.delete(id);
  }

  async delete(id: string): Promise<boolean> {
    const trace = this.traces.get(id);
    if (!trace) return false;

    this.traces.delete(id);
    this.runIdIndex.delete(trace.runId);
    this.agentIndex.get(trace.agentId)?.delete(id);
    this.demoIndex.get(trace.agentId)?.delete(id);
    return true;
  }

  async prune(agentId: string, maxTraces: number): Promise<number> {
    const agentTraces = this.agentIndex.get(agentId);
    if (!agentTraces || agentTraces.size <= maxTraces) return 0;

    const traces: ExecutionTrace[] = [];
    for (const id of agentTraces) {
      const trace = this.traces.get(id);
      if (trace) traces.push(trace);
    }

    traces.sort((a, b) => {
      if (a.isDemo && !b.isDemo) return -1;
      if (!a.isDemo && b.isDemo) return 1;

      const scoreA = a.score * 0.6 +
        (Date.now() - a.createdAt.getTime()) / (1000 * 60 * 60 * 24) * -0.01;
      const scoreB = b.score * 0.6 +
        (Date.now() - b.createdAt.getTime()) / (1000 * 60 * 60 * 24) * -0.01;
      return scoreB - scoreA;
    });

    const toRemove = traces.slice(maxTraces);
    for (const trace of toRemove) {
      await this.delete(trace.id);
    }

    return toRemove.length;
  }

  async clear(agentId: string): Promise<void> {
    const agentTraces = this.agentIndex.get(agentId);
    if (!agentTraces) return;

    for (const id of agentTraces) {
      const trace = this.traces.get(id);
      if (trace) {
        this.traces.delete(id);
        this.runIdIndex.delete(trace.runId);
      }
    }

    this.agentIndex.delete(agentId);
    this.demoIndex.delete(agentId);
  }

  async getStats(agentId: string): Promise<TraceStoreStats> {
    const agentTraces = this.agentIndex.get(agentId);
    const agentDemos = this.demoIndex.get(agentId);

    if (!agentTraces || agentTraces.size === 0) {
      return {
        totalTraces: 0,
        demoCount: 0,
        averageScore: 0,
        scoreDistribution: [],
        topPerformers: [],
      };
    }

    const traces: ExecutionTrace[] = [];
    for (const id of agentTraces) {
      const trace = this.traces.get(id);
      if (trace) traces.push(trace);
    }

    const totalScore = traces.reduce((sum, t) => sum + t.score, 0);
    const averageScore = totalScore / traces.length;

    const buckets = new Map<string, number>();
    for (const trace of traces) {
      const bucket = `${Math.floor(trace.score * 10) / 10}-${Math.ceil(trace.score * 10) / 10}`;
      buckets.set(bucket, (buckets.get(bucket) ?? 0) + 1);
    }

    const scoreDistribution = Array.from(buckets.entries())
      .map(([bucket, count]) => ({ bucket, count }))
      .sort((a, b) => b.bucket.localeCompare(a.bucket));

    traces.sort((a, b) => b.score - a.score);
    const topPerformers = traces.slice(0, 5).map(t => t.id);

    return {
      totalTraces: traces.length,
      demoCount: agentDemos?.size ?? 0,
      averageScore,
      scoreDistribution,
      topPerformers,
    };
  }

  getGlobalStats(): { totalTraces: number; agentCount: number; demoCount: number } {
    let demoCount = 0;
    for (const demos of this.demoIndex.values()) {
      demoCount += demos.size;
    }

    return {
      totalTraces: this.traces.size,
      agentCount: this.agentIndex.size,
      demoCount,
    };
  }
}
