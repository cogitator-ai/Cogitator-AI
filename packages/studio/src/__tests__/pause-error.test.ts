import { describe, it, expect } from 'vitest';
import type { RunInterrupt, RunResult } from '@cogitator-ai/types';
import { pauseError } from '../host/runner.js';

function paused(interrupts: RunInterrupt[]): RunResult {
  return { status: 'paused', interrupts, pendingApprovals: [] } as unknown as RunResult;
}

const plan: RunInterrupt = {
  id: 'p1#0',
  kind: 'plan',
  reason: 'plan_approval',
  message: 'Approve the plan so the agent can carry it out',
  details: { plan: '1. Read' },
};

const budget: RunInterrupt = {
  id: 'budget:session.cost',
  kind: 'budget',
  reason: 'budget_exceeded',
  message: 'The session reached its budget',
  details: { scope: 'session', metric: 'cost', used: 1.2, limit: 1 },
};

const question: RunInterrupt = {
  id: 'q1#0',
  kind: 'input',
  reason: 'confirm_plan',
  message: 'Go ahead?',
};

describe('pauseError', () => {
  it('says a run waits for the approval of its plan', () => {
    expect(pauseError(paused([plan]))).toBe(
      'The run paused for the approval of its plan. The studio does not approve plans, run the agent outside plan mode or mock exit_plan_mode in a fork.'
    );
  });

  it('says a run reached a budget', () => {
    expect(pauseError(paused([budget]))).toBe(
      'The run paused at a session cost budget it reached. The studio does not raise budgets, raise the budget of the project and run it again.'
    );
  });

  it('names each thing a run waits on, with the advice for each kind once', () => {
    expect(pauseError(paused([question, budget]))).toBe(
      'The run paused to ask confirm_plan ("Go ahead?"), at a session cost budget it reached. The studio does not answer questions of tools, mock the tool result in a fork instead. The studio does not raise budgets, raise the budget of the project and run it again.'
    );
  });
});
