import { describe, it, expect } from 'vitest';
import { parseDocument } from 'yaml';
import { unifiedDiff } from '../kit/diff.js';
import { applyOps, applyYamlOps, merge3 } from '../kit/merge.js';

describe('unifiedDiff', () => {
  it('is empty for equal texts', () => {
    expect(unifiedDiff('a.ts', 'x\ny\n', 'x\ny\n')).toBe('');
  });

  it('prints hunks with context the way git does', () => {
    const before = ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i', 'j'].join('\n') + '\n';
    const after = ['a', 'b', 'c', 'd', 'E', 'f', 'g', 'h', 'i', 'j', 'k'].join('\n') + '\n';
    expect(unifiedDiff('letters.txt', before, after)).toBe(
      [
        '--- a/letters.txt',
        '+++ b/letters.txt',
        '@@ -2,9 +2,10 @@',
        ' b',
        ' c',
        ' d',
        '-e',
        '+E',
        ' f',
        ' g',
        ' h',
        ' i',
        ' j',
        '+k',
        '',
      ].join('\n')
    );
  });

  it('splits distant changes into separate hunks', () => {
    const lines = Array.from({ length: 30 }, (_, i) => `line ${i + 1}`);
    const changed = lines.map((line, i) => (i === 1 || i === 27 ? `${line}!` : line));
    const diff = unifiedDiff('f', lines.join('\n') + '\n', changed.join('\n') + '\n');
    expect(diff.match(/^@@/gm)).toHaveLength(2);
    expect(diff).toContain('@@ -1,5 +1,5 @@');
    expect(diff).toContain('@@ -25,6 +25,6 @@');
  });

  it('shows created and deleted files against /dev/null', () => {
    expect(unifiedDiff('new.ts', undefined, 'x\n')).toBe(
      '--- /dev/null\n+++ b/new.ts\n@@ -0,0 +1,1 @@\n+x\n'
    );
    expect(unifiedDiff('old.ts', 'x\n', undefined)).toBe(
      '--- a/old.ts\n+++ /dev/null\n@@ -1,1 +0,0 @@\n-x\n'
    );
  });
});

describe('merge3', () => {
  it('takes the generated change when the user did not touch the key', () => {
    const outcome = merge3(
      { deps: { a: '1' } },
      { deps: { a: '1' }, mine: true },
      { deps: { a: '1', b: '2' } }
    );
    expect(outcome.conflicts).toEqual([]);
    expect(applyOps({ deps: { a: '1' }, mine: true }, outcome.ops)).toEqual({
      deps: { a: '1', b: '2' },
      mine: true,
    });
  });

  it("keeps the user's value of a key the generator did not change", () => {
    const outcome = merge3({ model: 'a', x: 1 }, { model: 'mine', x: 1 }, { model: 'a', x: 2 });
    expect(applyOps({ model: 'mine', x: 1 }, outcome.ops)).toEqual({ model: 'mine', x: 2 });
  });

  it('reports a key both sides changed differently', () => {
    const outcome = merge3({ port: 3000 }, { port: 8080 }, { port: 4000 });
    expect(outcome.conflicts).toEqual([['port']]);
    expect(outcome.ops).toEqual([]);
  });

  it('accepts the same change on both sides', () => {
    expect(merge3({ a: 1 }, { a: 2 }, { a: 2 })).toEqual({ ops: [], conflicts: [] });
  });

  it('merges lists of plain values as sets', () => {
    const outcome = merge3(
      { secrets: ['A', 'B'] },
      { secrets: ['A', 'B', 'MINE'] },
      { secrets: ['A', 'C'] }
    );
    expect(applyOps({ secrets: ['A', 'B', 'MINE'] }, outcome.ops)).toEqual({
      secrets: ['A', 'MINE', 'C'],
    });
  });

  it('deletes a key the generator dropped and the user left alone', () => {
    const outcome = merge3({ a: 1, b: 2 }, { a: 1, b: 2 }, { a: 1 });
    expect(applyOps({ a: 1, b: 2 }, outcome.ops)).toEqual({ a: 1 });
  });

  it('is a conflict when the user deleted a key the generator changes', () => {
    expect(merge3({ a: 1 }, {}, { a: 2 }).conflicts).toEqual([['a']]);
  });
});

describe('applyYamlOps', () => {
  it("keeps the user's comments and layout and spaces a new section", () => {
    const text = '# my notes\nllm:\n  defaultModel: mine # pinned\n';
    const doc = parseDocument(text);
    const base = { llm: { defaultModel: 'openai/gpt' } };
    const theirs = { ...base, memory: { adapter: 'sqlite' } };
    applyYamlOps(doc, merge3(base, doc.toJS(), theirs).ops);
    expect(doc.toString()).toBe(
      '# my notes\nllm:\n  defaultModel: mine # pinned\n\nmemory:\n  adapter: sqlite\n'
    );
  });
});
