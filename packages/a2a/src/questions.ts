import { z } from 'zod';
import { answerFormat, parseAnswer, type RunInterrupt } from '@cogitator-ai/types';
import type { A2AMessage, A2ATask, DataPart } from './types.js';
import { TOOL_APPROVAL_REQUEST_KIND, TOOL_APPROVAL_RESPONSE_KIND } from './approvals.js';

/** `kind` of the data part an agent sends when its run waits on questions its tools asked. */
export const INTERRUPT_REQUEST_KIND = 'interrupt-request';
/** `kind` of the data part a client sends back with its answers. */
export const INTERRUPT_RESPONSE_KIND = 'interrupt-response';

/** Metadata key holding the questions a task waits on; never sent to clients. */
export const TASK_PENDING_QUESTIONS_KEY = 'cogitator:pendingQuestions';

/** A question a tool of the remote agent asked (`context.interrupt()`), as the task carries it. */
export interface TaskQuestion {
  /** Key of its answer in an interrupt response */
  id: string;
  /**
   * `input` for a question a tool asked, `plan` for a plan to approve before the run leaves plan
   * mode, `budget` for a budget the run reached
   */
  kind?: 'input' | 'plan' | 'budget';
  /** Why the run asks, a short machine-readable reason such as `confirm_plan` */
  reason: string;
  /** What to tell the person who answers */
  message: string;
  /** JSON Schema the answer must match */
  responseSchema?: Record<string, unknown>;
  /** ISO time after which an answer is refused */
  expiresAt?: string;
  /** The tool that asked */
  toolName?: string;
  /** More to show the person who answers: the `plan` of a plan, the usage of a budget */
  details?: Record<string, unknown>;
}

const questionSchema = z.object({
  id: z.string(),
  kind: z.enum(['input', 'plan', 'budget']).optional(),
  reason: z.string(),
  message: z.string(),
  responseSchema: z.record(z.string(), z.unknown()).optional(),
  expiresAt: z.string().optional(),
  toolName: z.string().optional(),
  details: z.record(z.string(), z.unknown()).optional(),
});

const requestSchema = z.object({
  kind: z.literal(INTERRUPT_REQUEST_KIND),
  questions: z.array(questionSchema),
});

const responseSchema = z.object({
  kind: z.literal(INTERRUPT_RESPONSE_KIND),
  responses: z.record(z.string(), z.unknown()),
});

const COGITATOR_PART_KINDS: ReadonlySet<unknown> = new Set([
  TOOL_APPROVAL_REQUEST_KIND,
  TOOL_APPROVAL_RESPONSE_KIND,
  INTERRUPT_REQUEST_KIND,
  INTERRUPT_RESPONSE_KIND,
]);

/** A run's question as a task carries it: what the client needs to answer, nothing internal. */
export function toTaskQuestion(interrupt: RunInterrupt): TaskQuestion {
  return {
    id: interrupt.id,
    ...(interrupt.kind !== 'approval' && { kind: interrupt.kind }),
    reason: interrupt.reason,
    message: interrupt.message,
    ...(interrupt.responseSchema && { responseSchema: interrupt.responseSchema }),
    ...(interrupt.expiresAt && { expiresAt: interrupt.expiresAt }),
    ...(interrupt.toolName && { toolName: interrupt.toolName }),
    ...(interrupt.kind !== 'approval' && interrupt.details && { details: interrupt.details }),
  };
}

/** The data part an agent's message carries when its run waits on questions of its tools. */
export function interruptRequestPart(questions: readonly TaskQuestion[]): DataPart {
  return {
    kind: 'data',
    data: {
      kind: INTERRUPT_REQUEST_KIND,
      questions: questions.map((question) => ({ ...question })),
    },
  };
}

/**
 * The data part that answers the questions an `input-required` task waits on, by question id:
 * send it in the message that continues the task. A task waiting on a single question also takes
 * a plain message as the answer: its data part, else its text.
 *
 * @example
 * ```ts
 * const questions = readInterruptRequest(task);
 * if (questions) {
 *   await client.answerQuestions(task.id, { [questions[0].id]: { ok: true } });
 * }
 * ```
 */
