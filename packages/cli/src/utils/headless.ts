import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { format } from 'node:util';
import { z } from 'zod';
import { fromAgentWireResponseFormat } from '@cogitator-ai/core';
import {
  ApprovalDecisionSchema,
  DeliverySchema,
  OrderedLineWriter,
  UserInputSchema,
  type StdioOutput,
  type TurnInfo,
  type TurnEventNotification,
  type UserInput,
} from '@cogitator-ai/app-server';
import type { CogitatorConfig } from '@cogitator-ai/types';
import { EXIT, UsageError } from './cli.js';

export const OUTPUT_FORMATS = ['text', 'json', 'stream-json'] as const;
export const INPUT_FORMATS = ['text', 'stream-json'] as const;

export type OutputFormat = (typeof OUTPUT_FORMATS)[number];
export type InputFormat = (typeof INPUT_FORMATS)[number];

/** Exit codes of `cogitator run -p`: those of every command, and 3 for a turn left paused */
export const HEADLESS_EXIT = { ...EXIT, paused: 3 } as const;

/** The flags of `cogitator run` that belong to the headless mode */
export interface HeadlessFlags {
  print?: boolean;
  interactive?: boolean;
  outputFormat?: string;
  inputFormat?: string;
  resume?: string;
  fork?: boolean;
  sessionId?: string;
  jsonSchema?: string;
  sessionPersistence?: boolean;
}

/** What the headless mode runs with, its flags checked */
export interface HeadlessPlan {
  outputFormat: OutputFormat;
  inputFormat: InputFormat;
  resume?: string;
  fork: boolean;
  sessionId?: string;
  outputSchema?: Record<string, unknown>;
  persistSessions: boolean;
}

function oneOf<T extends string>(flag: string, value: string, allowed: readonly T[]): T {
  if ((allowed as readonly string[]).includes(value)) return value as T;
  throw new UsageError(`${flag} must be one of ${allowed.join(', ')}, not "${value}"`);
}

/**
 * The headless plan of the flags, undefined without `-p`. Throws a {@link UsageError} for flags
 * that do not go together: headless flags without `-p`, `--fork` without `--resume`, stream-json
 * input without stream-json output, `-p` with `-i`, a schema that cannot be read
 */
export function headlessPlan(flags: HeadlessFlags, cwd = process.cwd()): HeadlessPlan | undefined {
  if (!flags.print) {
    const stray = [
      flags.outputFormat !== undefined && '--output-format',
      flags.inputFormat !== undefined && '--input-format',
      flags.resume !== undefined && '--resume',
      flags.fork && '--fork',
      flags.sessionId !== undefined && '--session-id',
      flags.jsonSchema !== undefined && '--json-schema',
      flags.sessionPersistence === false && '--no-session-persistence',
    ].filter((flag): flag is string => typeof flag === 'string');
    if (stray.length > 0) {
      throw new UsageError(`${stray.join(', ')} only work with -p (--print)`, [
        'cogitator run -p "your prompt" --output-format json',
      ]);
    }
    return undefined;
  }
  if (flags.interactive)
    throw new UsageError('-p (--print) and -i (--interactive) do not go together');
  const outputFormat = oneOf('--output-format', flags.outputFormat ?? 'text', OUTPUT_FORMATS);
  const inputFormat = oneOf('--input-format', flags.inputFormat ?? 'text', INPUT_FORMATS);
  if (inputFormat === 'stream-json' && outputFormat !== 'stream-json') {
    throw new UsageError('--input-format stream-json needs --output-format stream-json');
  }
  if (flags.fork && flags.resume === undefined) {
    throw new UsageError('--fork forks the session --resume names: pass --resume <session-id>');
  }
  if (flags.sessionId !== undefined && flags.resume !== undefined && !flags.fork) {
    throw new UsageError('--session-id names a new session: with --resume it needs --fork');
  }
  if (flags.sessionId?.trim() === '') {
    throw new UsageError('--session-id must not be empty');
  }
  return {
    outputFormat,
    inputFormat,
    ...(flags.resume !== undefined && { resume: flags.resume }),
    fork: flags.fork ?? false,
    ...(flags.sessionId !== undefined && { sessionId: flags.sessionId }),
    ...(flags.jsonSchema !== undefined && { outputSchema: readJsonSchema(flags.jsonSchema, cwd) }),
    persistSessions: flags.sessionPersistence !== false,
  };
}

