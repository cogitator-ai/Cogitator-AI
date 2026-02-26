import { describe, it, expect, beforeEach, vi } from 'vitest';
import { TaskAnalyzer } from '../cost-routing/task-analyzer';
import { CostTracker } from '../cost-routing/cost-tracker';
import { BudgetEnforcer } from '../cost-routing/budget-enforcer';
import { CostAwareRouter } from '../cost-routing/cost-router';
import type { BudgetConfig } from '@cogitator-ai/types';

describe('TaskAnalyzer', () => {
  let analyzer: TaskAnalyzer;

  beforeEach(() => {
    analyzer = new TaskAnalyzer();
  });

  it('detects simple tasks', () => {
    const requirements = analyzer.analyze('What is 2+2?');
    expect(requirements.complexity).toBe('simple');
    expect(requirements.needsReasoning).toBe('basic');
  });

  it('detects complex tasks', () => {
    const longComplexTask = Array(20)
      .fill(
        'Analyze this large codebase and then compare the architecture patterns. ' +
          'First, identify all the design patterns used. Second, evaluate their effectiveness. ' +
          'Third, suggest improvements. Finally, create a comprehensive report. ' +
          'If there are issues, fix them. Otherwise, document the findings.'
      )
      .join(' ');
    const requirements = analyzer.analyze(longComplexTask);
    expect(requirements.complexity).toBe('complex');
  });

  it('detects vision requirements', () => {
    const requirements = analyzer.analyze('Analyze this image and describe what you see');
    expect(requirements.needsVision).toBe(true);
  });

  it('detects tool requirements', () => {
    const requirements = analyzer.analyze('Search the web for the latest news about AI');
    expect(requirements.needsToolCalling).toBe(true);
  });

  it('detects long context needs', () => {
    const requirements = analyzer.analyze('Analyze this entire codebase repository');
    expect(requirements.needsLongContext).toBe(true);
  });

  it('detects advanced reasoning', () => {
    const requirements = analyzer.analyze('Analyze and synthesize these complex arguments');
    expect(requirements.needsReasoning).toBe('advanced');
  });

  it('detects moderate reasoning', () => {
    const requirements = analyzer.analyze('Summarize this document');
    expect(requirements.needsReasoning).toBe('moderate');
  });

  it('detects speed preferences', () => {
    const fast = analyzer.analyze('Quick answer: what time is it?');
    expect(fast.needsSpeed).toBe('fast');

    const slow = analyzer.analyze('Provide a thorough and comprehensive analysis');
    expect(slow.needsSpeed).toBe('slow-ok');
  });

  it('detects cost sensitivity', () => {
    const cheap = analyzer.analyze('Give me a cheap and budget-friendly solution');
    expect(cheap.costSensitivity).toBe('high');

    const premium = analyzer.analyze('I need the best and most accurate result');
    expect(premium.costSensitivity).toBe('low');
  });

  it('detects code domain', () => {
    const requirements = analyzer.analyze('Write a TypeScript function to parse JSON');
    expect(requirements.domains).toContain('code');
  });

  it('detects multiple domains', () => {
    const requirements = analyzer.analyze(
      'Analyze financial data and write code to visualize the statistics'
    );
    expect(requirements.domains).toContain('code');
    expect(requirements.domains).toContain('finance');
    expect(requirements.domains).toContain('analysis');
  });
});

