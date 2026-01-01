import type { MetaObservation, ReasoningMode, Insight } from '@cogitator-ai/types';

export interface ActionRecord {
  type: string;
  toolName?: string;
  input?: unknown;
  output?: unknown;
  error?: string;
  duration?: number;
  timestamp: number;
}

export interface ObservationContext {
  runId: string;
  iteration: number;
  goal: string;
  currentMode: ReasoningMode;
  tokensUsed: number;
  timeElapsed: number;
  iterationsRemaining: number;
  budgetRemaining: number;
}

export class ObservationCollector {
  private observations = new Map<string, MetaObservation[]>();
  private actionHistory = new Map<string, ActionRecord[]>();
  private confidenceHistory = new Map<string, number[]>();

  initializeRun(runId: string): void {
    this.observations.set(runId, []);
    this.actionHistory.set(runId, []);
    this.confidenceHistory.set(runId, []);
  }

  recordAction(runId: string, action: ActionRecord): void {
    const history = this.actionHistory.get(runId);
    if (history) {
      history.push(action);
      if (history.length > 100) {
        history.shift();
      }
    }
  }

  recordConfidence(runId: string, confidence: number): void {
    const history = this.confidenceHistory.get(runId);
    if (history) {
      history.push(confidence);
      if (history.length > 20) {
        history.shift();
      }
    }
  }

  collect(context: ObservationContext, insights: Insight[]): MetaObservation {
    const { runId, iteration, goal, currentMode } = context;
    const prevObservations = this.observations.get(runId) ?? [];
    const lastObs = prevObservations[prevObservations.length - 1];
    const actions = this.actionHistory.get(runId) ?? [];
    const confidenceHist = this.confidenceHistory.get(runId) ?? [];

    const currentConfidence = confidenceHist[confidenceHist.length - 1] ?? 0.5;
    const progressScore = this.calculateProgress(actions);
    const progressDelta = lastObs ? progressScore - lastObs.progressScore : 0;
    const stagnationCount = progressDelta < 0.05 ? (lastObs?.stagnationCount ?? 0) + 1 : 0;
    const repetitionScore = this.calculateRepetition(actions);
    const toolSuccessRate = this.calculateToolSuccessRate(actions);
    const confidenceTrend = this.calculateTrend(confidenceHist);

    const observation: MetaObservation = {
      runId,
      iteration,
      timestamp: Date.now(),
      progressScore,
      progressDelta,
      stagnationCount,
      currentConfidence,
      confidenceTrend,
      confidenceHistory: confidenceHist.slice(-10),
      tokensUsed: context.tokensUsed,
      timeElapsed: context.timeElapsed,
      iterationsRemaining: context.iterationsRemaining,
      budgetRemaining: context.budgetRemaining,
      toolSuccessRate,
      errorRate: 1 - toolSuccessRate,
      repetitionScore,
      currentMode,
      recentActions: actions.slice(-5).map((a) => ({
        type: a.type,
        toolName: a.toolName,
        input: a.input,
        output: a.output,
        error: a.error,
      })),
      recentInsights: insights.slice(-3),
      goal,
    };

    prevObservations.push(observation);
    return observation;
  }

  private calculateProgress(actions: ActionRecord[]): number {
    if (actions.length === 0) return 0;
    const successful = actions.filter((a) => !a.error).length;
    return successful / actions.length;
  }

  private calculateRepetition(actions: ActionRecord[]): number {
    if (actions.length < 2) return 0;
    const toolCalls = actions
      .filter((a) => a.type === 'tool_call' && a.toolName)
      .map((a) => `${a.toolName}:${JSON.stringify(a.input)}`);

    if (toolCalls.length === 0) return 0;
    const unique = new Set(toolCalls);
    return 1 - unique.size / toolCalls.length;
  }

  private calculateToolSuccessRate(actions: ActionRecord[]): number {
    const toolCalls = actions.filter((a) => a.type === 'tool_call');
    if (toolCalls.length === 0) return 1;
    const successful = toolCalls.filter((a) => !a.error).length;
    return successful / toolCalls.length;
  }

  private calculateTrend(values: number[]): 'rising' | 'stable' | 'falling' {
    if (values.length < 3) return 'stable';
    const recent = values.slice(-3);
    const avg = recent.reduce((a, b) => a + b, 0) / recent.length;
    const first = recent[0];

    if (avg > first + 0.1) return 'rising';
    if (avg < first - 0.1) return 'falling';
    return 'stable';
  }

  getObservations(runId: string): MetaObservation[] {
    return this.observations.get(runId) ?? [];
  }

  getLatestObservation(runId: string): MetaObservation | null {
    const obs = this.observations.get(runId);
    return obs?.[obs.length - 1] ?? null;
  }

  cleanupRun(runId: string): void {
    this.observations.delete(runId);
    this.actionHistory.delete(runId);
    this.confidenceHistory.delete(runId);
  }
}
