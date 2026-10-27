import { describe, expect, it } from 'vitest';
import type { InboxItem } from '@cogitator-ai/types';
import {
  isWorkflowRequest,
  ratingOf,
  waitsForAnswer,
  workflowAnswerFormOf,
} from '../ui/inbox-answers';

function item(extra: Partial<InboxItem> = {}): InboxItem {
  return {
    id: 'i',
    kind: 'approval',
    title: 't',
    summary: '',
    status: 'unread',
    createdAt: 1,
    approvalId: 'req_1',
    ...extra,
  };
}

describe('inbox answers', () => {
  it('answers a workflow request in the form of its type, not always as a boolean', () => {
    expect(workflowAnswerFormOf(item({ metadata: { approvalType: 'approve-reject' } }))).toEqual({
      type: 'approve-reject',
    });
    expect(
      workflowAnswerFormOf(
        item({
          metadata: {
            approvalType: 'multi-choice',
            choices: [
              { id: 'a', label: 'Plan A', value: { plan: 'a' } },
              { id: 'b', label: '', value: 2 },
              { label: 'no id' },
            ],
          },
        })
      )
    ).toEqual({
      type: 'multi-choice',
      choices: [
        { id: 'a', label: 'Plan A', value: { plan: 'a' } },
        { id: 'b', label: 'b', value: 2 },
      ],
    });
    expect(workflowAnswerFormOf(item({ metadata: { approvalType: 'free-form' } }))).toEqual({
      type: 'free-form',
    });
    expect(workflowAnswerFormOf(item({ metadata: { approvalType: 'numeric-rating' } }))).toEqual({
      type: 'numeric-rating',
    });
    expect(workflowAnswerFormOf(item())).toEqual({ type: 'approve-reject' });
    expect(ratingOf('4.5')).toBe(4.5);
    expect(ratingOf('')).toBeUndefined();
    expect(ratingOf('five')).toBeUndefined();
  });

  it('waits for an answer until one is given, archived or not', () => {
    expect(waitsForAnswer(item({ status: 'archived' }))).toBe(true);
    expect(waitsForAnswer(item({ answeredAt: 5, status: 'unread' }))).toBe(false);
    expect(waitsForAnswer(item({ kind: 'result' }))).toBe(false);
    expect(isWorkflowRequest(item())).toBe(true);
    expect(isWorkflowRequest(item({ threadId: 't' }))).toBe(false);
  });
});
