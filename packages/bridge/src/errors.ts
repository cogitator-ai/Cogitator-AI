/** Why the bridge refused a call. */
export type BridgeErrorCode =
  | 'invalid_input'
  | 'not_registered'
  | 'unknown_agent'
  | 'ambiguous_agent'
  | 'no_session'
  | 'unknown_job'
  | 'unknown_letter'
  | 'not_a_party'
  | 'job_finished'
  | 'invalid_letter'
  | 'depth_exceeded'
  | 'budget_exhausted'
  | 'loop_detected'
  | 'needs_person'
  | 'no_person'
  | 'no_worktree'
  | 'no_board'
  | 'worktree_limit'
  | 'limit_reached'
  | 'already_running'
  | 'not_running'
  | 'storage';

/** An error of the bridge, with a code a caller can branch on and a message an agent can act on. */
export class BridgeError extends Error {
  readonly code: BridgeErrorCode;
  readonly data?: Record<string, unknown>;

  constructor(code: BridgeErrorCode, message: string, data?: Record<string, unknown>) {
    super(message);
    this.name = 'BridgeError';
    this.code = code;
    if (data !== undefined) this.data = data;
  }
}

export function isBridgeError(error: unknown): error is BridgeError {
  return error instanceof BridgeError;
}
