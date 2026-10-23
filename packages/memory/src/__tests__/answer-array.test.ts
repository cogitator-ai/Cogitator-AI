import { describe, expect, it } from 'vitest';
import { findAnswerArray } from '../answer-array';

describe('findAnswerArray', () => {
  it('finds the array of objects past brackets and text around it', () => {
    expect(findAnswerArray('In [2] and [3]:\n[{"a":1},{"b":"x]"}]\nsee [4]')).toEqual({
      values: [{ a: 1 }, { b: 'x]' }],
      cut: false,
    });
    expect(findAnswerArray('Nothing in [0]: []')).toEqual({ values: [], cut: false });
    expect(findAnswerArray('[1, 2] and [the rest]')).toBeUndefined();
    expect(findAnswerArray('no array')).toBeUndefined();
  });

  it('reads brackets, braces and escaped quotes inside strings as text', () => {
    expect(findAnswerArray('[{"q":"say \\"[}\\" twice","n":[1,{"m":2}]}]')).toEqual({
      values: [{ q: 'say "[}" twice', n: [1, { m: 2 }] }],
      cut: false,
    });
  });

  it('leaves out an element that is not JSON instead of the whole array', () => {
    expect(findAnswerArray('[{"a":1}, {b: 2}, {"c":3},]')).toEqual({
      values: [{ a: 1 }, { c: 3 }],
      cut: false,
    });
  });

  it('keeps the finished elements of an array the answer ends inside', () => {
    expect(findAnswerArray('[{"a":1},{"b":[2,3]},{"c":"unfini')).toEqual({
      values: [{ a: 1 }, { b: [2, 3] }],
      cut: true,
    });
    expect(findAnswerArray('[{"a":1},{"b":2}')).toEqual({
      values: [{ a: 1 }, { b: 2 }],
      cut: true,
    });
    expect(findAnswerArray('[{"a":')).toBeUndefined();
  });

  it('skips a bracket whose pair does not match', () => {
    expect(findAnswerArray('[oops} then [{"a":1}]')).toEqual({ values: [{ a: 1 }], cut: false });
  });
});
