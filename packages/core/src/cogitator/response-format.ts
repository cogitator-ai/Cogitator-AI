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
 * Returns `undefined` when the agent asked for plain text, when the text holds
 * no JSON, or when it does not match the agent's schema.
 */
export function parseStructuredOutput(format: ResponseFormat | undefined, output: string): unknown {
  const check = checkStructuredOutput(format, output);
  return check.ok ? check.value : undefined;
}

/**
 * Why `output` does not satisfy `format`, in words a model can act on, or
 * `undefined` when it does (or the agent asked for plain text).
 */
export function structuredOutputProblem(
  format: ResponseFormat | undefined,
  output: string
): string | undefined {
  const check = checkStructuredOutput(format, output);
  return check.ok ? undefined : check.problem;
}

type StructuredCheck = { ok: true; value: unknown } | { ok: false; problem: string };

function checkStructuredOutput(
  format: ResponseFormat | undefined,
  output: string
): StructuredCheck {
  if (!format || format.type === 'text') return { ok: true, value: undefined };

  const parsed = parseJson(output);
  if (parsed === undefined) return { ok: false, problem: 'the answer is not valid JSON' };
  if (format.type === 'json') return { ok: true, value: parsed };

  const result = format.schema.safeParse(parsed);
  if (result.success) return { ok: true, value: result.data };
  return {
    ok: false,
    problem: result.error.issues
      .map((issue) => `${issue.path.join('.') || 'the answer'}: ${issue.message}`)
      .join('; '),
  };
}

/** JSON in `text`: the whole text, a fenced block, or the outermost object or array within prose. */
function parseJson(text: string): unknown {
  const trimmed = text.trim();
  const fenced = /^```(?:json)?\s*\n?([\s\S]*?)\n?```$/i.exec(trimmed);
  const candidate = fenced ? fenced[1] : trimmed;
  const whole = tryParse(candidate);
  if (whole !== undefined) return whole;

  for (const [open, close] of [
    ['{', '}'],
    ['[', ']'],
  ] as const) {
    const start = candidate.indexOf(open);
    const end = candidate.lastIndexOf(close);
    if (start !== -1 && end > start) {
      const embedded = tryParse(candidate.slice(start, end + 1));
      if (embedded !== undefined) return embedded;
    }
  }
  return undefined;
}

function tryParse(text: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return undefined;
  }
}
