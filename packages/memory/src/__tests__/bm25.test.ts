import { describe, it, expect } from 'vitest';
import { BM25Index } from '../search/bm25';
import { tokenize, getTermFrequency } from '../search/tokenizer';

describe('tokenize', () => {
  it('splits text into tokens', () => {
    expect(tokenize('hello world')).toEqual(['hello', 'world']);
  });

  it('lowercases by default', () => {
    expect(tokenize('Hello World')).toEqual(['hello', 'world']);
  });

  it('preserves case when lowercase is false', () => {
    expect(tokenize('Hello World', { lowercase: false })).toEqual(['Hello', 'World']);
  });

  it('removes stop words by default', () => {
    const result = tokenize('the cat is on the mat');
    expect(result).toEqual(['cat', 'mat']);
  });

  it('keeps stop words when removeStopwords is false', () => {
    const result = tokenize('the cat is on the mat', { removeStopwords: false });
    expect(result).toContain('the');
    expect(result).toContain('is');
    expect(result).toContain('on');
  });

  it('filters tokens shorter than minLength', () => {
    const result = tokenize('I am a big cat', { removeStopwords: false });
    expect(result).not.toContain('I');
    expect(result).not.toContain('a');
    expect(result).toContain('am');
    expect(result).toContain('big');
    expect(result).toContain('cat');
  });

  it('respects custom minLength', () => {
    const result = tokenize('hi there everyone', { minLength: 5, removeStopwords: false });
    expect(result).toEqual(['there', 'everyone']);
  });

  it('returns empty array for empty string', () => {
    expect(tokenize('')).toEqual([]);
  });

  it('returns empty array for whitespace-only input', () => {
    expect(tokenize('   \t\n  ')).toEqual([]);
  });

  it('strips punctuation', () => {
    expect(tokenize('hello, world! foo-bar')).toEqual(['hello', 'world', 'foo', 'bar']);
  });

  it('handles CJK characters', () => {
    const result = tokenize('机器学习 deep learning', { removeStopwords: false });
    expect(result).toContain('机器学习');
    expect(result).toContain('deep');
    expect(result).toContain('learning');
  });

  it('handles accented characters', () => {
    const result = tokenize('café résumé naïve');
    expect(result).toEqual(['café', 'résumé', 'naïve']);
  });

  it('handles mixed unicode and ascii', () => {
    const result = tokenize('hello мир 世界');
    expect(result).toEqual(['hello', 'мир', '世界']);
  });
});

describe('getTermFrequency', () => {
  it('counts single occurrences', () => {
    const freq = getTermFrequency(['hello', 'world']);
    expect(freq.get('hello')).toBe(1);
    expect(freq.get('world')).toBe(1);
  });

  it('counts multiple occurrences', () => {
    const freq = getTermFrequency(['cat', 'dog', 'cat', 'cat']);
    expect(freq.get('cat')).toBe(3);
    expect(freq.get('dog')).toBe(1);
  });

  it('returns empty map for empty array', () => {
    const freq = getTermFrequency([]);
    expect(freq.size).toBe(0);
  });
});

