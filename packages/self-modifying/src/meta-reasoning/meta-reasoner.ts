import { nanoid } from 'nanoid';
import type {
  MetaReasoningConfig,
  MetaObservation,
  MetaAssessment,
  MetaAdaptation,
  MetaRecommendation,
  MetaTrigger,
  ReasoningMode,
  ReasoningModeConfig,
  Insight,
  LLMBackend,
  MetaIssue,
  MetaOpportunity,
} from '@cogitator-ai/types';
import { DEFAULT_META_REASONING_CONFIG } from '@cogitator-ai/types';
import {
  ObservationCollector,
  type ActionRecord,
  type ObservationContext,
} from './observation-collector';
import { StrategySelector } from './strategy-selector';
import {
  buildMetaAssessmentPrompt,
  parseMetaAssessmentResponse,
  META_REASONING_SYSTEM_PROMPT,
} from './prompts';

export { DEFAULT_META_REASONING_CONFIG };

export interface MetaReasonerOptions {
  llm: LLMBackend;
  model: string;
  config?: Partial<MetaReasoningConfig>;
}

export class MetaReasoner {
  private llm: LLMBackend;
  private model: string;
  private config: MetaReasoningConfig;
  private collector: ObservationCollector;
  private selector: StrategySelector;

  private assessments = new Map<string, MetaAssessment[]>();
  private adaptations = new Map<string, MetaAdaptation[]>();
  private currentMode = new Map<string, ReasoningMode>();

  private lastAssessmentTime = new Map<string, number>();
  private lastAdaptationTime = new Map<string, number>();

  constructor(options: MetaReasonerOptions) {
    this.llm = options.llm;
    this.model = options.model;
    this.config = { ...DEFAULT_META_REASONING_CONFIG, ...options.config } as MetaReasoningConfig;

    this.collector = new ObservationCollector();
    this.selector = new StrategySelector({
      allowedModes: this.config.allowedModes,
      modeProfiles: this.config.modeProfiles,
    });
  }

  initializeRun(runId: string): ReasoningModeConfig {
    this.collector.initializeRun(runId);
    this.assessments.set(runId, []);
    this.adaptations.set(runId, []);
    this.currentMode.set(runId, this.config.defaultMode);

    return this.getModeConfig(this.config.defaultMode);
  }

  recordAction(runId: string, action: ActionRecord): void {
    this.collector.recordAction(runId, action);
  }

  recordConfidence(runId: string, confidence: number): void {
    this.collector.recordConfidence(runId, confidence);
  }

  shouldTrigger(
    runId: string,
    trigger: MetaTrigger,
    context: {
      iteration: number;
      confidence: number;
      progressDelta: number;
      stagnationCount: number;
    }
  ): boolean {
    if (!this.config.enabled) return false;

    const lastAssessment = this.lastAssessmentTime.get(runId) ?? 0;
    if (Date.now() - lastAssessment < this.config.metaAssessmentCooldown) {
      return false;
    }

    const assessmentCount = this.assessments.get(runId)?.length ?? 0;
    if (assessmentCount >= this.config.maxMetaAssessments) {
      return false;
    }

    switch (trigger) {
      case 'iteration_complete':
        return (
          context.iteration > 0 && context.iteration % this.config.triggerAfterIterations === 0
        );

      case 'confidence_drop':
        return context.confidence < this.config.triggerOnConfidenceDrop;

      case 'progress_stall':
        return context.stagnationCount >= this.config.triggerOnProgressStall;

      case 'periodic':
        return (
          context.iteration > 0 && context.iteration % this.config.triggerAfterIterations === 0
        );

      case 'tool_call_failed':
        return true;

      case 'explicit_request':
        return true;

      default:
        return false;
    }
  }

  observe(context: ObservationContext, insights: Insight[]): MetaObservation {
    return this.collector.collect(context, insights);
  }

