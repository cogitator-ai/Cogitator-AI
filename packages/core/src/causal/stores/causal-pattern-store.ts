import type { CausalPattern, CausalPatternStore } from '@cogitator-ai/types';

function clonePattern(pattern: CausalPattern): CausalPattern {
  return {
    ...pattern,
    pattern: {
      ...pattern.pattern,
      conditions: [...pattern.pattern.conditions],
    },
  };
}

export class InMemoryCausalPatternStore implements CausalPatternStore {
  private patterns = new Map<string, CausalPattern>();
  private agentIndex = new Map<string, Set<string>>();

  async save(pattern: CausalPattern): Promise<void> {
    this.patterns.set(pattern.id, clonePattern(pattern));

    if (!this.agentIndex.has(pattern.agentId)) {
      this.agentIndex.set(pattern.agentId, new Set());
    }
    this.agentIndex.get(pattern.agentId)!.add(pattern.id);
  }

  async findRelevant(
    agentId: string,
    context: { trigger?: string; effect?: string },
    limit: number
  ): Promise<CausalPattern[]> {
    const patternIds = this.agentIndex.get(agentId);
    if (!patternIds) return [];

    const patterns: CausalPattern[] = [];
    for (const id of patternIds) {
      const pattern = this.patterns.get(id);
      if (!pattern) continue;

      const triggerMatch =
        !context.trigger ||
        pattern.pattern.trigger.toLowerCase().includes(context.trigger.toLowerCase());
      const effectMatch =
        !context.effect ||
        pattern.pattern.effect.toLowerCase().includes(context.effect.toLowerCase());

      if (triggerMatch && effectMatch) {
        patterns.push(clonePattern(pattern));
      }
    }

    patterns.sort((a, b) => {
      const scoreA = a.occurrences * a.successRate * a.avgStrength;
      const scoreB = b.occurrences * b.successRate * b.avgStrength;
      return scoreB - scoreA;
    });

    return patterns.slice(0, limit);
  }

  async markUsed(patternId: string): Promise<void> {
    const pattern = this.patterns.get(patternId);
    if (pattern) {
      pattern.lastSeen = Date.now();
      pattern.occurrences++;
    }
  }

  async prune(agentId: string, maxAge: number, maxCount: number): Promise<number> {
    const patternIds = this.agentIndex.get(agentId);
    if (!patternIds) return 0;

    const now = Date.now();
    const toRemove: string[] = [];

    const agentPatterns: CausalPattern[] = [];
    for (const id of patternIds) {
      const pattern = this.patterns.get(id);
      if (pattern) {
        if (now - pattern.lastSeen > maxAge) {
          toRemove.push(id);
        } else {
          agentPatterns.push(pattern);
        }
      }
    }

    if (agentPatterns.length > maxCount) {
      agentPatterns.sort((a, b) => {
        const scoreA = a.occurrences * a.successRate;
        const scoreB = b.occurrences * b.successRate;
        return scoreB - scoreA;
      });

      for (let i = maxCount; i < agentPatterns.length; i++) {
        toRemove.push(agentPatterns[i].id);
      }
    }

    for (const id of toRemove) {
      this.patterns.delete(id);
      patternIds.delete(id);
    }

    return toRemove.length;
  }

  async getStats(agentId: string): Promise<{
    totalPatterns: number;
    avgSuccessRate: number;
    topPatterns: CausalPattern[];
  }> {
    const patternIds = this.agentIndex.get(agentId);
    if (!patternIds || patternIds.size === 0) {
      return { totalPatterns: 0, avgSuccessRate: 0, topPatterns: [] };
    }

    const patterns: CausalPattern[] = [];
    let totalSuccessRate = 0;

    for (const id of patternIds) {
      const pattern = this.patterns.get(id);
      if (pattern) {
        patterns.push(clonePattern(pattern));
        totalSuccessRate += pattern.successRate;
      }
    }

    patterns.sort((a, b) => {
      const scoreA = a.occurrences * a.successRate * a.avgStrength;
      const scoreB = b.occurrences * b.successRate * b.avgStrength;
      return scoreB - scoreA;
    });

    return {
      totalPatterns: patterns.length,
      avgSuccessRate: patterns.length > 0 ? totalSuccessRate / patterns.length : 0,
      topPatterns: patterns.slice(0, 5),
    };
  }

  clear(agentId?: string): void {
    if (agentId) {
      const patternIds = this.agentIndex.get(agentId);
      if (patternIds) {
        for (const id of patternIds) {
          this.patterns.delete(id);
        }
        this.agentIndex.delete(agentId);
      }
    } else {
      this.patterns.clear();
      this.agentIndex.clear();
    }
  }
}
