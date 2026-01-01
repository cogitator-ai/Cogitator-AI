import type {
  ReasoningMode,
  ReasoningModeConfig,
  TaskProfile,
  MetaObservation,
} from '@cogitator-ai/types';
import { DEFAULT_MODE_PROFILES } from '@cogitator-ai/types';

export { DEFAULT_MODE_PROFILES };

export interface StrategySelectorOptions {
  allowedModes: ReasoningMode[];
  modeProfiles: Record<ReasoningMode, ReasoningModeConfig>;
}

export interface ModeScore {
  mode: ReasoningMode;
  score: number;
  reasoning: string;
}

export class StrategySelector {
  private allowedModes: ReasoningMode[];
  private modeProfiles: Record<ReasoningMode, ReasoningModeConfig>;
  private modeHistory = new Map<string, Array<{ mode: ReasoningMode; success: boolean }>>();

  constructor(options: StrategySelectorOptions) {
    this.allowedModes = options.allowedModes;
    this.modeProfiles = options.modeProfiles;
  }

  selectForTask(taskProfile: TaskProfile): ReasoningMode {
    const scores = this.scoreModesForTask(taskProfile);
    scores.sort((a, b) => b.score - a.score);
    return scores[0]?.mode ?? 'analytical';
  }

  scoreModesForTask(taskProfile: TaskProfile): ModeScore[] {
    const scores: ModeScore[] = [];

    for (const mode of this.allowedModes) {
      const score = this.calculateModeScore(mode, taskProfile);
      scores.push(score);
    }

    return scores;
  }

  private calculateModeScore(mode: ReasoningMode, profile: TaskProfile): ModeScore {
    let score = 0.5;
    const reasons: string[] = [];

    switch (mode) {
      case 'analytical':
        if (profile.requiresReasoning) {
          score += 0.2;
          reasons.push('Good for reasoning tasks');
        }
        if (profile.complexity === 'complex' || profile.complexity === 'expert') {
          score += 0.1;
          reasons.push('Handles complexity well');
        }
        break;

      case 'creative':
        if (profile.requiresCreativity) {
          score += 0.3;
          reasons.push('Best for creative tasks');
        }
        if (profile.complexity === 'simple') {
          score += 0.1;
          reasons.push('Works well for simpler tasks');
        }
        break;

      case 'systematic':
        if (profile.complexity === 'expert' || profile.complexity === 'extreme') {
          score += 0.2;
          reasons.push('Thorough for complex tasks');
        }
        if (
          !profile.timeConstraint ||
          profile.timeConstraint === 'none' ||
          profile.timeConstraint === 'relaxed'
        ) {
          score += 0.1;
          reasons.push('Has time for systematic approach');
        }
        break;

      case 'intuitive':
        if (profile.timeConstraint === 'strict') {
          score += 0.3;
          reasons.push('Fast for time-constrained tasks');
        }
        if (profile.complexity === 'simple') {
          score += 0.2;
          reasons.push('Efficient for simple tasks');
        }
        break;

      case 'reflective':
        if (profile.requiresReasoning && profile.complexity !== 'simple') {
          score += 0.15;
          reasons.push('Deep reflection for reasoning');
        }
        break;

      case 'exploratory':
        if (profile.requiresCreativity && profile.requiresReasoning) {
          score += 0.2;
          reasons.push('Explores multiple paths');
        }
        if (!profile.requiresTools) {
          score += 0.1;
          reasons.push('Good for open-ended problems');
        }
        break;
    }

    return {
      mode,
      score: Math.min(1, Math.max(0, score)),
      reasoning: reasons.join('; ') || 'Default scoring',
    };
  }

  suggestSwitch(observation: MetaObservation): ReasoningMode | null {
    const { currentMode, stagnationCount, confidenceTrend, repetitionScore } = observation;

    if (stagnationCount >= 3 || confidenceTrend === 'falling' || repetitionScore > 0.5) {
      const alternatives = this.allowedModes.filter((m) => m !== currentMode);

      if (currentMode === 'analytical' && alternatives.includes('creative')) {
        return 'creative';
      }
      if (currentMode === 'creative' && alternatives.includes('systematic')) {
        return 'systematic';
      }
      if (currentMode === 'systematic' && alternatives.includes('exploratory')) {
        return 'exploratory';
      }
      if (currentMode === 'intuitive' && alternatives.includes('analytical')) {
        return 'analytical';
      }

      return alternatives[0] ?? null;
    }

    return null;
  }

  recordModeOutcome(runId: string, mode: ReasoningMode, success: boolean): void {
    if (!this.modeHistory.has(runId)) {
      this.modeHistory.set(runId, []);
    }
    this.modeHistory.get(runId)!.push({ mode, success });
  }

  getModeConfig(mode: ReasoningMode): ReasoningModeConfig {
    return this.modeProfiles[mode];
  }

  getSuccessRate(mode: ReasoningMode): number {
    let total = 0;
    let successful = 0;

    for (const history of this.modeHistory.values()) {
      for (const entry of history) {
        if (entry.mode === mode) {
          total++;
          if (entry.success) successful++;
        }
      }
    }

    return total > 0 ? successful / total : 0.5;
  }

  cleanupRun(runId: string): void {
    this.modeHistory.delete(runId);
  }
}