describe('CostTracker', () => {
  let tracker: CostTracker;

  beforeEach(() => {
    tracker = new CostTracker();
  });

  it('records and retrieves run cost', () => {
    tracker.record({
      runId: 'run1',
      agentId: 'agent1',
      model: 'gpt-4o',
      inputTokens: 1000,
      outputTokens: 500,
      cost: 0.05,
    });

    expect(tracker.getRunCost('run1')).toBe(0.05);
  });

  it('tracks multiple records for same run', () => {
    tracker.record({
      runId: 'run1',
      agentId: 'agent1',
      model: 'gpt-4o',
      inputTokens: 1000,
      outputTokens: 500,
      cost: 0.05,
    });
    tracker.record({
      runId: 'run1',
      agentId: 'agent1',
      model: 'gpt-4o',
      inputTokens: 500,
      outputTokens: 250,
      cost: 0.025,
    });

    expect(tracker.getRunCost('run1')).toBeCloseTo(0.075, 6);
  });

  it('returns summary with totals', () => {
    tracker.record({
      runId: 'run1',
      agentId: 'agent1',
      model: 'gpt-4o',
      inputTokens: 1000,
      outputTokens: 500,
      cost: 0.05,
    });
    tracker.record({
      runId: 'run2',
      agentId: 'agent2',
      model: 'gpt-4o-mini',
      inputTokens: 2000,
      outputTokens: 1000,
      cost: 0.01,
    });

    const summary = tracker.getSummary();

    expect(summary.totalCost).toBeCloseTo(0.06, 6);
    expect(summary.totalInputTokens).toBe(3000);
    expect(summary.totalOutputTokens).toBe(1500);
    expect(summary.runCount).toBe(2);
    expect(summary.byModel['gpt-4o']).toBe(0.05);
    expect(summary.byModel['gpt-4o-mini']).toBe(0.01);
    expect(summary.byAgent.agent1).toBe(0.05);
    expect(summary.byAgent.agent2).toBe(0.01);
  });

  it('filters summary by agentId', () => {
    tracker.record({
      runId: 'run1',
      agentId: 'agent1',
      model: 'gpt-4o',
      inputTokens: 1000,
      outputTokens: 500,
      cost: 0.05,
    });
    tracker.record({
      runId: 'run2',
      agentId: 'agent2',
      model: 'gpt-4o',
      inputTokens: 1000,
      outputTokens: 500,
      cost: 0.05,
    });

    const summary = tracker.getSummary({ agentId: 'agent1' });
    expect(summary.totalCost).toBe(0.05);
    expect(summary.runCount).toBe(1);
  });

  it('clears all records', () => {
    tracker.record({
      runId: 'run1',
      agentId: 'agent1',
      model: 'gpt-4o',
      inputTokens: 1000,
      outputTokens: 500,
      cost: 0.05,
    });

    tracker.clear();
    const summary = tracker.getSummary();
    expect(summary.totalCost).toBe(0);
    expect(summary.runCount).toBe(0);
  });

  it('caps records at MAX_RECORDS (10000) and drops oldest', () => {
    for (let i = 0; i < 10_050; i++) {
      tracker.record({
        runId: `run_${i}`,
        agentId: 'agent1',
        model: 'gpt-4o',
        inputTokens: 1,
        outputTokens: 1,
        cost: 0.001,
      });
    }

    const records = tracker.getRecords();
    expect(records.length).toBe(10_000);

    expect(tracker.getRunCost('run_0')).toBe(0);
    expect(tracker.getRunCost('run_49')).toBe(0);
    expect(tracker.getRunCost('run_50')).toBeGreaterThan(0);
    expect(tracker.getRunCost('run_10049')).toBeGreaterThan(0);
  });
});

