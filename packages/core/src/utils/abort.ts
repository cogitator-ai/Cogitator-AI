export interface LinkedAbortController {
  signal: AbortSignal;
  readonly timedOut: boolean;
  readonly parentAborted: boolean;
  cleanup(): void;
}

export function createLinkedAbortController(
  parentSignal?: AbortSignal,
  timeoutMs?: number
): LinkedAbortController {
  const controller = new AbortController();
  let timedOut = false;
  let parentAborted = false;

  const abortFromParent = () => {
    parentAborted = true;
    controller.abort(parentSignal?.reason);
  };

  if (parentSignal?.aborted) {
    abortFromParent();
  } else {
    parentSignal?.addEventListener('abort', abortFromParent, { once: true });
  }

  const timeoutId =
    timeoutMs === undefined
      ? undefined
      : setTimeout(() => {
          timedOut = true;
          controller.abort();
        }, timeoutMs);

  return {
    signal: controller.signal,
    get timedOut() {
      return timedOut;
    },
    get parentAborted() {
      return parentAborted;
    },
    cleanup() {
      if (timeoutId) {
        clearTimeout(timeoutId);
      }
      parentSignal?.removeEventListener('abort', abortFromParent);
    },
  };
}

export function getAbortErrorMessage(
  action: string,
  controls: LinkedAbortController,
  timeoutMs?: number
): string {
  if ((controls.timedOut || !controls.parentAborted) && timeoutMs !== undefined) {
    return `${action} timed out after ${timeoutMs}ms`;
  }
  return `${action} aborted`;
}

/** `reason` of an aborted signal as an error: itself when it is one, else an error saying it */
export function toAbortError(reason: unknown, fallbackMessage: string): Error {
  if (reason instanceof Error) return reason;
  if (reason === undefined || reason === null) return new Error(fallbackMessage);
  return new Error(String(reason));
}
