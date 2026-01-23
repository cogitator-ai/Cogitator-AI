import { createHash } from 'crypto';

export interface CacheKeyOptions {
  toolName: string;
  params: unknown;
  prefix?: string;
}

export function generateCacheKey(options: CacheKeyOptions): string {
  const { toolName, params, prefix = 'toolcache' } = options;
  const paramsStr = stableStringify(params);
  const hash = createHash('sha256').update(`${toolName}:${paramsStr}`).digest('hex').slice(0, 16);
  return `${prefix}:${toolName}:${hash}`;
}

export function stableStringify(obj: unknown): string {
  if (obj === null || typeof obj !== 'object') {
    return JSON.stringify(obj);
  }

  if (Array.isArray(obj)) {
    return '[' + obj.map(stableStringify).join(',') + ']';
  }

  const keys = Object.keys(obj).sort();
  const pairs = keys.map(
    (k) => `${JSON.stringify(k)}:${stableStringify((obj as Record<string, unknown>)[k])}`
  );
  return '{' + pairs.join(',') + '}';
}

export function paramsToQueryString(params: unknown): string {
  if (typeof params === 'string') return params;

  if (typeof params === 'object' && params !== null) {
    const obj = params as Record<string, unknown>;
    const queryFields = ['query', 'q', 'search', 'text', 'input', 'prompt', 'question'];
    for (const field of queryFields) {
      if (typeof obj[field] === 'string') {
        return obj[field] as string;
      }
    }
    return JSON.stringify(params);
  }

  return String(params);
}

export function cosineSimilarity(a: number[], b: number[]): number {
  if (a.length !== b.length) return 0;

  let dotProduct = 0;
  let normA = 0;
  let normB = 0;

  for (let i = 0; i < a.length; i++) {
    dotProduct += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }

  const magnitude = Math.sqrt(normA) * Math.sqrt(normB);
  return magnitude === 0 ? 0 : dotProduct / magnitude;
}

export function parseDuration(duration: string): number {
  const match = /^(\d+(?:\.\d+)?)\s*(ms|s|m|h|d|w)$/i.exec(duration);
  if (!match) {
    throw new Error(`Invalid duration format: ${duration}`);
  }

  const value = parseFloat(match[1]);
  const unit = match[2].toLowerCase();

  const multipliers: Record<string, number> = {
    ms: 1,
    s: 1000,
    m: 60_000,
    h: 3600_000,
    d: 86400_000,
    w: 604800_000,
  };

  return Math.floor(value * multipliers[unit]);
}