/**
 * The JSON Schema `--json-schema` names: inline JSON, or the path of a file holding it. It must
 * be an object the runtime reads as a response format
 */
export function readJsonSchema(value: string, cwd = process.cwd()): Record<string, unknown> {
  const trimmed = value.trim();
  let text = trimmed;
  if (!trimmed.startsWith('{')) {
    const path = resolve(cwd, trimmed);
    if (!existsSync(path)) {
      throw new UsageError(`--json-schema is neither inline JSON nor a file: ${trimmed}`);
    }
    text = readFileSync(path, 'utf-8');
  }
  let schema: unknown;
  try {
    schema = JSON.parse(text);
  } catch (error) {
    throw new UsageError(
      `--json-schema is not valid JSON: ${error instanceof Error ? error.message : String(error)}`
    );
  }
  if (typeof schema !== 'object' || schema === null || Array.isArray(schema)) {
    throw new UsageError('--json-schema must be a JSON Schema object');
  }
  const record = schema as Record<string, unknown>;
  try {
    fromAgentWireResponseFormat({ type: 'json_schema', schema: record });
  } catch (error) {
    throw new UsageError(
      `--json-schema cannot be used: ${error instanceof Error ? error.message : String(error)}`
    );
  }
  return record;
}

/** Where sessions are kept without `memory.adapter`: `COGITATOR_SESSIONS_DB`, else in the home */
export function sessionsDbPath(env: NodeJS.ProcessEnv = process.env): string {
  const fromEnv = env.COGITATOR_SESSIONS_DB?.trim();
  return fromEnv ? resolve(fromEnv) : join(homedir(), '.cogitator', 'sessions.db');
}

/**
 * The config with a session store: as it is with `memory.adapter`, else SQLite at
 * {@link sessionsDbPath}, or memory of the process alone when sessions are not kept
 */
export function withSessionStore(
  config: CogitatorConfig,
  persist: boolean,
  env: NodeJS.ProcessEnv = process.env
): CogitatorConfig {
  if (config.memory?.adapter) return config;
  if (!persist) return { ...config, memory: { ...config.memory, adapter: 'memory' } };
  return {
    ...config,
    memory: { ...config.memory, adapter: 'sqlite', sqlite: { path: sessionsDbPath(env) } },
  };
}

const ContentPartsSchema = z.array(
  z.union([
    UserInputSchema,
    z
      .object({
        type: z.literal('image'),
        source: z.object({
          type: z.literal('base64'),
          media_type: z.enum(['image/jpeg', 'image/png', 'image/gif', 'image/webp']),
          data: z.string().min(1),
        }),
      })
      .transform((part): UserInput => ({
        type: 'image',
        data: part.source.data,
        mimeType: part.source.media_type,
      })),
  ])
);

const UserLineSchema = z.object({
  type: z.literal('user'),
  message: z.object({
    role: z.literal('user'),
    content: z.union([z.string().min(1), ContentPartsSchema.min(1)]),
  }),
  delivery: DeliverySchema.optional(),
});

const ResumeLineSchema = z.object({
  type: z.literal('resume'),
  decisions: z.record(z.string(), ApprovalDecisionSchema).optional(),
  responses: z.record(z.string(), z.unknown()).optional(),
  defaultDecision: ApprovalDecisionSchema.optional(),
});

const InterruptLineSchema = z.object({ type: z.literal('interrupt') });

const InputLineSchema = z.discriminatedUnion('type', [
  UserLineSchema,
  ResumeLineSchema,
  InterruptLineSchema,
]);

/** A line of `--input-format stream-json`, read */
export type InputLine =
  | { type: 'user'; input: UserInput[]; delivery?: 'steer' | 'followUp' | 'inject' }
  | z.output<typeof ResumeLineSchema>
  | { type: 'interrupt' };

/**
 * A line of stream-json input: `user` with a message (text, or parts with images, as Claude
 * Code's stream-json has them) and how to deliver it to a turn going on, `resume` with the
 * answers to a paused turn, or `interrupt`
 */
export function parseInputLine(value: unknown): { line: InputLine } | { error: string } {
  const parsed = InputLineSchema.safeParse(value);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    const where = issue && issue.path.length > 0 ? ` at ${issue.path.join('.')}` : '';
    return { error: `Not an input line${where}: ${issue?.message ?? 'invalid'}` };
  }
  const line = parsed.data;
  if (line.type !== 'user') return { line };
  const content = line.message.content;
  return {
    line: {
      type: 'user',
      input: typeof content === 'string' ? [{ type: 'text', text: content }] : content,
      ...(line.delivery !== undefined && { delivery: line.delivery }),
    },
  };
}

