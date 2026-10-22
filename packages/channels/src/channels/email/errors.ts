/**
 * An optional package the channel needs is not installed. It is no fault of one message, so the
 * IMAP inbox leaves the mail unread instead of marking it as unreadable.
 */
export class EmailDependencyError extends Error {
  constructor(
    readonly packageName: string,
    purpose: string,
    options?: { cause?: unknown }
  ) {
    super(`${packageName} is required ${purpose}. Install it: pnpm add ${packageName}`, options);
    this.name = 'EmailDependencyError';
  }
}
