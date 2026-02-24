import { describe, it, expect, beforeEach, vi } from 'vitest';
import { ABTestingFramework } from '../learning/ab-testing';
import type { ABTest, ABTestStore, ABTestResults, ABTestVariant } from '@cogitator-ai/types';

function emptyResults(): ABTestResults {
  return {
    sampleSize: 0,
    successRate: 0,
    avgScore: 0,
    avgLatency: 0,
    totalCost: 0,
    scores: [],
  };
}

function makeTest(overrides: Partial<ABTest> = {}): ABTest {
  return {
    id: `test_${Math.random().toString(36).slice(2, 8)}`,
    agentId: 'agent-1',
    name: 'Test A/B',
    status: 'draft',
    controlInstructions: 'Control prompt',
    treatmentInstructions: 'Treatment prompt',
    treatmentAllocation: 0.5,
    minSampleSize: 50,
    maxDuration: 7 * 24 * 60 * 60 * 1000,
    confidenceLevel: 0.95,
    metricToOptimize: 'score',
    controlResults: emptyResults(),
    treatmentResults: emptyResults(),
    createdAt: new Date(),
    ...overrides,
  };
}

function createMockStore(): ABTestStore {
  const tests = new Map<string, ABTest>();

  return {
    create: vi.fn(async (data: Omit<ABTest, 'id' | 'createdAt'>) => {
      const test: ABTest = {
        ...data,
        id: `test_${Math.random().toString(36).slice(2, 8)}`,
        createdAt: new Date(),
      };
      tests.set(test.id, test);
      return test;
    }),

    get: vi.fn(async (id: string) => tests.get(id) ?? null),

    getActive: vi.fn(async (agentId: string) => {
      for (const t of tests.values()) {
        if (t.agentId === agentId && t.status === 'running') return t;
      }
      return null;
    }),

    update: vi.fn(async (id: string, updates: Partial<ABTest>) => {
      const existing = tests.get(id)!;
      const updated = { ...existing, ...updates };
      tests.set(id, updated);
      return updated;
    }),

    recordResult: vi.fn(
      async (
        testId: string,
        variant: ABTestVariant,
        score: number,
        latency: number,
        cost: number
      ) => {
        const test = tests.get(testId);
        if (!test) return;
        const results = variant === 'control' ? test.controlResults : test.treatmentResults;
        const newSize = results.sampleSize + 1;
        const updated: ABTestResults = {
          sampleSize: newSize,
          successRate:
            (results.successRate * results.sampleSize + (score >= 0.5 ? 1 : 0)) / newSize,
          avgScore: (results.avgScore * results.sampleSize + score) / newSize,
          avgLatency: (results.avgLatency * results.sampleSize + latency) / newSize,
          totalCost: results.totalCost + cost,
          scores: [...results.scores, score],
        };
        if (variant === 'control') test.controlResults = updated;
        else test.treatmentResults = updated;
      }
    ),

    list: vi.fn(async () => [...tests.values()]),
    delete: vi.fn(async () => true),
  };
}

