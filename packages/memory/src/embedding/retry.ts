const RETRYABLE_STATUSES = new Set([408, 429, 500, 502, 503, 504]);
const MAX_RETRIES = 3;
const BASE_DELAY_MS = 1000;
const MAX_RETRY_AFTER_MS = 30_000;
const TIMEOUT_MS = 30_000;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Delay requested by a `Retry-After` header (seconds or HTTP date), capped.
 */
function retryAfterMs(response: Response): number | undefined {
  const header = response.headers.get('retry-after');
  if (!header) return undefined;

  const seconds = Number(header);
  const ms = Number.isFinite(seconds) ? seconds * 1000 : Date.parse(header) - Date.now();
  if (!Number.isFinite(ms) || ms < 0) return undefined;
  return Math.min(ms, MAX_RETRY_AFTER_MS);
}

/**
 * Fetch with a per-attempt timeout, retrying transient HTTP statuses and network/timeout
 * errors with exponential backoff (honouring `Retry-After`).
 */
export async function fetchWithRetry(input: string, init: RequestInit = {}): Promise<Response> {
  let lastError: unknown;

  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    const isLastAttempt = attempt === MAX_RETRIES;
    const backoff = BASE_DELAY_MS * 2 ** attempt;

    let response: Response;
    try {
      response = await fetch(input, {
        ...init,
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
    } catch (error) {
      lastError = error;
      if (isLastAttempt) break;
      await sleep(backoff);
      continue;
    }

    if (!RETRYABLE_STATUSES.has(response.status) || isLastAttempt) {
      return response;
    }

    await sleep(retryAfterMs(response) ?? backoff);
  }

  const reason = lastError instanceof Error ? lastError.message : String(lastError);
  throw new Error(`Embedding request failed after ${MAX_RETRIES + 1} attempts: ${reason}`, {
    cause: lastError,
  });
}
