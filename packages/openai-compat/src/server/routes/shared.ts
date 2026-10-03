import type { FastifyReply } from 'fastify';
import { formatOpenAIError } from '../middleware/error-handler';

export const MAX_LIST_LIMIT = 100;
export const DEFAULT_LIST_LIMIT = 20;

export interface ListLimitBounds {
  max: number;
  fallback: number;
}

/** `GET /v1/files` returns up to 10 000 files per page and all of them by default, as OpenAI does */
export const FILE_LIST_LIMIT: ListLimitBounds = { max: 10_000, fallback: 10_000 };

export function sendNotFound(reply: FastifyReply, resource: string, id: string) {
  return reply
    .status(404)
    .send(formatOpenAIError('not_found', `No ${resource} found with id '${id}'`));
}

export function sendInvalidRequest(reply: FastifyReply, message: string, param?: string) {
  return reply
    .status(400)
    .send(formatOpenAIError('invalid_request', message, 'invalid_request_error', param));
}

/**
 * Parse a `limit` query value (query strings arrive as strings). Returns
 * null when the value is not an integer between 1 and `bounds.max`.
 */
export function parseLimit(
  value: unknown,
  bounds: ListLimitBounds = { max: MAX_LIST_LIMIT, fallback: DEFAULT_LIST_LIMIT }
): number | null {
  if (value === undefined || value === '') return bounds.fallback;
  const parsed = typeof value === 'number' ? value : Number(value);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > bounds.max) return null;
  return parsed;
}

export function parseOrder(value: unknown): 'asc' | 'desc' | null {
  if (value === undefined || value === '') return 'desc';
  return value === 'asc' || value === 'desc' ? value : null;
}

/**
 * Apply OpenAI cursor pagination (`after` / `before` ids) to an ordered list.
 */
export function paginate<T extends { id: string }>(
  items: T[],
  options: { limit: number; after?: string; before?: string }
): { data: T[]; has_more: boolean; first_id?: string; last_id?: string } {
  let list = items;
  if (options.after) {
    const idx = list.findIndex((item) => item.id === options.after);
    if (idx !== -1) list = list.slice(idx + 1);
  }
  if (options.before) {
    const idx = list.findIndex((item) => item.id === options.before);
    if (idx !== -1) list = list.slice(0, idx);
  }
  const data = list.slice(0, options.limit);
  return {
    data,
    has_more: list.length > options.limit,
    first_id: data[0]?.id,
    last_id: data[data.length - 1]?.id,
  };
}
