/** The error of an execution stopped by its abort signal, with the reason it was given. */
export function abortMessage(signal: AbortSignal): string {
  const reason: unknown = signal.reason;
  const detail =
    reason instanceof Error ? reason.message : reason === undefined ? '' : String(reason);
  return detail ? `Execution aborted: ${detail}` : 'Execution aborted';
}
