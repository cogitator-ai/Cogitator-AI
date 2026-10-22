import { describe, it, expect } from 'vitest';
import type { Cogitator } from '@cogitator-ai/core';
import type { RunOptions, RunResult } from '@cogitator-ai/types';
import { cogitatorModel } from '../provider';
import { collect, createAgent, createFakeCogitator } from './helpers';

/** A runtime whose run hands off, falls back to another model, then answers */
function eventfulCogitator(): Cogitator {
  const { cogitator, run } = createFakeCogitator({ tokens: ['Done'] });
  const answer = run.getMockImplementation()!;
  run.mockImplementation(async (agent, options: RunOptions): Promise<RunResult> => {
    options.onHandoff?.({ from: 'triage', to: 'billing', reason: 'a refund' });
    options.onModelFallback?.({
      from: 'openai/gpt-x',
      to: 'anthropic/claude-y',
      error: new Error('rate limited'),
    });
    return answer(agent, options);
  });
  return cogitator;
}

const call = {
  prompt: [{ role: 'user' as const, content: [{ type: 'text' as const, text: 'Hi' }] }],
};

const handoff = {
  type: 'custom',
  kind: 'cogitator.handoff',
  providerMetadata: { cogitator: { from: 'triage', to: 'billing', reason: 'a refund' } },
};
const fallback = {
  type: 'custom',
  kind: 'cogitator.model-fallback',
  providerMetadata: {
    cogitator: { from: 'openai/gpt-x', to: 'anthropic/claude-y', error: 'rate limited' },
  },
};

describe('agent events as custom parts', () => {
  it('puts handoffs and model fallbacks in the content of a v4 answer, in order', async () => {
    const model = cogitatorModel(eventfulCogitator(), createAgent('triage'), {
      specificationVersion: 'v4',
    });

    const { content } = await model.doGenerate(call);

    expect(content.slice(0, 2)).toEqual([handoff, fallback]);
    expect(content.at(-1)).toEqual({ type: 'text', text: 'Done' });
  });

  it('streams them as they happen, before the text that follows', async () => {
    const model = cogitatorModel(eventfulCogitator(), createAgent('triage'), {
      specificationVersion: 'v4',
    });

    const { stream } = await model.doStream(call);
    const parts = await collect(stream);
    const types = parts.map((part) => (part.type === 'custom' ? part.kind : part.type));

    expect(types.indexOf('cogitator.handoff')).toBeLessThan(
      types.indexOf('cogitator.model-fallback')
    );
    expect(types.indexOf('cogitator.model-fallback')).toBeLessThan(types.indexOf('text-delta'));
    expect(parts.filter((part) => part.type === 'custom')).toEqual([handoff, fallback]);
  });

  it('leaves them out of specifications without custom parts', async () => {
    const model = cogitatorModel(eventfulCogitator(), createAgent('triage'), {
      specificationVersion: 'v3',
    });

    const { content } = await model.doGenerate(call);

    expect(content.some((part) => (part as { type: string }).type === 'custom')).toBe(false);
  });
});
