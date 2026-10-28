import { describe, expect, it } from 'vitest';
import {
  JsonPatchError,
  applyJsonPatch,
  createJsonPatch,
  jsonEqual,
  parseJsonPointer,
  type JsonPatchOperation,
} from '../json-patch';

describe('createJsonPatch', () => {
  it('is empty for equal values, keys in any order', () => {
    expect(createJsonPatch({ a: 1, b: [1, { c: 2 }] }, { b: [1, { c: 2 }], a: 1 })).toEqual([]);
  });

  it('changes a value deep inside with one operation', () => {
    const from = { todos: [{ id: 1, done: false }], title: 'x' };
    const to = { todos: [{ id: 1, done: true }], title: 'x' };
    expect(createJsonPatch(from, to)).toEqual([
      { op: 'replace', path: '/todos/0/done', value: true },
    ]);
  });

  it('adds and removes keys and array items', () => {
    const patch = createJsonPatch({ a: 1, list: [1, 2, 3] }, { b: 2, list: [1] });
    expect(patch).toEqual([
      { op: 'remove', path: '/a' },
      { op: 'add', path: '/b', value: 2 },
      { op: 'remove', path: '/list/2' },
      { op: 'remove', path: '/list/1' },
    ]);
    const grown = createJsonPatch({ list: [1] }, { list: [1, 2, 3] });
    expect(grown).toEqual([
      { op: 'add', path: '/list/1', value: 2 },
      { op: 'add', path: '/list/2', value: 3 },
    ]);
  });

  it('escapes keys as JSON Pointer tokens', () => {
    expect(createJsonPatch({}, { 'a/b': 1, 'c~d': 2 })).toEqual([
      { op: 'add', path: '/a~1b', value: 1 },
      { op: 'add', path: '/c~0d', value: 2 },
    ]);
    expect(parseJsonPointer('/a~1b/c~0d')).toEqual(['a/b', 'c~d']);
  });

  it('replaces the whole document when the kinds differ', () => {
    expect(createJsonPatch([1], { a: 1 })).toEqual([{ op: 'replace', path: '', value: { a: 1 } }]);
    expect(createJsonPatch(undefined, 3)).toEqual([{ op: 'replace', path: '', value: 3 }]);
  });

  it('treats an undefined key as a missing one', () => {
    expect(createJsonPatch({ a: undefined }, { a: 1 })).toEqual([
      { op: 'add', path: '/a', value: 1 },
    ]);
    expect(createJsonPatch({ a: 1 }, { a: undefined })).toEqual([{ op: 'remove', path: '/a' }]);
  });

  it('round-trips through applyJsonPatch', () => {
    const cases: Array<[unknown, unknown]> = [
      [{ a: { b: [1, 2, { c: 'x' }] } }, { a: { b: [2, { c: 'y' }], d: null } }],
      [[{ id: 1 }, { id: 2 }], [{ id: 2 }]],
      [{ nested: { deep: { list: [] } } }, { nested: { deep: { list: [1, [2, 3]] } } }],
      ['text', { now: 'object' }],
    ];
    for (const [from, to] of cases) {
      expect(applyJsonPatch(from, createJsonPatch(from, to))).toEqual(to);
    }
  });
});

describe('applyJsonPatch', () => {
  it('applies every operation of RFC 6902 without touching the input', () => {
    const document = { a: { b: 1 }, list: [1, 2] };
    const patch: JsonPatchOperation[] = [
      { op: 'add', path: '/list/-', value: 3 },
      { op: 'add', path: '/list/0', value: 0 },
      { op: 'copy', from: '/a', path: '/copied' },
      { op: 'move', from: '/a/b', path: '/moved' },
      { op: 'replace', path: '/copied/b', value: 2 },
      { op: 'test', path: '/moved', value: 1 },
      { op: 'remove', path: '/list/1' },
    ];
    expect(applyJsonPatch(document, patch)).toEqual({
      a: {},
      list: [0, 2, 3],
      copied: { b: 2 },
      moved: 1,
    });
    expect(document).toEqual({ a: { b: 1 }, list: [1, 2] });
  });

  it('fails the whole patch when an operation does not apply', () => {
    expect(() => applyJsonPatch({ a: 1 }, [{ op: 'remove', path: '/b' }])).toThrow(JsonPatchError);
    expect(() => applyJsonPatch({ a: 1 }, [{ op: 'replace', path: '/b', value: 1 }])).toThrow(
      'Nothing to replace'
    );
    expect(() => applyJsonPatch({ a: 1 }, [{ op: 'test', path: '/a', value: 2 }])).toThrow(
      'Test failed'
    );
    expect(() => applyJsonPatch([1], [{ op: 'add', path: '/5', value: 1 }])).toThrow(
      'No array index'
    );
    expect(() =>
      applyJsonPatch({ a: { b: 1 } }, [{ op: 'move', from: '/a', path: '/a/c' }])
    ).toThrow('into itself');
  });

  it('writes __proto__ as a key of its own, never as the prototype', () => {
    const patched = applyJsonPatch({}, [
      { op: 'add', path: '/__proto__', value: { polluted: true } },
      { op: 'copy', from: '/__proto__', path: '/constructor' },
    ]) as Record<string, unknown>;
    expect(Object.getPrototypeOf(patched)).toBe(Object.prototype);
    expect(Object.keys(patched)).toEqual(['__proto__', 'constructor']);
    expect(Object.getOwnPropertyDescriptor(patched, '__proto__')?.value).toEqual({
      polluted: true,
    });
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
    const moved = applyJsonPatch({ a: { b: 1 } }, [
      { op: 'move', from: '/a', path: '/__proto__' },
      { op: 'replace', path: '/__proto__', value: 2 },
    ]) as Record<string, unknown>;
    expect(Object.getPrototypeOf(moved)).toBe(Object.prototype);
    expect(Object.getOwnPropertyDescriptor(moved, '__proto__')?.value).toBe(2);
  });

  it('replaces the root', () => {
    expect(applyJsonPatch({ a: 1 }, [{ op: 'replace', path: '', value: [1] }])).toEqual([1]);
  });
});

describe('jsonEqual', () => {
  it('compares JSON values structurally', () => {
    expect(jsonEqual({ a: [1, { b: 2 }] }, { a: [1, { b: 2 }] })).toBe(true);
    expect(jsonEqual({ a: 1 }, { a: 1, b: 2 })).toBe(false);
    expect(jsonEqual([1, 2], [2, 1])).toBe(false);
    expect(jsonEqual(null, {})).toBe(false);
  });
});
