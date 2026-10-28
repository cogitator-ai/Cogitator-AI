import { z } from 'zod';
import {
  APP_SERVER_METHODS,
  APP_SERVER_NOTIFICATIONS,
  APP_SERVER_SCHEMAS,
  APP_SERVER_SERVER_REQUESTS,
} from '../protocol/methods.js';
import { APP_SERVER_PROTOCOL_VERSION } from '../protocol/common.js';

/** A JSON Schema as plain JSON */
export type JsonSchema = Record<string, unknown>;

/** A request of the protocol in the bundle: references to its params and its result */
export interface BundledMethod {
  params: { $ref: string };
  result: { $ref: string };
  clientName: string;
  description: string;
}

/** The whole protocol as one JSON Schema document, see {@link generateJsonSchema} */
export interface AppServerSchemaBundle {
  $schema: string;
  title: string;
  description: string;
  'x-protocolVersion': number;
  'x-methods': Record<string, BundledMethod>;
  'x-notifications': Record<string, { $ref: string }>;
  'x-serverRequests': Record<string, BundledMethod>;
  $defs: Record<string, JsonSchema>;
}

const DEFS = '#/$defs/';

/** The file `generate-json-schema` writes */
export const JSON_SCHEMA_FILE_NAME = 'cogitator-app-server.schema.json';

/**
 * The protocol as one JSON Schema (draft 2020-12) document: every named type under `$defs`,
 * and the methods, notifications and server requests as references to their types under
 * `x-methods`, `x-notifications` and `x-serverRequests`. Objects allow keys they do not name,
 * so a newer side's fields do not fail an older one.
 */
export function generateJsonSchema(): AppServerSchemaBundle {
  const registry = z.registry<{ id: string }>();
  const names = new Map<z.ZodType, string>();
  for (const [name, schema] of APP_SERVER_SCHEMAS) {
    registry.add(schema, { id: name });
    names.set(schema, name);
  }
  const { schemas } = z.toJSONSchema(registry, {
    io: 'input',
    unrepresentable: 'any',
    uri: (id) => `${DEFS}${id}`,
  });
  const defs: Record<string, JsonSchema> = {};
  for (const [name] of APP_SERVER_SCHEMAS) {
    const { $schema: _schema, $id: _id, ...definition } = schemas[name] as JsonSchema;
    defs[name] = definition;
  }
  const ref = (schema: z.ZodType, where: string) => {
    const name = names.get(schema);
    if (name === undefined)
      throw new Error(`The schema of ${where} has no name in APP_SERVER_SCHEMAS`);
    return { $ref: `${DEFS}${name}` };
  };
  const bundle = (methods: typeof APP_SERVER_METHODS | typeof APP_SERVER_SERVER_REQUESTS) =>
    Object.fromEntries(
      Object.entries(methods).map(([method, entry]) => [
        method,
        {
          params: ref(entry.params, `${method} params`),
          result: ref(entry.result, `${method} result`),
          clientName: entry.clientName,
          description: entry.description,
        },
      ])
    );
  return {
    $schema: 'https://json-schema.org/draft/2020-12/schema',
    title: 'Cogitator app-server protocol',
    description:
      'JSON-RPC 2.0 over NDJSON: the params and results of the methods, the notifications and the requests the server sends',
    'x-protocolVersion': APP_SERVER_PROTOCOL_VERSION,
    'x-methods': bundle(APP_SERVER_METHODS),
    'x-notifications': Object.fromEntries(
      Object.entries(APP_SERVER_NOTIFICATIONS).map(([method, schema]) => [
        method,
        ref(schema, method),
      ])
    ),
    'x-serverRequests': bundle(APP_SERVER_SERVER_REQUESTS),
    $defs: defs,
  };
}

/** The name a `$ref` of the bundle points to */
export function refName(ref: string): string {
  if (!ref.startsWith(DEFS)) throw new Error(`Unexpected $ref ${ref}`);
  return ref.slice(DEFS.length);
}
