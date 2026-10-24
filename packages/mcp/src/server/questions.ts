import { CogitatorError, ErrorCode, type RunInterrupt } from '@cogitator-ai/types';
import type { MCPElicitField, MCPElicitRequest, MCPToolContext } from '../types';

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
 *
 * @throws CogitatorError `RUN_PAUSED` naming the question when nobody can answer it: the client
 * has no elicitation, the person declined, or its schema is no flat form
 */
export async function elicitAnswers(
  elicit: MCPToolContext['elicit'],
  questions: readonly RunInterrupt[],
  agentName: string
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
    const reply = elicit
      ? await elicit({ message: question.message, schema: form.schema })
      : undefined;
    if (!reply) {
      throw unanswered(question, agentName, 'this MCP client cannot answer elicitation requests');
    }
    if (reply.action !== 'accept') {
      throw unanswered(question, agentName, 'the user declined to answer');
    }
    responses[question.id] = form.answerOf(reply.content);
  }
  return responses;
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

function elicitField(schema: Record<string, unknown>): MCPElicitField | undefined {
  const text = (key: string) => (typeof schema[key] === 'string' ? schema[key] : undefined);
  const labels = {
    ...(text('title') !== undefined && { title: text('title') }),
    ...(text('description') !== undefined && { description: text('description') }),
  };
  switch (schema.type) {
    case 'string': {
      const options = Array.isArray(schema.enum)
        ? schema.enum.filter((value): value is string => typeof value === 'string')
        : undefined;
      return { type: 'string', ...labels, ...(options && { enum: options }) };
    }
    case 'number':
    case 'integer':
      return { type: schema.type, ...labels };
    case 'boolean':
      return {
        type: 'boolean',
        ...labels,
        ...(typeof schema.default === 'boolean' && { default: schema.default }),
      };
    default:
      return undefined;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
