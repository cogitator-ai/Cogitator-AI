import { z, type ZodType } from 'zod';
import {
  CogitatorError,
  ErrorCode,
  type InterruptRequest,
  type RunCheckpoint,
  type RunInterrupt,
  type ToolApprovalDecision,
  type ToolApprovalRequest,
  type ToolCall,
} from '@cogitator-ai/types';

/** JSON Schema of an approval's answer, a `ToolApprovalDecision` */
export const APPROVAL_RESPONSE_SCHEMA: Record<string, unknown> = {
  type: 'object',
  properties: { approved: { type: 'boolean' }, reason: { type: 'string' } },
  required: ['approved'],
  additionalProperties: false,
};

/** An approval a run waits for, as an interrupt: its id is the tool call's */
export function approvalInterrupt(request: ToolApprovalRequest): RunInterrupt {
  return {
    id: request.toolCallId,
    kind: 'approval',
    reason: 'tool_approval',
    message: `Approve the call of ${request.toolName}${request.description ? `: ${request.description}` : ''}`,
    responseSchema: APPROVAL_RESPONSE_SCHEMA,
    toolCallId: request.toolCallId,
    toolName: request.toolName,
  };
}

/**
 * The interrupts of a checkpoint: its own, or for one saved before they existed, the approvals
 * its paused calls wait for
 */
export function checkpointInterrupts(checkpoint: RunCheckpoint): RunInterrupt[] {
  if (checkpoint.interrupts) return checkpoint.interrupts.map((entry) => ({ ...entry }));
  return checkpoint.turn.toolCalls
    .filter((call) => !Object.hasOwn(checkpoint.turn.decisions, call.id))
    .map((call) =>
      approvalInterrupt({
        toolCallId: call.id,
        toolName: call.name,
        arguments: call.arguments,
        description: '',
      })
    );
}

/** Whether `entry` has its answer */
export function isAnswered(entry: RunInterrupt): boolean {
  return Object.hasOwn(entry, 'response') && entry.response !== undefined;
}

/** The id of the `index`-th question tool call `toolCallId` asks */
export function toolInterruptId(toolCallId: string, index: number): string {
  return `${toolCallId}#${index}`;
}

/** What `context.interrupt()` throws to pause the run at a question nobody answered yet */
export class ToolInterruptSignal extends Error {
  constructor(readonly interrupt: RunInterrupt) {
    super(`Tool "${interrupt.toolName ?? 'unknown'}" waits for an answer: ${interrupt.message}`);
    this.name = 'ToolInterruptSignal';
  }
}

/** Whether `error` is a tool's question pausing the run */
export function isToolInterrupt(error: unknown): error is ToolInterruptSignal {
  return error instanceof ToolInterruptSignal;
}

/**
 * The `context.interrupt()` of one execution of `toolCall`: its `n`-th call answers with the
 * answer `interrupts` keep for the `n`-th question of the call, and without one throws a
 * {@link ToolInterruptSignal}, which pauses the run
 */
export function toolInterrupter(
  toolCall: ToolCall,
  interrupts: readonly RunInterrupt[]
): <T = unknown>(request: InterruptRequest<T>) => Promise<T> {
  let asked = 0;
  return async <T>(request: InterruptRequest<T>): Promise<T> => {
    const id = toolInterruptId(toolCall.id, asked++);
    const kept = interrupts.find((entry) => entry.id === id);
    if (kept && isAnswered(kept)) return answerAs(request.responseSchema, kept.response, id);
    throw new ToolInterruptSignal({
      id,
      kind: 'input',
      reason: nonBlank(request.reason, 'reason'),
      message: nonBlank(request.message, 'message'),
      ...(request.responseSchema !== undefined && {
        responseSchema: jsonSchemaOf(request.responseSchema),
      }),
      ...(request.expiresAt !== undefined && { expiresAt: isoTime(request.expiresAt) }),
      toolCallId: toolCall.id,
      toolName: toolCall.name,
    });
  };
}

/** The decisions and the interrupts after a resume answered some, see {@link answerInterrupts} */
export interface AnsweredInterrupts {
  /** Every interrupt of the run, answers filled in */
  interrupts: RunInterrupt[];
  /** The approvals among the answers, as decisions by tool call id */
  decisions: Record<string, ToolApprovalDecision>;
  /** The questions of tools answered now */
  answered: RunInterrupt[];
}

