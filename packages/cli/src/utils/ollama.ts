import chalk from 'chalk';
import { resolveOllamaHost } from '@cogitator-ai/config';
import { findConfig, loadRunConfig } from './run-config.js';

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
  headers?: Record<string, string>;
}

export interface OllamaConnection {
  baseUrl: string;
  apiKey?: string;
  headers?: Record<string, string>;
}

export interface OllamaConnectionOptions {
  /**
   * A flag that overrides the URL of the config, such as `models --url`. An
   * explicit URL names a server of its own, so the config file is not read at
   * all for it: its credentials and headers never reach that server.
   */
  url?: string;
  cwd?: string;
}

/**
 * The connection of a server named only by the environment: `resolveOllamaUrl`
 * over `env`, and `OLLAMA_API_KEY` as its bearer token. No config file, no
 * `.env` beside one, no headers, so it cannot fail on configuration.
 */
export function environmentConnection(
  env: Record<string, string | undefined> = process.env,
  url?: string
): OllamaConnection {
  const apiKey = env.OLLAMA_API_KEY;
  return {
    baseUrl: resolveOllamaUrl(env, url),
    ...(apiKey ? { apiKey } : {}),
  };
}

/**
 * Warns on stderr when the Ollama configuration cannot be read, keeping stdout
 * clean for commands with `--json`.
 */
export function warnConfigError(error: unknown, fallbackMessage: string): void {
  const detail =
    error instanceof Error ? error.message.split('\n').slice(0, 4).join(' ') : String(error);
  console.error(chalk.yellow('⚠'), `Cannot read the Ollama configuration: ${detail}`);
  console.error(chalk.dim(fallbackMessage));
}

/**
 * The Ollama server and credentials the CLI uses, loaded the way `run` loads them:
 * the `.env` next to the config file (or in `cwd`), `COGITATOR_CONFIG`, environment
 * variables and `cogitator.yml`. An explicit `url` skips the config entirely and
 * uses {@link environmentConnection} instead, so the configured server's credentials
 * and headers are never sent to another one. Otherwise the server, key and headers
 * are the ones `loadConfig` merges, the same the chat uses. Config errors are
 * thrown, not hidden: `status` and `models` catch them and fall back to
 * {@link environmentConnection}.
 */
export function resolveOllamaConnection(options: OllamaConnectionOptions = {}): OllamaConnection {
  const cwd = options.cwd ?? process.cwd();
  const env = process.env;
  if (options.url !== undefined) return environmentConnection(env, options.url);

  const configPath = findConfig(undefined, env, cwd);
  if (env.COGITATOR_CONFIG && !configPath) {
    throw new Error(`COGITATOR_CONFIG points to a missing file: ${env.COGITATOR_CONFIG}`);
  }

  const { config } = loadRunConfig(configPath, cwd);
  const ollama = config.llm?.providers?.ollama;
  const baseUrl = resolveOllamaUrl(env, ollama?.baseUrl);
  const apiKey = ollama?.apiKey;
  const headers = ollama?.headers;

  return {
    baseUrl,
    ...(apiKey ? { apiKey } : {}),
    ...(headers ? { headers } : {}),
  };
}

/**
 * The Ollama URL to use, in precedence: `configured` (an explicit `--url`, else
 * the config's `llm.providers.ollama.baseUrl`), then `OLLAMA_BASE_URL`,
 * `OLLAMA_URL` and `OLLAMA_HOST`, each read the way Ollama reads `OLLAMA_HOST`
 * (port 11434 when none is given, `0.0.0.0` as `localhost`), then
 * `http://localhost:11434`.
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

function buildHeaders(
  options: Pick<OllamaRequestOptions, 'apiKey' | 'headers'>,
  json: boolean
): Record<string, string> {
  const headers: Record<string, string> = {};
  for (const [name, value] of Object.entries(options.headers ?? {})) {
    const lower = name.toLowerCase();
    if (json && lower === 'content-type') continue;
    if (options.apiKey && lower === 'authorization') continue;
    headers[name] = value;
  }
  if (json) headers['Content-Type'] = 'application/json';
  if (options.apiKey) headers.Authorization = `Bearer ${options.apiKey}`;
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
    headers: buildHeaders(options, false),
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
  options: Pick<OllamaRequestOptions, 'apiKey' | 'headers'> = {}
): Promise<void> {
  const res = await fetch(`${baseUrl}/api/pull`, {
    method: 'POST',
    headers: buildHeaders(options, true),
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