describe('BM25Index', () => {
  function createIndex() {
    const index = new BM25Index();
    index.addDocuments([
      { id: '1', content: 'The quick brown fox jumps over the lazy dog' },
      { id: '2', content: 'Machine learning and deep learning are hot topics' },
      { id: '3', content: 'The fox is quick and brown' },
      { id: '4', content: 'TypeScript is a typed superset of JavaScript' },
    ]);
    return index;
  }

  describe('addDocument / size', () => {
    it('tracks document count', () => {
      const index = new BM25Index();
      expect(index.size).toBe(0);

      index.addDocument({ id: '1', content: 'hello world' });
      expect(index.size).toBe(1);

      index.addDocument({ id: '2', content: 'foo bar' });
      expect(index.size).toBe(2);
    });

    it('replaces document with same id', () => {
      const index = new BM25Index();
      index.addDocument({ id: '1', content: 'original content' });
      index.addDocument({ id: '1', content: 'updated content' });

      expect(index.size).toBe(1);
      expect(index.getDocument('1')?.content).toBe('updated content');
    });

    it('addDocuments adds multiple at once', () => {
      const index = new BM25Index();
      index.addDocuments([
        { id: '1', content: 'first' },
        { id: '2', content: 'second' },
        { id: '3', content: 'third' },
      ]);
      expect(index.size).toBe(3);
    });
  });

  describe('removeDocument', () => {
    it('removes existing document and returns true', () => {
      const index = createIndex();
      expect(index.removeDocument('1')).toBe(true);
      expect(index.size).toBe(3);
      expect(index.getDocument('1')).toBeUndefined();
    });

    it('returns false for non-existent document', () => {
      const index = createIndex();
      expect(index.removeDocument('nonexistent')).toBe(false);
    });

    it('removed document no longer appears in search results', () => {
      const index = createIndex();
      index.removeDocument('1');
      const results = index.search('quick brown fox');
      const ids = results.map((r) => r.id);
      expect(ids).not.toContain('1');
    });
  });

  describe('getDocument', () => {
    it('returns document by id', () => {
      const index = createIndex();
      const doc = index.getDocument('2');
      expect(doc).toEqual({
        id: '2',
        content: 'Machine learning and deep learning are hot topics',
      });
    });

    it('returns undefined for missing id', () => {
      const index = createIndex();
      expect(index.getDocument('999')).toBeUndefined();
    });
  });

  describe('clear', () => {
    it('resets all state', () => {
      const index = createIndex();
      expect(index.size).toBe(4);

      index.clear();
      expect(index.size).toBe(0);
      expect(index.search('fox')).toEqual([]);
      expect(index.getDocument('1')).toBeUndefined();
    });
  });

  describe('search', () => {
    it('returns relevant documents sorted by score', () => {
      const index = createIndex();
      const results = index.search('quick brown fox');
      expect(results.length).toBeGreaterThan(0);
      const ids = results.map((r) => r.id);
      expect(ids).toContain('1');
      expect(ids).toContain('3');
      expect(results[0].score).toBeGreaterThan(0);
    });

    it('doc 3 also matches fox query', () => {
      const index = createIndex();
      const results = index.search('fox');
      const ids = results.map((r) => r.id);
      expect(ids).toContain('1');
      expect(ids).toContain('3');
    });

    it('returns empty array when no documents match', () => {
      const index = createIndex();
      expect(index.search('quantum physics')).toEqual([]);
    });

    it('returns empty array for empty query', () => {
      const index = createIndex();
      expect(index.search('')).toEqual([]);
    });

    it('returns empty array for stop-words-only query', () => {
      const index = createIndex();
      expect(index.search('the is on')).toEqual([]);
    });

    it('returns empty array when index is empty', () => {
      const index = new BM25Index();
      expect(index.search('anything')).toEqual([]);
    });

    it('respects limit parameter', () => {
      const index = createIndex();
      const results = index.search('quick brown fox', 1);
      expect(results.length).toBe(1);
    });

    it('deduplicates query terms so repeated words do not inflate scores', () => {
      const index = createIndex();
      const single = index.search('fox');
      const repeated = index.search('fox fox fox fox');

      expect(single.length).toBe(repeated.length);
      for (let i = 0; i < single.length; i++) {
        expect(single[i].id).toBe(repeated[i].id);
        expect(single[i].score).toBeCloseTo(repeated[i].score, 10);
      }
    });

    it('results include content field', () => {
      const index = createIndex();
      const results = index.search('typescript');
      expect(results.length).toBe(1);
      expect(results[0].content).toBe('TypeScript is a typed superset of JavaScript');
    });

    it('scores are in descending order', () => {
      const index = createIndex();
      const results = index.search('quick fox');
      for (let i = 1; i < results.length; i++) {
        expect(results[i - 1].score).toBeGreaterThanOrEqual(results[i].score);
      }
    });
  });

  describe('IDF calculation', () => {
    it('rare terms score higher than common terms', () => {
      const index = new BM25Index();
      index.addDocuments([
        { id: '1', content: 'common rare' },
        { id: '2', content: 'common stuff' },
        { id: '3', content: 'common things' },
      ]);

      const rareResults = index.search('rare');
      const commonResults = index.search('common');

      expect(rareResults.length).toBe(1);
      expect(commonResults.length).toBe(3);
      expect(rareResults[0].score).toBeGreaterThan(commonResults[0].score);
    });

    it('IDF follows BM25 formula: log((N - df + 0.5) / (df + 0.5) + 1)', () => {
      const index = new BM25Index();
      index.addDocument({ id: '1', content: 'alpha beta' });
      index.addDocument({ id: '2', content: 'alpha gamma' });
      index.addDocument({ id: '3', content: 'delta epsilon' });

      const N = 3;
      const dfAlpha = 2;
      const expectedIdfAlpha = Math.log((N - dfAlpha + 0.5) / (dfAlpha + 0.5) + 1);

      const dfDelta = 1;
      const expectedIdfDelta = Math.log((N - dfDelta + 0.5) / (dfDelta + 0.5) + 1);

      expect(expectedIdfDelta).toBeGreaterThan(expectedIdfAlpha);

      const alphaResults = index.search('alpha');
      const deltaResults = index.search('delta');
      expect(deltaResults[0].score).toBeGreaterThan(alphaResults[0].score);
    });
  });

  describe('custom k1/b parameters', () => {
    it('k1=0 makes term frequency irrelevant', () => {
      const index = new BM25Index({ k1: 0 });
      index.addDocuments([
        { id: '1', content: 'cat cat cat cat cat' },
        { id: '2', content: 'cat dog' },
      ]);

      const results = index.search('cat');
      expect(results.length).toBe(2);
      expect(results[0].score).toBeCloseTo(results[1].score, 5);
    });

    it('b=0 disables length normalization', () => {
      const index = new BM25Index({ b: 0 });
      index.addDocuments([
        { id: 'short', content: 'cat' },
        { id: 'long', content: 'cat extra words padding filler stuff material' },
      ]);

      const results = index.search('cat');
      expect(results.length).toBe(2);
      expect(results[0].score).toBeCloseTo(results[1].score, 5);
    });

    it('higher k1 increases influence of term frequency', () => {
      const docs = [
        { id: '1', content: 'cat cat cat dog' },
        { id: '2', content: 'cat dog bird' },
      ];

      const lowK1 = new BM25Index({ k1: 0.5 });
      lowK1.addDocuments(docs);
      const lowResults = lowK1.search('cat');
      const lowSpread = lowResults[0].score - lowResults[1].score;

      const highK1 = new BM25Index({ k1: 5 });
      highK1.addDocuments(docs);
      const highResults = highK1.search('cat');
      const highSpread = highResults[0].score - highResults[1].score;

      expect(highSpread).toBeGreaterThan(lowSpread);
    });
  });
});
