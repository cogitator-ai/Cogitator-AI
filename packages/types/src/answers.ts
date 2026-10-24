/**
 * Reading what a person typed or said as the answer to a question a tool asked
 * (`context.interrupt()`), by the question's JSON Schema
 */

import { z, type ZodType } from 'zod';

type Schema = Record<string, unknown>;

/** An answer read from text: the value for `responses`, or why the text does not answer */
export type ParsedAnswer = { ok: true; value: unknown } | { ok: false; problem: string };

const YES = new Set(['yes', 'y', 'true', 'ok', 'okay', 'sure', '1', 'да', 'д', 'ага']);
const NO = new Set(['no', 'n', 'false', 'nope', '0', 'нет', 'н']);

/**
 * Reads `text` as the answer to a question with `schema`: a yes or no for a boolean (in English
 * or Russian), a number, a member of an `enum` whatever its case, the first member of an `anyOf`
 * or `oneOf` the text fits, JSON for an object or the text as its one required field, JSON or a
 * comma-separated list for an array, the text itself for a string or no schema. The value is
 * checked against the schema, and a text that fits none gives a `problem` a person can read
 */
export function parseAnswer(text: string, schema?: Schema): ParsedAnswer {
  const trimmed = text.trim();
  if (!schema) return { ok: true, value: text };
  const validator = validatorOf(schema);
  for (const candidate of candidatesOf(trimmed, schema)) {
    if (!validator || validator.safeParse(candidate).success) return { ok: true, value: candidate };
  }
  const format = answerFormat(schema);
  return {
    ok: false,
    problem: format ? `the answer should be ${format}` : 'the answer does not fit what was asked',
  };
}

/**
 * What an answer to a question with `schema` looks like, for a person: `yes or no`, `a number
 * from 1 to 5`, `one of: eu, us`. Undefined for free text
 */
export function answerFormat(schema?: Schema): string | undefined {
  if (!schema) return undefined;
  const choices = enumOf(schema);
  if (choices) return `one of: ${choices.map(String).join(', ')}`;
  if ('const' in schema) return `"${String(schema.const)}"`;
  const members = membersOf(schema);
  if (members) {
    const formats = members.map(answerFormat).filter((format) => format !== undefined);
    return formats.length > 0 ? formats.join(' or ') : undefined;
  }
  switch (typeOf(schema)) {
    case 'boolean':
      return 'yes or no';
    case 'integer':
      return `a whole number${rangeOf(schema)}`;
    case 'number':
      return `a number${rangeOf(schema)}`;
    case 'array': {
      const items = isSchema(schema.items) ? answerFormat(schema.items) : undefined;
      return `a comma-separated list${items ? ` of ${items}` : ''}`;
    }
    case 'object': {
      const field = soleField(schema);
      if (field) return answerFormat(field.schema) ?? `the ${field.name}`;
      const keys = Object.keys(propertiesOf(schema));
      return keys.length > 0 ? `JSON with ${keys.join(', ')}` : 'JSON';
    }
    case 'string': {
      if (typeof schema.format === 'string') return `a ${schema.format}`;
      const length = lengthOf(schema);
      return length ? `text${length}` : undefined;
    }
    default:
      return undefined;
  }
}

function candidatesOf(text: string, schema: Schema): unknown[] {
  const choices = enumOf(schema);
  if (choices) {
    const match = choices.find((choice) => String(choice).toLowerCase() === text.toLowerCase());
    return match === undefined ? [text] : [match];
  }
  if ('const' in schema) return [schema.const];
  const members = membersOf(schema);
  if (members) return members.flatMap((member) => candidatesOf(text, member));
  switch (typeOf(schema)) {
    case 'boolean': {
      const word = text.toLowerCase().replace(/[.!]+$/, '');
      if (YES.has(word)) return [true];
      if (NO.has(word)) return [false];
      return [];
    }
    case 'integer':
    case 'number': {
      const value = Number(text.replace(',', '.'));
      return text !== '' && Number.isFinite(value) ? [value] : [];
    }
    case 'null':
      return ['null', 'none', ''].includes(text.toLowerCase()) ? [null] : [];
    case 'array': {
      const json = jsonOf(text);
      if (Array.isArray(json)) return [json];
      const items = isSchema(schema.items) ? schema.items : undefined;
      const parts = text.split(',').map((part) => part.trim());
      return [parts.map((part) => (items ? (candidatesOf(part, items)[0] ?? part) : part))];
    }
    case 'object': {
      const json = jsonOf(text);
      const field = soleField(schema);
      const fromText = field
        ? candidatesOf(text, field.schema).map((value) => ({ [field.name]: value }))
        : [];
      return [
        ...(json !== undefined && typeof json === 'object' && json !== null ? [json] : []),
        ...fromText,
      ];
    }
    case 'string':
      return [text];
    default: {
      const json = jsonOf(text);
      return json === undefined ? [text] : [json, text];
    }
  }
}

function validatorOf(schema: Schema): ZodType | undefined {
  try {
    return z.fromJSONSchema(schema);
  } catch {
    return undefined;
  }
}

function jsonOf(text: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return undefined;
  }
}

function isSchema(value: unknown): value is Schema {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function typeOf(schema: Schema): string | undefined {
  const type = schema.type;
  if (typeof type === 'string') return type;
  if (Array.isArray(type)) {
    const real = type.filter(
      (entry): entry is string => typeof entry === 'string' && entry !== 'null'
    );
    return real.length === 1 ? real[0] : undefined;
  }
  return undefined;
}

function enumOf(schema: Schema): unknown[] | undefined {
  return Array.isArray(schema.enum) && schema.enum.length > 0 ? schema.enum : undefined;
}

function membersOf(schema: Schema): Schema[] | undefined {
  const members = Array.isArray(schema.anyOf)
    ? schema.anyOf
    : Array.isArray(schema.oneOf)
      ? schema.oneOf
      : undefined;
  return members?.filter(isSchema);
}

function propertiesOf(schema: Schema): Record<string, unknown> {
  return isSchema(schema.properties) ? schema.properties : {};
}

/** The one field an object needs, which a plain text answer fills */
function soleField(schema: Schema): { name: string; schema: Schema } | undefined {
  const properties = propertiesOf(schema);
  const required = Array.isArray(schema.required)
    ? schema.required.filter((name): name is string => typeof name === 'string')
    : [];
  const names = required.length > 0 ? required : Object.keys(properties);
  if (names.length !== 1) return undefined;
  const [name] = names;
  const field = name === undefined ? undefined : properties[name];
  return name !== undefined && isSchema(field) ? { name, schema: field } : undefined;
}

function rangeOf(schema: Schema): string {
  const min = typeof schema.minimum === 'number' ? schema.minimum : undefined;
  const max = typeof schema.maximum === 'number' ? schema.maximum : undefined;
  if (min !== undefined && max !== undefined) return ` from ${min} to ${max}`;
  if (min !== undefined) return ` of at least ${min}`;
  if (max !== undefined) return ` of at most ${max}`;
  return '';
}

function lengthOf(schema: Schema): string {
  const min = typeof schema.minLength === 'number' ? schema.minLength : undefined;
  const max = typeof schema.maxLength === 'number' ? schema.maxLength : undefined;
  if (min !== undefined && max !== undefined) return ` of ${min} to ${max} characters`;
  if (min !== undefined) return ` of at least ${min} characters`;
  if (max !== undefined) return ` of at most ${max} characters`;
  return '';
}
