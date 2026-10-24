/**
 * Records keyed by strings that come from users (agent names, option names, settings keys):
 * read only through a key the record owns, so `__proto__`, `constructor` or `toString` read
 * nothing from `Object.prototype` and never write to it
 */

/** `record[key]` when the record owns `key`, undefined otherwise */
export function own<T>(
  record: Readonly<Record<string, T>> | undefined,
  key: string
): T | undefined {
  return record !== undefined && Object.hasOwn(record, key) ? record[key] : undefined;
}

/** A record without a prototype, where `__proto__` is a key like any other */
export function dictionary<T>(entries: Iterable<readonly [string, T]> = []): Record<string, T> {
  const record = Object.create(null) as Record<string, T>;
  for (const [key, value] of entries) record[key] = value;
  return record;
}
