import { describe, it, expect, vi } from 'vitest';
import type { ChatStreamChunk, LLMBackend, OptimizationResult } from '@cogitator-ai/types';
import { Cogitator } from '../cogitator';
import { Agent } from '../agent';
import {
  ABTestingFramework,
  AgentOptimizer,
  AutoOptimizer,
  PromptMonitor,
  RollbackManager,
} from '../learning/index';
import { InMemoryABTestStore, InMemoryInstructionVersionStore } from '../learning/prompt-stores';

function answeringBackend(): LLMBackend {
  return {
    provider: 'openai',
    chat: vi.fn(async () => ({
      id: 'r',
      content: 'ok',
      finishReason: 'stop' as const,
      usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 },
    })),
    chatStream: vi.fn(async function* (): AsyncGenerator<ChatStreamChunk> {
      yield* [];
    }),
  };
}

const improved: OptimizationResult = {
  success: true,
  instructionsBefore: 'v1',
  instructionsAfter: 'v2',
  demosAdded: [],
  demosRemoved: [],
  scoreBefore: 0.5,
  scoreAfter: 0.8,
  improvement: 0.3,
  tracesEvaluated: 10,
  bootstrapRounds: 2,
  duration: 1,
  tokensUsed: 0,
  errors: [],
};

async function setup(abDefaults: { defaultMinSampleSize?: number; defaultMaxDuration?: number }) {
  const abTests = new InMemoryABTestStore();
  const versions = new InMemoryInstructionVersionStore();
  const backend = answeringBackend();
  const cog = new Cogitator({
    llm: { backends: { mock: backend }, retry: false },
    prompts: { abTests, versions },
  });
  const agent = new Agent({ id: 'support', name: 'support', model: 'mock/m', instructions: 'v1' });

  const agentOptimizer = new AgentOptimizer({ llm: backend, model: 'm' });
  const compile = vi.spyOn(agentOptimizer, 'compile').mockResolvedValue(improved);
  const abTesting = new ABTestingFramework({ store: abTests, ...abDefaults });
  const rollbackManager = new RollbackManager({ store: versions });
  const autoOptimizer = new AutoOptimizer({
    enabled: true,
    triggerAfterRuns: 1000,
    agentOptimizer,
    abTesting,
    monitor: new PromptMonitor(),
    rollbackManager,
  });

  const runThread = async (threadId: string) => {
    const result = await cog.run(agent, { input: 'q', threadId, useMemory: false });
    const trace = await agentOptimizer.captureTrace(result, 'q');
    await autoOptimizer.recordExecution(trace);
    return trace;
  };

  return { cog, abTesting, rollbackManager, autoOptimizer, compile, runThread };
}

describe('AutoOptimizer A/B tests served through cogitator.prompts', () => {
  it('counts each run once, for the variant it used', async () => {
    const { cog, abTesting, rollbackManager, autoOptimizer, runThread } = await setup({});
    await rollbackManager.deployVersion('support', 'v1', 'manual');

    const run = await autoOptimizer.triggerOptimization('support');
    expect(run.status).toBe('testing');

    const traces = [];
    for (let i = 0; i < 20; i++) traces.push(await runThread(`thread_${i}`));

    const test = await abTesting.getTest(run.abTestId!);
    const treatmentRuns = traces.filter((t) => t.prompt?.abTest?.variant === 'treatment').length;
    expect(treatmentRuns).toBeGreaterThan(0);
    expect(test?.treatmentResults.sampleSize).toBe(treatmentRuns);
    expect(test?.controlResults.sampleSize).toBe(20 - treatmentRuns);
    await cog.close();
  });

  it('completes its optimization run when Cogitator completed the test', async () => {
    const { cog, rollbackManager, autoOptimizer, runThread } = await setup({
      defaultMaxDuration: 0,
    });
    await rollbackManager.deployVersion('support', 'v1', 'manual');

    const run = await autoOptimizer.triggerOptimization('support');
    await runThread('thread_1');

    expect(run.status).toBe('completed');
    expect(run.abTestOutcome).toBeDefined();
    await cog.close();
  });

  it('fails instead of optimizing empty instructions when no version is deployed', async () => {
    const { cog, autoOptimizer, compile } = await setup({});

    const run = await autoOptimizer.triggerOptimization('support');

    expect(run.status).toBe('failed');
    expect(run.error).toContain('no deployed instructions');
    expect(compile).not.toHaveBeenCalled();
    await cog.close();
  });

  it('optimizes the deployed instructions of the agent', async () => {
    const { cog, rollbackManager, autoOptimizer, compile } = await setup({});
    await rollbackManager.deployVersion('support', 'v1', 'manual');

    await autoOptimizer.triggerOptimization('support');

    const [agent] = compile.mock.calls[0];
    expect(agent).toMatchObject({ id: 'support', instructions: 'v1' });
    await cog.close();
  });
});
