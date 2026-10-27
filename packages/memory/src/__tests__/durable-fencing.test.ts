import { describe, expect, it } from 'vitest';
import type { MemoryEntry } from '@cogitator-ai/types';
import { DURABLE_FENCE, withoutStaleDurableEntries } from '../compaction';

function entry(id: string, metadata?: Record<string, unknown>): MemoryEntry {
  return {
    id,
    threadId: 't',
    message: { role: 'assistant', content: id },
    tokenCount: 1,
    createdAt: new Date(0),
    ...(metadata && { metadata }),
  };
}

describe('withoutStaleDurableEntries', () => {
  it('drops entries of an older lease epoch that come after a newer one of the same run', () => {
    const entries = [
      entry('plain'),
      entry('first', { durableRun: 'run_a/s1', durableEpoch: 1 }),
      {
        ...entry('fence', { durableRun: 'run_a/fence-2', durableEpoch: 2 }),
        type: 'custom' as const,
        event: { kind: DURABLE_FENCE },
      },
      entry('late', { durableRun: 'run_a/s1', durableEpoch: 1 }),
      entry('other run', { durableRun: 'run_b/s1', durableEpoch: 1 }),
      entry('second', { durableRun: 'run_a/s2', durableEpoch: 2 }),
    ];

    expect(withoutStaleDurableEntries(entries).map((kept) => kept.id)).toEqual([
      'plain',
      'first',
      'fence',
      'other run',
      'second',
    ]);
  });
});
