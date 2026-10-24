import { describe, expect, it } from 'vitest';
import type { TreeEntry } from '../protocol.js';
import { eventLabel, eventText } from '../ui/tree-events.js';

function entry(type: string, event: unknown, text = ''): TreeEntry {
  return { id: 'e1', type, event, text, createdAt: 0 };
}

describe('thread tree events', () => {
  it('tells a run waiting for answers from an answered and an aborted one', () => {
    const paused = entry(
      'interrupt',
      {
        status: 'paused',
        interrupts: [{ id: 'int_1', kind: 'input', reason: 'pick_order', message: 'Which order?' }],
      },
      'Paused for pick_order'
    );
    const resumed = entry(
      'interrupt',
      { status: 'resumed', interrupts: [{ id: 'int_1', reason: 'pick_order', response: 'A-1' }] },
      'Resumed with the answers to pick_order'
    );
    const aborted = entry('interrupt', { reason: 'stopped' }, 'The run was interrupted: stopped');

    expect([paused, resumed, aborted].map(eventLabel)).toEqual([
      'Waiting for an answer',
      'Answered',
      'Interrupted',
    ]);
    expect([paused, resumed, aborted].map(eventText)).toEqual([
      'Which order?',
      'pick_order',
      'The run was interrupted: stopped',
    ]);
  });

  it('falls back to the entry text when an interrupt records no questions', () => {
    expect(eventText(entry('interrupt', { status: 'paused' }, 'Paused for refund'))).toBe(
      'Paused for refund'
    );
    expect(eventLabel(entry('interrupt', { status: 'unknown' }))).toBe('Interrupted');
  });

  it('labels the other events and leaves messages unlabeled', () => {
    expect(eventLabel(entry('approval', { pending: [{ toolName: 'refund' }] }))).toBe(
      'Paused for approval'
    );
    expect(eventText(entry('approval', { pending: [{ toolName: 'refund' }] }))).toBe('refund');
    expect(eventText(entry('model_change', { from: 'a', to: 'b' }))).toBe('a → b');
    expect(eventLabel(entry('message', undefined))).toBeUndefined();
    expect(eventLabel(entry('toString', undefined))).toBeUndefined();
  });
});