export function interruptResponsePart(responses: Record<string, unknown>): DataPart {
  return { kind: 'data', data: { kind: INTERRUPT_RESPONSE_KIND, responses: { ...responses } } };
}

/**
 * The questions an `input-required` task waits on, read from its status message (or, when a
 * server leaves that out, its last agent message), or undefined when it waits on none.
 */
export function readInterruptRequest(task: A2ATask): TaskQuestion[] | undefined {
  if (task.status.state !== 'input-required') return undefined;
  const last =
    task.status.message ??
    [...(task.history ?? [])].reverse().find((message) => message.role === 'agent');
  for (const part of last?.parts ?? []) {
    if (part.kind !== 'data') continue;
    const parsed = requestSchema.safeParse(part.data);
    if (parsed.success && parsed.data.questions.length > 0) return parsed.data.questions;
  }
  return undefined;
}

/** The answers a message carries in an interrupt response data part, if any. */
export function readInterruptResponse(message: A2AMessage): Record<string, unknown> | undefined {
  for (const part of message.parts) {
    if (part.kind !== 'data') continue;
    const parsed = responseSchema.safeParse(part.data);
    if (parsed.success) return parsed.data.responses;
  }
  return undefined;
}

/** The questions a task's paused run waits on, as the task manager keeps them. */
export function taskPendingQuestions(task: A2ATask): TaskQuestion[] | undefined {
  const parsed = z.array(questionSchema).safeParse(task.metadata?.[TASK_PENDING_QUESTIONS_KEY]);
  return parsed.success && parsed.data.length > 0 ? parsed.data : undefined;
}

/**
 * What a message that continues a task gives the questions it waits on: the answers by question
 * id, or why it answers none, in words for the person who wrote it.
 */
export type MessageAnswers = { responses: Record<string, unknown> } | { problem: string };

/**
 * The answers a message that continues a task gives to the questions it waits on: those of an
 * interrupt response data part, or for a single question, the message itself (its first data
 * part that is not a Cogitator approval or interrupt part, else its text read with
 * `parseAnswer()` by the question's schema). A `problem` when an interrupt response names a
 * question the task does not wait on, or the text does not answer the question. Undefined when
 * the message answers nothing, e.g. plain text while several questions wait.
 */
export function answersFromMessage(
  message: A2AMessage,
  questions: readonly TaskQuestion[]
): MessageAnswers | undefined {
  const explicit = readInterruptResponse(message);
  if (explicit) {
    const unknown = Object.keys(explicit).filter(
      (id) => !questions.some((question) => question.id === id)
    );
    return unknown.length > 0
      ? { problem: `The answers name no question this task waits on: ${unknown.join(', ')}.` }
      : { responses: explicit };
  }
  if (questions.length !== 1) return undefined;
  const [question] = questions;
  const data = message.parts.find(
    (part): part is DataPart => part.kind === 'data' && !COGITATOR_PART_KINDS.has(part.data.kind)
  );
  if (data) return { responses: { [question.id]: data.data } };
  const text = message.parts
    .flatMap((part) => (part.kind === 'text' ? [part.text] : []))
    .join('\n')
    .trim();
  if (!text) return undefined;
  const parsed = parseAnswer(text, question.responseSchema);
  return parsed.ok
    ? { responses: { [question.id]: parsed.value } }
    : { problem: `That does not answer the question: ${parsed.problem}.` };
}

/**
 * A question as a person reads it: its message and, unless it takes free text, the answer form,
 * after the plan of a plan
 */
export function questionPrompt(question: TaskQuestion): string {
  const format = answerFormat(question.responseSchema);
  const asked = format ? `${question.message} (${format})` : question.message;
  const plan = question.kind === 'plan' ? question.details?.plan : undefined;
  return typeof plan === 'string' && plan.trim() !== '' ? `${plan.trim()}\n\n${asked}` : asked;
}
