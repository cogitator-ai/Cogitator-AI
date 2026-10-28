import { APP_SERVER_ERROR_CODES } from '../protocol/errors.js';
import { CLIENT_RUNTIME } from './client-runtime.js';
import {
  generateJsonSchema,
  refName,
  type AppServerSchemaBundle,
  type BundledMethod,
  type JsonSchema,
} from './json-schema.js';

/** The file `generate-ts` writes */
export const TYPESCRIPT_CLIENT_FILE_NAME = 'cogitator-app-server.ts';

const IDENTIFIER = /^[A-Za-z_$][A-Za-z0-9_$]*$/;

function isSchema(value: unknown): value is JsonSchema {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function schemaList(value: unknown): JsonSchema[] {
  return Array.isArray(value) ? value.filter(isSchema) : [];
}

function literal(value: unknown): string {
  return typeof value === 'string'
    ? `'${value.replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`
    : JSON.stringify(value);
}

function propertyKey(key: string): string {
  return IDENTIFIER.test(key) ? key : literal(key);
}

function pad(depth: number): string {
  return '  '.repeat(depth);
}

/** `text` as a JSDoc block at `depth`, nothing for no text */
function jsDoc(text: unknown, depth: number): string {
  if (typeof text !== 'string' || text.trim() === '') return '';
  const lines = text.replace(/\*\//g, '*\\/').split('\n');
  if (lines.length === 1) return `${pad(depth)}/** ${lines[0]} */\n`;
  return `${pad(depth)}/**\n${lines.map((line) => `${pad(depth)} *${line ? ` ${line}` : ''}`).join('\n')}\n${pad(depth)} */\n`;
}

function union(members: string[]): string {
  const unique = [...new Set(members)];
  if (unique.length === 0) return 'never';
  return unique.join(' | ');
}

function wrapped(type: string): string {
  return type.includes(' | ') || type.includes(' & ') ? `(${type})` : type;
}

/** The TypeScript type of a JSON Schema, written at `depth` */
export function printType(schema: JsonSchema, depth = 0): string {
  if (typeof schema.$ref === 'string') return refName(schema.$ref);
  if ('const' in schema) return literal(schema.const);
  if (Array.isArray(schema.enum)) return union(schema.enum.map(literal));
  const anyOf = schemaList(schema.anyOf ?? schema.oneOf);
  if (anyOf.length > 0) return union(anyOf.map((member) => printType(member, depth)));
  const allOf = schemaList(schema.allOf);
  if (allOf.length > 0) return allOf.map((member) => wrapped(printType(member, depth))).join(' & ');
  if (Array.isArray(schema.type)) {
    return union(schema.type.map((type) => printType({ ...schema, type }, depth)));
  }
  switch (schema.type) {
    case 'string':
      return 'string';
    case 'number':
    case 'integer':
      return 'number';
    case 'boolean':
      return 'boolean';
    case 'null':
      return 'null';
    case 'array':
      return `Array<${isSchema(schema.items) ? printType(schema.items, depth) : 'unknown'}>`;
    case 'object':
      return printObject(schema, depth);
    default:
      return 'unknown';
  }
}

function printObject(schema: JsonSchema, depth: number): string {
  const properties = isSchema(schema.properties) ? Object.entries(schema.properties) : [];
  const extra = schema.additionalProperties;
  const extraType = isSchema(extra)
    ? printType(extra, depth)
    : extra === true
      ? 'unknown'
      : undefined;
  if (properties.length === 0) return `Record<string, ${extraType ?? 'unknown'}>`;
  return `{\n${printMembers(schema, depth + 1)}${extraType !== undefined ? `${pad(depth + 1)}[key: string]: ${extraType};\n` : ''}${pad(depth)}}`;
}

function printMembers(schema: JsonSchema, depth: number): string {
  const required = new Set(Array.isArray(schema.required) ? schema.required : []);
  const properties = isSchema(schema.properties) ? Object.entries(schema.properties) : [];
  return properties
    .map(([key, value]) => {
      const property = isSchema(value) ? value : {};
      const optional = required.has(key) ? '' : '?';
      return `${jsDoc(property.description, depth)}${pad(depth)}${propertyKey(key)}${optional}: ${printType(property, depth)};\n`;
    })
    .join('');
}

/** A named type of the bundle as a declaration: an interface for an object, else a type */
function printDeclaration(name: string, schema: JsonSchema): string {
  const doc = jsDoc(schema.description, 0);
  const properties = isSchema(schema.properties) ? Object.keys(schema.properties) : [];
  const plainObject =
    schema.type === 'object' &&
    properties.length > 0 &&
    schema.additionalProperties === undefined &&
    schema.anyOf === undefined &&
    schema.oneOf === undefined;
  if (plainObject) return `${doc}export interface ${name} {\n${printMembers(schema, 1)}}\n`;
  return `${doc}export type ${name} = ${printType(schema, 0)};\n`;
}

function hasRequired(bundle: AppServerSchemaBundle, ref: string): boolean {
  const schema = bundle.$defs[refName(ref)];
  return Array.isArray(schema?.required) && schema.required.length > 0;
}

function printMethodMap(name: string, doc: string, methods: Record<string, BundledMethod>): string {
  const entries = Object.entries(methods)
    .map(
      ([method, entry]) =>
        `${jsDoc(entry.description, 1)}  ${literal(method)}: { params: ${refName(entry.params.$ref)}; result: ${refName(entry.result.$ref)} };\n`
    )
    .join('');
  return `${jsDoc(doc, 0)}export interface ${name} {\n${entries}}\n`;
}

function printClientMethods(bundle: AppServerSchemaBundle): string {
  return Object.entries(bundle['x-methods'])
    .map(([method, entry]) => {
      const params = refName(entry.params.$ref);
      const result = refName(entry.result.$ref);
      const argument = hasRequired(bundle, entry.params.$ref)
        ? `params: ${params}`
        : `params: ${params} = {}`;
      return `${jsDoc(`${entry.description} (\`${method}\`)`, 1)}  ${entry.clientName}(${argument}): Promise<${result}> {\n    return this.request(${literal(method)}, params);\n  }\n`;
    })
    .join('\n');
}

/**
 * The source of the typed client: a type for every params, result and notification of the
 * protocol, the maps of methods, notifications and server requests, the error codes, and the
 * `AppServerClient` class with a method per request. It needs nothing but a transport that
 * moves lines, such as the stdio of `cogitator app-server`.
 */
export function generateTypeScriptClient(
  bundle: AppServerSchemaBundle = generateJsonSchema()
): string {
  const declarations = Object.entries(bundle.$defs)
    .map(([name, schema]) => printDeclaration(name, schema))
    .join('\n');
  const notifications = Object.entries(bundle['x-notifications'])
    .map(([method, ref]) => `  ${literal(method)}: ${refName(ref.$ref)};\n`)
    .join('');
  const codes = Object.entries(APP_SERVER_ERROR_CODES)
    .map(([name, code]) => `  ${name}: ${code},\n`)
    .join('');
  return [
    '/**',
    ' * The typed client of the Cogitator app-server protocol, generated from its Zod schemas by',
    ' * `pnpm --filter @cogitator-ai/app-server generate` (or `cogitator app-server generate-ts`).',
    ' * Do not edit it by hand: change the schemas and generate it again.',
    ' */',
    '',
    `export const APP_SERVER_PROTOCOL_VERSION = ${bundle['x-protocolVersion']};`,
    '',
    '/** The error codes the app-server answers with */',
    `export const APP_SERVER_ERROR_CODES = {\n${codes}} as const;`,
    '',
    declarations,
    printMethodMap(
      'AppServerMethods',
      'The requests a client sends, by method',
      bundle['x-methods']
    ),
    `/** The notifications the server sends, by method */\nexport interface AppServerNotifications {\n${notifications}}\n`,
    printMethodMap(
      'AppServerServerRequests',
      'The requests the server sends to the client, by method',
      bundle['x-serverRequests']
    ),
    CLIENT_RUNTIME.replace('  /* methods */\n', printClientMethods(bundle)),
  ].join('\n');
}
