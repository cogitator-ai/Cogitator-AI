import { describe, it, expect } from 'vitest';
import {
  choiceMatch,
  choiceSetMatch,
  extractBoxedAnswer,
  normalizeAnswer,
  parseEvalSpec,
  phraseSetMatch,
  readBinaryLabel,
  readRubricScore,
  scoringFor,
  substringMatch,
  tokenF1,
} from '../scoring.js';
import type { BenchQuestion } from '../types.js';

const question = (scoring: BenchQuestion['scoring'], answer = 'Rome'): BenchQuestion => ({
  id: 'q',
  category: 'c',
  question: 'Where?',
  answer,
  scoring,
});

describe('deterministic scores', () => {
  it('normalizes like SQuAD and matches substrings', () => {
    expect(normalizeAnswer('The  City of Rome!')).toBe('city of rome');
    expect(substringMatch('It is Rome, Italy.', ['rome'])).toBe(true);
    expect(substringMatch('Paris', ['Rome', ''])).toBe(false);
  });

  it('computes token F1', () => {
    expect(tokenF1('a red bike', 'red bike')).toBe(1);
    expect(tokenF1('red car', 'red bike')).toBeCloseTo(0.5);
    expect(tokenF1('', 'red')).toBe(0);
  });
});

describe('LongMemEval-V2 evaluators', () => {
  const spec =
    'norm_phrase_set_match|lower=true|normalize_hyphen=true|strip_punct=true|separators=,;|require_non_empty=true';

  it('reads boxed answers, nested braces included', () => {
    expect(extractBoxedAnswer('so \\boxed{A {b}} done')).toBe('A {b}');
    expect(extractBoxedAnswer('no box')).toBe('no box');
    expect(extractBoxedAnswer('\\boxed{x} then \\boxed{y}')).toBe('y');
  });

  it('parses specs and matches phrase sets, in order when asked', () => {
    const { name, options } = parseEvalSpec(spec);
    expect(name).toBe('norm_phrase_set_match');
    expect(options.separators).toEqual([',', ';']);
    expect(
      phraseSetMatch(
        'Open Incidents; Closed-incidents',
        'closed incidents, open incidents',
        options,
        false
      )
    ).toBe(true);
    expect(
      phraseSetMatch('open incidents', 'open incidents, closed incidents', options, false)
    ).toBe(false);
    expect(phraseSetMatch('b then a', 'a, b', options, true)).toBe(false);
    expect(phraseSetMatch('a then b', 'a, b', options, true)).toBe(true);
    expect(phraseSetMatch('incidental', 'incident', options, false)).toBe(false);
  });

  it('matches multiple choice answers', () => {
    expect(choiceMatch('\\boxed{Option B.}', 'b')).toBe(true);
    expect(choiceMatch('C', 'B')).toBe(false);
    expect(choiceSetMatch('Answer: A and C', 'C, A')).toBe(true);
    expect(choiceSetMatch('A', 'A, C')).toBe(false);
  });

  it('scores an UNKNOWN final answer zero without a judge', () => {
    expect(
      scoringFor(question({ kind: 'lme-v2', evalFunction: spec }), '\\boxed{UNKNOWN}')
    ).toEqual({
      kind: 'score',
      score: 0,
    });
  });

  it('asks the judge for abstention questions', () => {
    const scoring = scoringFor(
      question({ kind: 'lme-v2', evalFunction: 'llm_abstention_checker|require_non_empty=true' }),
      'There is no such page.'
    );
    expect(scoring.kind).toBe('judge');
    if (scoring.kind === 'judge') {
      expect(scoring.requests[0].system).toMatch(/flawed-premise/);
      expect(scoring.requests[0].read('{"label": 1, "reason": "ok"}')).toBe(1);
    }
  });
});

describe('judge prompts and replies', () => {
  it('uses the LongMemEval template of the question type', () => {
    const scoring = scoringFor(
      question(
        { kind: 'longmemeval', questionType: 'temporal-reasoning', abstention: false },
        '18 days'
      ),
      '19 days'
    );
    if (scoring.kind !== 'judge') throw new Error('expected a judge');
    expect(scoring.requests[0].prompt).toContain('off-by-one');
    expect(scoring.requests[0].prompt).toContain('Correct Answer: 18 days');
    expect(scoring.requests[0].read('Yes.')).toBe(1);
    expect(scoring.requests[0].read('no')).toBe(0);
  });

  it('asks one rubric question per BEAM rubric item and averages them', () => {
    const scoring = scoringFor(
      question({ kind: 'beam-rubric', rubric: ['says 250ms', 'mentions caching'] }),
      'About 250ms.'
    );
    if (scoring.kind !== 'judge') throw new Error('expected a judge');
    expect(scoring.requests).toHaveLength(2);
    expect(scoring.requests[1].prompt).toContain(
      'RUBRIC CRITERION (what to check): mentions caching'
    );
    expect(scoring.requests[0].prompt).toContain('RESPONSE TO EVALUATE: About 250ms.');
    expect(scoring.combine([1, 0.5])).toBe(0.75);
  });

  it('reads rubric scores and binary labels, a bad reply as zero', () => {
    expect(readRubricScore('{"score": 0.5, "reason": "x"}')).toBe(0.5);
    expect(readRubricScore('```json\n{"score": [1.0]}\n```')).toBe(1);
    expect(readRubricScore('nonsense')).toBe(0);
    expect(readBinaryLabel("{'label': 1}")).toBe(1);
    expect(readBinaryLabel('label = 0')).toBe(0);
  });
});
