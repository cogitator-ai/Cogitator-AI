import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  CapabilityAnalyzer,
  EvolutionStrategy,
  ParameterOptimizer,
  parseTaskProfileResponse,
  parseCandidateGenerationResponse,
} from '../architecture-evolution';
import type { LLMBackend, EvolutionCandidate } from '@cogitator-ai/types';

const mockLLM: LLMBackend = {
  complete: vi.fn(),
  name: 'mock',
  supportsTool: () => true,
  supportsStreaming: () => false,
  validateConfig: () => true,
};

describe('CapabilityAnalyzer', () => {
  it('analyzes task with heuristics', async () => {
    const analyzer = new CapabilityAnalyzer({ enableLLMAnalysis: false });

    const profile = await analyzer.analyzeTask(
      'Write a complex algorithm to optimize database queries with detailed analysis'
    );

    expect(profile.domain).toBe('coding');
    expect(profile.complexity).toBe('complex');
    expect(profile.reasoningDepth).toBe('deep');
  });

  it('detects tool requirements', async () => {
    const analyzer = new CapabilityAnalyzer({ enableLLMAnalysis: false });

    const profile = await analyzer.analyzeTask('Search for information and calculate the result');

    expect(profile.requiresTools).toBe(true);
    expect(profile.toolIntensity).not.toBe('none');
  });

  it('detects creative tasks', async () => {
    const analyzer = new CapabilityAnalyzer({ enableLLMAnalysis: false });

    const profile = await analyzer.analyzeTask(
      'Create an imaginative story with artistic elements and novel ideas'
    );

    expect(profile.domain).toBe('creative');
    expect(profile.creativityLevel).toBe('high');
  });

  it('detects time constraints', async () => {
    const analyzer = new CapabilityAnalyzer({ enableLLMAnalysis: false });

    const urgentProfile = await analyzer.analyzeTask('I need this done urgently asap');
    expect(urgentProfile.timeConstraint).toBe('strict');

    const relaxedProfile = await analyzer.analyzeTask('When possible, no rush on this');
    expect(relaxedProfile.timeConstraint).toBe('relaxed');
  });

  it('estimates token usage', async () => {
    const analyzer = new CapabilityAnalyzer({ enableLLMAnalysis: false });

    const simpleProfile = await analyzer.analyzeTask('Hello');
    const complexProfile = await analyzer.analyzeTask(
      'Design and implement a comprehensive microservices architecture with event sourcing, CQRS, and distributed tracing capabilities that can handle millions of requests per second'
    );

    expect(complexProfile.estimatedTokens).toBeGreaterThan(simpleProfile.estimatedTokens);
  });
});

