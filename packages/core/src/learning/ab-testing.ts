import type {
  ABTest,
  ABTestStore,
  ABTestVariant,
  ABTestOutcome,
  ABTestResults,
  ABTestingConfig,
} from '@cogitator-ai/types';

export interface ABTestingFrameworkConfig extends ABTestingConfig {
  store: ABTestStore;
}

interface ResolvedABTestingConfig {
  defaultConfidenceLevel: number;
  defaultMinSampleSize: number;
  defaultMaxDuration: number;
  autoDeployWinner: boolean;
}

const DEFAULT_CONFIG: ResolvedABTestingConfig = {
  defaultConfidenceLevel: 0.95,
  defaultMinSampleSize: 50,
  defaultMaxDuration: 7 * 24 * 60 * 60 * 1000,
  autoDeployWinner: false,
};

export class ABTestingFramework {
  private store: ABTestStore;
  private config: ResolvedABTestingConfig;
  private activeTests = new Map<string, ABTest>();

  constructor(config: ABTestingFrameworkConfig) {
    this.store = config.store;
    this.config = {
      defaultConfidenceLevel:
        config.defaultConfidenceLevel ?? DEFAULT_CONFIG.defaultConfidenceLevel,
      defaultMinSampleSize: config.defaultMinSampleSize ?? DEFAULT_CONFIG.defaultMinSampleSize,
      defaultMaxDuration: config.defaultMaxDuration ?? DEFAULT_CONFIG.defaultMaxDuration,
      autoDeployWinner: config.autoDeployWinner ?? DEFAULT_CONFIG.autoDeployWinner,
    };
  }

  async createTest(params: {
    agentId: string;
    name: string;
    description?: string;
    controlInstructions: string;
    treatmentInstructions: string;
    treatmentAllocation?: number;
    minSampleSize?: number;
    maxDuration?: number;
    confidenceLevel?: number;
    metricToOptimize?: string;
  }): Promise<ABTest> {
    const test = await this.store.create({
      agentId: params.agentId,
      name: params.name,
      description: params.description,
      status: 'draft',
      controlInstructions: params.controlInstructions,
      treatmentInstructions: params.treatmentInstructions,
      treatmentAllocation: params.treatmentAllocation ?? 0.5,
      minSampleSize: params.minSampleSize ?? this.config.defaultMinSampleSize,
      maxDuration: params.maxDuration ?? this.config.defaultMaxDuration,
      confidenceLevel: params.confidenceLevel ?? this.config.defaultConfidenceLevel,
      metricToOptimize: params.metricToOptimize ?? 'score',
      controlResults: this.emptyResults(),
      treatmentResults: this.emptyResults(),
    });

    return test;
  }

  async startTest(testId: string): Promise<ABTest> {
    const test = await this.store.update(testId, {
      status: 'running',
      startedAt: new Date(),
    });

    this.activeTests.set(test.agentId, test);
    return test;
  }

  async pauseTest(testId: string): Promise<ABTest> {
    const test = await this.store.update(testId, {
      status: 'paused',
    });

    this.activeTests.delete(test.agentId);
    return test;
  }

  async resumeTest(testId: string): Promise<ABTest> {
    const test = await this.store.update(testId, {
      status: 'running',
    });

    this.activeTests.set(test.agentId, test);
    return test;
  }

  async completeTest(testId: string): Promise<{ test: ABTest; outcome: ABTestOutcome }> {
    const test = await this.store.update(testId, {
      status: 'completed',
      completedAt: new Date(),
    });

    this.activeTests.delete(test.agentId);

    const outcome = this.analyzeResults(test);

    return { test, outcome };
  }

  async cancelTest(testId: string): Promise<ABTest> {
    const test = await this.store.update(testId, {
      status: 'cancelled',
      completedAt: new Date(),
    });

    this.activeTests.delete(test.agentId);
    return test;
  }

  async getActiveTest(agentId: string): Promise<ABTest | null> {
    const cached = this.activeTests.get(agentId);
    if (cached) {
      return cached;
    }

    const test = await this.store.getActive(agentId);
    if (test) {
      this.activeTests.set(agentId, test);
    }
    return test;
  }

