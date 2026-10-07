export const DEFAULT_OLLAMA_URL = 'http://localhost:11434';

export interface OllamaModel {
  name: string;
  size: number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** `value` without the slashes it ends with, in linear time, unlike `replace(/\/+$/, '')`. */
function trimTrailingSlashes(value: string): string {
  let end = value.length;
  while (end > 0 && value[end - 1] === '/') end--;
  return value.slice(0, end);
}

/**
 * The Ollama server the generated code talks to: `OLLAMA_BASE_URL`, which it
 * reads, then `OLLAMA_HOST`, which the Ollama CLI reads, then the local default.
 */
export function resolveOllamaUrl(env: Record<string, string | undefined> = process.env): string {
  const raw = env.OLLAMA_BASE_URL?.trim() || env.OLLAMA_HOST?.trim();
  if (!raw) return DEFAULT_OLLAMA_URL;
  const withScheme = /^https?:\/\//i.test(raw) ? raw : `http://${raw}`;
  return trimTrailingSlashes(withScheme);
}

/** The models installed in the Ollama at `baseUrl`, or `undefined` when it does not answer. */
export async function listOllamaModels(
  baseUrl: string,
  timeoutMs = 2000
): Promise<OllamaModel[] | undefined> {
  try {
    const res = await fetch(`${baseUrl}/api/tags`, { signal: AbortSignal.timeout(timeoutMs) });
    if (!res.ok) return undefined;
    const data: unknown = await res.json();
    if (!isRecord(data) || !Array.isArray(data.models)) return undefined;
    return data.models.flatMap((model: unknown) =>
      isRecord(model) && typeof model.name === 'string'
        ? [{ name: model.name, size: typeof model.size === 'number' ? model.size : 0 }]
        : []
    );
  } catch {
    return undefined;
  }
}

function withTag(name: string): string {
  return name.includes(':') ? name : `${name}:latest`;
}

/** Whether `model` is among `installed`, treating a name without a tag as `:latest` like Ollama does. */
export function hasOllamaModel(installed: readonly OllamaModel[], model: string): boolean {
  const wanted = withTag(model);
  return installed.some((m) => withTag(m.name) === wanted);
}

function describeProgress(event: Record<string, unknown>, status: string): string {
  const { completed, total } = event;
  if (typeof completed === 'number' && typeof total === 'number' && total > 0) {
    return `${status} ${Math.floor((completed / total) * 100)}%`;
  }
  return status;
}

async function* ndjson(stream: ReadableStream<Uint8Array>): AsyncGenerator<unknown> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let newline = buffer.indexOf('\n');
      while (newline >= 0) {
        const line = buffer.slice(0, newline).trim();
        buffer = buffer.slice(newline + 1);
        if (line) yield JSON.parse(line) as unknown;
        newline = buffer.indexOf('\n');
      }
    }
    const rest = (buffer + decoder.decode()).trim();
    if (rest) yield JSON.parse(rest) as unknown;
  } finally {
    reader.releaseLock();
  }
}

/** Pulls `model` into the Ollama at `baseUrl`, reporting each status line; throws when the pull fails. */
export async function pullOllamaModel(
  baseUrl: string,
  model: string,
  onStatus: (status: string) => void
): Promise<void> {
  const res = await fetch(`${baseUrl}/api/pull`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ model, stream: true }),
  });
  if (!res.ok || !res.body) {
    const detail = await res.text().catch(() => '');
    throw new Error(`Failed to pull ${model}: HTTP ${res.status}${detail ? ` ${detail}` : ''}`);
  }

  let succeeded = false;
  for await (const event of ndjson(res.body)) {
    if (!isRecord(event)) continue;
    if (typeof event.error === 'string') throw new Error(`Failed to pull ${model}: ${event.error}`);
    if (typeof event.status !== 'string') continue;
    if (event.status === 'success') succeeded = true;
    onStatus(describeProgress(event, event.status));
  }

  if (!succeeded) {
    throw new Error(`Failed to pull ${model}: the download stopped before it finished`);
  }
}