describe('ABTestingFramework', () => {
  let store: ReturnType<typeof createMockStore>;
  let framework: ABTestingFramework;

  beforeEach(() => {
    store = createMockStore();
    framework = new ABTestingFramework({ store });
  });

  describe('lifecycle', () => {
    it('creates a test with defaults', async () => {
      const test = await framework.createTest({
        agentId: 'agent-1',
        name: 'Prompt optimization',
        controlInstructions: 'Be helpful',
        treatmentInstructions: 'Be very helpful and detailed',
      });

      expect(test.status).toBe('draft');
      expect(test.treatmentAllocation).toBe(0.5);
      expect(test.minSampleSize).toBe(50);
      expect(test.confidenceLevel).toBe(0.95);
      expect(test.controlResults.sampleSize).toBe(0);
    });

    it('starts a test', async () => {
      const test = await framework.createTest({
        agentId: 'agent-1',
        name: 'Test',
        controlInstructions: 'A',
        treatmentInstructions: 'B',
      });

      const started = await framework.startTest(test.id);

      expect(started.status).toBe('running');
      expect(started.startedAt).toBeInstanceOf(Date);
    });

    it('pauses and resumes a test', async () => {
      const test = await framework.createTest({
        agentId: 'agent-1',
        name: 'Test',
        controlInstructions: 'A',
        treatmentInstructions: 'B',
      });
      await framework.startTest(test.id);

      const paused = await framework.pauseTest(test.id);
      expect(paused.status).toBe('paused');

      const resumed = await framework.resumeTest(test.id);
      expect(resumed.status).toBe('running');
    });

    it('completes a test', async () => {
      const test = await framework.createTest({
        agentId: 'agent-1',
        name: 'Test',
        controlInstructions: 'A',
        treatmentInstructions: 'B',
      });
      await framework.startTest(test.id);

      const { test: completed, outcome } = await framework.completeTest(test.id);

      expect(completed.status).toBe('completed');
      expect(completed.completedAt).toBeInstanceOf(Date);
      expect(outcome).toHaveProperty('pValue');
      expect(outcome).toHaveProperty('isSignificant');
    });

    it('cancels a test', async () => {
      const test = await framework.createTest({
        agentId: 'agent-1',
        name: 'Test',
        controlInstructions: 'A',
        treatmentInstructions: 'B',
      });
      await framework.startTest(test.id);

      const cancelled = await framework.cancelTest(test.id);
      expect(cancelled.status).toBe('cancelled');
    });
  });

  describe('getActiveTest / getTest', () => {
    it('returns active test for agent', async () => {
      const test = await framework.createTest({
        agentId: 'agent-1',
        name: 'Test',
        controlInstructions: 'A',
        treatmentInstructions: 'B',
      });
      await framework.startTest(test.id);

      const active = await framework.getActiveTest('agent-1');
      expect(active).not.toBeNull();
      expect(active!.id).toBe(test.id);
    });

    it('returns null when no active test', async () => {
      const active = await framework.getActiveTest('agent-1');
      expect(active).toBeNull();
    });

    it('getTest retrieves by id regardless of status', async () => {
      const test = await framework.createTest({
        agentId: 'agent-1',
        name: 'Test',
        controlInstructions: 'A',
        treatmentInstructions: 'B',
      });
      await framework.startTest(test.id);
      await framework.completeTest(test.id);

      const retrieved = await framework.getTest(test.id);
      expect(retrieved).not.toBeNull();
      expect(retrieved!.status).toBe('completed');
    });
  });

  describe('variant selection', () => {
    it('returns control or treatment', () => {
      const test = makeTest({ treatmentAllocation: 0.5 });
      const variants = new Set<ABTestVariant>();

      for (let i = 0; i < 100; i++) {
        variants.add(framework.selectVariant(test));
      }

      expect(variants.has('control')).toBe(true);
      expect(variants.has('treatment')).toBe(true);
    });

    it('getInstructionsForVariant returns correct instructions', () => {
      const test = makeTest({
        controlInstructions: 'CTRL',
        treatmentInstructions: 'TREAT',
      });

      expect(framework.getInstructionsForVariant(test, 'control')).toBe('CTRL');
      expect(framework.getInstructionsForVariant(test, 'treatment')).toBe('TREAT');
    });
  });

  describe('result recording', () => {
    it('records results and updates cache', async () => {
      const test = await framework.createTest({
        agentId: 'agent-1',
        name: 'Test',
        controlInstructions: 'A',
        treatmentInstructions: 'B',
      });
      await framework.startTest(test.id);

      await framework.recordResult(test.id, 'control', 0.8, 100, 0.01);
      await framework.recordResult(test.id, 'treatment', 0.9, 120, 0.015);

      expect(store.recordResult).toHaveBeenCalledTimes(2);
    });
  });

  describe('analyzeResults', () => {
    it('returns insufficient data for small samples', () => {
      const test = makeTest({
        controlResults: { ...emptyResults(), sampleSize: 1, scores: [0.8], avgScore: 0.8 },
        treatmentResults: { ...emptyResults(), sampleSize: 1, scores: [0.9], avgScore: 0.9 },
      });

      const outcome = framework.analyzeResults(test);

      expect(outcome.isSignificant).toBe(false);
      expect(outcome.winner).toBeNull();
      expect(outcome.recommendation).toContain('Insufficient');
    });

    it('detects significant treatment win', () => {
      const controlScores = Array.from({ length: 50 }, () => 0.5 + Math.random() * 0.1);
      const treatmentScores = Array.from({ length: 50 }, () => 0.8 + Math.random() * 0.1);
      const mean = (arr: number[]) => arr.reduce((a, b) => a + b, 0) / arr.length;

      const test = makeTest({
        controlResults: {
          sampleSize: 50,
          scores: controlScores,
          avgScore: mean(controlScores),
          successRate: 0.8,
          avgLatency: 100,
          totalCost: 0.5,
        },
        treatmentResults: {
          sampleSize: 50,
          scores: treatmentScores,
          avgScore: mean(treatmentScores),
          successRate: 0.95,
          avgLatency: 110,
          totalCost: 0.6,
        },
      });

      const outcome = framework.analyzeResults(test);

      expect(outcome.isSignificant).toBe(true);
      expect(outcome.winner).toBe('treatment');
      expect(outcome.effectSize).toBeGreaterThan(0);
    });

    it('detects significant control win', () => {
      const controlScores = Array.from({ length: 50 }, () => 0.8 + Math.random() * 0.1);
      const treatmentScores = Array.from({ length: 50 }, () => 0.4 + Math.random() * 0.1);
      const mean = (arr: number[]) => arr.reduce((a, b) => a + b, 0) / arr.length;

      const test = makeTest({
        controlResults: {
          sampleSize: 50,
          scores: controlScores,
          avgScore: mean(controlScores),
          successRate: 0.95,
          avgLatency: 100,
          totalCost: 0.5,
        },
        treatmentResults: {
          sampleSize: 50,
          scores: treatmentScores,
          avgScore: mean(treatmentScores),
          successRate: 0.5,
          avgLatency: 100,
          totalCost: 0.5,
        },
      });

      const outcome = framework.analyzeResults(test);

      expect(outcome.isSignificant).toBe(true);
      expect(outcome.winner).toBe('control');
    });

    it('not significant when distributions overlap', () => {
      const scores = Array.from({ length: 50 }, () => 0.6 + Math.random() * 0.2);
      const mean = (arr: number[]) => arr.reduce((a, b) => a + b, 0) / arr.length;

      const test = makeTest({
        controlResults: {
          sampleSize: 50,
          scores: [...scores],
          avgScore: mean(scores),
          successRate: 0.8,
          avgLatency: 100,
          totalCost: 0.5,
        },
        treatmentResults: {
          sampleSize: 50,
          scores: [...scores],
          avgScore: mean(scores),
          successRate: 0.8,
          avgLatency: 100,
          totalCost: 0.5,
        },
      });

      const outcome = framework.analyzeResults(test);

      expect(outcome.isSignificant).toBe(false);
      expect(outcome.winner).toBeNull();
    });
  });

  describe('checkAndCompleteIfReady', () => {
    it('returns null for non-running test', async () => {
      const test = await framework.createTest({
        agentId: 'agent-1',
        name: 'Test',
        controlInstructions: 'A',
        treatmentInstructions: 'B',
      });

      const outcome = await framework.checkAndCompleteIfReady(test.id);
      expect(outcome).toBeNull();
    });

    it('does not complete before min samples reached', async () => {
      const test = await framework.createTest({
        agentId: 'agent-1',
        name: 'Test',
        controlInstructions: 'A',
        treatmentInstructions: 'B',
        minSampleSize: 100,
      });
      await framework.startTest(test.id);

      await framework.recordResult(test.id, 'control', 0.8, 100, 0.01);

      const outcome = await framework.checkAndCompleteIfReady(test.id);
      expect(outcome).toBeNull();
    });
  });
});
