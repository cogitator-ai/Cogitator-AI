import type { InterventionRecord, InterventionLog } from '@cogitator-ai/types';

function cloneRecord(record: InterventionRecord): InterventionRecord {
  return {
    ...record,
    intervention: { ...record.intervention },
    observedBefore: { ...record.observedBefore },
    observedAfter: { ...record.observedAfter },
    actualEffect: { ...record.actualEffect },
    expectedEffect: {
      ...record.expectedEffect,
      effects: record.expectedEffect.effects.map((effect) => ({ ...effect })),
      sideEffects: record.expectedEffect.sideEffects.map((effect) => ({ ...effect })),
    },
  };
}

export class InMemoryInterventionLog implements InterventionLog {
  private records = new Map<string, InterventionRecord>();
  private agentIndex = new Map<string, string[]>();

  async log(record: InterventionRecord): Promise<void> {
    this.records.set(record.id, cloneRecord(record));

    if (!this.agentIndex.has(record.agentId)) {
      this.agentIndex.set(record.agentId, []);
    }
    this.agentIndex.get(record.agentId)!.push(record.id);
  }

  async getHistory(agentId: string, limit: number): Promise<InterventionRecord[]> {
    const recordIds = this.agentIndex.get(agentId);
    if (!recordIds) return [];

    const records: InterventionRecord[] = [];
    const start = Math.max(0, recordIds.length - limit);

    for (let i = recordIds.length - 1; i >= start; i--) {
      const record = this.records.get(recordIds[i]);
      if (record) {
        records.push(cloneRecord(record));
      }
    }

    return records;
  }

  async findSimilar(
    agentId: string,
    intervention: Record<string, unknown>
  ): Promise<InterventionRecord[]> {
    const recordIds = this.agentIndex.get(agentId);
    if (!recordIds) return [];

    const interventionKeys = Object.keys(intervention);
    const similar: InterventionRecord[] = [];

    for (const id of recordIds) {
      const record = this.records.get(id);
      if (!record) continue;

      const recordKeys = Object.keys(record.intervention);
      const overlap = interventionKeys.filter((k) => recordKeys.includes(k));

      if (overlap.length > 0) {
        similar.push(cloneRecord(record));
      }
    }

    similar.sort((a, b) => b.timestamp - a.timestamp);

    return similar.slice(0, 10);
  }

  async getStats(agentId: string): Promise<{
    totalInterventions: number;
    successRate: number;
    avgEffectAccuracy: number;
  }> {
    const recordIds = this.agentIndex.get(agentId);
    if (!recordIds || recordIds.length === 0) {
      return { totalInterventions: 0, successRate: 0, avgEffectAccuracy: 0 };
    }

    let successCount = 0;
    let totalAccuracy = 0;
    let accuracyCount = 0;

    for (const id of recordIds) {
      const record = this.records.get(id);
      if (!record) continue;

      if (record.success) successCount++;

      const accuracy = this.calculateEffectAccuracy(record);
      if (accuracy !== null) {
        totalAccuracy += accuracy;
        accuracyCount++;
      }
    }

    return {
      totalInterventions: recordIds.length,
      successRate: recordIds.length > 0 ? successCount / recordIds.length : 0,
      avgEffectAccuracy: accuracyCount > 0 ? totalAccuracy / accuracyCount : 0,
    };
  }

  private calculateEffectAccuracy(record: InterventionRecord): number | null {
    const expected = record.expectedEffect.effects;
    const actual = record.actualEffect;

    if (expected.length === 0) return null;

    let totalAccuracy = 0;
    let count = 0;

    for (const effect of expected) {
      const actualValue = actual[effect.variable];
      if (actualValue === undefined) continue;

      const expectedValue = effect.expectedValue;

      if (typeof expectedValue === 'boolean' && typeof actualValue === 'boolean') {
        totalAccuracy += expectedValue === actualValue ? 1 : 0;
      } else if (typeof expectedValue === 'number' && typeof actualValue === 'number') {
        const diff = Math.abs(expectedValue - actualValue);
        const maxDiff = Math.max(Math.abs(expectedValue), Math.abs(actualValue), 1);
        totalAccuracy += Math.max(0, 1 - diff / maxDiff);
      } else {
        totalAccuracy += String(expectedValue) === String(actualValue) ? 1 : 0;
      }
      count++;
    }

    return count > 0 ? totalAccuracy / count : null;
  }

  clear(agentId?: string): void {
    if (agentId) {
      const recordIds = this.agentIndex.get(agentId);
      if (recordIds) {
        for (const id of recordIds) {
          this.records.delete(id);
        }
        this.agentIndex.delete(agentId);
      }
    } else {
      this.records.clear();
      this.agentIndex.clear();
    }
  }
}
