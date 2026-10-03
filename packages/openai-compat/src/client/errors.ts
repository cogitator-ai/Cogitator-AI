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
