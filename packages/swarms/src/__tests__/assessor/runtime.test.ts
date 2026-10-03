import { describe, it, expect, vi } from 'vitest';
import { Agent } from '@cogitator-ai/core';
import type { AssessorConfig, RunResult, SwarmConfig, TaskRequirements } from '@cogitator-ai/types';
import { createAssessor } from '../../assessor/assessor';
import type { AssessorRuntime } from '../../assessor/ai-task-analyzer';
import { createMockRunResult } from '../strategies/__mocks__/mock-helpers';

const swarmConfig: SwarmConfig = {
  name: 'assessed',
  strategy: 'round-robin',
  agents: [new Agent({ name: 'worker', model: 'ollama/llama3.3', instructions: 'Work' })],
};

const cloudOnly: AssessorConfig = { enabledProviders: ['openai', 'anthropic', 'google'] };

function runtime(options: {
  configured?: string[];
  analysis?: Partial<TaskRequirements> | Error;
}): AssessorRuntime & { run: ReturnType<typeof vi.fn> } {
  const configured = options.configured ?? ['openai', 'anthropic', 'google'];
  const run = vi.fn(async (): Promise<RunResult> => {
    if (options.analysis instanceof Error) throw options.analysis;
    return createMockRunResult('{}', { structured: options.analysis });
  });
  const route = (model: string) => {
    const provider = model.split('/')[0];
    if (!configured.includes(provider)) throw new Error(`${provider} API key is required`);
    return { backend: {}, model };
  };
  return { run, route } as unknown as AssessorRuntime & { run: ReturnType<typeof vi.fn> };
}

const aiAnalysis: TaskRequirements = {
  needsVision: true,
  needsToolCalling: false,
  needsLongContext: false,
  needsReasoning: 'advanced',
  needsSpeed: 'slow-ok',
  costSensitivity: 'low',
  complexity: 'complex',
  domains: ['legal'],
};

describe('SwarmAssessor with a Cogitator runtime', () => {
  it('offers only cloud models whose provider the Cogitator can run', async () => {
    const assessor = createAssessor(cloudOnly, runtime({ configured: ['anthropic'] }));

    const result = await assessor.analyze('Summarize the notes', swarmConfig);

    expect(result.discoveredModels.length).toBeGreaterThan(0);
    expect(result.discoveredModels.every((m) => m.provider === 'anthropic')).toBe(true);
    expect(result.assignments[0].provider).toBe('anthropic');
  });

  it('keeps the original model when no provider is configured', async () => {
    const assessor = createAssessor(cloudOnly, runtime({ configured: [] }));

    const result = await assessor.analyze('Summarize the notes', swarmConfig);

    expect(result.discoveredModels).toEqual([]);
    expect(result.assignments[0].assignedModel).toBe('ollama/llama3.3');
  });

  it('offers every enabled provider without a runtime', async () => {
    const assessor = createAssessor(cloudOnly);

    const result = await assessor.analyze('Summarize the notes', swarmConfig);

    expect(new Set(result.discoveredModels.map((m) => m.provider))).toEqual(
      new Set(['openai', 'anthropic', 'google'])
    );
  });

  it("uses the assessor model's analysis in 'ai' mode", async () => {
    const cogitator = runtime({ analysis: aiAnalysis });
    const assessor = createAssessor(
      { ...cloudOnly, mode: 'ai', assessorModel: 'anthropic/claude-haiku-4-5' },
      cogitator
    );

    const result = await assessor.analyze('Summarize the notes', swarmConfig);

    expect(result.taskAnalysis).toEqual(aiAnalysis);
    const [agent, options] = cogitator.run.mock.calls[0] as [Agent, { input: string }];
    expect(agent.model).toBe('anthropic/claude-haiku-4-5');
    expect(options.input).toBe('Summarize the notes');
  });

  it("adds the hard requirements the rules detect in 'hybrid' mode", async () => {
    const assessor = createAssessor(
      { ...cloudOnly, mode: 'hybrid' },
      runtime({ analysis: aiAnalysis })
    );

    const result = await assessor.analyze('Search the web for the contract terms', swarmConfig);

    expect(result.taskAnalysis).toMatchObject({
      needsVision: true,
      needsToolCalling: true,
      needsReasoning: 'advanced',
      complexity: 'complex',
    });
    expect(result.taskAnalysis.domains).toEqual(expect.arrayContaining(['legal']));
  });

  it('falls back to the rules with a warning when the assessor model fails', async () => {
    const assessor = createAssessor(
      { ...cloudOnly, mode: 'ai' },
      runtime({ analysis: new Error('model offline') })
    );

    const result = await assessor.analyze('Summarize the notes', swarmConfig);

    expect(result.taskAnalysis.needsVision).toBe(false);
    expect(result.warnings).toContainEqual(expect.stringContaining('model offline'));
  });

  it('falls back to the rules with a warning when the model returns no valid analysis', async () => {
    const assessor = createAssessor(
      { ...cloudOnly, mode: 'ai' },
      runtime({ analysis: { needsVision: true } })
    );

    const result = await assessor.analyze('Summarize the notes', swarmConfig);

    expect(result.taskAnalysis.needsVision).toBe(false);
    expect(result.warnings).toContainEqual(expect.stringContaining('valid task analysis'));
  });

  it("warns that 'ai' mode needs a Cogitator when used without one", async () => {
    const assessor = createAssessor({ ...cloudOnly, mode: 'ai' });

    const result = await assessor.analyze('Summarize the notes', swarmConfig);

    expect(result.warnings).toContainEqual(expect.stringContaining('needs a Cogitator'));
  });

  it("does not run the assessor model in 'rules' mode", async () => {
    const cogitator = runtime({ analysis: aiAnalysis });
    const assessor = createAssessor(cloudOnly, cogitator);

    await assessor.analyze('Summarize the notes', swarmConfig);

    expect(cogitator.run).not.toHaveBeenCalled();
  });
});