  async getTest(testId: string): Promise<ABTest | null> {
    return this.store.get(testId);
  }

  selectVariant(test: ABTest): ABTestVariant {
    return Math.random() < test.treatmentAllocation ? 'treatment' : 'control';
  }

  getInstructionsForVariant(test: ABTest, variant: ABTestVariant): string {
    return variant === 'treatment' ? test.treatmentInstructions : test.controlInstructions;
  }

  async recordResult(
    testId: string,
    variant: ABTestVariant,
    score: number,
    latency: number,
    cost: number
  ): Promise<void> {
    await this.store.recordResult(testId, variant, score, latency, cost);

    const test = await this.store.get(testId);
    if (test?.agentId) {
      this.activeTests.set(test.agentId, test);
    }
  }

  async checkAndCompleteIfReady(testId: string): Promise<ABTestOutcome | null> {
    const test = await this.store.get(testId);
    if (test?.status !== 'running') {
      return null;
    }

    const totalSamples = test.controlResults.sampleSize + test.treatmentResults.sampleSize;
    const minSamplesReached = totalSamples >= test.minSampleSize * 2;

    const elapsed = test.startedAt ? Date.now() - test.startedAt.getTime() : 0;
    const maxDurationReached = elapsed >= test.maxDuration;

    if (minSamplesReached || maxDurationReached) {
      const outcome = this.analyzeResults(test);

      if (outcome.isSignificant || maxDurationReached) {
        await this.store.update(testId, {
          status: 'completed',
          completedAt: new Date(),
        });
        this.activeTests.delete(test.agentId);
        return outcome;
      }
    }

    return null;
  }

  analyzeResults(test: ABTest): ABTestOutcome {
    const control = test.controlResults;
    const treatment = test.treatmentResults;

    if (control.sampleSize < 2 || treatment.sampleSize < 2) {
      return {
        winner: null,
        pValue: 1,
        confidenceInterval: [0, 0],
        effectSize: 0,
        isSignificant: false,
        recommendation: 'Insufficient sample size for statistical analysis',
      };
    }

    const controlMean = control.avgScore;
    const treatmentMean = treatment.avgScore;
    const controlStd = this.calculateStd(control.scores, controlMean);
    const treatmentStd = this.calculateStd(treatment.scores, treatmentMean);

    const { tStatistic, degreesOfFreedom } = this.welchTTest(
      controlMean,
      treatmentMean,
      controlStd,
      treatmentStd,
      control.sampleSize,
      treatment.sampleSize
    );

    const pValue = this.tDistributionPValue(Math.abs(tStatistic), degreesOfFreedom);

    const pooledStd = Math.sqrt(
      ((control.sampleSize - 1) * controlStd ** 2 +
        (treatment.sampleSize - 1) * treatmentStd ** 2) /
        (control.sampleSize + treatment.sampleSize - 2)
    );
    const effectSize = pooledStd > 0 ? (treatmentMean - controlMean) / pooledStd : 0;

    const seDiff = Math.sqrt(
      controlStd ** 2 / control.sampleSize + treatmentStd ** 2 / treatment.sampleSize
    );
    const tCritical = this.tCriticalValue(test.confidenceLevel, degreesOfFreedom);
    const meanDiff = treatmentMean - controlMean;
    const confidenceInterval: [number, number] = [
      meanDiff - tCritical * seDiff,
      meanDiff + tCritical * seDiff,
    ];

    const alpha = 1 - test.confidenceLevel;
    const isSignificant = pValue < alpha;

    let winner: ABTestVariant | null = null;
    let recommendation: string;

    if (!isSignificant) {
      recommendation = `No statistically significant difference detected (p=${pValue.toFixed(4)}). Consider collecting more data or accepting null hypothesis.`;
    } else if (treatmentMean > controlMean) {
      winner = 'treatment';
      recommendation = `Treatment performs significantly better (p=${pValue.toFixed(4)}, effect size=${effectSize.toFixed(3)}). Recommend deploying treatment variant.`;
    } else {
      winner = 'control';
      recommendation = `Control performs significantly better (p=${pValue.toFixed(4)}, effect size=${Math.abs(effectSize).toFixed(3)}). Recommend keeping control variant.`;
    }

    return {
      winner,
      pValue,
      confidenceInterval,
      effectSize,
      isSignificant,
      recommendation,
    };
  }

