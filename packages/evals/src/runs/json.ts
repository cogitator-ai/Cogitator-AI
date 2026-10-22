import { createHash } from 'node:crypto';

function hasToJson(value: object): value is { toJSON: (key: string) => unknown } {
  return typeof (value as { toJSON?: unknown }).toJSON === 'function';
}

function convert(
  value: unknown,
  key: string,
  ancestors: object[],
  sortKeys: boolean,
  calledToJson = false
): unknown {
  if (value === null) return null;
  switch (typeof value) {
    case 'string':
    case 'boolean':
      return value;
    case 'number':
      return Number.isFinite(value) ? value : null;
    case 'bigint':
      return value.toString();
    case 'undefined':
    case 'function':
    case 'symbol':
      return undefined;
  }
  const object = value as object;
  if (!calledToJson && hasToJson(object)) {
    return convert(object.toJSON(key), key, ancestors, sortKeys, true);
  }
  if (ancestors.includes(object)) return '[Circular]';
  const nested = [...ancestors, object];
  if (Array.isArray(object)) {
    return object.map((item, at) => convert(item, String(at), nested, sortKeys) ?? null);
  }
  const keys = Object.keys(object);
  if (sortKeys) keys.sort();
  const out: Record<string, unknown> = {};
  for (const name of keys) {
    const converted = convert((object as Record<string, unknown>)[name], name, nested, sortKeys);
    if (converted !== undefined) out[name] = converted;
  }
  return out;
}

/**
 * A value as JSON keeps it, as `JSON.stringify` would write it (`toJSON` called once per value),
 * except that a bigint becomes its
 * decimal string and a circular reference the string `[Circular]` instead of throwing
 */
export function toJson(value: unknown): unknown {
  return convert(value, '', [], false);
}

/** JSON of a value with the keys of every object sorted, the same text for the same data */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(convert(value, '', [], true) ?? null);
}

/** Hex SHA-256 of the canonical JSON of a value */
export function fingerprint(value: unknown): string {
  return createHash('sha256').update(canonicalJson(value)).digest('hex');
}
