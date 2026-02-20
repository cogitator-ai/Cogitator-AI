import { describe, it, expect } from 'vitest';
import { Dataset } from '../datasets';

const sampleCases = [
  { input: 'What is 2+2?', expected: '4' },
  { input: 'Capital of France?', expected: 'Paris' },
  { input: 'Translate hello to Spanish', expected: 'Hola' },
  { input: 'What color is the sky?', expected: 'Blue' },
  { input: 'Largest planet?', expected: 'Jupiter' },
];

describe('Dataset', () => {
  describe('from()', () => {
    it('creates dataset from array of cases', () => {
      const ds = Dataset.from(sampleCases);
      expect(ds.length).toBe(5);
    });

    it('creates empty dataset', () => {
      const ds = Dataset.from([]);
      expect(ds.length).toBe(0);
      expect(ds.cases).toEqual([]);
    });

    it('validates cases via EvalCaseSchema', () => {
      const ds = Dataset.from([{ input: 'test' }]);
      expect(ds.length).toBe(1);
    });

    it('rejects cases with missing input', () => {
      expect(() => Dataset.from([{} as any])).toThrow();
    });

    it('rejects cases with non-string input', () => {
      expect(() => Dataset.from([{ input: 42 } as any])).toThrow();
    });
  });

  describe('length', () => {
    it('returns the number of cases', () => {
      expect(Dataset.from(sampleCases).length).toBe(5);
      expect(Dataset.from([{ input: 'one' }]).length).toBe(1);
    });
  });

  describe('cases', () => {
    it('returns readonly array of cases', () => {
      const ds = Dataset.from(sampleCases);
      expect(ds.cases).toHaveLength(5);
      expect(ds.cases[0]).toEqual({ input: 'What is 2+2?', expected: '4' });
    });

    it('returns frozen array', () => {
      const ds = Dataset.from(sampleCases);
      expect(Object.isFrozen(ds.cases)).toBe(true);
    });
  });

  describe('[Symbol.iterator]', () => {
    it('works with for...of', () => {
      const ds = Dataset.from(sampleCases);
      const collected: unknown[] = [];
      for (const c of ds) {
        collected.push(c);
      }
      expect(collected).toHaveLength(5);
      expect(collected[0]).toEqual({ input: 'What is 2+2?', expected: '4' });
    });

    it('works with spread operator', () => {
      const ds = Dataset.from(sampleCases);
      const arr = [...ds];
      expect(arr).toHaveLength(5);
    });

    it('works on empty dataset', () => {
      const ds = Dataset.from([]);
      const arr = [...ds];
      expect(arr).toHaveLength(0);
    });
  });

  describe('filter()', () => {
    it('returns new dataset with matching cases', () => {
      const ds = Dataset.from(sampleCases);
      const filtered = ds.filter((c) => c.expected === 'Paris');
      expect(filtered.length).toBe(1);
      expect(filtered.cases[0].input).toBe('Capital of France?');
    });

    it('does not mutate original dataset', () => {
      const ds = Dataset.from(sampleCases);
      ds.filter((c) => c.expected === 'Paris');
      expect(ds.length).toBe(5);
    });

    it('returns empty dataset when nothing matches', () => {
      const ds = Dataset.from(sampleCases);
      const filtered = ds.filter(() => false);
      expect(filtered.length).toBe(0);
    });

    it('returns dataset with all cases when everything matches', () => {
      const ds = Dataset.from(sampleCases);
      const filtered = ds.filter(() => true);
      expect(filtered.length).toBe(5);
    });
  });

  describe('sample()', () => {
    it('returns n random cases', () => {
      const ds = Dataset.from(sampleCases);
      const sampled = ds.sample(3);
      expect(sampled.length).toBe(3);
    });

    it('does not mutate original dataset', () => {
      const ds = Dataset.from(sampleCases);
      ds.sample(2);
      expect(ds.length).toBe(5);
    });

    it('returns all cases when n > length', () => {
      const ds = Dataset.from(sampleCases);
      const sampled = ds.sample(100);
      expect(sampled.length).toBe(5);
    });

    it('returns empty dataset when n is 0', () => {
      const ds = Dataset.from(sampleCases);
      const sampled = ds.sample(0);
      expect(sampled.length).toBe(0);
    });

    it('returns empty dataset when sampling from empty', () => {
      const ds = Dataset.from([]);
      const sampled = ds.sample(5);
      expect(sampled.length).toBe(0);
    });

    it('returns cases that exist in original', () => {
      const ds = Dataset.from(sampleCases);
      const sampled = ds.sample(3);
      for (const c of sampled) {
        expect(sampleCases).toContainEqual(c);
      }
    });
  });

  describe('shuffle()', () => {
    it('returns dataset with same length', () => {
      const ds = Dataset.from(sampleCases);
      const shuffled = ds.shuffle();
      expect(shuffled.length).toBe(ds.length);
    });

    it('does not mutate original dataset', () => {
      const ds = Dataset.from(sampleCases);
      const originalCases = [...ds.cases];
      ds.shuffle();
      expect([...ds.cases]).toEqual(originalCases);
    });

    it('contains same elements', () => {
      const ds = Dataset.from(sampleCases);
      const shuffled = ds.shuffle();
      for (const c of shuffled) {
        expect(ds.cases).toContainEqual(c);
      }
    });

    it('produces different order (probabilistic)', () => {
      const ds = Dataset.from(sampleCases);
      let differentOrderSeen = false;
      for (let i = 0; i < 20; i++) {
        const shuffled = ds.shuffle();
        const originalInputs = ds.cases.map((c) => c.input);
        const shuffledInputs = shuffled.cases.map((c) => c.input);
        if (JSON.stringify(originalInputs) !== JSON.stringify(shuffledInputs)) {
          differentOrderSeen = true;
          break;
        }
      }
      expect(differentOrderSeen).toBe(true);
    });

    it('handles single element', () => {
      const ds = Dataset.from([{ input: 'only one' }]);
      const shuffled = ds.shuffle();
      expect(shuffled.length).toBe(1);
      expect(shuffled.cases[0].input).toBe('only one');
    });

    it('handles empty dataset', () => {
      const ds = Dataset.from([]);
      const shuffled = ds.shuffle();
      expect(shuffled.length).toBe(0);
    });
  });

  describe('immutability', () => {
    it('chaining operations does not affect original', () => {
      const ds = Dataset.from(sampleCases);
      const result = ds
        .filter((c) => c.expected !== undefined)
        .shuffle()
        .sample(2);
      expect(result.length).toBe(2);
      expect(ds.length).toBe(5);
    });
  });
});
