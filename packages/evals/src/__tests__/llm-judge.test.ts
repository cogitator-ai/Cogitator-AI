import { describe, it, expect, vi } from 'vitest';
import {
  faithfulness,
  relevance,
  coherence,
  helpfulness,
  contextRelevance,
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
    it('shows the judge the case context, so faithfulness can be checked against sources', async () => {
      const ctx = makeJudgeContext('{"score": 0.2, "reasoning": "Invents a number"}');
      const bound = bindJudgeContext(faithfulness(), ctx);
      await bound({
        case: {
          input: 'Write the lede',
          context: { dossier: 'The council voted 7 to 2.', sources: ['minutes', 'report'] },
        },
        output: 'The council voted 8 to 1.',
        duration: 10,
      });

      const call = (ctx.cogitator.run as ReturnType<typeof vi.fn>).mock.calls[0][0];
      expect(call.input).toContain('<context>\ndossier: The council voted 7 to 2.');
      expect(call.input).toContain('"minutes"');
      expect(call.input.indexOf('<context>')).toBeLessThan(call.input.indexOf('<response>'));
    });

    it('leaves the context block out when a case has none', async () => {
      const ctx = makeJudgeContext('{"score": 1, "reasoning": "ok"}');
      await bindJudgeContext(faithfulness(), ctx)(makeResult('out'));
      const call = (ctx.cogitator.run as ReturnType<typeof vi.fn>).mock.calls[0][0];
      expect(call.input).not.toContain('</context>');
    });

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
    it('leaves the expected block out when expected is not provided', async () => {
      const ctx = makeJudgeContext('{"score": 0.9, "reasoning": "ok"}');
      const bound = bindJudgeContext(faithfulness(), ctx);
      await bound(makeResult('output', 'input'));

      const call = (ctx.cogitator.run as ReturnType<typeof vi.fn>).mock.calls[0][0];
      expect(call.input).not.toContain('</expected>');
    });

    it('includes expected value when provided', async () => {
      const ctx = makeJudgeContext('{"score": 0.9, "reasoning": "ok"}');
      const bound = bindJudgeContext(faithfulness(), ctx);
      await bound(makeResult('output', 'input', 'the expected'));

      const call = (ctx.cogitator.run as ReturnType<typeof vi.fn>).mock.calls[0][0];
      expect(call.input).toContain('<expected>\nthe expected\n</expected>');
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

describe('retrieval-aware judge metrics', () => {
  const passages = [
    { id: 'c1', content: 'Paris is the capital of France.', source: 'facts.txt' },
    { content: 'France is in Europe.' },
  ];

  function withRetrieval(context?: Record<string, unknown>): EvalCaseResult {
    return {
      case: { input: 'capital of France?', ...(context && { context }) },
      output: 'Paris',
      duration: 1,
      retrieved: passages,
    };
  }

  function promptOf(judge: JudgeContext): string {
    return (judge.cogitator.run as ReturnType<typeof vi.fn>).mock.calls[0][0].input as string;
  }

  it('contextRelevance judges the input against the retrieved passages', async () => {
    const judge = makeJudgeContext('{"score": 0.8, "reasoning": "on topic"}');
    const bound = bindJudgeContext(contextRelevance(), judge);

    const score = await bound(withRetrieval({ notes: 'ignored' }));

    expect(score).toEqual({ name: 'contextRelevance', score: 0.8, details: 'on topic' });
    const prompt = promptOf(judge);
    expect(prompt).toContain(
      '<input>\ncapital of France?\n</input>\n<passages>\n<passage index="1" source="facts.txt">\nParis is the capital of France.\n</passage>\n<passage index="2">\nFrance is in Europe.\n</passage>\n</passages>'
    );
    expect(prompt).not.toContain('ignored');
    expect(prompt).not.toContain('</response>');
  });

  it('contextRelevance falls back to the case context, and skips a case with neither', async () => {
    const judge = makeJudgeContext('{"score": 1, "reasoning": "ok"}');
    const bound = bindJudgeContext(contextRelevance(), judge);

    await bound({ case: { input: 'q', context: { doc: 'some text' } }, output: 'a', duration: 1 });
    expect(promptOf(judge)).toContain('<context>\ndoc: some text\n</context>');

    const skipped = await bound({ case: { input: 'q' }, output: 'a', duration: 1 });
    expect(skipped).toEqual({
      name: 'contextRelevance',
      score: 0,
      details: 'no retrieved passages or context to judge',
    });
    expect(judge.cogitator.run).toHaveBeenCalledTimes(1);
  });

  it('faithfulness reads the retrieved passages when there are some, the context otherwise', async () => {
    const withPassages = makeJudgeContext('{"score": 1, "reasoning": "ok"}');
    await bindJudgeContext(faithfulness(), withPassages)(withRetrieval({ notes: 'case context' }));
    expect(promptOf(withPassages)).toContain('<passage index="1" source="facts.txt">\nParis');
    expect(promptOf(withPassages)).not.toContain('case context');
    expect(promptOf(withPassages)).toContain('<response>\nParis\n</response>');

    const withContext = makeJudgeContext('{"score": 1, "reasoning": "ok"}');
    await bindJudgeContext(
      faithfulness(),
      withContext
    )({
      case: { input: 'q', context: { notes: 'case context' } },
      output: 'a',
      duration: 1,
    });
    expect(promptOf(withContext)).toContain('<context>\nnotes: case context\n</context>');
  });

  it('relevance keeps judging with the case context', async () => {
    const judge = makeJudgeContext('{"score": 1, "reasoning": "ok"}');
    await bindJudgeContext(relevance(), judge)(withRetrieval({ notes: 'case context' }));
    expect(promptOf(judge)).toContain('<context>\nnotes: case context\n</context>');
    expect(promptOf(judge)).not.toContain('</passages>');
  });

  it('contextRelevance is a judge metric with its own name', () => {
    expect(contextRelevance().requiresJudge).toBe(true);
    expect(contextRelevance({ name: 'ctx' }).metricName).toBe('ctx');
  });
});

describe('judging multi-turn cases', () => {
  const conversation: EvalCaseResult = {
    case: {
      input: 'My name is Ada.',
      turns: ['I live in Paris.', 'Where do I live?'],
      expected: 'Paris',
    },
    output: 'You live in Paris.',
    duration: 1,
    turns: [
      { input: 'My name is Ada.', output: 'Nice to meet you, Ada.' },
      { input: 'I live in Paris.', output: 'Paris is lovely.' },
      { input: 'Where do I live?', output: 'You live in Paris.' },
    ],
    retrieved: [{ content: 'Ada lives in Paris.' }],
  };

  function promptOf(judge: JudgeContext): string {
    return (judge.cogitator.run as ReturnType<typeof vi.fn>).mock.calls[0][0].input as string;
  }

  it('shows the judge the conversation and marks the last user message', async () => {
    const judge = makeJudgeContext('{"score": 1, "reasoning": "ok"}');
    await bindJudgeContext(relevance(), judge)(conversation);

    expect(promptOf(judge)).toContain(
      '<conversation>\n<turn role="user">\nMy name is Ada.\n</turn>\n<turn role="assistant">\nNice to meet you, Ada.\n</turn>\n<turn role="user">\nI live in Paris.\n</turn>\n<turn role="assistant">\nParis is lovely.\n</turn>\n</conversation>\n<input>\nWhere do I live?\n</input>\n<expected>\nParis\n</expected>\n<response>\nYou live in Paris.\n</response>'
    );
    expect(promptOf(judge)).toContain('which is the <input> the response answers');
    expect(promptOf(judge)).not.toContain('<input>\nMy name is Ada.');
  });

  it('gives contextRelevance the conversation with the passages', async () => {
    const judge = makeJudgeContext('{"score": 1, "reasoning": "ok"}');
    await bindJudgeContext(contextRelevance(), judge)(conversation);

    expect(promptOf(judge)).toContain(
      '<input>\nWhere do I live?\n</input>\n<passages>\n<passage index="1">\nAda lives in Paris.\n</passage>\n</passages>'
    );
    expect(promptOf(judge)).toContain('<turn role="user">\nI live in Paris.\n</turn>');
  });
});
