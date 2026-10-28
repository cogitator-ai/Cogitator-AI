/**
 * The arguments of a tool call as the client sent them and as the tool's schema parsed them. A
 * call keeps the arguments of its first round across rounds: a schema with a generated default
 * (`z.string().default(() => randomUUID())`) parses to new values on every parse, and the round
 * is known by what the client sent
 */

import type { StandardSchemaWithJSON } from '@modelcontextprotocol/server';
import { z } from 'zod';
import { stableJson } from '../digest';

/** A call's arguments: `wire` as the client sent them, `parsed` as the tool's schema made them */
export interface ToolArgs {
  wire: unknown;
  parsed: unknown;
}

/**
 * The schema the MCP SDK registers a tool with: it advertises the tool's own schema unchanged
 * and validates with it, handing the handler both the arguments sent and the parsed ones
 */
export function wireArgsSchema(schema: z.ZodType): StandardSchemaWithJSON<unknown, ToolArgs> {
  const standard = schema['~standard'];
  const jsonSchema = (io: 'input' | 'output', target: string): Record<string, unknown> => {
    const own = standard.jsonSchema;
    if (own) return own[io]({ target });
    return z.toJSONSchema(schema, {
      target: target === 'draft-07' || target === 'openapi-3.0' ? target : 'draft-2020-12',
      io,
    }) as Record<string, unknown>;
  };
  return {
    '~standard': {
      version: 1,
      vendor: 'cogitator',
      validate: async (value) => {
        const result = await standard.validate(value);
        return result.issues
          ? { issues: result.issues }
          : { value: { wire: value, parsed: result.value } };
      },
      jsonSchema: {
        input: (options) => jsonSchema('input', options.target),
        output: (options) => jsonSchema('output', options.target),
      },
    },
  };
}

/**
 * The parsed arguments to keep in the signed state of a round, undefined when they do not
 * survive JSON (a `Date`, a `Map`): such a call parses them anew each round
 */
export function keepableArgs(parsed: unknown): unknown {
  try {
    const json = JSON.stringify(parsed);
    if (json === undefined) return undefined;
    return stableJson(JSON.parse(json)) === stableJson(parsed)
      ? (JSON.parse(json) as unknown)
      : undefined;
  } catch {
    return undefined;
  }
}
