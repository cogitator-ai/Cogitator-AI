import type { ToolParametersSchema } from '@cogitator-ai/types';

type JSONSchemaNode = Record<string, unknown>;

const DEFS_PREFIX = '#/$defs/';
const DEFINITIONS_PREFIX = '#/definitions/';

/**
 * The parameters of a tool as one self-contained JSON Schema object, the form every backend,
 * MCP and the AI SDK bridge send on.
 *
 * Definitions in `definitions` and `$defs` are gathered into `$defs`. A local `$ref` to a
 * definition that is not recursive is replaced by the definition, so providers with a partial
 * JSON Schema dialect see plain nested schemas. Definitions recursive refs point to stay in
 * `$defs`, with their refs written as `#/$defs/<name>`, so the schema never refers to a
 * definition it does not carry. `$schema` is dropped, every other keyword is kept.
 */
export function toToolParameters(schema: JSONSchemaNode): ToolParametersSchema {
  const { $schema: _schema, $defs, definitions, ...root } = schema;
  const defs = new Map<string, JSONSchemaNode>();
  const aliases = new Map<string, string>();

  for (const [name, def] of entries(definitions)) {
    defs.set(name, def);
    aliases.set(`${DEFINITIONS_PREFIX}${encodePointerSegment(name)}`, name);
  }
  for (const [name, def] of entries($defs)) {
    const unique = uniqueName(name, defs);
    defs.set(unique, def);
    aliases.set(`${DEFS_PREFIX}${encodePointerSegment(name)}`, unique);
  }
  if (defs.size === 0) return asParameters(root);

  const target = (ref: string): string | undefined => aliases.get(ref);
  const recursive = recursiveDefinitions(defs, target);
  const kept = new Map<string, JSONSchemaNode>();

  const inline = (node: unknown, inlining: ReadonlySet<string>): unknown => {
    if (Array.isArray(node)) return node.map((item) => inline(item, inlining));
    if (!isNode(node)) return node;

    const ref = typeof node.$ref === 'string' ? node.$ref : undefined;
    const name = ref === undefined ? undefined : target(ref);
    if (name !== undefined) {
      const { $ref: _ref, ...siblings } = node;
      const rest = inlineEntries(siblings, inlining);
      if (recursive.has(name) || inlining.has(name)) {
        keep(name);
        return { $ref: `${DEFS_PREFIX}${encodePointerSegment(name)}`, ...rest };
      }
      const resolved = inline(defs.get(name), new Set([...inlining, name]));
      return isNode(resolved) ? { ...resolved, ...rest } : rest;
    }
    return inlineEntries(node, inlining);
  };

  const inlineEntries = (node: JSONSchemaNode, inlining: ReadonlySet<string>): JSONSchemaNode => {
    const result: JSONSchemaNode = {};
    for (const [key, value] of Object.entries(node)) {
      result[key] = isPropertyMap(key)
        ? mapValues(value, (child) => inline(child, inlining))
        : inline(value, inlining);
    }
    return result;
  };

  const keep = (name: string): void => {
    if (kept.has(name)) return;
    kept.set(name, {});
    kept.set(name, inline(defs.get(name), new Set([name])) as JSONSchemaNode);
  };

  const inlined = inline(root, new Set());
  const parameters = asParameters(isNode(inlined) ? inlined : {});
  if (kept.size > 0) {
    parameters.$defs = Object.fromEntries(kept);
  }
  return parameters;
}

/** Definitions that reach themselves through refs: they cannot be inlined. */
function recursiveDefinitions(
  defs: ReadonlyMap<string, JSONSchemaNode>,
  target: (ref: string) => string | undefined
): Set<string> {
  const edges = new Map<string, Set<string>>();
  for (const [name, def] of defs) {
    const refs = new Set<string>();
    collectRefs(def, (ref) => {
      const resolved = target(ref);
      if (resolved !== undefined) refs.add(resolved);
    });
    edges.set(name, refs);
  }

  const recursive = new Set<string>();
  for (const start of defs.keys()) {
    const seen = new Set<string>();
    const stack = [...(edges.get(start) ?? [])];
    while (stack.length > 0) {
      const next = stack.pop()!;
      if (next === start) {
        recursive.add(start);
        break;
      }
      if (seen.has(next)) continue;
      seen.add(next);
      stack.push(...(edges.get(next) ?? []));
    }
  }
  return recursive;
}

function collectRefs(node: unknown, visit: (ref: string) => void): void {
  if (Array.isArray(node)) {
    for (const item of node) collectRefs(item, visit);
    return;
  }
  if (!isNode(node)) return;
  if (typeof node.$ref === 'string') visit(node.$ref);
  for (const value of Object.values(node)) collectRefs(value, visit);
}

function asParameters(node: JSONSchemaNode): ToolParametersSchema {
  const required = Array.isArray(node.required)
    ? node.required.filter((key): key is string => typeof key === 'string')
    : undefined;
  return {
    ...node,
    type: 'object',
    properties: isNode(node.properties) ? node.properties : {},
    ...(required !== undefined ? { required } : {}),
  };
}

const PROPERTY_MAPS = new Set(['properties', 'patternProperties', '$defs', 'definitions']);

function isPropertyMap(key: string): boolean {
  return PROPERTY_MAPS.has(key);
}

function mapValues(value: unknown, map: (child: unknown) => unknown): unknown {
  if (!isNode(value)) return value;
  return Object.fromEntries(Object.entries(value).map(([key, child]) => [key, map(child)]));
}

function entries(value: unknown): [string, JSONSchemaNode][] {
  if (!isNode(value)) return [];
  return Object.entries(value).filter((entry): entry is [string, JSONSchemaNode] =>
    isNode(entry[1])
  );
}

function uniqueName(name: string, taken: ReadonlyMap<string, unknown>): string {
  if (!taken.has(name)) return name;
  let index = 2;
  while (taken.has(`${name}_${index}`)) index++;
  return `${name}_${index}`;
}

function encodePointerSegment(segment: string): string {
  return segment.replace(/~/g, '~0').replace(/\//g, '~1');
}

function isNode(value: unknown): value is JSONSchemaNode {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
