/** One operation of a JSON Patch (RFC 6902) */
export type JsonPatchOperation =
  | { op: 'add'; path: string; value: unknown }
  | { op: 'remove'; path: string }
  | { op: 'replace'; path: string; value: unknown }
  | { op: 'move'; from: string; path: string }
  | { op: 'copy'; from: string; path: string }
  | { op: 'test'; path: string; value: unknown };

/** A patch that does not apply to its document: a path that is not there, or a `test` that fails */
export class JsonPatchError extends Error {
  constructor(
    message: string,
    readonly operation: JsonPatchOperation
  ) {
    super(message);
    this.name = 'JsonPatchError';
  }
}

type JsonContainer = Record<string, unknown> | unknown[];

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** The JSON Pointer (RFC 6901) token of a key: `~` as `~0`, `/` as `~1` */
function escapeToken(token: string): string {
  return token.replace(/~/g, '~0').replace(/\//g, '~1');
}

function unescapeToken(token: string): string {
  return token.replace(/~1/g, '/').replace(/~0/g, '~');
}

/** The tokens of a JSON Pointer, none for the whole document (`''`) */
export function parseJsonPointer(pointer: string): string[] {
  if (pointer === '') return [];
  if (!pointer.startsWith('/')) throw new Error(`A JSON Pointer starts with "/": "${pointer}"`);
  return pointer.slice(1).split('/').map(unescapeToken);
}

/** Whether two JSON values are equal, objects compared key by key in any order */
export function jsonEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (Array.isArray(a)) {
    return Array.isArray(b) && a.length === b.length && a.every((item, i) => jsonEqual(item, b[i]));
  }
  if (isRecord(a) && isRecord(b)) {
    const keys = Object.keys(a);
    return (
      keys.length === Object.keys(b).length &&
      keys.every((key) => Object.hasOwn(b, key) && jsonEqual(a[key], b[key]))
    );
  }
  return false;
}

/**
 * The JSON Patch (RFC 6902) that turns `from` into `to`: objects are compared key by key and
 * arrays item by item, so a change deep inside a large state costs one operation. Values are
 * JSON: `undefined` in an object counts as a missing key
 */
export function createJsonPatch(from: unknown, to: unknown): JsonPatchOperation[] {
  const patch: JsonPatchOperation[] = [];
  diff(from, to, '', patch);
  return patch;
}

function diff(from: unknown, to: unknown, path: string, patch: JsonPatchOperation[]): void {
  if (jsonEqual(from, to)) return;
  if (isRecord(from) && isRecord(to)) {
    for (const key of Object.keys(from)) {
      if (from[key] !== undefined && (!Object.hasOwn(to, key) || to[key] === undefined)) {
        patch.push({ op: 'remove', path: `${path}/${escapeToken(key)}` });
      }
    }
    for (const [key, value] of Object.entries(to)) {
      if (value === undefined) continue;
      const child = `${path}/${escapeToken(key)}`;
      if (!Object.hasOwn(from, key) || from[key] === undefined) {
        patch.push({ op: 'add', path: child, value });
      } else {
        diff(from[key], value, child, patch);
      }
    }
    return;
  }
  if (Array.isArray(from) && Array.isArray(to)) {
    const shared = Math.min(from.length, to.length);
    for (let i = 0; i < shared; i++) diff(from[i], to[i], `${path}/${i}`, patch);
    for (let i = from.length - 1; i >= to.length; i--)
      patch.push({ op: 'remove', path: `${path}/${i}` });
    for (let i = from.length; i < to.length; i++) {
      patch.push({ op: 'add', path: `${path}/${i}`, value: to[i] });
    }
    return;
  }
  patch.push({ op: 'replace', path, value: to });
}

/**
 * `document` with `patch` applied, as RFC 6902 has it: the operations apply in order, and the
 * whole patch fails if one does. The document passed in is left as it is
 *
 * @throws JsonPatchError when an operation names a path that is not there or a `test` fails
 */
export function applyJsonPatch(document: unknown, patch: readonly JsonPatchOperation[]): unknown {
  let result = document === undefined ? undefined : structuredClone(document);
  for (const operation of patch) result = applyOperation(result, operation);
  return result;
}

