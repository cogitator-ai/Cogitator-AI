import type {
  EvolutionCandidate,
  EvolutionStrategy as IEvolutionStrategy,
} from '@cogitator-ai/types';

export interface EvolutionStrategyOptions {
  strategy: IEvolutionStrategy;
  explorationBonus?: number;
}

export interface SelectionResult {
  candidate: EvolutionCandidate;
  score: number;
  isExploration: boolean;
  reasoning: string;
}

export class EvolutionStrategy {
  private readonly strategy: IEvolutionStrategy;
  private readonly explorationBonus: number;
  private totalSelections = 0;

  constructor(options: EvolutionStrategyOptions) {
    this.strategy = options.strategy;
    this.explorationBonus = options.explorationBonus ?? 2.0;
  }

  select(candidates: EvolutionCandidate[]): SelectionResult {
    if (candidates.length === 0) {
      throw new Error('No candidates to select from');
    }

    if (candidates.length === 1) {
      return {
        candidate: candidates[0],
        score: candidates[0].score,
        isExploration: false,
        reasoning: 'Only one candidate available',
      };
    }

    this.totalSelections++;

    switch (this.strategy.type) {
      case 'epsilon_greedy':
        return this.epsilonGreedy(candidates);
      case 'ucb':
        return this.upperConfidenceBound(candidates);
      case 'thompson_sampling':
        return this.thompsonSampling(candidates);
      default:
        return this.epsilonGreedy(candidates);
    }
  }

  private epsilonGreedy(candidates: EvolutionCandidate[]): SelectionResult {
    const epsilon = this.strategy.epsilon ?? 0.1;
    const isExploration = Math.random() < epsilon;

    if (isExploration) {
      const unexplored = candidates.filter((c) => c.evaluationCount === 0);
      if (unexplored.length > 0) {
        const candidate = unexplored[Math.floor(Math.random() * unexplored.length)];
        return {
          candidate,
          score: 0,
          isExploration: true,
          reasoning: `Epsilon-greedy exploration: selected unexplored candidate ${candidate.id}`,
        };
      }

      const candidate = candidates[Math.floor(Math.random() * candidates.length)];
      return {
        candidate,
        score: candidate.score,
        isExploration: true,
        reasoning: `Epsilon-greedy exploration: randomly selected ${candidate.id}`,
      };
    }

    const best = candidates.reduce((a, b) => (b.score > a.score ? b : a));
    return {
      candidate: best,
      score: best.score,
      isExploration: false,
      reasoning: `Epsilon-greedy exploitation: selected best scoring ${best.id} (score: ${best.score.toFixed(3)})`,
    };
  }

  private upperConfidenceBound(candidates: EvolutionCandidate[]): SelectionResult {
    const c = this.strategy.explorationConstant ?? this.explorationBonus;

    const ucbScores = candidates.map((candidate) => {
      if (candidate.evaluationCount === 0) {
        return { candidate, ucb: Infinity, isExploration: true };
      }

      const exploitation = candidate.score;
      const exploration =
        c * Math.sqrt(Math.log(this.totalSelections + 1) / candidate.evaluationCount);
      const ucb = exploitation + exploration;

      return { candidate, ucb, isExploration: exploration > exploitation };
    });

    const best = ucbScores.reduce((a, b) => (b.ucb > a.ucb ? b : a));

    return {
      candidate: best.candidate,
      score: best.ucb === Infinity ? 0 : best.ucb,
      isExploration: best.isExploration,
      reasoning:
        best.ucb === Infinity
          ? `UCB: selected unexplored candidate ${best.candidate.id}`
          : `UCB: selected ${best.candidate.id} with UCB score ${best.ucb.toFixed(3)} (base: ${best.candidate.score.toFixed(3)}, exploration bonus)`,
    };
  }

  private thompsonSampling(candidates: EvolutionCandidate[]): SelectionResult {
    const samples = candidates.map((candidate) => {
      const alpha =
        candidate.evaluationCount > 0 ? candidate.score * candidate.evaluationCount + 1 : 1;
      const beta =
        candidate.evaluationCount > 0 ? (1 - candidate.score) * candidate.evaluationCount + 1 : 1;

      const sample = this.sampleBeta(alpha, beta);

      return { candidate, sample };
    });

    const best = samples.reduce((a, b) => (b.sample > a.sample ? b : a));
    const isExploration = best.candidate.evaluationCount < 3;

    return {
      candidate: best.candidate,
      score: best.sample,
      isExploration,
      reasoning: `Thompson sampling: selected ${best.candidate.id} with sample ${best.sample.toFixed(3)} (evals: ${best.candidate.evaluationCount})`,
    };
  }

  private sampleBeta(alpha: number, beta: number): number {
    const gammaA = this.sampleGamma(alpha);
    const gammaB = this.sampleGamma(beta);
    return gammaA / (gammaA + gammaB);
  }

  private sampleGamma(shape: number): number {
    if (shape < 1) {
      return this.sampleGamma(shape + 1) * Math.pow(Math.random(), 1 / shape);
    }

    const d = shape - 1 / 3;
    const c = 1 / Math.sqrt(9 * d);

    while (true) {
      let x: number;
      let v: number;

      do {
        x = this.sampleNormal();
        v = 1 + c * x;
      } while (v <= 0);

      v = v * v * v;
      const u = Math.random();

      if (u < 1 - 0.0331 * (x * x) * (x * x)) {
        return d * v;
      }

      if (Math.log(u) < 0.5 * x * x + d * (1 - v + Math.log(v))) {
        return d * v;
      }
    }
  }

  private sampleNormal(): number {
    const u1 = Math.random() || Number.MIN_VALUE;
    const u2 = Math.random();
    return Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
  }

  updateCandidate(candidate: EvolutionCandidate, reward: number): void {
    const clampedReward = Math.max(0, Math.min(1, reward));
    const oldScore = candidate.score;
    const oldCount = candidate.evaluationCount;

    candidate.evaluationCount++;
    candidate.score = (oldScore * oldCount + clampedReward) / candidate.evaluationCount;
  }

  getExplorationRate(): number {
    if (this.totalSelections === 0) return 1;

    switch (this.strategy.type) {
      case 'epsilon_greedy':
        return this.strategy.epsilon ?? 0.1;
      case 'ucb':
        return Math.min(
          1,
          (this.strategy.explorationConstant ?? 2) / Math.sqrt(this.totalSelections)
        );
      case 'thompson_sampling':
        return 0.5;
      default:
        return 0.1;
    }
  }

  shouldExploreMore(candidates: EvolutionCandidate[]): boolean {
    const unexploredCount = candidates.filter((c) => c.evaluationCount === 0).length;
    if (unexploredCount > 0) return true;

    const avgEvaluations =
      candidates.reduce((sum, c) => sum + c.evaluationCount, 0) / candidates.length;
    if (avgEvaluations < 5) return true;

    const scores = candidates.map((c) => c.score);
    const maxScore = Math.max(...scores);
    const minScore = Math.min(...scores);
    const scoreRange = maxScore - minScore;

    if (scoreRange > 0.3) return true;

    return false;
  }

  reset(): void {
    this.totalSelections = 0;
  }
}
