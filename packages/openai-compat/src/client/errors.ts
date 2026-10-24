import { CogitatorError, ErrorCode, type RunInterrupt } from '@cogitator-ai/types';

/**
 * A request the adapter refuses: an unknown assistant or thread, a run in the
 * wrong state, an invalid parameter. Its message is meant for the API client,
 * unlike other errors, which are server failures and reach clients only as a
 * generic message.
 */
export class InvalidRequestError extends Error {
  constructor(
    message: string,
    /** The request parameter at fault, when there is one */
    readonly param?: string
  ) {
    super(message);
    this.name = 'InvalidRequestError';
  }
}

/**
 * The error that ends a run which paused on questions its tools asked (`context.interrupt()`).
 * The OpenAI APIs can only hand function calls to their client, never a question, and resuming
 * without an answer pauses on the same question again, so the run stops here. Its message names
 * the questions, `details.interrupts` has them in full.
 *
 * @param questions - The questions the run waits on, see `pendingQuestions()`
 * @param api - The API that served the run, for the message (e.g. `Assistants API`)
 */
export function unansweredQuestionsError(
  questions: readonly RunInterrupt[],
  api: string
): CogitatorError {
  const asked = questions.map((entry) => `${entry.reason} ("${entry.message}")`).join(', ');
  return new CogitatorError({
    message:
      `The agent paused to ask ${asked}, which the ${api} cannot put to its client. ` +
      'Tools that ask questions need a caller that answers them with cogitator.resume().',
    code: ErrorCode.RUN_PAUSED,
    details: { interrupts: questions.map((entry) => ({ ...entry })) },
  });
}
