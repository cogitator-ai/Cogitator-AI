/**
 * A failure with a short, stable `code` that names its cause, such as
 * `HTTP_404` or `DIRECTORY_NOT_EMPTY`. The code holds no path, name or anything
 * a user typed, which is what lets telemetry report it.
 */
export class CodedError extends Error {
  readonly code: string;

  constructor(code: string, message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'CodedError';
    this.code = code;
  }
}

/** `ConnectionRefused` or `TypeError` as a code: `CONNECTION_REFUSED`, `TYPE_ERROR`. */
export function constantCase(name: string): string {
  return name.replace(/([a-z0-9])([A-Z])/g, '$1_$2').toUpperCase();
}
