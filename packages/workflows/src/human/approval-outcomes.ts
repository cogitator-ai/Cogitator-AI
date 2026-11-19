import type { ApprovalResponse, ApprovalStore } from '@cogitator-ai/types';

/**
 * Thrown by `submitResponse` for a request that already has an answer: the
 * first answer wins. `existing` is that answer when the store could read it.
 */
export class ApprovalAlreadyAnsweredError extends Error {
  override readonly name = 'ApprovalAlreadyAnsweredError';

  constructor(
    readonly requestId: string,
    readonly existing?: ApprovalResponse
  ) {
    super(`Approval request ${requestId} was already answered`);
  }
}

/** `respondedBy` of the answer waiters get when a pending request is deleted. */
export const WITHDRAWN = '__withdrawn__';

/** The answer waiters get when a request is deleted, or expires, before anyone answers it. */
export function withdrawnResponse(requestId: string): ApprovalResponse {
  return {
    requestId,
    decision: { error: 'Approval request was withdrawn before it was answered' },
    respondedBy: WITHDRAWN,
    respondedAt: Date.now(),
    comment: 'Request deleted before it was answered',
  };
}

/** `respondedBy` of the answer that closes a request once its escalation has an answer. */
export const ESCALATED = '__escalated__';

/**
 * The answer a timed-out request gets when the escalation it was handed to is answered: the
 * decision is on the escalation, this one only takes the request off its first assignee's list.
 */
export function escalatedResponse(requestId: string, escalatedTo: string): ApprovalResponse {
  return {
    requestId,
    decision: { error: 'Timeout exceeded, the request was escalated' },
    respondedBy: ESCALATED,
    respondedAt: Date.now(),
    comment: `Escalated to ${escalatedTo}`,
  };
}

/**
 * Whether a response stands for no answer (a timeout, an expired escalation, a request closed
 * by its escalation or a withdrawn one) rather than a person's decision.
 */
export function isUnanswered(response: ApprovalResponse): boolean {
  const { decision } = response;
  return (
    response.respondedBy.startsWith('__') &&
    typeof decision === 'object' &&
    decision !== null &&
    'error' in decision
  );
}

/**
 * Submits `response` unless the request already has an answer, and returns
 * the answer that stands: `response`, or the one that got there first.
 */
export async function submitOrExisting(
  store: ApprovalStore,
  response: ApprovalResponse
): Promise<ApprovalResponse> {
  try {
    await store.submitResponse(response);
    return response;
  } catch (error) {
    if (!(error instanceof ApprovalAlreadyAnsweredError)) throw error;
    const existing = error.existing ?? (await store.getResponse(response.requestId));
    if (existing) return existing;
    return new Promise<ApprovalResponse>((resolve) => {
      const unsubscribe = store.onResponse(response.requestId, (answer) => {
        unsubscribe();
        resolve(answer);
      });
    });
  }
}