describe('EvolutionStrategy', () => {
  describe('epsilon-greedy', () => {
    it('exploits best candidate most of the time', () => {
      const strategy = new EvolutionStrategy({
        strategy: { type: 'epsilon_greedy', epsilon: 0.1 },
      });

      const candidates: EvolutionCandidate[] = [
        {
          id: 'best',
          config: {},
          reasoning: '',
          expectedImprovement: 0.9,
          risk: 'low',
          generation: 0,
          score: 0.9,
          evaluationCount: 10,
        },
        {
          id: 'worst',
          config: {},
          reasoning: '',
          expectedImprovement: 0.3,
          risk: 'low',
          generation: 0,
          score: 0.3,
          evaluationCount: 10,
        },
      ];

      let bestCount = 0;
      for (let i = 0; i < 100; i++) {
        const result = strategy.select(candidates);
        if (result.candidate.id === 'best') bestCount++;
      }

      expect(bestCount).toBeGreaterThan(80);
    });
  });

  describe('UCB', () => {
    it('explores unexplored candidates first', () => {
      const strategy = new EvolutionStrategy({
        strategy: { type: 'ucb', explorationConstant: 2 },
      });

      const candidates: EvolutionCandidate[] = [
        {
          id: 'explored',
          config: {},
          reasoning: '',
          expectedImprovement: 0.9,
          risk: 'low',
          generation: 0,
          score: 0.9,
          evaluationCount: 100,
        },
        {
          id: 'unexplored',
          config: {},
          reasoning: '',
          expectedImprovement: 0.5,
          risk: 'low',
          generation: 0,
          score: 0,
          evaluationCount: 0,
        },
      ];

      const result = strategy.select(candidates);

      expect(result.candidate.id).toBe('unexplored');
      expect(result.isExploration).toBe(true);
    });

    it('balances exploration and exploitation', () => {
      const strategy = new EvolutionStrategy({
        strategy: { type: 'ucb', explorationConstant: 2 },
      });

      const candidates: EvolutionCandidate[] = [
        {
          id: 'high-score',
          config: {},
          reasoning: '',
          expectedImprovement: 0.9,
          risk: 'low',
          generation: 0,
          score: 0.9,
          evaluationCount: 50,
        },
        {
          id: 'low-score',
          config: {},
          reasoning: '',
          expectedImprovement: 0.3,
          risk: 'low',
          generation: 0,
          score: 0.3,
          evaluationCount: 5,
        },
      ];

      const result = strategy.select(candidates);
      expect(result.candidate).toBeDefined();
    });
  });

  describe('Thompson Sampling', () => {
    it('samples from posterior distributions', () => {
      const strategy = new EvolutionStrategy({
        strategy: { type: 'thompson_sampling' },
      });

      const candidates: EvolutionCandidate[] = [
        {
          id: 'a',
          config: {},
          reasoning: '',
          expectedImprovement: 0.7,
          risk: 'low',
          generation: 0,
          score: 0.7,
          evaluationCount: 10,
        },
        {
          id: 'b',
          config: {},
          reasoning: '',
          expectedImprovement: 0.6,
          risk: 'low',
          generation: 0,
          score: 0.6,
          evaluationCount: 10,
        },
      ];

      const selections = new Map<string, number>();
      for (let i = 0; i < 100; i++) {
        const result = strategy.select(candidates);
        selections.set(result.candidate.id, (selections.get(result.candidate.id) || 0) + 1);
      }

      expect(selections.get('a')).toBeGreaterThan(0);
      expect(selections.get('b')).toBeGreaterThan(0);
    });
  });

  it('updates candidate scores', () => {
    const strategy = new EvolutionStrategy({
      strategy: { type: 'epsilon_greedy', epsilon: 0.1 },
    });

    const candidate: EvolutionCandidate = {
      id: 'test',
      config: {},
      reasoning: '',
      expectedImprovement: 0.5,
      risk: 'low',
      generation: 0,
      score: 0.5,
      evaluationCount: 2,
    };

    strategy.updateCandidate(candidate, 0.8);

    expect(candidate.evaluationCount).toBe(3);
    expect(candidate.score).toBeCloseTo((0.5 * 2 + 0.8) / 3, 5);
  });

  it('determines exploration needs', () => {
    const strategy = new EvolutionStrategy({
      strategy: { type: 'ucb' },
    });

    const unexploredCandidates: EvolutionCandidate[] = [
      {
        id: 'a',
        config: {},
        reasoning: '',
        expectedImprovement: 0.5,
        risk: 'low',
        generation: 0,
        score: 0,
        evaluationCount: 0,
      },
    ];

    const wellExploredCandidates: EvolutionCandidate[] = [
      {
        id: 'a',
        config: {},
        reasoning: '',
        expectedImprovement: 0.5,
        risk: 'low',
        generation: 0,
        score: 0.7,
        evaluationCount: 20,
      },
      {
        id: 'b',
        config: {},
        reasoning: '',
        expectedImprovement: 0.5,
        risk: 'low',
        generation: 0,
        score: 0.72,
        evaluationCount: 20,
      },
    ];

    expect(strategy.shouldExploreMore(unexploredCandidates)).toBe(true);
    expect(strategy.shouldExploreMore(wellExploredCandidates)).toBe(false);
  });
});

