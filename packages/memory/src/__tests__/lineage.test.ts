import { describe, it, expect } from 'vitest';
import type { MemoryEntry } from '@cogitator-ai/types';
import { InMemoryAdapter } from '../adapters/memory';
import { evidenceOnPath, verifyEvidence, verifyEvidenceInMemory } from '../lineage';

const entry = (fields: Partial<MemoryEntry>): MemoryEntry => ({
  id: 'e1',
  threadId: 't',
  message: { role: 'user', content: 'My cat is called   Whiskers.\nShe is three.' },
  tokenCount: 5,
  createdAt: new Date(0),
  ...fields,
});

describe('verifyEvidence', () => {
  it('verifies a quote found word for word, whitespace aside', () => {
    expect(verifyEvidence({ entryId: 'e1', quote: 'called Whiskers. She is' }, entry({}))).toBe(
      'verified'
    );
  });

  it('suggests a quote the entry does not hold, or an empty one', () => {
    expect(verifyEvidence({ entryId: 'e1', quote: 'called Mittens' }, entry({}))).toBe('suggested');
    expect(verifyEvidence({ entryId: 'e1', quote: '  ' }, entry({}))).toBe('suggested');
  });

  it('reads the text parts of a message with parts', () => {
    const parts = entry({
      message: {
        role: 'user',
        content: [
          { type: 'text', text: 'Look at this:' },
          { type: 'image_url', image_url: { url: 'https://x.test/a.png' } },
        ],
      },
    });
    expect(verifyEvidence({ entryId: 'e1', quote: 'Look at this' }, parts)).toBe('verified');
  });

  it('checks a quote of a tool result against that call only', () => {
    const tool = entry({
      message: { role: 'tool', content: '{"status":"shipped"}', toolCallId: 'c1', name: 'lookup' },
      toolResults: [
        { callId: 'c1', name: 'lookup', result: { status: 'shipped', eta: 'Friday' } },
        { callId: 'c2', name: 'weather', result: 'sunny in Paris' },
      ],
    });
    expect(verifyEvidence({ toolCallId: 'c1', quote: '"eta":"Friday"' }, tool)).toBe('verified');
    expect(verifyEvidence({ toolCallId: 'c1', quote: 'sunny in Paris' }, tool)).toBe('suggested');
    expect(verifyEvidence({ toolCallId: 'c2', quote: 'sunny in Paris' }, tool)).toBe('verified');
  });

  it('suggests a quote of a tool call that returned nothing', () => {
    const empty = entry({
      message: { role: 'tool', content: '', toolCallId: 'c1', name: 'noop' },
      toolResults: [{ callId: 'c1', name: 'noop', result: undefined }],
    });
    expect(verifyEvidence({ toolCallId: 'c1', quote: 'anything' }, empty)).toBe('suggested');
  });
});

describe('evidenceOnPath', () => {
  it('holds when every entry named is on the path, files aside', () => {
    const path = new Set(['a', 'b']);
    expect(
      evidenceOnPath(
        [
          { entryId: 'a', quote: 'x' },
          { fileRange: { path: 'notes.md', start: 0, end: 4 }, quote: 'note' },
        ],
        path
      )
    ).toBe(true);
    expect(evidenceOnPath([{ entryId: 'c', quote: 'x' }], path)).toBe(false);
  });
});

describe('verifyEvidenceInMemory', () => {
  it('checks each piece against its stored entry and verifies the whole only when all hold', async () => {
    const memory = new InMemoryAdapter({ provider: 'memory' });
    await memory.connect();
    await memory.createThread('agent', {}, 't');
    const added = await memory.addEntry({
      threadId: 't',
      message: { role: 'user', content: 'I moved to Lisbon in May.' },
      tokenCount: 6,
    });
    if (!added.success) throw new Error(added.error);

    const good = await verifyEvidenceInMemory(memory, [
      { entryId: added.data.id, quote: 'moved to Lisbon' },
    ]);
    const mixed = await verifyEvidenceInMemory(memory, [
      { entryId: added.data.id, quote: 'moved to Lisbon' },
      { entryId: 'gone', quote: 'anything' },
    ]);

    expect(good.success && good.data.status).toBe('verified');
    expect(mixed.success && mixed.data.status).toBe('suggested');
    expect(mixed.success && mixed.data.evidence.map((item) => item.status)).toEqual([
      'verified',
      'suggested',
    ]);
    const none = await verifyEvidenceInMemory(memory, []);
    expect(none.success && none.data.status).toBe('suggested');
  });
});