describe('BudgetEnforcer', () => {
  let tracker: CostTracker;

  beforeEach(() => {
    tracker = new CostTracker();
  });

  it('allows within budget', () => {
    const config: BudgetConfig = {
      maxCostPerRun: 0.1,
    };
    const enforcer = new BudgetEnforcer(config, tracker);

    const result = enforcer.checkBudget(0.05);
    expect(result.allowed).toBe(true);
  });

  it('blocks over per-run limit', () => {
    const config: BudgetConfig = {
      maxCostPerRun: 0.1,
    };
    const enforcer = new BudgetEnforcer(config, tracker);

    const result = enforcer.checkBudget(0.15);
    expect(result.allowed).toBe(false);
    expect(result.reason).toContain('per-run limit');
  });

  it('blocks when hourly limit would be exceeded', () => {
    tracker.record({
      runId: 'run1',
      agentId: 'agent1',
      model: 'gpt-4o',
      inputTokens: 1000,
      outputTokens: 500,
      cost: 4.5,
    });

    const config: BudgetConfig = {
      maxCostPerHour: 5.0,
    };
    const enforcer = new BudgetEnforcer(config, tracker);

    const result = enforcer.checkBudget(1.0);
    expect(result.allowed).toBe(false);
    expect(result.reason).toContain('hourly budget');
  });

  it('blocks when daily limit would be exceeded', () => {
    tracker.record({
      runId: 'run1',
      agentId: 'agent1',
      model: 'gpt-4o',
      inputTokens: 1000,
      outputTokens: 500,
      cost: 95.0,
    });

    const config: BudgetConfig = {
      maxCostPerDay: 100.0,
    };
    const enforcer = new BudgetEnforcer(config, tracker);

    const result = enforcer.checkBudget(10.0);
    expect(result.allowed).toBe(false);
    expect(result.reason).toContain('daily budget');
  });

  it('triggers warning callback at threshold', () => {
    tracker.record({
      runId: 'run1',
      agentId: 'agent1',
      model: 'gpt-4o',
      inputTokens: 1000,
      outputTokens: 500,
      cost: 4.0,
    });

    const onWarning = vi.fn();
    const config: BudgetConfig = {
      maxCostPerHour: 5.0,
      warningThreshold: 0.8,
      onBudgetWarning: onWarning,
    };
    const enforcer = new BudgetEnforcer(config, tracker);

    enforcer.checkBudget(0.1);
    expect(onWarning).toHaveBeenCalledWith(4.0, 5.0);
  });

  it('triggers exceeded callback', () => {
    const onExceeded = vi.fn();
    const config: BudgetConfig = {
      maxCostPerRun: 0.1,
      onBudgetExceeded: onExceeded,
    };
    const enforcer = new BudgetEnforcer(config, tracker);

    enforcer.checkBudget(0.15);
    expect(onExceeded).toHaveBeenCalled();
  });

  it('returns budget status', () => {
    tracker.record({
      runId: 'run1',
      agentId: 'agent1',
      model: 'gpt-4o',
      inputTokens: 1000,
      outputTokens: 500,
      cost: 2.0,
    });

    const config: BudgetConfig = {
      maxCostPerHour: 5.0,
      maxCostPerDay: 100.0,
    };
    const enforcer = new BudgetEnforcer(config, tracker);

    const status = enforcer.getBudgetStatus();
    expect(status.hourlyUsed).toBe(2.0);
    expect(status.hourlyLimit).toBe(5.0);
    expect(status.hourlyRemaining).toBe(3.0);
    expect(status.dailyRemaining).toBe(98.0);
  });
});

describe('CostAwareRouter', () => {
  it('creates with default config', () => {
    const router = new CostAwareRouter();
    const config = router.getConfig();

    expect(config.enabled).toBe(true);
    expect(config.autoSelectModel).toBe(false);
    expect(config.preferLocal).toBe(true);
    expect(config.trackCosts).toBe(true);
  });

  it('analyzes task requirements', () => {
    const router = new CostAwareRouter();
    const requirements = router.analyzeTask('What is 2+2?');

    expect(requirements.complexity).toBe('simple');
    expect(requirements.needsReasoning).toBe('basic');
  });

  it('records and retrieves cost', () => {
    const router = new CostAwareRouter();

    router.recordCost({
      runId: 'run1',
      agentId: 'agent1',
      model: 'gpt-4o',
      inputTokens: 1000,
      outputTokens: 500,
      cost: 0.05,
    });

    expect(router.getRunCost('run1')).toBe(0.05);
    expect(router.getCostSummary().totalCost).toBe(0.05);
  });

  it('checks budget when configured', () => {
    const router = new CostAwareRouter({
      config: {
        enabled: true,
        budget: {
          maxCostPerRun: 0.1,
        },
      },
    });

    const allowed = router.checkBudget(0.05);
    expect(allowed.allowed).toBe(true);

    const blocked = router.checkBudget(0.15);
    expect(blocked.allowed).toBe(false);
  });

  it('allows all when no budget configured', () => {
    const router = new CostAwareRouter();

    const result = router.checkBudget(1000);
    expect(result.allowed).toBe(true);
  });

  it('updates config', () => {
    const router = new CostAwareRouter();
    expect(router.getConfig().autoSelectModel).toBe(false);

    router.updateConfig({ autoSelectModel: true });
    expect(router.getConfig().autoSelectModel).toBe(true);
  });

  it('clears cost history', () => {
    const router = new CostAwareRouter();

    router.recordCost({
      runId: 'run1',
      agentId: 'agent1',
      model: 'gpt-4o',
      inputTokens: 1000,
      outputTokens: 500,
      cost: 0.05,
    });

    router.clearCostHistory();
    expect(router.getCostSummary().totalCost).toBe(0);
  });
});
