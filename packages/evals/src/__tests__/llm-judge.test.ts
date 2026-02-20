import { describe, it, expect, vi } from 'vitest';
import {
  faithfulness,
  relevance,
  coherence,
  helpfulness,
  llmMetric,
  bindJudgeContext,
} from '../metrics/llm-judge';
import type { EvalCaseResult } from '../metrics/types';
import type { JudgeContext } from '../metrics/llm-judge';

function makeResult(output: string, input = 'test input', expected?: string): EvalCaseResult {
  return {
    case: { input, expected },
    output,
    duration: 100,
  };
}

function makeJudgeContext(output: string): JudgeContext {
  return {
    cogitator: {
      run: vi.fn().mockResolvedValue({ output }),
    },
    judgeConfig: { model: 'gpt-4o', temperature: 0 },
  };
}

describe('LLM judge metrics', () => {
  describe('requiresJudge flag', () => {
    it('faithfulness has requiresJudge = true', () => {
      expect(faithfulness().requiresJudge).toBe(true);
    });

    it('relevance has requiresJudge = true', () => {
      expect(relevance().requiresJudge).toBe(true);
    });

    it('coherence has requiresJudge = true', () => {
      expect(coherence().requiresJudge).toBe(true);
    });

    it('helpfulness has requiresJudge = true', () => {
      expect(helpfulness().requiresJudge).toBe(true);
    });

    it('llmMetric has requiresJudge = true', () => {
      expect(llmMetric({ name: 'custom', prompt: 'Rate it' }).requiresJudge).toBe(true);
    });
  });

  describe('metricName property', () => {
    it('faithfulness has correct metricName', () => {
      expect(faithfulness().metricName).toBe('faithfulness');
    });

    it('relevance has correct metricName', () => {
      expect(relevance().metricName).toBe('relevance');
    });

    it('coherence has correct metricName', () => {
      expect(coherence().metricName).toBe('coherence');
    });

    it('helpfulness has correct metricName', () => {
      expect(helpfulness().metricName).toBe('helpfulness');
    });

    it('llmMetric uses provided name', () => {
      expect(llmMetric({ name: 'tone', prompt: 'Rate tone' }).metricName).toBe('tone');
    });
  });

  describe('faithfulness', () => {
    it('returns correct score from judge response', async () => {
      const ctx = makeJudgeContext('{"score": 0.85, "reasoning": "Good faithfulness"}');
      const bound = bindJudgeContext(faithfulness(), ctx);
      const result = await bound(makeResult('Paris is the capital of France'));

      expect(result.name).toBe('faithfulness');
      expect(result.score).toBe(0.85);
      expect(result.details).toBe('Good faithfulness');
    });

    it('calls cogitator.run with correct prompt structure', async () => {
      const ctx = makeJudgeContext('{"score": 0.9, "reasoning": "ok"}');
      const bound = bindJudgeContext(faithfulness(), ctx);
      await bound(makeResult('some output', 'some input', 'expected answer'));

      expect(ctx.cogitator.run).toHaveBeenCalledTimes(1);
      const call = (ctx.cogitator.run as ReturnType<typeof vi.fn>).mock.calls[0][0];
      expect(call.input).toContain('some input');
      expect(call.input).toContain('some output');
      expect(call.input).toContain('expected answer');
    });
  });

  describe('relevance', () => {
    it('returns correct score', async () => {
      const ctx = makeJudgeContext('{"score": 0.7, "reasoning": "Somewhat relevant"}');
      const bound = bindJudgeContext(relevance(), ctx);
      const result = await bound(makeResult('answer'));

      expect(result.name).toBe('relevance');
      expect(result.score).toBe(0.7);
      expect(result.details).toBe('Somewhat relevant');
    });

    it('uses a different prompt than faithfulness', async () => {
      const faithCtx = makeJudgeContext('{"score": 0.9, "reasoning": "ok"}');
      const relCtx = makeJudgeContext('{"score": 0.9, "reasoning": "ok"}');

      const boundFaith = bindJudgeContext(faithfulness(), faithCtx);
      const boundRel = bindJudgeContext(relevance(), relCtx);

      await boundFaith(makeResult('output'));
      await boundRel(makeResult('output'));

      const faithCall = (faithCtx.cogitator.run as ReturnType<typeof vi.fn>).mock.calls[0][0];
      const relCall = (relCtx.cogitator.run as ReturnType<typeof vi.fn>).mock.calls[0][0];

      expect(faithCall.input).not.toBe(relCall.input);
    });
  });

  describe('coherence', () => {
    it('returns correct score', async () => {
      const ctx = makeJudgeContext('{"score": 0.95, "reasoning": "Very coherent"}');
      const bound = bindJudgeContext(coherence(), ctx);
      const result = await bound(makeResult('well structured answer'));

      expect(result.name).toBe('coherence');
      expect(result.score).toBe(0.95);
    });

    it('has a unique prompt', async () => {
      const ctx = makeJudgeContext('{"score": 0.9, "reasoning": "ok"}');
      const bound = bindJudgeContext(coherence(), ctx);
      await bound(makeResult('output'));

      const call = (ctx.cogitator.run as ReturnType<typeof vi.fn>).mock.calls[0][0];
      expect(call.input).toBeDefined();
    });
  });

  describe('helpfulness', () => {
    it('returns correct score', async () => {
      const ctx = makeJudgeContext('{"score": 0.6, "reasoning": "Could be more helpful"}');
      const bound = bindJudgeContext(helpfulness(), ctx);
      const result = await bound(makeResult('brief answer'));

      expect(result.name).toBe('helpfulness');
      expect(result.score).toBe(0.6);
      expect(result.details).toBe('Could be more helpful');
    });
  });

  describe('llmMetric (custom)', () => {
    it('uses custom prompt', async () => {
      const ctx = makeJudgeContext('{"score": 0.8, "reasoning": "Professional tone"}');
      const m = llmMetric({ name: 'tone', prompt: 'Rate the professionalism of the response' });
      const bound = bindJudgeContext(m, ctx);
      const result = await bound(makeResult('Dear user, here is your answer'));

      expect(result.name).toBe('tone');
      expect(result.score).toBe(0.8);

      const call = (ctx.cogitator.run as ReturnType<typeof vi.fn>).mock.calls[0][0];
      expect(call.input).toContain('Dear user, here is your answer');
    });
  });

  describe('error handling', () => {
    it('returns score 0 when cogitator.run throws', async () => {
      const ctx: JudgeContext = {
        cogitator: {
          run: vi.fn().mockRejectedValue(new Error('API timeout')),
        },
        judgeConfig: { model: 'gpt-4o', temperature: 0 },
      };
      const bound = bindJudgeContext(faithfulness(), ctx);
      const result = await bound(makeResult('output'));

      expect(result.score).toBe(0);
      expect(result.details).toContain('API timeout');
    });

    it('returns score 0 when judge returns invalid JSON', async () => {
      const ctx = makeJudgeContext('This is not valid JSON at all');
      const bound = bindJudgeContext(faithfulness(), ctx);
      const result = await bound(makeResult('output'));

      expect(result.score).toBe(0);
      expect(result.details).toContain('could not parse judge response');
    });

    it('uses regex fallback to extract score from non-JSON response', async () => {
      const ctx = makeJudgeContext('The score is 0.75 because the answer was good');
      const bound = bindJudgeContext(faithfulness(), ctx);
      const result = await bound(makeResult('output'));

      expect(result.score).toBe(0.75);
    });

    it('returns score 0 when JSON has no score field', async () => {
      const ctx = makeJudgeContext('{"rating": 0.9, "reasoning": "Great"}');
      const bound = bindJudgeContext(faithfulness(), ctx);
      const result = await bound(makeResult('output'));

      expect(result.score).toBe(0);
      expect(result.details).toContain('could not parse judge response');
    });

    it('returns score 0 when score is not a number', async () => {
      const ctx = makeJudgeContext('{"score": "high", "reasoning": "Great"}');
      const bound = bindJudgeContext(faithfulness(), ctx);
      const result = await bound(makeResult('output'));

      expect(result.score).toBe(0);
      expect(result.details).toContain('could not parse judge response');
    });
  });

  describe('bindJudgeContext', () => {
    it('returns a MetricFn without requiresJudge', () => {
      const ctx = makeJudgeContext('{"score": 1, "reasoning": "ok"}');
      const bound = bindJudgeContext(faithfulness(), ctx);

      expect(bound.metricName).toBe('faithfulness');
      expect('requiresJudge' in bound).toBe(false);
    });

    it('bound metric is callable', async () => {
      const ctx = makeJudgeContext('{"score": 0.5, "reasoning": "ok"}');
      const bound = bindJudgeContext(faithfulness(), ctx);
      const result = await bound(makeResult('output'));

      expect(result.score).toBe(0.5);
    });
  });

  describe('judge message formatting', () => {
    it('includes N/A when expected is not provided', async () => {
      const ctx = makeJudgeContext('{"score": 0.9, "reasoning": "ok"}');
      const bound = bindJudgeContext(faithfulness(), ctx);
      await bound(makeResult('output', 'input'));

      const call = (ctx.cogitator.run as ReturnType<typeof vi.fn>).mock.calls[0][0];
      expect(call.input).toContain('N/A');
    });

    it('includes expected value when provided', async () => {
      const ctx = makeJudgeContext('{"score": 0.9, "reasoning": "ok"}');
      const bound = bindJudgeContext(faithfulness(), ctx);
      await bound(makeResult('output', 'input', 'the expected'));

      const call = (ctx.cogitator.run as ReturnType<typeof vi.fn>).mock.calls[0][0];
      expect(call.input).toContain('the expected');
      expect(call.input).not.toContain('N/A');
    });
  });

  describe('score clamping', () => {
    it('clamps score above 1 to 1', async () => {
      const ctx = makeJudgeContext('{"score": 1.5, "reasoning": "over"}');
      const bound = bindJudgeContext(faithfulness(), ctx);
      const result = await bound(makeResult('output'));

      expect(result.score).toBe(1);
    });

    it('clamps score below 0 to 0', async () => {
      const ctx = makeJudgeContext('{"score": -0.3, "reasoning": "under"}');
      const bound = bindJudgeContext(faithfulness(), ctx);
      const result = await bound(makeResult('output'));

      expect(result.score).toBe(0);
    });
  });
});
