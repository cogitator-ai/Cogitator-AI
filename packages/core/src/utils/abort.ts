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
