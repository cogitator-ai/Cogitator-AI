import { describe, it, expect, vi } from 'vitest';
import { createIfMissing, fromJson } from '../postgres-schema';

function pgError(code: string): Error {
  return Object.assign(new Error(`pg error ${code}`), { code });
}

describe('createIfMissing', () => {
  it('retries once when another session created the object at the same moment', async () => {
    const query = vi.fn().mockRejectedValueOnce(pgError('23505')).mockResolvedValueOnce({});

    await createIfMissing({ query }, 'CREATE TABLE IF NOT EXISTS t (id TEXT)');

    expect(query).toHaveBeenCalledTimes(2);
  });

  it('passes other errors on without retrying', async () => {
    const query = vi.fn().mockRejectedValue(pgError('42501'));

    await expect(createIfMissing({ query }, 'CREATE TABLE t (id TEXT)')).rejects.toThrow('42501');
    expect(query).toHaveBeenCalledTimes(1);
  });
});

describe('fromJson', () => {
  it('reads JSONB given parsed or as text', () => {
    expect(fromJson<{ a: number }>({ a: 1 })).toEqual({ a: 1 });
    expect(fromJson<{ a: number }>('{"a":1}')).toEqual({ a: 1 });
  });
});
