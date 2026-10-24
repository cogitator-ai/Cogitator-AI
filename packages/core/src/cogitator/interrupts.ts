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
import { getLogger } from '../logger';

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
  const completed = new Set(checkpoint.turn.completed ?? []);
  return checkpoint.turn.toolCalls
    .filter((call) => !completed.has(call.id) && !Object.hasOwn(checkpoint.turn.decisions, call.id))
    .map((call) =>
      approvalInterrupt({
        toolCallId: call.id,
        toolName: call.name,
        arguments: call.arguments,
        description: '',
      })
    );
}

/** Whether `entry` lapsed by `now`: its `expiresAt` came */
export function isExpired(entry: RunInterrupt, now: number): boolean {
  return entry.expiresAt !== undefined && Date.parse(entry.expiresAt) <= now;
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
 * answer `interrupts` keep for the `n`-th question of the call, parsed by a Zod `responseSchema`,
 * and without one throws a {@link ToolInterruptSignal}, which pauses the run. A question asked
 * before keeps its record (its `expiresAt` among it), and an answer the Zod schema refuses (a
 * refinement JSON Schema cannot express) asks again. `onZodSchema` hears of each Zod schema, so
 * a resume in this process checks answers with it
 */
export function toolInterrupter(
  toolCall: ToolCall,
  interrupts: readonly RunInterrupt[],
  onZodSchema?: (id: string, schema: ZodType) => void
): <T = unknown>(request: InterruptRequest<T>) => Promise<T> {
  let asked = 0;
  return async <T>(request: InterruptRequest<T>): Promise<T> => {
    const id = toolInterruptId(toolCall.id, asked++);
    const kept = interrupts.find((entry) => entry.id === id);
    const schema = request.responseSchema;
    const zod = schema !== undefined && isZodSchema(schema) ? schema : undefined;
    if (kept && isAnswered(kept)) {
      if (!zod) return kept.response as T;
      const parsed = zod.safeParse(kept.response);
      if (parsed.success) return parsed.data;
      getLogger().warn('The answer to an interrupt does not match its schema, asking again', {
        interruptId: id,
        problem: z.prettifyError(parsed.error),
      });
      onZodSchema?.(id, zod);
      throw new ToolInterruptSignal(withoutAnswer(kept));
    }
    if (zod) onZodSchema?.(id, zod);
    if (kept) throw new ToolInterruptSignal(kept);
    throw new ToolInterruptSignal({
      id,
      kind: 'input',
      reason: nonBlank(request.reason, 'reason'),
      message: nonBlank(request.message, 'message'),
      ...(schema !== undefined && { responseSchema: jsonSchemaOf(schema) }),
      ...(request.expiresAt !== undefined && { expiresAt: isoTime(request.expiresAt) }),
      toolCallId: toolCall.id,
      toolName: toolCall.name,
    });
  };
}

function withoutAnswer(entry: RunInterrupt): RunInterrupt {
  const copy = { ...entry };
  delete copy.response;
  return copy;
}

/** How many Zod schemas of questions {@link InterruptSchemas} keeps at most */
const MAX_KEPT_SCHEMAS = 1000;

/**
 * The Zod schemas tools asked their questions with in this process, by run and interrupt id,
 * so a resume here checks answers with refinements JSON Schema loses. It keeps the questions
 * still waiting for an answer, forgets a run's once it ends, and at most
 * {@link MAX_KEPT_SCHEMAS}, the oldest dropped first: a resume without the schema checks the
 * stored JSON Schema instead
 */
export class InterruptSchemas {
  private readonly schemas = new Map<string, ZodType>();

  get size(): number {
    return this.schemas.size;
  }

  remember(runId: string, interruptId: string, schema: ZodType): void {
    const key = schemaKey(runId, interruptId);
    this.schemas.delete(key);
    this.schemas.set(key, schema);
    while (this.schemas.size > MAX_KEPT_SCHEMAS) {
      const oldest = this.schemas.keys().next();
      if (oldest.done) break;
      this.schemas.delete(oldest.value);
    }
  }

  get(runId: string, interruptId: string): ZodType | undefined {
    return this.schemas.get(schemaKey(runId, interruptId));
  }

  forget(runId: string, interruptId: string): void {
    this.schemas.delete(schemaKey(runId, interruptId));
  }

  forgetRun(runId: string): void {
    const prefix = schemaKey(runId, '');
    for (const key of [...this.schemas.keys()]) {
      if (key.startsWith(prefix)) this.schemas.delete(key);
    }
  }

  clear(): void {
    this.schemas.clear();
  }
}

function schemaKey(runId: string, interruptId: string): string {
  return `${runId}\n${interruptId}`;
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
 * run waits on, come before its `expiresAt` and match its schema: the Zod schema the tool asked
 * with when this process still has it (`zodSchemaOf`), else its JSON `responseSchema`
 *
 * @throws CogitatorError `VALIDATION_ERROR` for an unknown, already answered or malformed answer,
 * `INTERRUPT_EXPIRED` for an answer that came too late
 */
export function answerInterrupts(
  interrupts: readonly RunInterrupt[],
  responses: Record<string, unknown>,
  now: number,
  zodSchemaOf?: (id: string) => ZodType | undefined
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
    if (isExpired(entry, now)) {
      throw new CogitatorError({
        message: `Interrupt "${id}" expired at ${entry.expiresAt}, its answer is refused`,
        code: ErrorCode.INTERRUPT_EXPIRED,
        details: { interruptId: id, expiresAt: entry.expiresAt },
      });
    }
    const zod = zodSchemaOf?.(id);
    const parsed = zod?.safeParse(response);
    const problem = parsed
      ? parsed.success
        ? undefined
        : z.prettifyError(parsed.error)
      : entry.responseSchema
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
  const json: Record<string, unknown> = {
    ...z.toJSONSchema(schema, { io: 'input', unrepresentable: 'any' }),
  };
  delete json.$schema;
  return json;
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
