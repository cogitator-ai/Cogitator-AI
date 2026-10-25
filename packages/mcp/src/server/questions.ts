import { CogitatorError, ErrorCode, type RunInterrupt } from '@cogitator-ai/types';
import type { MCPElicitField, MCPElicitOption, MCPElicitRequest, MCPToolContext } from '../types';

/** The field an answer that is not an object takes in the elicitation form. */
const ANSWER_FIELD = 'answer';

/** How a question becomes an elicitation form, and the form's content its answer. */
interface QuestionForm {
  schema: MCPElicitRequest['schema'];
  answerOf: (content: Record<string, unknown>) => unknown;
}

/**
 * Ask the person at the MCP client the questions a paused run's tools asked
 * (`context.interrupt()`), one elicitation form each, and return the answers by interrupt id for
 * `cogitator.resume()`. A question whose answer is a primitive (or has no schema) becomes a form
 * with one `answer` field, one whose answer is an object of primitives becomes that form.
 * `problems` holds, by interrupt id, why an earlier answer was refused, said before the question.
 *
 * @throws CogitatorError `RUN_PAUSED` naming the question when nobody can answer it: the client
 * has no elicitation, the person declined, or its schema is no flat form
 */
export async function elicitAnswers(
  elicit: MCPToolContext['elicit'],
  questions: readonly RunInterrupt[],
  agentName: string,
  problems: ReadonlyMap<string, string> = new Map()
): Promise<Record<string, unknown>> {
  const responses: Record<string, unknown> = {};
  for (const question of questions) {
    const form = questionForm(question.responseSchema);
    if (!form) {
      throw unanswered(
        question,
        agentName,
        'its answer schema is not a flat form MCP elicitation can ask'
      );
    }
    const problem = problems.get(question.id);
    const plan = question.kind === 'plan' ? question.details?.plan : undefined;
    const asked =
      typeof plan === 'string' && plan.trim() !== ''
        ? `${plan.trim()}\n\n${question.message}`
        : question.message;
    const message = problem ? `${problem}\n\n${asked}` : asked;
    const reply = elicit ? await elicit({ message, schema: form.schema }) : undefined;
    if (!reply) {
      throw unanswered(question, agentName, 'this MCP client cannot answer elicitation requests');
    }
    if (reply.action !== 'accept') {
      const why =
        reply.action === 'decline'
          ? 'the user declined to answer'
          : 'the user dismissed the question without answering';
      throw unanswered(question, agentName, why);
    }
    responses[question.id] = form.answerOf(reply.content);
  }
  return responses;
}

/**
 * The question an `INTERRUPT_ANSWER_INVALID` error of a resume refused the answer to, among
 * `questions`, and why, undefined for any other error
 */
export function refusedQuestion(
  error: unknown,
  questions: readonly RunInterrupt[]
): { question: RunInterrupt; problem: string } | undefined {
  if (!CogitatorError.isCogitatorError(error)) return undefined;
  if (error.code !== ErrorCode.INTERRUPT_ANSWER_INVALID) return undefined;
  const id = error.details?.interruptId;
  const question = questions.find((entry) => entry.id === id);
  return question && { question, problem: error.message };
}

function unanswered(question: RunInterrupt, agentName: string, why: string): CogitatorError {
  return new CogitatorError({
    message:
      `Agent "${agentName}" paused to ask ${question.reason} ("${question.message}"), ` +
      `but ${why}. The run stays paused: answer it with cogitator.resume() and responses.`,
    code: ErrorCode.RUN_PAUSED,
    details: { interrupt: { ...question } },
  });
}

function questionForm(schema: Record<string, unknown> | undefined): QuestionForm | undefined {
  if (!schema) {
    return single({ type: 'string', title: 'Answer' });
  }
  if (schema.type !== 'object') {
    const field = elicitField(schema);
    return field && single(field);
  }
  const properties = isRecord(schema.properties) ? schema.properties : {};
  const fields: Record<string, MCPElicitField> = {};
  for (const [key, property] of Object.entries(properties)) {
    const field = isRecord(property) ? elicitField(property) : undefined;
    if (!field) return undefined;
    fields[key] = field;
  }
  const required = Array.isArray(schema.required)
    ? schema.required.filter((key): key is string => typeof key === 'string')
    : undefined;
  return {
    schema: { type: 'object', properties: fields, ...(required && { required }) },
    answerOf: (content) => content,
  };
}

function single(field: MCPElicitField): QuestionForm {
  return {
    schema: { type: 'object', properties: { [ANSWER_FIELD]: field }, required: [ANSWER_FIELD] },
    answerOf: (content) => content[ANSWER_FIELD],
  };
}