/**
 * Fills `responses` into the interrupts of a paused run. Each answer must name an interrupt the
 * run waits on, come before its `expiresAt` and match its `responseSchema`
 *
 * @throws CogitatorError `VALIDATION_ERROR` for an unknown, already answered or malformed answer,
 * `INTERRUPT_EXPIRED` for an answer that came too late
 */
export function answerInterrupts(
  interrupts: readonly RunInterrupt[],
  responses: Record<string, unknown>,
  now: number
): AnsweredInterrupts {
  const result: AnsweredInterrupts = {
    interrupts: interrupts.map((entry) => ({ ...entry })),
    decisions: {},
    answered: [],
  };
  for (const [id, response] of Object.entries(responses)) {
    if (response === undefined) continue;
    const entry = result.interrupts.find((candidate) => candidate.id === id);
    if (!entry) {
      throw new CogitatorError({
        message: `The paused run waits on no interrupt "${id}"`,
        code: ErrorCode.VALIDATION_ERROR,
        details: { interruptId: id },
      });
    }
    if (isAnswered(entry)) {
      throw new CogitatorError({
        message: `Interrupt "${id}" was answered already`,
        code: ErrorCode.VALIDATION_ERROR,
        details: { interruptId: id },
      });
    }
    if (entry.expiresAt !== undefined && Date.parse(entry.expiresAt) <= now) {
      throw new CogitatorError({
        message: `Interrupt "${id}" expired at ${entry.expiresAt}, its answer is refused`,
        code: ErrorCode.INTERRUPT_EXPIRED,
        details: { interruptId: id, expiresAt: entry.expiresAt },
      });
    }
    const problem = entry.responseSchema
      ? schemaProblem(entry.responseSchema, response)
      : undefined;
    if (problem !== undefined) {
      throw new CogitatorError({
        message: `The answer to interrupt "${id}" does not match its schema: ${problem}`,
        code: ErrorCode.VALIDATION_ERROR,
        details: { interruptId: id },
      });
    }
    if (entry.kind === 'approval') {
      result.decisions[entry.toolCallId ?? entry.id] = toDecision(response);
      continue;
    }
    entry.response = response;
    result.answered.push(entry);
  }
  return result;
}

function toDecision(response: unknown): ToolApprovalDecision {
  const { approved, reason } = z
    .object({ approved: z.boolean(), reason: z.string().optional() })
    .parse(response);
  if (approved) return { approved: true };
  return reason === undefined ? { approved: false } : { approved: false, reason };
}

function schemaProblem(schema: Record<string, unknown>, value: unknown): string | undefined {
  let validator: ZodType;
  try {
    validator = z.fromJSONSchema(schema);
  } catch (error) {
    return `its schema cannot be read (${error instanceof Error ? error.message : String(error)})`;
  }
  const parsed = validator.safeParse(value);
  return parsed.success ? undefined : z.prettifyError(parsed.error);
}

function isZodSchema<T>(schema: ZodType<T> | Record<string, unknown>): schema is ZodType<T> {
  return typeof (schema as { safeParse?: unknown }).safeParse === 'function';
}

function jsonSchemaOf<T>(schema: ZodType<T> | Record<string, unknown>): Record<string, unknown> {
  if (!isZodSchema(schema)) return structuredClone(schema);
  const json: Record<string, unknown> = { ...z.toJSONSchema(schema, { unrepresentable: 'any' }) };
  delete json.$schema;
  return json;
}

function answerAs<T>(
  schema: ZodType<T> | Record<string, unknown> | undefined,
  response: unknown,
  id: string
): T {
  if (schema === undefined || !isZodSchema(schema)) return response as T;
  const parsed = schema.safeParse(response);
  if (parsed.success) return parsed.data;
  throw new CogitatorError({
    message: `The answer to interrupt "${id}" does not match its schema: ${z.prettifyError(parsed.error)}`,
    code: ErrorCode.VALIDATION_ERROR,
    details: { interruptId: id },
  });
}

function nonBlank(value: string, field: string): string {
  if (typeof value === 'string' && value.trim() !== '') return value;
  throw new CogitatorError({
    message: `interrupt() needs a non-empty ${field}`,
    code: ErrorCode.VALIDATION_ERROR,
  });
}

function isoTime(value: Date | string | number): string {
  const time = value instanceof Date ? value.getTime() : new Date(value).getTime();
  if (Number.isFinite(time)) return new Date(time).toISOString();
  throw new CogitatorError({
    message: `interrupt() got an expiresAt that is not a time: ${String(value)}`,
    code: ErrorCode.VALIDATION_ERROR,
  });
}