  async assess(observation: MetaObservation): Promise<MetaAssessment> {
    const startTime = Date.now();
    const currentModeConfig = this.getModeConfig(observation.currentMode);

    const prompt = buildMetaAssessmentPrompt(observation, {
      allowedModes: this.config.allowedModes,
      currentModeConfig,
    });

    const response = await this.llm.chat({
      model: this.config.metaModel ?? this.model,
      messages: [
        { role: 'system', content: META_REASONING_SYSTEM_PROMPT },
        { role: 'user', content: prompt },
      ],
      temperature: 0.3,
      maxTokens: this.config.maxMetaTokens,
    });

    const parsed = parseMetaAssessmentResponse(response.content);

    const assessment: MetaAssessment = {
      id: `meta_${nanoid(10)}`,
      observationId: `obs_${observation.runId}_${observation.iteration}`,
      timestamp: Date.now(),

      onTrack: parsed?.onTrack ?? observation.currentConfidence > 0.5,
      confidence: parsed?.confidence ?? 0.5,
      reasoning: parsed?.reasoning ?? 'Assessment unavailable',

      issues: (parsed?.issues ?? []) as MetaIssue[],
      opportunities: (parsed?.opportunities ?? []).map((o) => ({
        type: o.type as MetaOpportunity['type'],
        confidence: o.expectedImprovement ?? 0.5,
        description: o.description,
      })) as MetaOpportunity[],

      recommendation: this.buildRecommendation(parsed, observation),

      requiresAdaptation:
        parsed?.recommendation?.action !== undefined &&
        parsed?.recommendation?.action !== 'continue',

      assessmentDuration: Date.now() - startTime,
      assessmentCost: (response.usage?.outputTokens ?? 0) * 0.00001,
    };

    const runAssessments = this.assessments.get(observation.runId) ?? [];
    runAssessments.push(assessment);
    this.assessments.set(observation.runId, runAssessments);
    this.lastAssessmentTime.set(observation.runId, Date.now());

    return assessment;
  }

  private buildRecommendation(
    parsed: ReturnType<typeof parseMetaAssessmentResponse>,
    observation: MetaObservation
  ): MetaRecommendation {
    if (!parsed?.recommendation) {
      const suggestedMode = this.selector.suggestSwitch(observation);
      if (suggestedMode) {
        return {
          action: 'switch_mode',
          newMode: suggestedMode,
          confidence: 0.6,
          reasoning: 'Heuristic-based mode switch suggestion',
        };
      }
      return {
        action: 'continue',
        confidence: 0.5,
        reasoning: 'Default: continue current approach',
      };
    }

    return {
      action: parsed.recommendation.action as MetaRecommendation['action'],
      newMode: parsed.recommendation.newMode as ReasoningMode | undefined,
      parameterChanges: parsed.recommendation.parameterChanges as
        | Partial<ReasoningModeConfig>
        | undefined,
      contextAddition: parsed.recommendation.contextAddition,
      confidence: parsed.recommendation.confidence,
      reasoning: parsed.recommendation.reasoning,
    };
  }

