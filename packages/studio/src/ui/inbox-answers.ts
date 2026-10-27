import type { InboxItem } from '@cogitator-ai/types';

/** A choice of a workflow's multi-choice request, as its inbox item keeps it */
export interface InboxChoice {
  id: string;
  label: string;
  value: unknown;
  description?: string;
}

/**
 * The answer a workflow's request takes, from the `approvalType` and `choices` its inbox item
 * keeps: approve or reject (a boolean), one of its choices (the choice's value), text, or a
 * number
 */
export type WorkflowAnswerForm =
  | { type: 'approve-reject' }
  | { type: 'multi-choice'; choices: InboxChoice[] }
  | { type: 'free-form' }
  | { type: 'numeric-rating' };

/** Whether the item is a request of a routine's workflow, answered by `decision` */
export function isWorkflowRequest(item: InboxItem): boolean {
  return item.approvalId !== undefined && item.threadId === undefined;
}

/** Whether the run of an item still waits for an answer: archiving it does not answer it */
export function waitsForAnswer(item: InboxItem): boolean {
  return (item.kind === 'approval' || item.kind === 'question') && item.answeredAt === undefined;
}

function choicesOf(raw: unknown): InboxChoice[] {
  if (!Array.isArray(raw)) return [];
  return raw.flatMap((entry: unknown): InboxChoice[] => {
    if (typeof entry !== 'object' || entry === null) return [];
    const { id, label, value, description } = entry as Record<string, unknown>;
    if (typeof id !== 'string') return [];
    return [
      {
        id,
        label: typeof label === 'string' && label !== '' ? label : id,
        value: value === undefined ? id : value,
        ...(typeof description === 'string' && { description }),
      },
    ];
  });
}

/** The form a workflow's request takes, approve or reject when the item does not say */
export function workflowAnswerFormOf(item: InboxItem): WorkflowAnswerForm {
  switch (item.metadata?.approvalType) {
    case 'multi-choice': {
      const choices = choicesOf(item.metadata.choices);
      return choices.length > 0 ? { type: 'multi-choice', choices } : { type: 'free-form' };
    }
    case 'free-form':
      return { type: 'free-form' };
    case 'numeric-rating':
      return { type: 'numeric-rating' };
    default:
      return { type: 'approve-reject' };
  }
}

/** A rating as typed, undefined when it is not a number */
export function ratingOf(text: string): number | undefined {
  if (text.trim() === '') return undefined;
  const value = Number(text);
  return Number.isFinite(value) ? value : undefined;
}
