import { randomBytes } from 'node:crypto';
import type { Cogitator } from '@cogitator-ai/core';
import pg from 'pg';
import type { StageContext } from '../../runner/types.js';

export const CORE = '@cogitator-ai/core';
export const SWARMS = '@cogitator-ai/swarms';
export const WORKFLOWS = '@cogitator-ai/workflows';
export const WORKER = '@cogitator-ai/worker';

/** A name no other stage or earlier run uses: `gauntlet_<label>_<hex>`. */
export function uniqueName(label: string): string {
  return `gauntlet_${label}_${randomBytes(4).toString('hex')}`;
}

/** `openrouter/deepseek/deepseek-v4-pro` -> `deepseek`, for readable agent names. */
export function vendorOf(model: string): string {
  const parts = model.split('/');
  return (parts.length > 2 ? parts[1] : parts[0]) ?? model;
}

/** Host and port of a `redis://` URL, in the shape the worker and swarm configs take. */
export function redisEndpoint(url: string): { host: string; port: number; password?: string } {
  const parsed = new URL(url);
  return {
    host: parsed.hostname,
    port: Number(parsed.port || 6379),
    ...(parsed.password && { password: decodeURIComponent(parsed.password) }),
  };
}

/** A Postgres pool on the gauntlet database, ended when the run finishes. */
export function postgresPool(ctx: StageContext): pg.Pool {
  const pool = new pg.Pool({ connectionString: ctx.services.postgres, max: 4 });
  ctx.onCleanup(() => pool.end());
  return pool;
}

/** Polls `probe` until it returns a value, failing with `what` after `timeoutMs`. */
export async function waitFor<T>(
  what: string,
  probe: () => Promise<T | undefined> | T | undefined,
  options: { timeoutMs: number; intervalMs?: number; signal?: AbortSignal }
): Promise<T> {
  const deadline = Date.now() + options.timeoutMs;
  for (;;) {
    options.signal?.throwIfAborted();
    const value = await probe();
    if (value !== undefined) return value;
    if (Date.now() > deadline) {
      throw new Error(
        `Timed out after ${Math.round(options.timeoutMs / 1000)} s waiting for ${what}`
      );
    }
    await new Promise((resolve) => setTimeout(resolve, options.intervalMs ?? 200));
  }
}

/** `promise`, or a rejection naming `what` once `ms` passed. */
export async function within<T>(promise: Promise<T>, ms: number, what: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () => reject(new Error(`Timed out after ${Math.round(ms / 1000)} s waiting for ${what}`)),
      ms
    );
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    clearTimeout(timer);
  }
}

/** A promise with its settle functions, for results that arrive through callbacks. */
export interface Deferred<T> {
  promise: Promise<T>;
  resolve(value: T): void;
  reject(error: unknown): void;
}

export function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

/**
 * A runtime for worker processes: a plain one with the gauntlet's OpenRouter backend, as a
 * user would build it. Serialized agents keep their `openrouter/...` model on the way to the
 * worker, which routes it to that backend.
 */
export function workerCogitator(ctx: StageContext): Cogitator {
  return ctx.createCogitator();
}

/** The first `length` characters, for evidence values. */
export function excerpt(text: string, length = 160): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length > length ? `${flat.slice(0, length)}...` : flat;
}