/**
 * The elicitation field for a question's JSON Schema, with the constraints MCP `requestedSchema`
 * can carry (protocol 2025-11-25): title, description and default, a string's length, format and
 * choices, a number's range, a multiple choice's options and size. Keywords it cannot carry (a
 * pattern, an exclusive bound) stay with the run, which checks the answer against the full
 * schema. Undefined for a schema no form field asks.
 */
function elicitField(schema: Record<string, unknown>): MCPElicitField | undefined {
  const labels = {
    ...textEntry(schema, 'title'),
    ...textEntry(schema, 'description'),
  };
  const choices = optionsOf(schema);
  if (choices) {
    if (schema.type !== undefined && schema.type !== 'string') return undefined;
    return {
      type: 'string',
      ...labels,
      ...choices,
      ...(typeof schema.default === 'string' && { default: schema.default }),
    };
  }
  switch (schema.type) {
    case 'string':
      return {
        type: 'string',
        ...labels,
        ...numberEntry(schema, 'minLength'),
        ...numberEntry(schema, 'maxLength'),
        ...(isElicitFormat(schema.format) && { format: schema.format }),
        ...(typeof schema.default === 'string' && { default: schema.default }),
      };
    case 'number':
    case 'integer':
      return {
        type: schema.type,
        ...labels,
        ...numberEntry(schema, 'minimum'),
        ...numberEntry(schema, 'maximum'),
        ...numberEntry(schema, 'default'),
      };
    case 'boolean':
      return {
        type: 'boolean',
        ...labels,
        ...(typeof schema.default === 'boolean' && { default: schema.default }),
      };
    case 'array':
      return multiSelect(schema, labels);
    default:
      return undefined;
  }
}

/** A multiple choice field for an array of string choices, undefined for any other array. */
function multiSelect(
  schema: Record<string, unknown>,
  labels: { title?: string; description?: string }
): MCPElicitField | undefined {
  const items = isRecord(schema.items) ? optionsOf(schema.items) : undefined;
  if (!items) return undefined;
  const base = {
    type: 'array' as const,
    ...labels,
    ...numberEntry(schema, 'minItems'),
    ...numberEntry(schema, 'maxItems'),
    ...(isStringArray(schema.default) && { default: schema.default }),
  };
  return 'oneOf' in items
    ? { ...base, items: { anyOf: items.oneOf } }
    : { ...base, items: { type: 'string', enum: items.enum } };
}

/**
 * The string choices a schema offers: its `enum`, or the `const` members of its `oneOf` or
 * `anyOf`, with their labels when every member has a title. Undefined when it offers none, or a
 * choice that is not a string.
 */
function optionsOf(
  schema: Record<string, unknown>
): { enum: string[] } | { oneOf: MCPElicitOption[] } | undefined {
  if (schema.enum !== undefined) {
    return isStringArray(schema.enum) && schema.enum.length > 0 ? { enum: schema.enum } : undefined;
  }
  const members: unknown[] | undefined = Array.isArray(schema.oneOf)
    ? schema.oneOf
    : Array.isArray(schema.anyOf)
      ? schema.anyOf
      : undefined;
  if (!members || members.length === 0) return undefined;
  const options: Array<{ const: string; title?: string }> = [];
  for (const member of members) {
    if (!isRecord(member) || typeof member.const !== 'string') return undefined;
    options.push({ const: member.const, ...textEntry(member, 'title') });
  }
  const titled = options.filter((option): option is MCPElicitOption => option.title !== undefined);
  return titled.length === options.length
    ? { oneOf: titled }
    : { enum: options.map((option) => option.const) };
}

const ELICIT_FORMATS = ['email', 'uri', 'date', 'date-time'] as const;

function isElicitFormat(value: unknown): value is (typeof ELICIT_FORMATS)[number] {
  return ELICIT_FORMATS.some((format) => format === value);
}

function textEntry<K extends string>(
  schema: Record<string, unknown>,
  key: K
): Partial<Record<K, string>> {
  const value = schema[key];
  return typeof value === 'string' ? ({ [key]: value } as Record<K, string>) : {};
}

function numberEntry<K extends string>(
  schema: Record<string, unknown>,
  key: K
): Partial<Record<K, number>> {
  const value = schema[key];
  return typeof value === 'number' && Number.isFinite(value)
    ? ({ [key]: value } as Record<K, number>)
    : {};
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((entry) => typeof entry === 'string');
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
