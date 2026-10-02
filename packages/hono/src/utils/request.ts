import type { Context } from 'hono';
import type { HonoEnv } from '../types.js';
import { resolveError } from './errors.js';

export type JsonBodyResult = { ok: true; value: unknown } | { ok: false };

export async function readJsonBody(c: Context<HonoEnv>): Promise<JsonBodyResult> {
  const text = await c.req.text();
  if (!text.trim()) return { ok: true, value: undefined };
  try {
    return { ok: true, value: JSON.parse(text) as unknown };
  } catch {
    return { ok: false };
  }
}

export function createRequestAbortController(c: Context<HonoEnv>): AbortController {
  const controller = new AbortController();
  const signal = c.req.raw.signal;
  if (signal.aborted) {
    controller.abort();
  } else {
    signal.addEventListener('abort', () => controller.abort(), { once: true });
  }
  return controller;
}

export function invalidInput(c: Context<HonoEnv>, message: string): Response {
  return c.json({ error: { message, code: 'INVALID_INPUT' } }, 400);
}

export function invalidJson(c: Context<HonoEnv>): Response {
  return invalidInput(c, 'Invalid JSON body');
}

export function errorResponse(c: Context<HonoEnv>, error: unknown, label: string): Response {
  const { status, body } = resolveError(error, label);
  return c.json(body, status);
}

export function requestAborted(c: Context<HonoEnv>): Response {
  return c.json({ error: { message: 'Request aborted', code: 'ABORTED' } }, 400);
}