function applyOperation(document: unknown, operation: JsonPatchOperation): unknown {
  switch (operation.op) {
    case 'add':
      return put(document, operation.path, structuredClone(operation.value), 'add', operation);
    case 'replace':
      return put(document, operation.path, structuredClone(operation.value), 'replace', operation);
    case 'remove':
      return take(document, operation.path, operation).document;
    case 'copy': {
      const value = structuredClone(read(document, operation.from, operation));
      return put(document, operation.path, value, 'add', operation);
    }
    case 'move': {
      if (operation.path.startsWith(`${operation.from}/`)) {
        throw new JsonPatchError(`Cannot move "${operation.from}" into itself`, operation);
      }
      const taken = take(document, operation.from, operation);
      return put(taken.document, operation.path, taken.value, 'add', operation);
    }
    case 'test':
      if (!jsonEqual(read(document, operation.path, operation), operation.value)) {
        throw new JsonPatchError(`Test failed at "${operation.path}"`, operation);
      }
      return document;
  }
}

/** The container a path ends in, and the last token of it */
function parentOf(
  document: unknown,
  path: string,
  operation: JsonPatchOperation
): { parent: JsonContainer; token: string } {
  const tokens = parseJsonPointer(path);
  const token = tokens.pop();
  if (token === undefined) throw new JsonPatchError('The path names the whole document', operation);
  let parent: unknown = document;
  for (const step of tokens) parent = child(parent, step, path, operation);
  if (!Array.isArray(parent) && !isRecord(parent)) {
    throw new JsonPatchError(`No object or array at "${path}"`, operation);
  }
  return { parent, token };
}

function child(container: unknown, token: string, path: string, operation: JsonPatchOperation) {
  if (Array.isArray(container)) {
    const index = arrayIndex(token, container.length - 1, path, operation);
    return container[index];
  }
  if (isRecord(container) && Object.hasOwn(container, token)) return container[token];
  throw new JsonPatchError(`Nothing at "${path}"`, operation);
}

function arrayIndex(token: string, max: number, path: string, operation: JsonPatchOperation) {
  if (!/^(0|[1-9][0-9]*)$/.test(token) || Number(token) > max) {
    throw new JsonPatchError(`No array index "${token}" at "${path}"`, operation);
  }
  return Number(token);
}

function read(document: unknown, path: string, operation: JsonPatchOperation): unknown {
  let value = document;
  for (const token of parseJsonPointer(path)) value = child(value, token, path, operation);
  return value;
}

/**
 * Writes the key as an own property, so a patch that names `__proto__` sets a key of that name
 * instead of swapping the object's prototype
 */
function put(
  document: unknown,
  path: string,
  value: unknown,
  mode: 'add' | 'replace',
  operation: JsonPatchOperation
): unknown {
  if (path === '') return value;
  const { parent, token } = parentOf(document, path, operation);
  if (Array.isArray(parent)) {
    if (mode === 'add' && token === '-') {
      parent.push(value);
    } else if (mode === 'add') {
      parent.splice(arrayIndex(token, parent.length, path, operation), 0, value);
    } else {
      parent[arrayIndex(token, parent.length - 1, path, operation)] = value;
    }
  } else {
    if (mode === 'replace' && !Object.hasOwn(parent, token)) {
      throw new JsonPatchError(`Nothing to replace at "${path}"`, operation);
    }
    Object.defineProperty(parent, token, {
      value,
      writable: true,
      enumerable: true,
      configurable: true,
    });
  }
  return document;
}

function take(
  document: unknown,
  path: string,
  operation: JsonPatchOperation
): { document: unknown; value: unknown } {
  if (path === '') return { document: undefined, value: document };
  const { parent, token } = parentOf(document, path, operation);
  if (Array.isArray(parent)) {
    const [value] = parent.splice(arrayIndex(token, parent.length - 1, path, operation), 1);
    return { document, value };
  }
  if (!Object.hasOwn(parent, token)) {
    throw new JsonPatchError(`Nothing to remove at "${path}"`, operation);
  }
  const value = parent[token];
  delete parent[token];
  return { document, value };
}
