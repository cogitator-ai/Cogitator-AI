type JsonSchemaObject = Record<string, unknown>;

const SUPPORTED_STRING_FORMATS: ReadonlySet<string> = new Set([
  'date-time',
  'time',
  'date',
  'duration',
  'email',
  'hostname',
  'uri',
  'ipv4',
  'ipv6',
  'uuid',
]);

const UNSUPPORTED_CONSTRAINTS: readonly string[] = [
  'minimum',
  'maximum',
  'exclusiveMinimum',
  'exclusiveMaximum',
  'multipleOf',
  'minLength',
  'maxLength',
  'maxItems',
  'uniqueItems',
  'minProperties',
  'maxProperties',
  'patternProperties',
  'propertyNames',
];

const SCHEMA_MAP_KEYWORDS: readonly string[] = ['properties', '$defs', 'definitions'];
const SCHEMA_LIST_KEYWORDS: readonly string[] = ['anyOf', 'allOf', 'prefixItems'];

function isSchemaObject(value: unknown): value is JsonSchemaObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isObjectSchema(schema: JsonSchemaObject): boolean {
  const { type } = schema;
  if (type === 'object') return true;
  if (Array.isArray(type)) return type.includes('object');
  return type === undefined && isSchemaObject(schema.properties);
}

function transformNode(schema: unknown): unknown {
  if (!isSchemaObject(schema)) return schema;

  const result: JsonSchemaObject = {};
  const moved: string[] = [];

  for (const [key, value] of Object.entries(schema)) {
    if (key === '$schema') continue;

    if (key === 'oneOf' && Array.isArray(value)) {
      result.anyOf = value.map(transformNode);
    } else if (SCHEMA_LIST_KEYWORDS.includes(key) && Array.isArray(value)) {
      result[key] = value.map(transformNode);
    } else if (SCHEMA_MAP_KEYWORDS.includes(key) && isSchemaObject(value)) {
      result[key] = Object.fromEntries(
        Object.entries(value).map(([name, child]) => [name, transformNode(child)])
      );
    } else if (key === 'items' || key === 'not') {
      result[key] = transformNode(value);
    } else if (key === 'additionalProperties') {
      continue;
    } else if (
      key === 'format' &&
      typeof value === 'string' &&
      !SUPPORTED_STRING_FORMATS.has(value)
    ) {
      moved.push(`format: ${JSON.stringify(value)}`);
    } else if (key === 'minItems' && value !== 0 && value !== 1) {
      moved.push(`minItems: ${JSON.stringify(value)}`);
    } else if (UNSUPPORTED_CONSTRAINTS.includes(key)) {
      moved.push(`${key}: ${JSON.stringify(value)}`);
    } else {
      result[key] = value;
    }
  }

  if (isObjectSchema(schema)) {
    result.additionalProperties = false;
  }

  if (moved.length > 0) {
    const hint = `{${moved.join(', ')}}`;
    result.description =
      typeof result.description === 'string' && result.description.length > 0
        ? `${result.description}\n\n${hint}`
        : hint;
  }

  return result;
}

/**
 * Rewrite a JSON schema into the subset accepted by Claude structured outputs:
 * every object gets `additionalProperties: false`, `oneOf` becomes `anyOf`, and
 * unsupported constraints (numeric bounds, string lengths, `maxItems`, unknown
 * formats, ...) are moved into the description so the model still sees them.
 * The input is never mutated.
 */
export function toClaudeStrictJsonSchema(schema: Record<string, unknown>): Record<string, unknown> {
  const transformed = transformNode(schema);
  return isSchemaObject(transformed) ? transformed : {};
}
