import { describe, it, expect, afterEach } from 'vitest';
import { Agent, Cogitator } from '@cogitator-ai/core';
import { CogitatorError, ErrorCode, type ModelFallbackEvent, type Span } from '@cogitator-ai/types';
import { getOllamaUrl, getTestModel, ollamaSkipReason } from '../../helpers/setup';

const describeE2E = describe.skipIf((await ollamaSkipReason()) !== null);

const MISSING = 'ollama/cogitator-e2e-missing-model:1b';

let cogitator: Cogitator | undefined;

afterEach(async () => {
  await cogitator?.close();
  cogitator = undefined;
});

function ollamaCogitator(): Cogitator {
  cogitator = new Cogitator({
    llm: { providers: { ollama: { baseUrl: getOllamaUrl() } }, retry: false },
  });
  return cogitator;
}

describeE2E('Core: model fallback', () => {
  it(
    'answers on the fallback model when the primary one is not there',
    { timeout: 120_000 },
    async () => {
      const cog = ollamaCogitator();
      const fallback = `ollama/${getTestModel()}`;
      const agent = new Agent({
        name: 'fallback-agent',
        model: MISSING,
        fallbackModels: [fallback],
        instructions: 'Reply with one short sentence.',
      });
      const events: ModelFallbackEvent[] = [];
      const spans: Span[] = [];

      const result = await cog.run(agent, {
        input: 'Say hello.',
        onModelFallback: (event) => events.push(event),
        onSpan: (span) => spans.push(span),
      });

      expect(result.output.length).toBeGreaterThan(0);
      expect(result.modelUsed).toBe(fallback);
      expect(events).toHaveLength(1);
      expect(events[0]).toMatchObject({ from: MISSING, to: fallback });
      expect((events[0].error as CogitatorError).details?.kind).toBe('not_found');
      expect(spans.some((span) => span.name === 'llm.fallback')).toBe(true);
    }
  );

  it(
    'fails with every attempt when no model of the agent answers',
    { timeout: 60_000 },
    async () => {
      const cog = ollamaCogitator();
      const agent = new Agent({
        name: 'no-model-agent',
        model: MISSING,
        fallbackModels: ['ollama/cogitator-e2e-also-missing:1b'],
        instructions: 'Reply.',
      });

      const error = await cog.run(agent, { input: 'Hello' }).catch((e: unknown) => e);

      expect(error).toBeInstanceOf(CogitatorError);
      const failed = error as CogitatorError;
      expect(failed.code).toBe(ErrorCode.LLM_UNAVAILABLE);
      expect(failed.details?.attempts).toEqual([
        expect.objectContaining({ model: MISSING, kind: 'not_found' }),
        expect.objectContaining({
          model: 'ollama/cogitator-e2e-also-missing:1b',
          kind: 'not_found',
        }),
      ]);
    }
  );

  it(
    'skips a missing model in later runs once its breaker opened',
    { timeout: 120_000 },
    async () => {
      const cog = ollamaCogitator();
      const fallback = `ollama/${getTestModel()}`;
      const agent = new Agent({
        name: 'breaker-agent',
        model: MISSING,
        fallbackModels: [fallback],
        instructions: 'Reply with one word.',
      });
      const events: ModelFallbackEvent[] = [];

      await cog.run(agent, { input: 'One', onModelFallback: (event) => events.push(event) });
      await cog.run(agent, { input: 'Two', onModelFallback: (event) => events.push(event) });

      expect(events).toHaveLength(2);
      expect((events[1].error as CogitatorError).code).toBe(ErrorCode.CIRCUIT_OPEN);
    }
  );
});
