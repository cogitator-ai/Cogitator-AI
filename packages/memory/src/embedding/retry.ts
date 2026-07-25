const RETRYABLE_STATUSES = new Set([429, 500, 502, 503]);
const MAX_RETRIES = 3;
const BASE_DELAY_MS = 1000;
const TIMEOUT_MS = 30_000;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function fetchWithRetry(input: string, init: RequestInit = {}): Promise<Response> {
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    const response = await fetch(input, {
      ...init,
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });

    const isLastAttempt = attempt === MAX_RETRIES;
    if (!RETRYABLE_STATUSES.has(response.status) || isLastAttempt) {
      return response;
    }

    await sleep(BASE_DELAY_MS * 2 ** attempt);
  }

  throw new Error('Embedding request failed after maximum retries');
}
