import type {
  NegotiationOffer,
  NegotiationTerm,
  ConvergenceMetrics,
  MediationSuggestion,
} from '@cogitator-ai/types';

export interface ConvergenceCalculatorConfig {
  stagnationThreshold: number;
  maxRoundsWithoutProgress: number;
}

export class ConvergenceCalculator {
  private config: ConvergenceCalculatorConfig;
  private history: ConvergenceMetrics[] = [];

  constructor(config: ConvergenceCalculatorConfig) {
    this.config = config;
  }

  calculateTermConvergence(offers: NegotiationOffer[], termId: string): number {
    const termValues: unknown[] = [];

    for (const offer of offers) {
      if (offer.status !== 'pending' && offer.status !== 'accepted') continue;
      const term = offer.terms.find((t) => t.termId === termId);
      if (term) termValues.push(term.value);
    }

    if (termValues.length < 2) return 1;

    const numericValues = termValues.filter((v): v is number => typeof v === 'number');
    if (numericValues.length >= 2) {
      const min = Math.min(...numericValues);
      const max = Math.max(...numericValues);
      if (max === min) return 1;
      const range = max - min;
      const mean = numericValues.reduce((a, b) => a + b, 0) / numericValues.length;
      const variance =
        numericValues.reduce((sum, v) => sum + Math.pow(v - mean, 2), 0) / numericValues.length;
      const normalizedStdDev = Math.sqrt(variance) / range;
      return Math.max(0, 1 - normalizedStdDev * 2);
    }

    const uniqueValues = new Set(termValues.map((v) => JSON.stringify(v)));
    return 1 / uniqueValues.size;
  }

  calculateOverallConvergence(offers: NegotiationOffer[], round: number): ConvergenceMetrics {
    const recentOffers = offers.filter(
      (o) => o.round >= round - 1 && (o.status === 'pending' || o.status === 'accepted')
    );

    const allTermIds = new Set<string>();
    for (const offer of recentOffers) {
      for (const term of offer.terms) {
        allTermIds.add(term.termId);
      }
    }

    const termConvergence: Record<string, number> = {};
    let totalConvergence = 0;
    let termCount = 0;

    for (const termId of allTermIds) {
      const conv = this.calculateTermConvergence(recentOffers, termId);
      termConvergence[termId] = conv;
      totalConvergence += conv;
      termCount++;
    }

    const overallConvergence = termCount > 0 ? totalConvergence / termCount : 0;

    const positionDrift = this.calculatePositionDrift(offers, round);
    const acceptanceRate = this.calculateAcceptanceRate(offers, round);
    const roundsWithoutProgress = this.calculateRoundsWithoutProgress(overallConvergence);

    let convergenceTrend: 'improving' | 'stable' | 'declining' = 'stable';
    if (this.history.length >= 2) {
      const recent = this.history.slice(-3);
      const avgRecent = recent.reduce((s, m) => s + m.overallConvergence, 0) / recent.length;
      const diff = overallConvergence - avgRecent;
      if (diff > this.config.stagnationThreshold) {
        convergenceTrend = 'improving';
      } else if (diff < -this.config.stagnationThreshold) {
        convergenceTrend = 'declining';
      }
    }

    const estimatedRoundsToConvergence = this.estimateRoundsToConvergence(
      overallConvergence,
      convergenceTrend
    );

    const metrics: ConvergenceMetrics = {
      round,
      overallConvergence,
      termConvergence,
      positionDrift,
      acceptanceRate,
      roundsWithoutProgress,
      convergenceTrend,
      estimatedRoundsToConvergence,
      timestamp: Date.now(),
    };

    this.history.push(metrics);
    return metrics;
  }

  private calculatePositionDrift(offers: NegotiationOffer[], round: number): number {
    const prevRoundOffers = offers.filter((o) => o.round === round - 1);
    const currentRoundOffers = offers.filter((o) => o.round === round);

    if (prevRoundOffers.length === 0 || currentRoundOffers.length === 0) return 0;

    let totalDrift = 0;
    let comparisons = 0;

    for (const agent of new Set([
      ...prevRoundOffers.map((o) => o.from),
      ...currentRoundOffers.map((o) => o.from),
    ])) {
      const prevOffer = prevRoundOffers.find((o) => o.from === agent);
      const currOffer = currentRoundOffers.find((o) => o.from === agent);

      if (prevOffer && currOffer) {
        totalDrift += this.calculateOfferDifference(prevOffer, currOffer);
        comparisons++;
      }
    }

    return comparisons > 0 ? totalDrift / comparisons : 0;
  }

