import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  MetaReasoner,
  ObservationCollector,
  StrategySelector,
  DEFAULT_MODE_PROFILES,
  buildMetaAssessmentPrompt,
  parseMetaAssessmentResponse,
} from '../meta-reasoning';
import type { LLMBackend } from '@cogitator-ai/types';

const mockLLM: LLMBackend = {
  complete: vi.fn().mockResolvedValue({
    content: JSON.stringify({
      isOnTrack: true,
      confidence: 0.8,
      issues: [],
      recommendations: ['Continue current approach'],
      requiresAdaptation: false,
    }),
  }),
  name: 'mock',
  supportsTool: () => true,
  supportsStreaming: () => false,
  validateConfig: () => true,
};

describe('ObservationCollector', () => {
  let collector: ObservationCollector;

  beforeEach(() => {
    collector = new ObservationCollector();
  });

  it('collects observations', () => {
    collector.recordAction({
      type: 'tool_call',
      name: 'calculator',
      success: true,
      duration: 100,
    });

    collector.recordAction({
      type: 'tool_call',
      name: 'search',
      success: false,
      duration: 200,
    });

    const observation = collector.collect({
      currentProgress: 'Some progress',
      tokensUsed: 500,
      timeElapsed: 5000,
      toolCallsCount: 2,
      errorCount: 1,
    });

    expect(observation.actionCount).toBe(2);
    expect(observation.failedActions).toBe(1);
    expect(observation.metrics.tokensUsed).toBe(500);
  });

  it('calculates repetition score', () => {
    for (let i = 0; i < 5; i++) {
      collector.recordAction({
        type: 'tool_call',
        name: 'same_tool',
        success: true,
        duration: 100,
      });
    }

    const observation = collector.collect({
      currentProgress: 'Progress',
      tokensUsed: 100,
      timeElapsed: 1000,
      toolCallsCount: 5,
      errorCount: 0,
    });

    expect(observation.repetitionScore).toBeGreaterThan(0.5);
  });

  it('tracks tool success rate', () => {
    collector.recordAction({ type: 'tool_call', name: 'a', success: true, duration: 100 });
    collector.recordAction({ type: 'tool_call', name: 'b', success: true, duration: 100 });
    collector.recordAction({ type: 'tool_call', name: 'c', success: false, duration: 100 });
    collector.recordAction({ type: 'tool_call', name: 'd', success: true, duration: 100 });

    const observation = collector.collect({
      currentProgress: '',
      tokensUsed: 0,
      timeElapsed: 0,
      toolCallsCount: 4,
      errorCount: 1,
    });

    expect(observation.toolSuccessRate).toBe(0.75);
  });

  it('resets state', () => {
    collector.recordAction({ type: 'tool_call', name: 'test', success: true, duration: 100 });
    collector.reset();

    const observation = collector.collect({
      currentProgress: '',
      tokensUsed: 0,
      timeElapsed: 0,
      toolCallsCount: 0,
      errorCount: 0,
    });

    expect(observation.actionCount).toBe(0);
  });
});

describe('StrategySelector', () => {
  let selector: StrategySelector;

  beforeEach(() => {
    selector = new StrategySelector();
  });

  it('selects mode based on task profile', () => {
    const result = selector.selectMode({
      complexity: 'complex',
      domain: 'coding',
      estimatedTokens: 5000,
      requiresTools: true,
      toolIntensity: 'heavy',
      reasoningDepth: 'deep',
      creativityLevel: 'low',
      accuracyRequirement: 'high',
      timeConstraint: 'none',
    });

    expect(result.mode).toBeDefined();
    expect(result.confidence).toBeGreaterThan(0);
  });

  it('suggests mode switch', () => {
    selector.selectMode({
      complexity: 'simple',
      domain: 'general',
      estimatedTokens: 500,
      requiresTools: false,
      toolIntensity: 'none',
      reasoningDepth: 'shallow',
      creativityLevel: 'moderate',
      accuracyRequirement: 'moderate',
      timeConstraint: 'none',
    });

    const suggestion = selector.suggestModeSwitch({
      currentIssues: ['Low confidence in outputs'],
      performanceMetrics: {
        tokensUsed: 2000,
        timeElapsed: 10000,
        qualityScore: 0.4,
      },
    });

    expect(suggestion).toBeDefined();
  });

  it('returns all mode profiles', () => {
    const profiles = DEFAULT_MODE_PROFILES;
    expect(Object.keys(profiles).length).toBeGreaterThan(0);
    expect(profiles.analytical).toBeDefined();
  });
});

