import { resolveOllamaHost } from '@cogitator-ai/config';

export const DEFAULT_OLLAMA_URL = 'http://localhost:11434';

export interface OllamaModelInfo {
  name: string;
  size: number;
  modified_at: string;
}

export interface OllamaPullProgress {
  status: string;
  completed?: number;
  total?: number;
}

export interface OllamaRequestOptions {
  apiKey?: string;
  timeoutMs?: number;
}

/**
 * The Ollama URL to use: `configured` (a flag or cogitator.yml), else
 * `OLLAMA_BASE_URL`, `OLLAMA_URL` or `OLLAMA_HOST`, each read the way Ollama
 * reads `OLLAMA_HOST`, the same way `loadConfig` reads them.
 */
export function resolveOllamaUrl(
  env: Record<string, string | undefined> = process.env,
  configured?: string
): string {
  const candidates = [configured, env.OLLAMA_BASE_URL, env.OLLAMA_URL, env.OLLAMA_HOST];
  for (const candidate of candidates) {
    const url = resolveOllamaHost(candidate);
    if (url) return url;
  }
  return DEFAULT_OLLAMA_URL;
}

function buildHeaders(apiKey: string | undefined, json: boolean): Record<string, string> {
  const headers: Record<string, string> = {};
  if (json) headers['Content-Type'] = 'application/json';
  if (apiKey) headers.Authorization = `Bearer ${apiKey}`;
  return headers;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function toModelInfo(value: unknown): OllamaModelInfo | null {
  if (!isRecord(value) || typeof value.name !== 'string') return null;
  return {
    name: value.name,
    size: typeof value.size === 'number' ? value.size : 0,
    modified_at: typeof value.modified_at === 'string' ? value.modified_at : '',
  };
}

export async function listOllamaModels(
  baseUrl: string,
  options: OllamaRequestOptions = {}
): Promise<OllamaModelInfo[]> {
  const res = await fetch(`${baseUrl}/api/tags`, {
    headers: buildHeaders(options.apiKey, false),
    signal: AbortSignal.timeout(options.timeoutMs ?? 5000),
  });
  if (!res.ok) {
    throw new Error(`Ollama responded with HTTP ${res.status} at ${baseUrl}`);
  }
  const data: unknown = await res.json();
  if (!isRecord(data) || !Array.isArray(data.models)) {
    throw new Error(`Unexpected response from ${baseUrl}/api/tags`);
  }
  return data.models.map(toModelInfo).filter((m): m is OllamaModelInfo => m !== null);
}

export async function* readNdjson(stream: ReadableStream<Uint8Array>): AsyncGenerator<unknown> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let buffer = '';

  const parseLine = (line: string): unknown => {
    const trimmed = line.trim();
    if (!trimmed) return undefined;
    return JSON.parse(trimmed) as unknown;
  };

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });

      let newline = buffer.indexOf('\n');
      while (newline >= 0) {
        const parsed = parseLine(buffer.slice(0, newline));
        buffer = buffer.slice(newline + 1);
        if (parsed !== undefined) yield parsed;
        newline = buffer.indexOf('\n');
      }
    }

    buffer += decoder.decode();
    const last = parseLine(buffer);
    if (last !== undefined) yield last;
  } finally {
    reader.releaseLock();
  }
}

export async function pullOllamaModel(
  baseUrl: string,
  model: string,
  onProgress: (progress: OllamaPullProgress) => void,
  options: Pick<OllamaRequestOptions, 'apiKey'> = {}
): Promise<void> {
  const res = await fetch(`${baseUrl}/api/pull`, {
    method: 'POST',
    headers: buildHeaders(options.apiKey, true),
    body: JSON.stringify({ model, stream: true }),
  });

  if (!res.ok) {
    const detail = await res.text().catch(() => '');
    throw new Error(`Failed to pull ${model}: HTTP ${res.status}${detail ? ` — ${detail}` : ''}`);
  }
  if (!res.body) {
    throw new Error(`Failed to pull ${model}: empty response body`);
  }

  let sawSuccess = false;
  for await (const event of readNdjson(res.body)) {
    if (!isRecord(event)) continue;
    if (typeof event.error === 'string') {
      throw new Error(`Failed to pull ${model}: ${event.error}`);
    }
    if (typeof event.status !== 'string') continue;
    if (event.status === 'success') sawSuccess = true;
    onProgress({
      status: event.status,
      completed: typeof event.completed === 'number' ? event.completed : undefined,
      total: typeof event.total === 'number' ? event.total : undefined,
    });
  }

  if (!sawSuccess) {
    throw new Error(`Failed to pull ${model}: stream ended before completion`);
  }
}
