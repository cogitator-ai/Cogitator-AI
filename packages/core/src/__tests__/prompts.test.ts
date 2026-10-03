import { describe, it, expect, vi } from 'vitest';
import type { ChatRequest, ChatStreamChunk, LLMBackend, PromptsConfig } from '@cogitator-ai/types';
import { Cogitator } from '../cogitator';
import { Agent } from '../agent';
import { InMemoryInstructionVersionStore } from '../learning/prompt-stores';

/** Answers with the system prompt it was given, so tests can see which instructions ran. */
function echoBackend(fail = false) {
  const systems: string[] = [];
  const backend: LLMBackend = {
    provider: 'openai',
    chat: vi.fn(async (request: ChatRequest) => {
      const system = String(request.messages.find((m) => m.role === 'system')?.content ?? '');
      systems.push(system);
      if (fail) throw new Error('model down');
      return {
        id: 'r',
        content: system,
        finishReason: 'stop' as const,
        usage: { inputTokens: 10, outputTokens: 10, totalTokens: 20 },
      };
    }),
    chatStream: vi.fn(async function* (): AsyncGenerator<ChatStreamChunk> {
      yield { id: 's', delta: {}, finishReason: 'stop' };
    }),
  };
  return { backend, systems };
}

const agent = () => new Agent({ name: 'writer', model: 'mock/m', instructions: 'v0: be brief' });

function setup(prompts: PromptsConfig = {}, fail = false) {
  const { backend, systems } = echoBackend(fail);
  const cog = new Cogitator({ llm: { backends: { mock: backend } }, prompts });
  return { cog, systems };
}

describe('prompt versions', () => {
  it('runs the deployed version and records how its runs went', async () => {
    const { cog } = setup();
    const v1 = await cog.prompts.deploy('writer', 'v1: be thorough');

    const result = await cog.run(agent(), { input: 'hi' });

    expect(result.output).toBe('v1: be thorough');
    expect(result.prompt).toEqual({ key: 'writer', versionId: v1.id, version: 1 });
    const current = await cog.prompts.current('writer');
    expect(current?.metrics).toMatchObject({ runCount: 1, successRate: 1, avgScore: 1 });
    await cog.close();
  });

  it('rolls back to the previous instructions', async () => {
    const { cog } = setup();
    await cog.prompts.deploy('writer', 'v1: be thorough');
    await cog.prompts.deploy('writer', 'v2: be witty');

    const rollback = await cog.prompts.rollbackTo('writer');
    const result = await cog.run(agent(), { input: 'hi' });

    expect(rollback.success).toBe(true);
    expect(result.output).toBe('v1: be thorough');
    expect((await cog.prompts.history('writer')).map((v) => v.version)).toEqual([3, 2, 1]);
    await cog.close();
  });

  it('records a failed run against its version', async () => {
    const versions = new InMemoryInstructionVersionStore();
    const { cog } = setup({ versions }, true);
    await cog.prompts.deploy('writer', 'v1');

    await expect(cog.run(agent(), { input: 'hi' })).rejects.toThrow('model down');

    expect((await versions.getCurrent('writer'))?.metrics).toMatchObject({
      runCount: 1,
      successRate: 0,
      avgScore: 0,
    });
    await cog.close();
  });

  it('leaves agents alone when nothing is configured', async () => {
    const { backend, systems } = echoBackend();
    const cog = new Cogitator({ llm: { backends: { mock: backend } } });

    const result = await cog.run(agent(), { input: 'hi' });

    expect(systems).toEqual(['v0: be brief']);
    expect(result.prompt).toBeUndefined();
    await cog.close();
  });
});

describe('A/B tests', () => {
  it('keeps each thread on one variant', async () => {
    const { cog } = setup();
    await cog.prompts.startABTest(agent(), { name: 'tone', treatment: 'B: be playful' });

    const variants = new Map<string, Set<string>>();
    for (let thread = 0; thread < 12; thread++) {
      for (let turn = 0; turn < 2; turn++) {
        const result = await cog.run(agent(), { input: 'hi', threadId: `t${thread}` });
        const seen = variants.get(`t${thread}`) ?? new Set<string>();
        seen.add(result.prompt!.abTest!.variant);
        variants.set(`t${thread}`, seen);
      }
    }

    expect([...variants.values()].every((seen) => seen.size === 1)).toBe(true);
    const all = [...variants.values()].flatMap((seen) => [...seen]);
    expect(new Set(all)).toEqual(new Set(['control', 'treatment']));
    await cog.close();
  });

  it('runs the variant instructions and deploys a significant winner', async () => {
    const { cog } = setup({
      autoDeployWinner: true,
      score: (result) => (result.output.startsWith('B:') ? 1 : 0.2 + Math.random() * 0.01),
    });
    const test = await cog.prompts.startABTest(agent(), {
      name: 'tone',
      treatment: 'B: be playful',
      minSampleSize: 5,
    });

    for (let thread = 0; thread < 60; thread++) {
      await cog.run(agent(), { input: 'hi', threadId: `thread-${thread}` });
      if (!(await cog.prompts.activeABTest('writer'))) break;
    }

    expect(await cog.prompts.activeABTest('writer')).toBeNull();
    const current = await cog.prompts.current('writer');
    expect(current).toMatchObject({
      instructions: 'B: be playful',
      source: 'ab_test',
      sourceId: test.id,
    });
    const after = await cog.run(agent(), { input: 'hi' });
    expect(after.output).toBe('B: be playful');
    await cog.close();
  });
});
