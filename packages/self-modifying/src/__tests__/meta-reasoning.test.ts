import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  MetaReasoner,
  ObservationCollector,
  StrategySelector,
  DEFAULT_MODE_PROFILES,
  mergeModeProfiles,
  buildMetaAssessmentPrompt,
  parseMetaAssessmentResponse,
} from '../meta-reasoning';
import type { LLMBackend, MetaObservation } from '@cogitator-ai/types';

const mockLLM = {
  provider: 'ollama',
  chat: vi.fn<LLMBackend['chat']>().mockResolvedValue({
    id: 'resp',
    finishReason: 'stop',
    content: JSON.stringify({
      onTrack: true,
      confidence: 0.8,
      issues: [],
      opportunities: [],
      reasoning: 'Continue current approach',
      recommendation: {
        action: 'continue',
        confidence: 0.8,
        reasoning: 'Making good progress',
      },
    }),
    usage: { inputTokens: 0, outputTokens: 100, totalTokens: 100 },
  }),
  chatStream: async function* () {},
} satisfies LLMBackend;

describe('ObservationCollector', () => {
  let collector: ObservationCollector;
  const runId = 'test-run';

  beforeEach(() => {
    collector = new ObservationCollector();
    collector.initializeRun(runId);
  });

  it('collects observations', () => {
    collector.recordAction(runId, {
      type: 'tool_call',
      toolName: 'calculator',
      timestamp: Date.now(),
      duration: 100,
    });

    collector.recordAction(runId, {
      type: 'tool_call',
      toolName: 'search',
      error: 'Not found',
      timestamp: Date.now(),
      duration: 200,
    });

    const observation = collector.collect(
      {
        runId,
        iteration: 1,
        goal: 'Test goal',
        currentMode: 'analytical',
        tokensUsed: 500,
        timeElapsed: 5000,
        iterationsRemaining: 10,
        budgetRemaining: 0.9,
      },
      []
    );

    expect(observation.tokensUsed).toBe(500);
    expect(observation.currentMode).toBe('analytical');
  });

  it('calculates repetition score', () => {
    for (let i = 0; i < 5; i++) {
      collector.recordAction(runId, {
        type: 'tool_call',
        toolName: 'same_tool',
        input: { key: 'value' },
        timestamp: Date.now(),
        duration: 100,
      });
    }

    const observation = collector.collect(
      {
        runId,
        iteration: 1,
        goal: 'Test',
        currentMode: 'analytical',
        tokensUsed: 100,
        timeElapsed: 1000,
        iterationsRemaining: 5,
        budgetRemaining: 0.8,
      },
      []
    );

    expect(observation.repetitionScore).toBeGreaterThan(0.5);
  });

  it('tracks tool success rate', () => {
    collector.recordAction(runId, {
      type: 'tool_call',
      toolName: 'a',
      timestamp: Date.now(),
    });
    collector.recordAction(runId, {
      type: 'tool_call',
      toolName: 'b',
      timestamp: Date.now(),
    });
    collector.recordAction(runId, {
      type: 'tool_call',
      toolName: 'c',
      error: 'Failed',
      timestamp: Date.now(),
    });
    collector.recordAction(runId, {
      type: 'tool_call',
      toolName: 'd',
      timestamp: Date.now(),
    });

    const observation = collector.collect(
      {
        runId,
        iteration: 1,
        goal: 'Test',
        currentMode: 'analytical',
        tokensUsed: 0,
        timeElapsed: 0,
        iterationsRemaining: 5,
        budgetRemaining: 0.8,
      },
      []
    );

    expect(observation.toolSuccessRate).toBe(0.75);
  });

  it('cleans up run state', () => {
    collector.recordAction(runId, {
      type: 'tool_call',
      toolName: 'test',
      timestamp: Date.now(),
    });

    collector.cleanupRun(runId);

    const observations = collector.getObservations(runId);
    expect(observations).toHaveLength(0);
  });
});