describe('ParameterOptimizer', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    (mockLLM.complete as ReturnType<typeof vi.fn>).mockResolvedValue({
      content: JSON.stringify([
        {
          id: 'candidate_1',
          config: { temperature: 0.5 },
          reasoning: 'Lower temperature for precision',
          expectedImprovement: 0.7,
          risk: 'low',
        },
        {
          id: 'candidate_2',
          config: { temperature: 0.9, maxTokens: 8000 },
          reasoning: 'Higher temperature for creativity',
          expectedImprovement: 0.6,
          risk: 'medium',
        },
      ]),
    });
  });

  it('optimizes architecture for task', async () => {
    const optimizer = new ParameterOptimizer({
      llm: mockLLM,
      config: {
        enabled: true,
        strategy: { type: 'ucb', explorationConstant: 2 },
        maxCandidates: 10,
        evaluationWindow: 10,
        minEvaluationsBeforeEvolution: 3,
        adaptationThreshold: 0.1,
      },
      baseConfig: {
        model: 'gpt-4',
        temperature: 0.7,
        maxTokens: 4096,
        toolStrategy: 'sequential',
        reflectionDepth: 1,
      },
    });

    const result = await optimizer.optimize('Write a creative story');

    expect(result.recommendedConfig).toBeDefined();
    expect(result.shouldAdopt).toBe(true);
  });

  it('records and learns from outcomes', async () => {
    const optimizer = new ParameterOptimizer({
      llm: mockLLM,
      config: {
        enabled: true,
        strategy: { type: 'epsilon_greedy', epsilon: 0.1 },
        maxCandidates: 5,
        evaluationWindow: 5,
        minEvaluationsBeforeEvolution: 2,
        adaptationThreshold: 0.1,
      },
      baseConfig: {
        model: 'gpt-4',
        temperature: 0.7,
        maxTokens: 4096,
        toolStrategy: 'sequential',
        reflectionDepth: 1,
      },
    });

    await optimizer.optimize('Test task');

    const candidates = optimizer.getCandidates();
    const candidateId = candidates[0]?.id;

    if (candidateId) {
      await optimizer.recordOutcome(
        candidateId,
        {
          complexity: 'simple',
          domain: 'general',
          estimatedTokens: 500,
          requiresTools: false,
          toolIntensity: 'none',
          reasoningDepth: 'shallow',
          creativityLevel: 'low',
          accuracyRequirement: 'moderate',
          timeConstraint: 'none',
        },
        {
          successRate: 1.0,
          latency: 1000,
          tokenUsage: 500,
          qualityScore: 0.9,
        }
      );

      const updatedCandidates = optimizer.getCandidates();
      const updated = updatedCandidates.find((c) => c.id === candidateId);
      expect(updated?.evaluationCount).toBeGreaterThan(0);
    }
  });

  it('resets state', async () => {
    const optimizer = new ParameterOptimizer({
      llm: mockLLM,
      config: {
        enabled: true,
        strategy: { type: 'ucb' },
        maxCandidates: 5,
        evaluationWindow: 5,
        minEvaluationsBeforeEvolution: 2,
        adaptationThreshold: 0.1,
      },
      baseConfig: {
        model: 'gpt-4',
        temperature: 0.7,
        maxTokens: 4096,
        toolStrategy: 'sequential',
        reflectionDepth: 1,
      },
    });

    await optimizer.optimize('Test');
    expect(optimizer.getCandidates().length).toBeGreaterThan(0);

    optimizer.reset();
    expect(optimizer.getCandidates()).toHaveLength(0);
    expect(optimizer.getHistory()).toHaveLength(0);
  });
});

describe('Parsing functions', () => {
  it('parses task profile response', () => {
    const response = `
    Analysis:
    {
      "complexity": "complex",
      "domain": "coding",
      "estimatedTokens": 5000,
      "requiresTools": true,
      "toolIntensity": "moderate",
      "reasoningDepth": "deep",
      "creativityLevel": "low",
      "accuracyRequirement": "high",
      "timeConstraint": "moderate"
    }
    `;

    const parsed = parseTaskProfileResponse(response);

    expect(parsed).not.toBeNull();
    expect(parsed?.complexity).toBe('complex');
    expect(parsed?.domain).toBe('coding');
  });

  it('parses candidate generation response', () => {
    const response = `
    [
      {
        "id": "opt_1",
        "config": { "temperature": 0.5, "maxTokens": 8000 },
        "reasoning": "Lower temperature for precision",
        "expectedImprovement": 0.7,
        "risk": "low"
      }
    ]
    `;

    const parsed = parseCandidateGenerationResponse(response);

    expect(parsed).toHaveLength(1);
    expect(parsed[0].id).toBe('opt_1');
    expect(parsed[0].config.temperature).toBe(0.5);
  });

  it('handles malformed responses', () => {
    expect(parseTaskProfileResponse('not json')).toBeNull();
    expect(parseCandidateGenerationResponse('not an array')).toHaveLength(0);
  });
});
