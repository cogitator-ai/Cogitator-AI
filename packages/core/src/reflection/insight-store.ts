import type { Insight, InsightStore, InsightType } from '@cogitator-ai/types';

export class InMemoryInsightStore implements InsightStore {
  private insights = new Map<string, Insight>();
  private agentIndex = new Map<string, Set<string>>();

  async store(insight: Insight): Promise<void> {
    this.insights.set(insight.id, insight);

    let agentInsights = this.agentIndex.get(insight.agentId);
    if (!agentInsights) {
      agentInsights = new Set();
      this.agentIndex.set(insight.agentId, agentInsights);
    }
    agentInsights.add(insight.id);
  }

  async storeMany(insights: Insight[]): Promise<void> {
    for (const insight of insights) {
      await this.store(insight);
    }
  }

  async findRelevant(agentId: string, context: string, limit = 5): Promise<Insight[]> {
    const agentInsights = this.agentIndex.get(agentId);
    if (!agentInsights) return [];

    const contextLower = context.toLowerCase();
    const contextWords = new Set(contextLower.split(/\s+/).filter(w => w.length > 3));

    const scored: Array<{ insight: Insight; score: number }> = [];

    for (const id of agentInsights) {
      const insight = this.insights.get(id);
      if (!insight) continue;

      let score = 0;

      const insightText = `${insight.content} ${insight.context}`.toLowerCase();
      for (const word of contextWords) {
        if (insightText.includes(word)) {
          score += 1;
        }
      }

      score += insight.confidence * 0.5;
      score += Math.min(insight.usageCount * 0.1, 1);

      const ageMs = Date.now() - insight.lastUsedAt.getTime();
      const ageDays = ageMs / (1000 * 60 * 60 * 24);
      score -= Math.min(ageDays * 0.01, 0.5);

      const typeBoost: Record<InsightType, number> = {
        pattern: 0.3,
        success: 0.2,
        tip: 0.2,
        mistake: 0.4,
        warning: 0.4,
      };
      score += typeBoost[insight.type] ?? 0;

      if (score > 0) {
        scored.push({ insight, score });
      }
    }

    scored.sort((a, b) => b.score - a.score);

    return scored.slice(0, limit).map(s => s.insight);
  }

  async getAll(agentId: string): Promise<Insight[]> {
    const agentInsights = this.agentIndex.get(agentId);
    if (!agentInsights) return [];

    const result: Insight[] = [];
    for (const id of agentInsights) {
      const insight = this.insights.get(id);
      if (insight) result.push(insight);
    }

    result.sort((a, b) => b.lastUsedAt.getTime() - a.lastUsedAt.getTime());
    return result;
  }

  async getById(id: string): Promise<Insight | null> {
    return this.insights.get(id) ?? null;
  }

  async markUsed(id: string): Promise<void> {
    const insight = this.insights.get(id);
    if (insight) {
      insight.usageCount += 1;
      insight.lastUsedAt = new Date();
    }
  }

  async prune(agentId: string, maxInsights: number): Promise<number> {
    const agentInsights = this.agentIndex.get(agentId);
    if (!agentInsights || agentInsights.size <= maxInsights) return 0;

    const insights: Insight[] = [];
    for (const id of agentInsights) {
      const insight = this.insights.get(id);
      if (insight) insights.push(insight);
    }

    insights.sort((a, b) => {
      const scoreA = a.usageCount * 0.5 + a.confidence * 0.3 +
        (Date.now() - a.lastUsedAt.getTime()) / (1000 * 60 * 60 * 24) * -0.2;
      const scoreB = b.usageCount * 0.5 + b.confidence * 0.3 +
        (Date.now() - b.lastUsedAt.getTime()) / (1000 * 60 * 60 * 24) * -0.2;
      return scoreB - scoreA;
    });

    const toRemove = insights.slice(maxInsights);
    for (const insight of toRemove) {
      this.insights.delete(insight.id);
      agentInsights.delete(insight.id);
    }

    return toRemove.length;
  }

  async delete(id: string): Promise<boolean> {
    const insight = this.insights.get(id);
    if (!insight) return false;

    this.insights.delete(id);
    this.agentIndex.get(insight.agentId)?.delete(id);
    return true;
  }

  async clear(agentId: string): Promise<void> {
    const agentInsights = this.agentIndex.get(agentId);
    if (!agentInsights) return;

    for (const id of agentInsights) {
      this.insights.delete(id);
    }
    this.agentIndex.delete(agentId);
  }

  getStats(): { totalInsights: number; agentCount: number } {
    return {
      totalInsights: this.insights.size,
      agentCount: this.agentIndex.size,
    };
  }
}