/** The exit code a turn ends the process with */
export function exitCodeOfTurn(turn: Pick<TurnInfo, 'status'>, structuredMissing = false): number {
  if (turn.status === 'paused') return HEADLESS_EXIT.paused;
  if (turn.status === 'completed')
    return structuredMissing ? HEADLESS_EXIT.failed : HEADLESS_EXIT.ok;
  return HEADLESS_EXIT.failed;
}

/** A line of `--output-format stream-json` for an event of a turn */
export function streamJsonEvent(notification: TurnEventNotification): Record<string, unknown> {
  return {
    ...notification.event,
    session_id: notification.threadId,
    parent_tool_use_id: notification.parentToolCallId ?? null,
  };
}

/** The `result` line a turn ends with, also the whole answer of `--output-format json` */
export function resultLine(
  turn: TurnInfo,
  options: { structuredWanted?: boolean } = {}
): Record<string, unknown> {
  const missing =
    options.structuredWanted === true &&
    turn.status === 'completed' &&
    turn.structured === undefined;
  const subtype =
    turn.status === 'completed' && !missing
      ? 'success'
      : turn.status === 'paused'
        ? 'paused'
        : turn.status === 'interrupted'
          ? 'interrupted'
          : 'error';
  const started = Date.parse(turn.startedAt);
  const ended = turn.completedAt ? Date.parse(turn.completedAt) : Date.now();
  const error =
    turn.error ??
    (missing
      ? {
          message: turn.structuredError ?? 'The answer does not match --json-schema',
          code: 'STRUCTURED_OUTPUT_MISSING',
        }
      : undefined);
  return {
    type: 'result',
    subtype,
    is_error: subtype === 'error',
    session_id: turn.threadId,
    turn_id: turn.id,
    result: turn.output ?? '',
    ...(turn.structured !== undefined && { structured_output: turn.structured }),
    duration_ms: turn.usage?.durationMs ?? Math.max(0, ended - started),
    ...(turn.usage && {
      total_cost_usd: turn.usage.cost,
      usage: {
        input_tokens: turn.usage.inputTokens,
        output_tokens: turn.usage.outputTokens,
        total_tokens: turn.usage.totalTokens,
        ...(turn.usage.cachedInputTokens !== undefined && {
          cache_read_input_tokens: turn.usage.cachedInputTokens,
        }),
        ...(turn.usage.cacheWriteTokens !== undefined && {
          cache_creation_input_tokens: turn.usage.cacheWriteTokens,
        }),
        ...(turn.usage.reasoningTokens !== undefined && {
          reasoning_tokens: turn.usage.reasoningTokens,
        }),
      },
    }),
    ...(turn.pending && {
      pending_approvals: turn.pending.approvals,
      interrupts: turn.pending.interrupts,
    }),
    ...(turn.undelivered && { undelivered: turn.undelivered }),
    ...(error && { error }),
  };
}

/** Stdout held for protocol output: console output goes to stderr until {@link restore} */
export interface ClaimedStdout {
  /** Writes `text` to stdout, in order, waiting for the stream to drain */
  write(text: string): Promise<void>;
  /** Resolves once everything written reached the stream */
  drained(): Promise<void>;
  /** Gives the console its stdout back */
  restore(): void;
}

/**
 * Holds stdout for protocol output: `console.log`, `console.info` and `console.debug` (the CLI's
 * own messages and the runtime's logger) go to `stderr` instead, so a reader of stdout gets
 * protocol lines only
 */
export function claimStdout(
  stdout: StdioOutput = process.stdout,
  stderr: { write(text: string): unknown } = process.stderr
): ClaimedStdout {
  const original = { log: console.log, info: console.info, debug: console.debug };
  const toStderr = (...args: unknown[]) => {
    stderr.write(`${format(...args)}\n`);
  };
  console.log = toStderr;
  console.info = toStderr;
  console.debug = toStderr;
  const writer = new OrderedLineWriter(stdout);
  let restored = false;
  return {
    write: (text) => writer.write(text),
    drained: () => writer.drained(),
    restore: () => {
      if (restored) return;
      restored = true;
      console.log = original.log;
      console.info = original.info;
      console.debug = original.debug;
    },
  };
}
