import { isMap, parseDocument, type Document, type Pair, type Scalar } from 'yaml';

export type MergePath = ReadonlyArray<string | number>;

/** One change a three-way merge applies to the user's copy. */
export type MergeOp =
  { kind: 'set'; path: MergePath; value: unknown } | { kind: 'delete'; path: MergePath };

export interface MergeOutcome {
  ops: MergeOp[];
  /** Paths the generator and the user changed in different ways. */
  conflicts: MergePath[];
}

type PlainObject = Record<string, unknown>;

function isPlainObject(value: unknown): value is PlainObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isPrimitiveList(value: unknown): value is Array<string | number | boolean> {
  return (
    Array.isArray(value) &&
    value.every((item) => ['string', 'number', 'boolean'].includes(typeof item))
  );
}

export function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (Array.isArray(a) && Array.isArray(b)) {
    return a.length === b.length && a.every((item, i) => deepEqual(item, b[i]));
  }
  if (isPlainObject(a) && isPlainObject(b)) {
    const keys = Object.keys(a);
    return (
      keys.length === Object.keys(b).length &&
      keys.every((key) => Object.hasOwn(b, key) && deepEqual(a[key], b[key]))
    );
  }
  return false;
}

/**
 * Merges what the generator changed (`base` to `theirs`) into the user's copy
 * (`ours`), the way `git merge` treats a file, but key by key. A key the
 * generator did not change keeps the user's value, a key the user did not
 * change takes the generator's. Lists of plain values merge as sets, so a
 * dependency or a secret added on both sides is kept once. Anything else both
 * sides changed differently is a conflict.
 */
export function merge3(
  base: unknown,
  ours: unknown,
  theirs: unknown,
  path: MergePath = []
): MergeOutcome {
  if (deepEqual(base, theirs) || deepEqual(ours, theirs)) return { ops: [], conflicts: [] };

  if ((base === undefined || isPlainObject(base)) && isPlainObject(ours) && isPlainObject(theirs)) {
    const from = base ?? {};
    const outcome: MergeOutcome = { ops: [], conflicts: [] };
    for (const key of new Set([...Object.keys(from), ...Object.keys(theirs)])) {
      const child = merge3(from[key], ours[key], theirs[key], [...path, key]);
      outcome.ops.push(...child.ops);
      outcome.conflicts.push(...child.conflicts);
    }
    return outcome;
  }

  if (deepEqual(ours, base)) {
    return {
      ops: [theirs === undefined ? { kind: 'delete', path } : { kind: 'set', path, value: theirs }],
      conflicts: [],
    };
  }

  if (
    (base === undefined || isPrimitiveList(base)) &&
    isPrimitiveList(ours) &&
    isPrimitiveList(theirs)
  ) {
    const from = base ?? [];
    const removed = from.filter((item) => !theirs.includes(item));
    const added = theirs.filter((item) => !from.includes(item) && !ours.includes(item));
    const merged = [...ours.filter((item) => !removed.includes(item)), ...added];
    return {
      ops: deepEqual(merged, ours) ? [] : [{ kind: 'set', path, value: merged }],
      conflicts: [],
    };
  }

  return { ops: [], conflicts: [path] };
}

/** `value` with `ops` applied, leaving `value` itself untouched. */
export function applyOps(value: unknown, ops: readonly MergeOp[]): unknown {
  let root: unknown = structuredClone(value);
  for (const op of ops) {
    if (op.path.length === 0) {
      root = op.kind === 'set' ? structuredClone(op.value) : undefined;
      continue;
    }
    let node: unknown = root;
    for (const key of op.path.slice(0, -1)) {
      if (!isPlainObject(node)) throw new Error(`Cannot merge into ${formatPath(op.path)}`);
      if (!isPlainObject(node[key])) node[key] = {};
      node = node[key];
    }
    if (!isPlainObject(node)) throw new Error(`Cannot merge into ${formatPath(op.path)}`);
    const last = String(op.path.at(-1));
    if (op.kind === 'set') node[last] = structuredClone(op.value);
    else delete node[last];
  }
  return root;
}

export function formatPath(path: MergePath): string {
  return path.length === 0 ? '(the whole file)' : path.join('.');
}

/**
 * Applies `ops` to a YAML document in place, keeping the user's comments,
 * layout and key order. A new top-level section gets a blank line before it,
 * like the generator writes them.
 */
export function applyYamlOps(doc: Document, ops: readonly MergeOp[]): void {
  for (const op of ops) {
    if (op.kind === 'delete') {
      doc.deleteIn(op.path);
      continue;
    }
    const [first] = op.path;
    const contents = doc.contents;
    if (op.path.length === 1 && isMap(contents) && !contents.has(first)) {
      const pair = doc.createPair(first, op.value) as Pair<Scalar, unknown>;
      pair.key.spaceBefore = contents.items.length > 0;
      contents.items.push(pair);
    } else {
      doc.setIn(op.path, doc.createNode(op.value));
    }
  }
}

export type StructuredFormat = 'json' | 'yaml';

export function structuredFormat(path: string): StructuredFormat | undefined {
  if (path.endsWith('.json')) return 'json';
  if (path.endsWith('.yml') || path.endsWith('.yaml')) return 'yaml';
  return undefined;
}

/** Parses a JSON or YAML file, or `undefined` when it does not parse. */
export function parseStructured(format: StructuredFormat, text: string): unknown {
  try {
    if (format === 'json') return JSON.parse(text) as unknown;
    const doc = parseDocument(text);
    return doc.errors.length > 0 ? undefined : (doc.toJS() as unknown);
  } catch {
    return undefined;
  }
}
