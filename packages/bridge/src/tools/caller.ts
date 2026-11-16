import { isAbsolute, resolve } from 'node:path';
import { z } from 'zod';
import { findProjectRoot } from '../paths.js';
import {
  AGENT_NAME_ENV,
  HARNESS_ENV,
  SESSION_NAME_ENV,
  callerFromEnv,
  harnessOfAlias,
} from '../registry.js';
import { HARNESSES, HarnessNameSchema, type CallerIdentity } from '../types.js';

/**
 * The argument a hook of a harness adds to a call of a bridge tool, to say which session makes
 * it. The model never writes it: the tools do not list it among their arguments.
 */
export const TOOL_CALL_HINT_KEY = '_bridge';

/** What a hook of a harness says of the session whose tool call it sees. */
export interface ToolCallHint {
  harness: string;
  /** The harness's own id of the session, as it is at the moment of the call */
  session: string;
  /** The folder the session works in, an absolute path */
  cwd?: string;
}

const OneLine = z
  .string()
  .trim()
  .min(1)
  .max(256)
  .regex(/^[^\p{Cc}]*$/u);

const HintSchema = z.object({
  harness: HarnessNameSchema,
  session: OneLine,
  cwd: z
    .string()
    .min(1)
    .max(4096)
    .refine((path) => isAbsolute(path))
    .optional(),
});

/** What a tool call tells about the session that made it, besides the environment of the server. */
export interface ToolCallOrigin {
  /** The arguments of the call: a hook of the harness may have left a hint among them */
  args?: unknown;
  /** `_meta` of the MCP request, where Codex names the thread of the call */
  meta?: Record<string, unknown>;
  /** The name the MCP client gave itself, such as `codex-mcp-client` */
  client?: string;
}

/** The key Codex keeps what it knows of the turn under, in `_meta` of every tool call. */
const CODEX_TURN_META = 'x-codex-turn-metadata';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function hinted(args: unknown): ToolCallHint | undefined {
  if (!isRecord(args)) return undefined;
  const parsed = HintSchema.safeParse(args[TOOL_CALL_HINT_KEY]);
  return parsed.success ? parsed.data : undefined;
}

/**
 * The thread Codex names in a tool call. Codex gives a server none of the session's environment,
 * and names the thread in `_meta` of each call instead.
 */
function codexThread(origin: ToolCallOrigin): ToolCallHint | undefined {
  const meta = origin.meta;
  if (!meta) return undefined;
  const turn = meta[CODEX_TURN_META];
  const fromTurn = isRecord(turn) ? OneLine.safeParse(turn.thread_id) : undefined;
  if (fromTurn?.success) return { harness: HARNESSES.codex, session: fromTurn.data };
  if (!origin.client?.toLowerCase().startsWith('codex')) return undefined;
  const thread = OneLine.safeParse(meta.threadId);
  return thread.success ? { harness: HARNESSES.codex, session: thread.data } : undefined;
}

/**
 * Who makes a call of a bridge tool. A server of tools outlives the session it was started for
 * (Claude Code keeps it across `/clear`) or serves a session whose id it was never told (Codex),
 * so the session is read from each call, not once: from the hint a hook of the harness added to
 * the arguments, else from what the client sent with the call, else from the environment of the
 * server, as `callerFromEnv` reads it. Undefined when none of them names a session.
 *
 * @param env the environment of the server process
 * @param cwd the folder the server process runs in
 * @throws BridgeError `not_registered` when only the environment names a session, and it names
 * sessions of several harnesses without saying which one is calling
 */
export function callerOfToolCall(
  origin: ToolCallOrigin,
  env: NodeJS.ProcessEnv,
  cwd: string
): CallerIdentity | undefined {
  const told = hinted(origin.args) ?? codexThread(origin);
  if (!told) return callerFromEnv(env, cwd);

  const folder = resolve(told.cwd ?? cwd);
  const started = env[HARNESS_ENV]?.trim();
  const own = !started || harnessOfAlias(started) === told.harness;
  const agentName = own ? env[AGENT_NAME_ENV]?.trim() : undefined;
  const sessionName = own ? env[SESSION_NAME_ENV]?.trim() : undefined;
  return {
    harness: told.harness,
    sessionId: told.session,
    cwd: folder,
    project: findProjectRoot(folder),
    ...(sessionName && { sessionName }),
    ...(agentName && { agentName }),
  };
}

/** The arguments of a tool call without the hint of a hook, as the model wrote them. */
export function withoutToolCallHint<T extends Record<string, unknown>>(args: T): T {
  if (!(TOOL_CALL_HINT_KEY in args)) return args;
  const { [TOOL_CALL_HINT_KEY]: _hint, ...rest } = args;
  return rest as T;
}
