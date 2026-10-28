/**
 * The digest a tool call is known by across rounds: its tool and its arguments, keys in order
 */

import { createHash } from 'node:crypto';

/** A digest of a call: its tool and its arguments, keys in order */
export function callDigest(tool: string, args: unknown): string {
  return createHash('sha256')
    .update(tool)
    .update('\0')
    .update(stableJson(args))
    .digest('base64url');
}

/** JSON of `value` with object keys in order, the same for equal values */
export function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (typeof value === 'object' && value !== null) {
    const entries = Object.entries(value)
      .filter(([, entry]) => entry !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([key, entry]) => `${JSON.stringify(key)}:${stableJson(entry)}`).join(',')}}`;
  }
  return JSON.stringify(value) ?? 'null';
}