  async adapt(runId: string, assessment: MetaAssessment): Promise<MetaAdaptation | null> {
    const recommendation = assessment.recommendation;

    if (!recommendation || recommendation.action === 'continue') {
      return null;
    }

    if (recommendation.confidence < this.config.minConfidenceToAdapt) {
      return null;
    }

    const lastAdaptation = this.lastAdaptationTime.get(runId) ?? 0;
    if (Date.now() - lastAdaptation < this.config.adaptationCooldown) {
      return null;
    }

    const adaptationCount = this.adaptations.get(runId)?.length ?? 0;
    if (adaptationCount >= this.config.maxAdaptations) {
      return null;
    }

    const currentMode = this.currentMode.get(runId) ?? this.config.defaultMode;
    const currentConfig = this.getModeConfig(currentMode);

    let newConfig: Partial<ReasoningModeConfig> = {};
    let adaptationType: MetaAdaptation['type'] = 'parameter_change';

    switch (recommendation.action) {
      case 'switch_mode':
        if (recommendation.newMode && this.config.allowedModes.includes(recommendation.newMode)) {
          newConfig = this.getModeConfig(recommendation.newMode);
          adaptationType = 'mode_switch';
          this.currentMode.set(runId, recommendation.newMode);
        }
        break;

      case 'adjust_parameters':
        if (recommendation.parameterChanges) {
          newConfig = { ...currentConfig, ...recommendation.parameterChanges };
          adaptationType = 'parameter_change';
        }
        break;

      case 'inject_context':
        adaptationType = 'context_injection';
        break;

      case 'abort':
        return null;
    }

    const adaptation: MetaAdaptation = {
      id: `adapt_${nanoid(10)}`,
      assessmentId: assessment.id,
      timestamp: Date.now(),

      type: adaptationType,
      before: currentConfig,
      after: newConfig,

      rollbackable: this.config.enableRollback,
      rollbackDeadline: this.config.enableRollback
        ? Date.now() + this.config.rollbackWindow
        : undefined,
    };

    const runAdaptations = this.adaptations.get(runId) ?? [];
    runAdaptations.push(adaptation);
    this.adaptations.set(runId, runAdaptations);
    this.lastAdaptationTime.set(runId, Date.now());

    return adaptation;
  }

  rollback(runId: string): MetaAdaptation | null {
    const runAdaptations = this.adaptations.get(runId) ?? [];
    const lastAdaptation = runAdaptations[runAdaptations.length - 1];

    if (!lastAdaptation?.rollbackable) {
      return null;
    }

    if (lastAdaptation.rollbackDeadline && Date.now() > lastAdaptation.rollbackDeadline) {
      return null;
    }

    const rollback: MetaAdaptation = {
      id: `rollback_${nanoid(10)}`,
      assessmentId: lastAdaptation.assessmentId,
      timestamp: Date.now(),

      type: 'rollback',
      before: lastAdaptation.after,
      after: lastAdaptation.before,

      rollbackable: false,
    };

    if (lastAdaptation.type === 'mode_switch' && lastAdaptation.before.mode) {
      this.currentMode.set(runId, lastAdaptation.before.mode);
    }

    runAdaptations.push(rollback);
    return rollback;
  }

  recordOutcome(
    runId: string,
    adaptationId: string,
    outcome: { improved: boolean; progressDelta: number; confidenceDelta: number }
  ): void {
    const runAdaptations = this.adaptations.get(runId) ?? [];
    const adaptation = runAdaptations.find((a) => a.id === adaptationId);

    if (adaptation) {
      adaptation.outcome = outcome;

      if (this.config.rollbackOnDecline && !outcome.improved && adaptation.rollbackable) {
        this.rollback(runId);
      }
    }
  }

  getCurrentConfig(runId: string): ReasoningModeConfig {
    const mode = this.currentMode.get(runId) ?? this.config.defaultMode;
    return this.getModeConfig(mode);
  }

  getCurrentMode(runId: string): ReasoningMode {
    return this.currentMode.get(runId) ?? this.config.defaultMode;
  }

  getModeConfig(mode: ReasoningMode): ReasoningModeConfig {
    return this.config.modeProfiles[mode];
  }

  getRunStats(runId: string): {
    observations: number;
    assessments: number;
    adaptations: number;
    currentMode: ReasoningMode;
    successfulAdaptations: number;
  } {
    const runAdaptations = this.adaptations.get(runId) ?? [];

    return {
      observations: this.collector.getObservations(runId).length,
      assessments: this.assessments.get(runId)?.length ?? 0,
      adaptations: runAdaptations.length,
      currentMode: this.currentMode.get(runId) ?? this.config.defaultMode,
      successfulAdaptations: runAdaptations.filter((a) => a.outcome?.improved).length,
    };
  }

  cleanupRun(runId: string): void {
    this.collector.cleanupRun(runId);
    this.selector.cleanupRun(runId);
    this.assessments.delete(runId);
    this.adaptations.delete(runId);
    this.currentMode.delete(runId);
    this.lastAssessmentTime.delete(runId);
    this.lastAdaptationTime.delete(runId);
  }
}
