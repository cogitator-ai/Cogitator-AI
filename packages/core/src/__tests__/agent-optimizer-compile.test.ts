import { describe, it, expect, vi } from 'vitest';
import type { LLMBackend, RunResult } from '@cogitator-ai/types';
import { Agent } from '../agent';
import { AgentOptimizer } from '../learning/index';
import type { TrainsetRunner } from '../learning/index';

const llm: LLMBackend = {
  provider: 'openai',
  chat: vi.fn(),
  chatStream: vi.fn(),
};

function result(agent: Agent, input: string, output: string): RunResult {
  return {
    output,
    runId: `run_${input}`,
    agentId: agent.id,
    threadId: 't',
    usage: { inputTokens: 5, outputTokens: 5, totalTokens: 10, cost: 0, duration: 1 },
    toolCalls: [],
    messages: [{ role: 'user', content: input }],
    trace: { traceId: `trace_${agent.instructions.length}_${input}`, spans: [] },
  };
}

/** Answers correctly only once the instructions ask for exact answers. */
function runner(): TrainsetRunner & { run: ReturnType<typeof vi.fn> } {
  return {
    run: vi.fn(async (agent: Agent, { input }: { input: string }) =>
      result(agent, input, agent.instructions.includes('exact') ? 'correct' : 'vague')
    ),
  };
}

function optimizerWith(cogitator?: TrainsetRunner) {
  const optimizer = new AgentOptimizer({ llm, model: 'm', ...(cogitator && { cogitator }) });
  vi.spyOn(optimizer.getMetricEvaluator(), 'evaluate').mockImplementation(async (trace) => ({
    score: trace.output === 'correct' ? 1 : 0.2,
    results: [],
    passed: trace.output === 'correct',
  }));
  vi.spyOn(optimizer.getInstructionOptimizer(), 'optimize').mockImplementation(
    async (_agentId, current) => ({
      originalInstructions: current,
      optimizedInstructions: `${current} Give exact answers.`,
      improvement: 0.3,
      gapsAddressed: [],
      candidatesEvaluated: 1,
      reasoning: 'answers were vague',
    })
  );
  return optimizer;
}

const trainset = [
  { input: 'q1', expected: 'correct' },
  { input: 'q2', expected: 'correct' },
];

describe('AgentOptimizer.compile', () => {
  it('runs the trainset before and after optimizing and reports the measured change', async () => {
    const cogitator = runner();
    const optimizer = optimizerWith(cogitator);
    const agent = new Agent({ name: 'qa', model: 'm', instructions: 'Answer.' });

    const outcome = await optimizer.compile(agent, trainset, { maxRounds: 1 });

    expect(outcome.errors).toEqual([]);
    expect(outcome.scoreBefore).toBeCloseTo(0.2);
    expect(outcome.scoreAfter).toBe(1);
    expect(outcome.improvement).toBeCloseTo(0.8);
    expect(outcome.instructionsAfter).toBe('Answer. Give exact answers.');
    expect(cogitator.run).toHaveBeenCalledTimes(4);
    expect(outcome.tracesEvaluated).toBe(4);
  });

  it('hands the stored traces to the instruction optimizer each round', async () => {
    const optimizer = optimizerWith(runner());
    const agent = new Agent({ name: 'qa', model: 'm', instructions: 'Answer.' });

    await optimizer.compile(agent, trainset, { maxRounds: 2 });

    const calls = vi.mocked(optimizer.getInstructionOptimizer().optimize).mock.calls;
    expect(calls).toHaveLength(2);
    expect(calls[0][2]?.traces?.map((t) => t.input).sort()).toEqual(['q1', 'q2']);
  });

  it('says why a trainset cannot run and falls back to the estimate', async () => {
    const optimizer = optimizerWith();
    const agent = new Agent({ name: 'qa', model: 'm', instructions: 'Answer.' });

    const outcome = await optimizer.compile(agent, trainset, { maxRounds: 1 });

    expect(outcome.errors[0]).toContain('cogitator');
    expect(outcome.success).toBe(false);
  });

  it('estimates the score after from stored traces when there is no trainset', async () => {
    const optimizer = optimizerWith();
    const agent = new Agent({ name: 'qa', model: 'm', instructions: 'Answer.' });
    await optimizer.captureTrace(result(agent, 'q1', 'vague'), 'q1');

    const outcome = await optimizer.compile(agent, [], { maxRounds: 1 });

    expect(outcome.errors).toEqual([]);
    expect(outcome.scoreBefore).toBeCloseTo(0.2);
    expect(outcome.scoreAfter).toBeCloseTo(0.5);
    expect(outcome.improvement).toBeGreaterThan(0);
  });
});
