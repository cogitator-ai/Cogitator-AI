import type { LLMProvider } from './spec.js';

/** What checking an API key found out. The key itself never appears in it. */
export type KeyCheck =
  | { status: 'valid' }
  | { status: 'rate-limited' }
  | { status: 'invalid'; httpStatus: number }
  | { status: 'unreachable'; reason: string }
  | { status: 'unexpected'; httpStatus: number };

interface KeyProbe {
  url: string;
  headers(key: string): Record<string, string>;
}

/**
 * The cheapest authenticated call of each provider: listing models costs no
 * tokens, and the key travels in a header, never in the URL.
 */
const PROBES: Record<Exclude<LLMProvider, 'ollama'>, KeyProbe> = {
  openai: {
    url: 'https://api.openai.com/v1/models',
    headers: (key) => ({ authorization: `Bearer ${key}` }),
  },
  anthropic: {
    url: 'https://api.anthropic.com/v1/models?limit=1',
    headers: (key) => ({ 'x-api-key': key, 'anthropic-version': '2023-06-01' }),
  },
  google: {
    url: 'https://generativelanguage.googleapis.com/v1beta/models?pageSize=1',
    headers: (key) => ({ 'x-goog-api-key': key }),
  },
};

/** Checks that `key` is accepted by `provider`, within `timeoutMs`. */
export async function checkApiKey(
  provider: Exclude<LLMProvider, 'ollama'>,
  key: string,
  options: { timeoutMs?: number; fetch?: typeof fetch } = {}
): Promise<KeyCheck> {
  const probe = PROBES[provider];
  const request = options.fetch ?? fetch;
  let response: Response;
  try {
    response = await request(probe.url, {
      headers: probe.headers(key),
      signal: AbortSignal.timeout(options.timeoutMs ?? 8_000),
    });
  } catch (error) {
    const reason =
      error instanceof Error && (error.name === 'TimeoutError' || error.name === 'AbortError')
        ? 'the request timed out'
        : 'the provider could not be reached';
    return { status: 'unreachable', reason };
  }
  await response.body?.cancel().catch(() => undefined);

  if (response.ok) return { status: 'valid' };
  if (response.status === 401 || response.status === 403) {
    return { status: 'invalid', httpStatus: response.status };
  }
  if (response.status === 429) return { status: 'rate-limited' };
  return { status: 'unexpected', httpStatus: response.status };
}

/** One line for the user about a key check. */
export function describeKeyCheck(envKey: string, check: KeyCheck): string {
  switch (check.status) {
    case 'valid':
      return `${envKey} works`;
    case 'rate-limited':
      return `${envKey} is accepted, but the provider is rate limiting it right now`;
    case 'invalid':
      return `${envKey} was rejected (HTTP ${check.httpStatus}): check the key in .env`;
    case 'unreachable':
      return `Could not check ${envKey}: ${check.reason}`;
    case 'unexpected':
      return `Could not check ${envKey}: the provider answered HTTP ${check.httpStatus}`;
  }
}
