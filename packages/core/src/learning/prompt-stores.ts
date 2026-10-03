import type {
  ABTest,
  ABTestResults,
  ABTestStatus,
  ABTestStore,
  ABTestVariant,
  InstructionVersion,
  InstructionVersionMetrics,
  InstructionVersionStore,
} from '@cogitator-ai/types';
import { nanoid } from 'nanoid';

/** Instruction versions in process memory. */
export class InMemoryInstructionVersionStore implements InstructionVersionStore {
  private readonly versions = new Map<string, InstructionVersion>();

  async save(version: Omit<InstructionVersion, 'id'>): Promise<InstructionVersion> {
    const saved: InstructionVersion = { ...structuredClone(version), id: `iv_${nanoid(12)}` };
    this.versions.set(saved.id, saved);
    return structuredClone(saved);
  }

  async get(id: string): Promise<InstructionVersion | null> {
    const version = this.versions.get(id);
    return version ? structuredClone(version) : null;
  }

  async getCurrent(agentId: string): Promise<InstructionVersion | null> {
    const current = this.ofAgent(agentId).find((version) => !version.retiredAt);
    return current ? structuredClone(current) : null;
  }

  async getHistory(agentId: string, limit = 10): Promise<InstructionVersion[]> {
    return this.ofAgent(agentId)
      .slice(0, limit)
      .map((version) => structuredClone(version));
  }

  async retire(id: string): Promise<void> {
    const version = this.versions.get(id);
    if (version && !version.retiredAt) version.retiredAt = new Date();
  }

  async updateMetrics(id: string, metrics: Partial<InstructionVersionMetrics>): Promise<void> {
    const version = this.versions.get(id);
    if (version) version.metrics = { ...version.metrics, ...metrics };
  }

  private ofAgent(agentId: string): InstructionVersion[] {
    return [...this.versions.values()]
      .filter((version) => version.agentId === agentId)
      .sort((a, b) => b.version - a.version);
  }
}

/** A/B tests in process memory. */
export class InMemoryABTestStore implements ABTestStore {
  private readonly tests = new Map<string, ABTest>();

  async create(test: Omit<ABTest, 'id' | 'createdAt'>): Promise<ABTest> {
    const created: ABTest = {
      ...structuredClone(test),
      id: `ab_${nanoid(12)}`,
      createdAt: new Date(),
    };
    this.tests.set(created.id, created);
    return structuredClone(created);
  }

  async get(id: string): Promise<ABTest | null> {
    const test = this.tests.get(id);
    return test ? structuredClone(test) : null;
  }

  async getActive(agentId: string): Promise<ABTest | null> {
    const active = [...this.tests.values()].find(
      (test) => test.agentId === agentId && test.status === 'running'
    );
    return active ? structuredClone(active) : null;
  }

  async update(id: string, updates: Partial<ABTest>): Promise<ABTest> {
    const test = this.tests.get(id);
    if (!test) throw new Error(`A/B test ${id} not found`);
    const updated: ABTest = { ...test, ...structuredClone(updates), id: test.id };
    this.tests.set(id, updated);
    return structuredClone(updated);
  }

  async recordResult(
    testId: string,
    variant: ABTestVariant,
    score: number,
    latency: number,
    cost: number
  ): Promise<void> {
    const test = this.tests.get(testId);
    if (!test) return;
    const key = variant === 'control' ? 'controlResults' : 'treatmentResults';
    test[key] = addResult(test[key], score, latency, cost);
  }

  async list(agentId?: string, status?: ABTestStatus): Promise<ABTest[]> {
    return [...this.tests.values()]
      .filter(
        (test) =>
          (agentId === undefined || test.agentId === agentId) &&
          (status === undefined || test.status === status)
      )
      .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())
      .map((test) => structuredClone(test));
  }

  async delete(id: string): Promise<boolean> {
    return this.tests.delete(id);
  }
}

/** One more result in a variant's running aggregates; a score of 0.5 or more counts as a success. */
export function addResult(
  results: ABTestResults,
  score: number,
  latency: number,
  cost: number
): ABTestResults {
  const n = results.sampleSize;
  return {
    sampleSize: n + 1,
    successRate: (results.successRate * n + (score >= 0.5 ? 1 : 0)) / (n + 1),
    avgScore: (results.avgScore * n + score) / (n + 1),
    avgLatency: (results.avgLatency * n + latency) / (n + 1),
    totalCost: results.totalCost + cost,
    scores: [...results.scores, score],
  };
}