  private calculateOfferDifference(offer1: NegotiationOffer, offer2: NegotiationOffer): number {
    const terms1 = new Map(offer1.terms.map((t) => [t.termId, t]));
    const terms2 = new Map(offer2.terms.map((t) => [t.termId, t]));
    const allTermIds = new Set([...terms1.keys(), ...terms2.keys()]);

    let totalDiff = 0;
    let termCount = 0;

    for (const termId of allTermIds) {
      const t1 = terms1.get(termId);
      const t2 = terms2.get(termId);

      if (!t1 || !t2) {
        totalDiff += 1;
      } else if (typeof t1.value === 'number' && typeof t2.value === 'number') {
        const range = t1.range ?? { min: 0, max: 100 };
        const normalizedDiff = Math.abs(t1.value - t2.value) / (range.max - range.min || 1);
        totalDiff += Math.min(1, normalizedDiff);
      } else if (JSON.stringify(t1.value) !== JSON.stringify(t2.value)) {
        totalDiff += 1;
      }
      termCount++;
    }

    return termCount > 0 ? totalDiff / termCount : 0;
  }

  private calculateAcceptanceRate(offers: NegotiationOffer[], round: number): number {
    const roundOffers = offers.filter((o) => o.round === round);
    if (roundOffers.length === 0) return 0;

    const accepted = roundOffers.filter((o) => o.status === 'accepted').length;
    return accepted / roundOffers.length;
  }

  private calculateRoundsWithoutProgress(currentConvergence: number): number {
    let count = 0;
    for (let i = this.history.length - 1; i >= 0; i--) {
      const diff = currentConvergence - this.history[i].overallConvergence;
      if (Math.abs(diff) <= this.config.stagnationThreshold) {
        count++;
      } else {
        break;
      }
    }
    return count;
  }

  private estimateRoundsToConvergence(
    currentConvergence: number,
    trend: 'improving' | 'stable' | 'declining'
  ): number | undefined {
    if (currentConvergence >= 0.95) return 0;
    if (trend !== 'improving') return undefined;
    if (this.history.length < 2) return undefined;

    const recentHistory = this.history.slice(-5);
    let totalImprovement = 0;
    for (let i = 1; i < recentHistory.length; i++) {
      totalImprovement +=
        recentHistory[i].overallConvergence - recentHistory[i - 1].overallConvergence;
    }
    const avgImprovementPerRound = totalImprovement / (recentHistory.length - 1);

    if (avgImprovementPerRound <= 0) return undefined;

    const remaining = 0.95 - currentConvergence;
    return Math.ceil(remaining / avgImprovementPerRound);
  }

  isStagnant(): boolean {
    if (this.history.length === 0) return false;
    const latest = this.history[this.history.length - 1];
    return latest.roundsWithoutProgress >= this.config.maxRoundsWithoutProgress;
  }

  suggestCompromise(offers: NegotiationOffer[]): MediationSuggestion | null {
    const pendingOffers = offers.filter((o) => o.status === 'pending');
    if (pendingOffers.length < 2) return null;

    const termPositions = new Map<
      string,
      { values: { agent: string; value: unknown; priority: number }[]; term: NegotiationTerm }
    >();

    for (const offer of pendingOffers) {
      for (const term of offer.terms) {
        if (!term.negotiable) continue;

        if (!termPositions.has(term.termId)) {
          termPositions.set(term.termId, { values: [], term });
        }
        termPositions.get(term.termId)!.values.push({
          agent: offer.from,
          value: term.value,
          priority: term.priority,
        });
      }
    }

    const suggestedTerms: NegotiationTerm[] = [];
    const expectedImpact: MediationSuggestion['expectedImpact'] = [];

    for (const [termId, data] of termPositions) {
      const numericValues = data.values.filter(
        (v): v is { agent: string; value: number; priority: number } => typeof v.value === 'number'
      );

      if (numericValues.length >= 2) {
        const totalWeight = numericValues.reduce((s, v) => s + v.priority, 0);
        const weightedAvg = numericValues.reduce(
          (s, v) => s + (v.value * v.priority) / totalWeight,
          0
        );

        suggestedTerms.push({
          termId,
          label: data.term.label,
          value: Math.round(weightedAvg * 100) / 100,
          negotiable: false,
          priority: data.term.priority,
          range: data.term.range,
        });

        for (const v of numericValues) {
          const diff = Math.abs((v.value as number) - weightedAvg);
          const range = data.term.range ?? { min: 0, max: 100 };
          const normalizedDiff = diff / (range.max - range.min || 1);

          let existing = expectedImpact.find((i) => i.agent === v.agent);
          if (!existing) {
            existing = { agent: v.agent, gain: 0, sacrifice: 0 };
            expectedImpact.push(existing);
          }

          if ((v.value as number) > weightedAvg) {
            existing.sacrifice += normalizedDiff * v.priority;
          } else {
            existing.gain += normalizedDiff * v.priority;
          }
        }
      }
    }

    if (suggestedTerms.length === 0) return null;

    return {
      type: 'split_difference',
      description: 'Weighted average compromise based on term priorities',
      suggestedTerms,
      rationale:
        "This proposal balances positions based on each party's stated priorities, " +
        'offering a fair middle ground that respects what matters most to each side.',
      expectedImpact,
    };
  }

  getHistory(): ConvergenceMetrics[] {
    return [...this.history];
  }

  reset(): void {
    this.history = [];
  }
}