  private emptyResults(): ABTestResults {
    return {
      sampleSize: 0,
      successRate: 0,
      avgScore: 0,
      avgLatency: 0,
      totalCost: 0,
      scores: [],
    };
  }

  private calculateStd(values: number[], mean: number): number {
    if (values.length < 2) return 0;
    const squaredDiffs = values.map((v) => (v - mean) ** 2);
    const variance = squaredDiffs.reduce((a, b) => a + b, 0) / (values.length - 1);
    return Math.sqrt(variance);
  }

  private welchTTest(
    mean1: number,
    mean2: number,
    std1: number,
    std2: number,
    n1: number,
    n2: number
  ): { tStatistic: number; degreesOfFreedom: number } {
    const se1 = std1 ** 2 / n1;
    const se2 = std2 ** 2 / n2;
    const seDiff = Math.sqrt(se1 + se2);

    const tStatistic = seDiff > 0 ? (mean1 - mean2) / seDiff : 0;

    const numerator = (se1 + se2) ** 2;
    const denominator = se1 ** 2 / (n1 - 1) + se2 ** 2 / (n2 - 1);
    const degreesOfFreedom = denominator > 0 ? numerator / denominator : 1;

    return { tStatistic, degreesOfFreedom };
  }

  private tDistributionPValue(tStatistic: number, df: number): number {
    const x = df / (df + tStatistic ** 2);
    const beta = this.incompleteBeta(x, df / 2, 0.5);
    return beta;
  }

  private incompleteBeta(x: number, a: number, b: number): number {
    if (x === 0) return 0;
    if (x === 1) return 1;

    const maxIterations = 200;
    const epsilon = 1e-10;

    let sum = 0;
    let term = 1;

    for (let n = 0; n < maxIterations; n++) {
      const coeff = this.gamma(a + b + n) / (this.gamma(a + 1 + n) * this.gamma(b));
      term = coeff * Math.pow(x, a + n) * Math.pow(1 - x, b - 1);

      if (n > 0 && Math.abs(term) < epsilon) break;
      sum += term;
    }

    return (sum * this.gamma(a + b)) / (this.gamma(a) * this.gamma(b));
  }

  private gamma(z: number): number {
    if (z < 0.5) {
      return Math.PI / (Math.sin(Math.PI * z) * this.gamma(1 - z));
    }

    z -= 1;
    const g = 7;
    const c = [
      0.99999999999980993, 676.5203681218851, -1259.1392167224028, 771.32342877765313,
      -176.61502916214059, 12.507343278686905, -0.13857109526572012, 9.9843695780195716e-6,
      1.5056327351493116e-7,
    ];

    let x = c[0];
    for (let i = 1; i < g + 2; i++) {
      x += c[i] / (z + i);
    }

    const t = z + g + 0.5;
    return Math.sqrt(2 * Math.PI) * Math.pow(t, z + 0.5) * Math.exp(-t) * x;
  }

  private tCriticalValue(confidenceLevel: number, df: number): number {
    const alpha = 1 - confidenceLevel;
    const p = 1 - alpha / 2;

    let low = 0;
    let high = 10;

    while (high - low > 0.0001) {
      const mid = (low + high) / 2;
      const cdf = this.tCDF(mid, df);
      if (cdf < p) {
        low = mid;
      } else {
        high = mid;
      }
    }

    return (low + high) / 2;
  }

  private tCDF(t: number, df: number): number {
    const x = df / (df + t ** 2);
    const beta = this.incompleteBeta(x, df / 2, 0.5);
    return t >= 0 ? 1 - beta / 2 : beta / 2;
  }
}
