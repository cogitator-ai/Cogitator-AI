import { z } from 'zod';
import type { LLMResponseFormat, ResponseFormat } from '@cogitator-ai/types';

const SCHEMA_NAME = 'response';

/**
 * Translates an agent's `responseFormat` into the format LLM backends take.
 *
 * Zod schemas become JSON Schema. Strict mode is requested only when the
 * schema allows it (every property required, no additional properties),
 * since providers refuse strict schemas with optional fields.
 */
export function toLLMResponseFormat(
  format: ResponseFormat | undefined
): LLMResponseFormat | undefined {
  if (!format) return undefined;
  switch (format.type) {
    case 'text':
      return undefined;
    case 'json':
      return { type: 'json_object' };
    case 'json_schema': {
      const schema = z.toJSONSchema(format.schema, { unrepresentable: 'any' }) as Record<
        string,
        unknown
      >;
      delete schema.$schema;
      const description = typeof schema.description === 'string' ? schema.description : undefined;
      return {
        type: 'json_schema',
        jsonSchema: {
          name: SCHEMA_NAME,
          ...(description && { description }),
          schema,
          strict: isStrictCompatible(schema),
        },
      };
    }
  }
}

function isStrictCompatible(schema: unknown): boolean {
  if (typeof schema !== 'object' || schema === null) return true;
  if (Array.isArray(schema)) return schema.every(isStrictCompatible);
  const node = schema as Record<string, unknown>;

  if (node.type === 'object' || node.properties !== undefined) {
    const properties = (node.properties ?? {}) as Record<string, unknown>;
    const required = new Set(Array.isArray(node.required) ? (node.required as string[]) : []);
    if (Object.keys(properties).some((key) => !required.has(key))) return false;
    if (node.additionalProperties !== false) return false;
  }

  return Object.entries(node).every(
    ([key, value]) => key === 'required' || key === 'enum' || isStrictCompatible(value)
  );
}

/**
 * Reads the structured result of a run from its final text.
 *
 * Returns `undefined` when the agent asked for plain text, when the text is not
 * JSON, or when it does not match the agent's schema.
 */
export function parseStructuredOutput(format: ResponseFormat | undefined, output: string): unknown {
  if (!format || format.type === 'text') return undefined;

  const parsed = parseJson(output);
  if (parsed === undefined) return undefined;
  if (format.type === 'json') return parsed;

  const result = format.schema.safeParse(parsed);
  return result.success ? result.data : undefined;
}

function parseJson(text: string): unknown {
  const trimmed = text.trim();
  const fenced = /^```(?:json)?\s*\n?([\s\S]*?)\n?```$/i.exec(trimmed);
  const candidate = fenced ? fenced[1] : trimmed;
  try {
    return JSON.parse(candidate) as unknown;
  } catch {
    return undefined;
  }
}