describe('MetaReasoner', () => {
  let reasoner: MetaReasoner;

  beforeEach(() => {
    vi.clearAllMocks();
    reasoner = new MetaReasoner({
      llm: mockLLM,
      config: {
        enabled: true,
        maxAssessmentsPerRun: 5,
        maxAdaptationsPerRun: 3,
        assessmentCooldown: 1000,
        triggers: ['on_failure', 'periodic'],
        tokenBudget: 2000,
      },
    });
  });

  it('initializes run with mode config', () => {
    const config = reasoner.initializeRun('run-1');

    expect(config.mode).toBeDefined();
    expect(config.parameters).toBeDefined();
  });

  it('determines trigger conditions', () => {
    reasoner.initializeRun('run-1');

    const shouldTrigger = reasoner.shouldTrigger('run-1', 'on_failure', {
      currentProgress: 'Error occurred',
      tokensUsed: 500,
      timeElapsed: 5000,
      toolCallsCount: 2,
      errorCount: 3,
    });

    expect(shouldTrigger).toBe(true);
  });

  it('collects observations', () => {
    const observation = reasoner.observe(
      {
        currentProgress: 'Making progress',
        tokensUsed: 1000,
        timeElapsed: 10000,
        toolCallsCount: 5,
        errorCount: 0,
      },
      {
        confidence: 0.8,
        relevance: 0.9,
        coherence: 0.85,
      }
    );

    expect(observation.insights.confidence).toBe(0.8);
    expect(observation.metrics.tokensUsed).toBe(1000);
  });

  it('performs assessment', async () => {
    reasoner.initializeRun('run-1');

    const observation = reasoner.observe(
      {
        currentProgress: 'Some output',
        tokensUsed: 500,
        timeElapsed: 3000,
        toolCallsCount: 2,
        errorCount: 0,
      },
      { confidence: 0.7, relevance: 0.8, coherence: 0.9 }
    );

    const assessment = await reasoner.assess(observation);

    expect(assessment.isOnTrack).toBeDefined();
    expect(assessment.confidence).toBeDefined();
  });

  it('adapts strategy when needed', async () => {
    reasoner.initializeRun('run-1');

    const assessment = {
      isOnTrack: false,
      confidence: 0.4,
      issues: ['Low quality outputs'],
      recommendations: ['Switch to more analytical mode'],
      requiresAdaptation: true,
      suggestedMode: 'analytical' as const,
    };

    const adaptation = await reasoner.adapt('run-1', assessment);

    expect(adaptation).not.toBeNull();
    if (adaptation) {
      expect(adaptation.newMode).toBe('analytical');
    }
  });

  it('supports rollback', () => {
    reasoner.initializeRun('run-1');

    reasoner.adapt('run-1', {
      isOnTrack: false,
      confidence: 0.3,
      issues: [],
      recommendations: [],
      requiresAdaptation: true,
      suggestedMode: 'creative',
    });

    const rollback = reasoner.rollback('run-1');

    expect(rollback).not.toBeNull();
    if (rollback) {
      expect(rollback.isRollback).toBe(true);
    }
  });
});

describe('Meta-reasoning prompts', () => {
  it('builds assessment prompt', () => {
    const prompt = buildMetaAssessmentPrompt({
      id: 'obs-1',
      timestamp: new Date(),
      metrics: {
        tokensUsed: 1000,
        timeElapsed: 5000,
        progressPercentage: 50,
      },
      insights: {
        confidence: 0.7,
        relevance: 0.8,
        coherence: 0.9,
      },
      actionCount: 5,
      failedActions: 1,
      repetitionScore: 0.2,
      toolSuccessRate: 0.8,
      confidenceTrend: 'stable',
    });

    expect(prompt).toContain('tokensUsed');
    expect(prompt).toContain('confidence');
  });

  it('parses assessment response', () => {
    const response = `
    Here is my assessment:
    {
      "isOnTrack": true,
      "confidence": 0.85,
      "issues": ["Minor formatting issues"],
      "recommendations": ["Continue with current approach"],
      "requiresAdaptation": false
    }
    `;

    const parsed = parseMetaAssessmentResponse(response);

    expect(parsed).not.toBeNull();
    expect(parsed?.isOnTrack).toBe(true);
    expect(parsed?.confidence).toBe(0.85);
    expect(parsed?.issues).toContain('Minor formatting issues');
  });

  it('handles malformed response', () => {
    const parsed = parseMetaAssessmentResponse('Not a JSON response');
    expect(parsed).toBeNull();
  });
});