describe('StrategySelector', () => {
  let selector: StrategySelector;

  beforeEach(() => {
    selector = new StrategySelector({
      allowedModes: ['analytical', 'creative', 'systematic', 'intuitive'],
      modeProfiles: DEFAULT_MODE_PROFILES,
    });
  });

  it('selects mode based on task profile', () => {
    const mode = selector.selectForTask({
      complexity: 'complex',
      domain: 'coding',
      estimatedTokens: 5000,
      requiresTools: true,
      toolIntensity: 'heavy',
      reasoningDepth: 'deep',
      creativityLevel: 'low',
      accuracyRequirement: 'high',
      timeConstraint: 'none',
      requiresReasoning: true,
    });

    expect(mode).toBeDefined();
  });

  it('suggests mode switch on stagnation', () => {
    const observation: MetaObservation = {
      runId: 'test',
      iteration: 5,
      timestamp: Date.now(),
      currentMode: 'analytical',
      currentConfidence: 0.5,
      progressScore: 0.3,
      progressDelta: 0.01,
      stagnationCount: 4,
      confidenceHistory: [0.6, 0.5, 0.4],
      tokensUsed: 2000,
      timeElapsed: 10000,
      toolSuccessRate: 0.6,
      repetitionScore: 0.6,
      confidenceTrend: 'falling',
    };

    const suggestion = selector.suggestSwitch(observation);

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
  const runId = 'test-run';

  beforeEach(() => {
    vi.clearAllMocks();
    reasoner = new MetaReasoner({
      llm: mockLLM,
      model: 'gpt-4o',
      config: {
        enabled: true,
        maxMetaAssessments: 5,
        maxAdaptations: 3,
        metaAssessmentCooldown: 0,
        adaptationCooldown: 0,
        triggers: ['iteration_complete', 'confidence_drop', 'progress_stall'],
        tokenBudget: 2000,
      },
    });
  });

  it('initializes run with mode config', () => {
    const config = reasoner.initializeRun(runId);

    expect(config).toBeDefined();
    expect(config.mode).toBeDefined();
    expect(config.temperature).toBeDefined();
  });

  it('determines trigger conditions', () => {
    reasoner.initializeRun(runId);

    const shouldTrigger = reasoner.shouldTrigger(runId, 'progress_stall', {
      iteration: 5,
      confidence: 0.5,
      progressDelta: 0.01,
      stagnationCount: 3,
    });

    expect(shouldTrigger).toBe(true);
  });

  it('collects observations', () => {
    reasoner.initializeRun(runId);

    const observation = reasoner.observe(
      {
        runId,
        iteration: 1,
        goal: 'Test goal',
        currentMode: 'analytical',
        tokensUsed: 1000,
        timeElapsed: 10000,
        iterationsRemaining: 5,
        budgetRemaining: 0.8,
      },
      [
        {
          id: 'insight-1',
          type: 'pattern',
          content: 'Test insight',
          context: 'Test goal',
          confidence: 0.8,
          usageCount: 0,
          createdAt: new Date(0),
          lastUsedAt: new Date(0),
          agentId: 'agent-1',
          source: { runId, reflectionId: 'reflection-1' },
        },
      ]
    );

    expect(observation.tokensUsed).toBe(1000);
  });

  it('performs assessment', async () => {
    reasoner.initializeRun(runId);

    const observation: MetaObservation = {
      runId,
      iteration: 1,
      timestamp: Date.now(),
      goal: 'Test goal',
      currentMode: 'analytical',
      currentConfidence: 0.7,
      progressScore: 0.5,
      progressDelta: 0.1,
      stagnationCount: 0,
      confidenceHistory: [0.6, 0.7],
      tokensUsed: 500,
      timeElapsed: 3000,
      iterationsRemaining: 5,
      budgetRemaining: 0.9,
      toolSuccessRate: 0.8,
      repetitionScore: 0.2,
      confidenceTrend: 'stable',
    };

    const assessment = await reasoner.assess(observation);

    expect(assessment.onTrack).toBeDefined();
    expect(assessment.confidence).toBeDefined();
  });

  it('adapts strategy when needed', async () => {
    reasoner.initializeRun(runId);

    const assessment = {
      id: 'assess-1',
      observationId: 'obs-1',
      timestamp: Date.now(),
      onTrack: false,
      confidence: 0.7,
      issues: [],
      opportunities: [],
      reasoning: 'Need to switch mode',
      recommendation: {
        action: 'switch_mode' as const,
        newMode: 'creative' as const,
        confidence: 0.8,
        reasoning: 'Creative mode better for current task',
      },
      assessmentDuration: 100,
      assessmentCost: 0.001,
    };

    const adaptation = await reasoner.adapt(runId, assessment);

    expect(adaptation).not.toBeNull();
    if (adaptation) {
      expect(adaptation.type).toBe('mode_switch');
    }
  });

  it('supports rollback', async () => {
    reasoner.initializeRun(runId);

    const assessment = {
      id: 'assess-1',
      observationId: 'obs-1',
      timestamp: Date.now(),
      onTrack: false,
      confidence: 0.7,
      issues: [],
      opportunities: [],
      reasoning: 'Switch needed',
      recommendation: {
        action: 'switch_mode' as const,
        newMode: 'creative' as const,
        confidence: 0.8,
        reasoning: 'Try creative mode',
      },
      assessmentDuration: 100,
      assessmentCost: 0.001,
    };

    await reasoner.adapt(runId, assessment);
    const rollback = reasoner.rollback(runId);

    expect(rollback).not.toBeNull();
    if (rollback) {
      expect(rollback.type).toBe('rollback');
    }
  });
});

describe('Meta-reasoning prompts', () => {
  it('builds assessment prompt', () => {
    const observation: MetaObservation = {
      runId: 'test',
      iteration: 3,
      timestamp: Date.now(),
      goal: 'Complete the task',
      currentMode: 'analytical',
      currentConfidence: 0.7,
      progressScore: 0.5,
      progressDelta: 0.1,
      stagnationCount: 0,
      confidenceHistory: [0.6, 0.65, 0.7],
      tokensUsed: 1000,
      timeElapsed: 5000,
      iterationsRemaining: 7,
      budgetRemaining: 0.8,
      toolSuccessRate: 0.8,
      repetitionScore: 0.2,
      confidenceTrend: 'stable',
      recentActions: [
        { type: 'tool_call', toolName: 'search' },
        { type: 'tool_call', toolName: 'calculator' },
      ],
    };

    const prompt = buildMetaAssessmentPrompt(observation, {
      allowedModes: ['analytical', 'creative'],
      currentModeConfig: { mode: 'analytical', temperature: 0.3, depth: 3 },
    });

    expect(prompt).toContain('1000');
    expect(prompt).toContain('analytical');
  });

  it('parses assessment response', () => {
    const response = `
    Here is my assessment:
    {
      "onTrack": true,
      "confidence": 0.85,
      "issues": [
        {"type": "repetition", "severity": "low", "description": "Repeated tool call"},
        {"type": "minor", "severity": "low", "description": "Unknown issue type is dropped"}
      ],
      "opportunities": [],
      "reasoning": "Good progress",
      "recommendation": {
        "action": "continue",
        "confidence": 0.9,
        "reasoning": "Continue with current approach"
      }
    }
    `;

    const parsed = parseMetaAssessmentResponse(response);

    expect(parsed).not.toBeNull();
    expect(parsed?.onTrack).toBe(true);
    expect(parsed?.confidence).toBe(0.85);
    expect(parsed?.issues).toHaveLength(1);
    expect(parsed?.issues[0].type).toBe('repetition');
  });

  it('handles malformed response', () => {
    const parsed = parseMetaAssessmentResponse('Not a JSON response');
    expect(parsed).toBeNull();
  });
});

describe('mergeModeProfiles', () => {
  it('overrides the given fields of the given modes only', () => {
    const merged = mergeModeProfiles(DEFAULT_MODE_PROFILES, { creative: { temperature: 0.95 } });

    expect(merged.creative).toEqual({ ...DEFAULT_MODE_PROFILES.creative, temperature: 0.95 });
    expect(merged.analytical).toEqual(DEFAULT_MODE_PROFILES.analytical);
  });

  it('gives MetaReasoner complete profiles from partial ones', () => {
    const reasoner = new MetaReasoner({
      llm: mockLLM,
      model: 'test-model',
      config: { modeProfiles: { reflective: { depth: 7 } } },
    });

    expect(reasoner.getModeConfig('reflective')).toEqual({
      ...DEFAULT_MODE_PROFILES.reflective,
      depth: 7,
    });
  });
});
