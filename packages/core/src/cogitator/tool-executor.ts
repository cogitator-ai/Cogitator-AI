import type {
  BaseToolContext,
  Message,
  MessageContent,
  RunMiddlewareContext,
  Tool,
  ToolCall,
  ToolCallRequest,
  ToolContext,
  ToolPresentation,
  ToolProgress,
  ToolResult,
  Workspace,
} from '@cogitator-ai/types';
import { ErrorCode, isToolOutputResult, WorkspaceError } from '@cogitator-ai/types';
import { ToolRegistry } from '../registry';
import { getLogger } from '../logger';
import type { SandboxManager } from './initializers';

type SandboxRunOutput = NonNullable<Awaited<ReturnType<SandboxManager['execute']>>['data']>;
import type { ConstitutionalAI } from '../constitutional/index';
import { createLinkedAbortController, toAbortError } from '../utils/abort';
import {
  currentLockOwner,
  heldLockKeys,
  insideLockOwner,
  LockCycleError,
  LockOwner,
  toolLocks,
  type StepGate,
} from './tool-locks';
import { guardrailsMiddleware } from '../middleware/builtins';
import {
  canonicalArguments,
  MiddlewarePipeline,
  type ToolArgumentsParser,
} from '../middleware/pipeline';
import { isTripwire } from '../middleware/tripwire';
import { isToolInterrupt } from './interrupts';
import {
  DEFAULT_TOOL_RESULT_MAX_LENGTH,
  toolPartsToMessageContent,
  toolPartsToText,
  toolResultParts,
  truncateToolResultText,
} from '../tool-content';

type ExtraToolContext = Record<string, unknown> & {
  threadId?: string;
  userId?: string;
  channelType?: string;
  channelId?: string;
  topicId?: string;
  conversationId?: string;
  workspace?: Workspace;
  interrupt?: BaseToolContext['interrupt'];
};

/** One tool call of a run, or of `invokeTool()`, and what it runs with. */
export interface ToolCallExecution {
  registry: ToolRegistry;
  toolCall: ToolCall;
  runId: string;
  agentId: string;
  sandboxManager: SandboxManager | undefined;
  initializeSandbox: () => Promise<SandboxManager | undefined>;
  signal?: AbortSignal;
  extraContext?: ExtraToolContext;
  /** Whether a person approved the call */
  approved: boolean;
  allowNativeFallback: boolean;
  /** The `wrapToolCall` hooks the call goes through, and what they are told */
  middleware: MiddlewarePipeline;
  context: RunMiddlewareContext;
  /** Milliseconds a call of a tool without a `timeout` of its own may take (`timeouts.toolMs`) */
  defaultTimeout?: number;
  /** Hears what the tool reports with `context.update()` while it runs */
  onUpdate?: (progress: ToolProgress) => void;
  /**
   * The step of calls the run schedules together that this call belongs to, and whether the
   * schedule runs it alone, see `StepGate`
   */
  step?: { gate: StepGate; alone: boolean };
  /**
   * Decides the arguments a `wrapToolCall` middleware changed the call to, as the permissions
   * decided the ones the model sent. It may throw to pause the run for an approval. With it, the
   * permissions decide such arguments instead of the tool's own approval setting
   */
  permit?: (tool: Tool, args: Record<string, unknown>) => Promise<ChangedCallPermit>;
  /**
   * The guardrails whose tool call filter (`filterToolCalls`) checks arguments the call ends up
   * with after its middleware, the ones an approval of changed arguments gave
   */
  guardrails?: ConstitutionalAI;
  /**
   * Decides the call again once its locks are held, with the arguments it runs with: why it may
   * not run, or undefined when it may. The tool starts right after, nothing awaited in between
   */
  recheck?: (tool: Tool, args: Record<string, unknown>) => Promise<string | undefined>;
  /**
   * Called right before the tool starts, nothing awaited after it: why the call may not start
   * (an allowance spent meanwhile), or undefined once it counts as made
   */
  dispatch?: () => string | undefined;
  /**
   * Awaited once `dispatch` counted the call, before the tool starts: a durable run records what
   * the call was charged. A throw keeps the tool from starting
   */
  dispatched?: () => Promise<void>;
  /**
   * Whether the run was stopped (`RunMiddlewareContext.stop`) while the call waited: checked right
   * before the tool starts, nothing awaited after it
   */
  stopped?: () => boolean;
}

/**
 * Whether a call a middleware changed the arguments of may run, and the arguments an approval
 * of the change replaced them with, or why it may not
 */
export type ChangedCallPermit =
  { allowed: true; args?: Record<string, unknown> } | { allowed: false; reason: string };

/**
 * Runs one tool call: the tool looked up and its arguments checked against its schema, then
 * through the `wrapToolCall` hooks of `middleware` (the guardrails among them) to the tool,
 * natively or in its sandbox.
 */
export async function runToolCall(execution: ToolCallExecution): Promise<ToolResult> {
  const { registry, toolCall } = execution;
  const tool = registry.get(toolCall.name);

  if (!tool) {
    return {
      callId: toolCall.id,
      name: toolCall.name,
      result: null,
      error: `Tool not found: ${toolCall.name}`,
    };
  }

  if (toolCall.argumentsError !== undefined) {
    return {
      callId: toolCall.id,
      name: toolCall.name,
      result: null,
      error: `Invalid arguments: ${toolCall.argumentsError}`,
    };
  }

  const parsed = parseToolArguments(
    { toolCall, tool, args: toolCall.arguments, approved: false },
    false
  );
  if (!parsed.ok) {
    return { callId: toolCall.id, name: toolCall.name, result: null, error: parsed.error };
  }

  return execution.middleware.callTool(
    { toolCall, tool, args: parsed.args, approved: execution.approved },
    (call) => runTool(call, execution),
    execution.context,
    execution.permit ? parseToolArguments : parseCallArguments
  );
}

/**
 * Whether a call of `tool` with `args` waits for a person: its `requiresApproval`, or that
 * function's answer for `args`. A check that throws asks for approval.
 */
export function needsApproval(tool: Tool, args: Record<string, unknown>): boolean {
  const check = tool.requiresApproval;
  if (typeof check !== 'function') return check === true;
  try {
    return check(args);
  } catch {
    return true;
  }
}

/**
 * Whether a call of `tool` with `args` may run at the same time as other safe calls of its step:
 * its `isConcurrencySafe`, or that function's answer for the arguments as its schema reads them,
 * else its `annotations.readOnlyHint`. A check that throws, and a tool that declares nothing,
 * say no.
 */
export function isConcurrencySafe(tool: Tool, args: Record<string, unknown>): boolean {
  return safeWith(tool, parsedArguments(tool, args));
}

/** {@link isConcurrencySafe} for arguments the tool's schema already read, whatever their shape */
function safeWith(tool: Tool, parsed: unknown): boolean {
  const declared = tool.isConcurrencySafe ?? tool.annotations?.readOnlyHint === true;
  if (typeof declared !== 'function') return declared;
  try {
    return declared(parsed);
  } catch {
    return false;
  }
}

/** How a client shows a call of `tool` with the arguments its schema read, from its `presentation` */
function presentationOf(tool: Tool, parsed: unknown): ToolPresentation | undefined {
  const declared = tool.presentation;
  if (typeof declared !== 'function') return declared;
  try {
    return declared(parsed);
  } catch (error) {
    getLogger().debug('Tool presentation failed', {
      tool: tool.name,
      error: error instanceof Error ? error.message : String(error),
    });
    return undefined;
  }
}

/** The arguments as the tool's schema reads them, transforms applied, or as sent when it refuses them */
function parsedArguments(tool: Tool, args: Record<string, unknown>): unknown {
  if (typeof tool.parameters.safeParse !== 'function') return args;
  const parsed = tool.parameters.safeParse(args);
  return parsed.success ? parsed.data : args;
}

/** The arguments of `call` as its tool's Zod schema reads them, or as they are without one. */
const parseToolArguments: ToolArgumentsParser = ({ tool, toolCall }) => {
  if (typeof tool.parameters.safeParse !== 'function') {
    return { ok: true, args: toolCall.arguments };
  }
  const result = tool.parameters.safeParse(toolCall.arguments);
  return result.success
    ? { ok: true, args: result.data }
    : { ok: false, error: `Invalid arguments: ${result.error.message}` };
};

/**
 * Arguments of a call as `parseToolArguments` reads them, and refused when a middleware changed
 * them into ones the tool needs an approval for: nobody approved these arguments.
 */
const parseCallArguments: ToolArgumentsParser = (call, changed) => {
  const parsed = parseToolArguments(call, changed);
  if (!parsed.ok || !changed || !needsApproval(call.tool, call.toolCall.arguments)) return parsed;
  return {
    ok: false,
    error: `Tool "${call.tool.name}" needs approval for these arguments, and nobody approved them`,
  };
};

/**
 * Runs the tool of `call` once it may: a call of a step the run schedules (`step`) takes its
 * share of the step, or the step alone when the schedule runs it alone or its arguments as a
 * middleware left them are not safe to run beside others, so it also waits for a call that timed
 * out and still runs, then it holds the locks of its `lockKeys`, keys a call it runs
 * inside holds already taken again without waiting. Both are let go once the tool's own promise
 * settles, also when the call timed out or was aborted before. What the tool returned is read
 * then: a `toolOutput()` result gives the model its `content`, the application its `details` and
 * `presentation`, any other result gets the tool's own `presentation`.
 */
async function runTool(call: ToolCallRequest, execution: ToolCallExecution): Promise<ToolResult> {
  const { tool } = call;
  let { toolCall, args } = call;
  const { runId, agentId, signal, extraContext, step } = execution;
  const failed = (error: string, errorCode?: string): ToolResult => ({
    callId: toolCall.id,
    name: toolCall.name,
    result: null,
    error,
    ...(errorCode && { errorCode }),
  });
  if (
    execution.permit &&
    canonicalArguments(execution.toolCall.arguments) !== canonicalArguments(toolCall.arguments)
  ) {
    const permit = await execution.permit(tool, toolCall.arguments);
    if (!permit.allowed) return failed(`Permission denied: ${permit.reason}`, 'PERMISSION_DENIED');
    if (permit.args) {
      toolCall = { ...toolCall, arguments: permit.args };
      const parsed = parseToolArguments(
        { toolCall, tool, args: permit.args, approved: true },
        true
      );
      if (!parsed.ok) return failed(parsed.error);
      args = parsed.args;
      if (execution.guardrails) {
        const guard = await execution.guardrails.guardTool(
          tool,
          args as Record<string, unknown>,
          {
            ...extraContext,
            agentId,
            runId,
            signal: signal ?? new AbortController().signal,
            toolCallId: toolCall.id,
          },
          { approvedByUser: true }
        );
        if (!guard.approved) return failed(`Tool blocked: ${guard.reason ?? 'Policy violation'}`);
      }
    }
  }
  const owner = new LockOwner(currentLockOwner());

  let keys: readonly string[] = [];
  if (tool.lockKeys) {
    try {
      keys = await tool.lockKeys(args as Parameters<NonNullable<Tool['lockKeys']>>[0], {
        ...extraContext,
        agentId,
        runId,
        signal: signal ?? new AbortController().signal,
        toolCallId: toolCall.id,
      });
    } catch (error) {
      return failed(
        `Could not tell what the call changes: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  }

  const releases: Array<() => void> = [() => owner.letGo()];
  const releaseAll = () => {
    for (const release of releases.splice(0).reverse()) release();
  };
  const abortedNow = (): ToolResult | undefined =>
    signal?.aborted
      ? failed(toAbortError(signal.reason, `Tool "${tool.name}" aborted`).message)
      : undefined;
  const abortedAfterKeys = abortedNow();
  if (abortedAfterKeys) return abortedAfterKeys;
  try {
    if (step) {
      releases.push(
        await (!step.alone && safeWith(tool, args)
          ? step.gate.share(signal)
          : step.gate.exclusive(signal))
      );
    }
    const held = heldLockKeys();
    const fresh = keys.filter((key) => !held.has(key));
    if (fresh.length > 0) {
      releases.push(await toolLocks.acquire(fresh, signal, owner));
      owner.hold(fresh);
    }
  } catch (error) {
    releaseAll();
    if (error instanceof LockCycleError) return failed(error.message, error.code);
    return failed(toAbortError(error, `Tool "${tool.name}" aborted`).message);
  }

  let running: Promise<unknown> | undefined;
  const native: NativeRunOptions = {
    defaultTimeout: execution.defaultTimeout,
    onUpdate: execution.onUpdate,
    onStart: (started) => {
      running = started;
    },
  };
  try {
    const stale = execution.recheck ? await execution.recheck(tool, toolCall.arguments) : undefined;
    if (stale !== undefined) {
      releaseAll();
      return failed(`Permission denied: ${stale}`, 'PERMISSION_DENIED');
    }
    const aborted = abortedNow();
    if (aborted) {
      releaseAll();
      return aborted;
    }
    if (execution.stopped?.()) {
      releaseAll();
      return failed('Not started: the run was stopped');
    }
    const spent = execution.dispatch?.();
    if (spent !== undefined) {
      releaseAll();
      return failed(spent, 'BUDGET_EXCEEDED');
    }
    if (execution.dispatched) {
      try {
        await execution.dispatched();
      } catch (error) {
        releaseAll();
        throw error;
      }
    }
    const result = await insideLockOwner(owner, () =>
      tool.sandbox?.type === 'docker' || tool.sandbox?.type === 'wasm'
        ? executeInSandbox(
            tool,
            { ...toolCall, arguments: args as Record<string, unknown> },
            runId,
            agentId,
            execution.sandboxManager,
            execution.initializeSandbox,
            execution.allowNativeFallback,
            signal,
            extraContext,
            native
          )
        : executeNatively(tool, toolCall, args, runId, agentId, signal, extraContext, native)
    );
    return readOutput(tool, args, result);
  } finally {
    if (running) void running.then(releaseAll, releaseAll);
    else releaseAll();
  }
}

/** `result` with a `toolOutput()` result taken apart and the call's presentation, see {@link runTool} */
function readOutput(tool: Tool, args: unknown, result: ToolResult): ToolResult {
  const output = isToolOutputResult(result.result) ? result.result : undefined;
  const presentation = output?.presentation ?? presentationOf(tool, args);
  if (!output && !presentation) return result;
  return {
    ...result,
    ...(output && { result: output.content }),
    ...(output?.details !== undefined && { details: output.details }),
    ...(presentation && { presentation }),
  };
}

/**
 * Runs one tool call with the guardrails of `constitutionalAI` and no other middleware, see
 * {@link runToolCall}.
 */
export async function executeTool(
  registry: ToolRegistry,
  toolCall: ToolCall,
  runId: string,
  agentId: string,
  sandboxManager: SandboxManager | undefined,
  constitutionalAI: ConstitutionalAI | undefined,
  filterToolCalls: boolean,
  initializeSandbox: () => Promise<SandboxManager | undefined>,
  signal?: AbortSignal,
  extraContext?: ExtraToolContext,
  approvedByUser = false,
  allowNativeFallback = true
): Promise<ToolResult> {
  const abortSignal = signal ?? new AbortController().signal;
  return runToolCall({
    registry,
    toolCall,
    runId,
    agentId,
    sandboxManager,
    initializeSandbox,
    signal,
    extraContext,
    approved: approvedByUser,
    allowNativeFallback,
    middleware: new MiddlewarePipeline(
      constitutionalAI ? [guardrailsMiddleware(constitutionalAI, { filterToolCalls })] : []
    ),
    context: {
      runId,
      agentId,
      agentName: agentId,
      iteration: 0,
      signal: abortSignal,
      state: new Map(),
      ...(extraContext?.threadId !== undefined && { threadId: extraContext.threadId }),
      ...(extraContext?.userId !== undefined && { userId: extraContext.userId }),
      ...(extraContext?.channelType !== undefined && { channelType: extraContext.channelType }),
      ...(extraContext?.channelId !== undefined && { channelId: extraContext.channelId }),
      ...(extraContext?.topicId !== undefined && { topicId: extraContext.topicId }),
      ...(extraContext?.conversationId !== undefined && {
        conversationId: extraContext.conversationId,
      }),
      ...(extraContext?.deps !== undefined && { deps: extraContext.deps }),
      ...(extraContext?.workspace !== undefined && { workspace: extraContext.workspace }),
    },
  });
}

/** How a native call runs beyond its tool: the default timeout and where its updates go */
interface NativeRunOptions {
  defaultTimeout?: number;
  onUpdate?: (progress: ToolProgress) => void;
  /**
   * Gets the tool's own promise once it started: a call that timed out or was aborted returns
   * before the tool stops, and the locks it holds wait for that promise to settle
   */
  onStart?: (execution: Promise<unknown>) => void;
}

/** Milliseconds a call of `tool` may take: its own `timeout`, else `defaultTimeout` */
function timeoutOf(tool: Tool, defaultTimeout: number | undefined): number | undefined {
  if (tool.timeout && tool.timeout > 0) return tool.timeout;
  return defaultTimeout && defaultTimeout > 0 ? defaultTimeout : undefined;
}

async function executeNatively(
  tool: Tool,
  toolCall: ToolCall,
  args: unknown,
  runId: string,
  agentId: string,
  signal?: AbortSignal,
  extraContext?: ExtraToolContext,
  options: NativeRunOptions = {}
): Promise<ToolResult> {
  const timeoutMs = timeoutOf(tool, options.defaultTimeout);
  const abort = timeoutMs ? createLinkedAbortController(signal, timeoutMs) : undefined;
  let running = true;
  const { onUpdate } = options;
  const context: ToolContext = {
    ...extraContext,
    agentId,
    runId,
    signal: abort?.signal ?? signal ?? new AbortController().signal,
    toolCallId: toolCall.id,
    update: (progress) => {
      if (!running || !onUpdate || signal?.aborted) return;
      try {
        onUpdate(progress);
      } catch (error) {
        getLogger().warn('onToolUpdate failed', {
          tool: tool.name,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    },
  };

  try {
    const execution = tool.execute(args as Parameters<typeof tool.execute>[0], context);
    options.onStart?.(execution);
    const result = abort
      ? await raceWithAbort(execution, abort.signal, () =>
          abort.timedOut
            ? new Error(`Tool "${tool.name}" timed out after ${timeoutMs}ms`)
            : toAbortError(abort.signal.reason, `Tool "${tool.name}" aborted`)
        )
      : await execution;
    return {
      callId: toolCall.id,
      name: toolCall.name,
      result,
    };
  } catch (error) {
    if (isTripwire(error) || isToolInterrupt(error)) throw error;
    return {
      callId: toolCall.id,
      name: toolCall.name,
      result: null,
      error: error instanceof Error ? error.message : String(error),
      ...(abort?.timedOut && { errorCode: ErrorCode.TOOL_TIMEOUT }),
    };
  } finally {
    running = false;
    abort?.cleanup();
  }
}

function raceWithAbort<T>(
  promise: Promise<T>,
  signal: AbortSignal,
  createError: () => Error
): Promise<T> {
  if (signal.aborted) {
    promise.catch(() => undefined);
    return Promise.reject(createError());
  }

  return new Promise<T>((resolve, reject) => {
    const onAbort = () => {
      promise.catch(() => undefined);
      reject(createError());
    };
    signal.addEventListener('abort', onAbort, { once: true });
    promise.then(resolve, reject).finally(() => {
      signal.removeEventListener('abort', onAbort);
    });
  });
}

async function executeInSandbox(
  tool: Tool,
  toolCall: ToolCall,
  runId: string,
  agentId: string,
  sandboxManager: SandboxManager | undefined,
  initializeSandbox: () => Promise<SandboxManager | undefined>,
  allowNativeFallback: boolean,
  signal?: AbortSignal,
  extraContext?: ExtraToolContext,
  native: NativeRunOptions = {}
): Promise<ToolResult> {
  const { defaultTimeout } = native;
  const manager = sandboxManager ?? (await initializeSandbox());

  if (!manager) {
    const type = tool.sandbox?.type;
    if (type === 'docker' && !allowNativeFallback) {
      return {
        callId: toolCall.id,
        name: toolCall.name,
        result: null,
        error: `Tool "${tool.name}" needs a Docker sandbox, which is unavailable, and sandbox.allowNativeFallback is false`,
      };
    }
    getLogger().warn(
      type === 'docker'
        ? 'Sandbox unavailable: running a Docker-sandboxed tool UNSANDBOXED on the host. Set sandbox.allowNativeFallback: false to refuse instead.'
        : 'Sandbox unavailable: running the WASM tool through its own execute function',
      { tool: tool.name }
    );
    return executeNatively(
      tool,
      toolCall,
      toolCall.arguments,
      runId,
      agentId,
      signal,
      extraContext,
      native
    );
  }

  const args = toolCall.arguments;
  const sandboxConfig = tool.sandbox!;

  const isWasm = sandboxConfig.type === 'wasm';
  const request = isWasm
    ? {
        command: [],
        stdin: JSON.stringify(args),
        timeout: timeoutOf(tool, defaultTimeout),
        signal,
      }
    : {
        command: ['sh', '-c', String(args.command ?? '')],
        cwd: args.cwd as string | undefined,
        env: args.env as Record<string, string> | undefined,
        timeout: timeoutOf(tool, defaultTimeout),
        signal,
      };

  const result = await manager.execute(request, sandboxConfig);

  if (signal?.aborted) {
    return {
      callId: toolCall.id,
      name: toolCall.name,
      result: null,
      error: toAbortError(signal.reason, `Tool "${tool.name}" aborted`).message,
    };
  }

  if (!result.success) {
    return {
      callId: toolCall.id,
      name: toolCall.name,
      result: null,
      error: result.error,
    };
  }

  if (!result.data) {
    return {
      callId: toolCall.id,
      name: toolCall.name,
      result: null,
      error: 'Sandbox returned success but no data',
    };
  }

  if (isWasm) {
    const failure = wasmFailure(tool, result.data);
    if (failure) {
      return {
        callId: toolCall.id,
        name: toolCall.name,
        result: null,
        error: failure,
        ...(result.data.timedOut && { errorCode: ErrorCode.TOOL_TIMEOUT }),
      };
    }
    try {
      const parsed = JSON.parse(result.data.stdout);
      return {
        callId: toolCall.id,
        name: toolCall.name,
        result: parsed,
      };
    } catch {
      return {
        callId: toolCall.id,
        name: toolCall.name,
        result: result.data.stdout,
      };
    }
  }

  if (result.data.timedOut) {
    return {
      callId: toolCall.id,
      name: toolCall.name,
      result: null,
      error: `Tool "${tool.name}" timed out in the Docker sandbox after ${result.data.duration}ms`,
      errorCode: ErrorCode.TOOL_TIMEOUT,
    };
  }

  return {
    callId: toolCall.id,
    name: toolCall.name,
    result: {
      stdout: result.data.stdout,
      stderr: result.data.stderr,
      exitCode: result.data.exitCode,
      timedOut: result.data.timedOut,
      duration: result.data.duration,
      command: args.command,
    },
  };
}

/**
 * Why a WASM tool's run produced no usable result: it timed out, exited with an error (a panic
 * or a trap), or wrote more than the sandbox keeps, which leaves its JSON cut off.
 */
function wasmFailure(tool: Tool, data: SandboxRunOutput): string | undefined {
  const stderr = data.stderr.trim();
  if (data.timedOut) {
    return `Tool "${tool.name}" timed out in the WASM sandbox after ${data.duration}ms`;
  }
  if (data.exitCode !== 0) {
    return `Tool "${tool.name}" failed in the WASM sandbox (exit code ${data.exitCode})${stderr ? `: ${stderr}` : ''}`;
  }
  if (data.truncated) {
    return `Tool "${tool.name}" wrote more output than the WASM sandbox keeps (${data.stdout.length} characters), so its result was cut off`;
  }
  return undefined;
}

/**
 * The message that answers a tool call. A result that carries media (a `toolContent()` result,
 * or an object with a base64 image in `image` or `imageBase64`, see `toolResultParts`) reaches
 * the model as text and image parts, so vision models see a screenshot instead of its base64
 * text, and files only as a description. The text is cut to `maxLength` characters (see
 * `truncateToolResultText`), the `ToolResult` the application gets keeps all of it.
 */
export function createToolMessage(
  toolCall: ToolCall,
  result: ToolResult,
  maxLength = DEFAULT_TOOL_RESULT_MAX_LENGTH
): Message {
  const parts = result.error ? undefined : toolResultParts(result.result);
  const content: MessageContent = result.error
    ? JSON.stringify({ error: truncateToolResultText(result.error, maxLength) })
    : parts
      ? toolPartsToMessageContent(parts, maxLength)
      : truncateToolResultText(JSON.stringify(result.result ?? null), maxLength);
  return {
    role: 'tool',
    content,
    toolCallId: toolCall.id,
    name: toolCall.name,
  };
}

/** Where a run's tool results too long for the model are saved in full, relative to the workspace root. */
export const TOOL_RESULTS_DIR = '.cogitator/tool-results';

/** How long the saved results of a run are kept by default: 7 days. */
export const DEFAULT_TOOL_RESULT_RETENTION = 7 * 24 * 60 * 60 * 1000;

/**
 * Where the run's workspace keeps one tool result: `.cogitator/tool-results/<runId>/<toolCallId>.txt`,
 * each id made safe for a file name (characters other than letters, digits, `.`, `_` and `-`
 * replaced, with a short hash of the id when it had to change, so two ids never share a file).
 */
export function toolResultPath(runId: string, toolCallId: string): string {
  return `${TOOL_RESULTS_DIR}/${pathSegment(runId)}/${pathSegment(toolCallId)}.txt`;
}

export interface ToolResultOffload {
  workspace: Workspace;
  runId: string;
  /** Milliseconds older runs' results are kept, see `limits.toolResultRetention` */
  retention?: number;
}

/**
 * The message that answers a tool call, as {@link createToolMessage} makes it, except that a
 * result longer than `maxLength` is saved in full to `offload.workspace` first (see
 * {@link toolResultPath}): the model gets the cut preview and a note with the path and how to
 * page through it with `read_file`. The workspace's `.cogitator/` gets a `.gitignore` so the
 * results stay out of git, and results of runs older than `offload.retention` are removed.
 * Without a workspace, for an error, and when saving fails (logged), the result is only cut.
 * Offer the offload only to a run that has `read_file`, or the note points to a tool the model
 * cannot call.
 */
export async function createToolMessageWithOffload(
  toolCall: ToolCall,
  result: ToolResult,
  maxLength = DEFAULT_TOOL_RESULT_MAX_LENGTH,
  offload?: ToolResultOffload
): Promise<Message> {
  if (!offload || result.error || !Number.isFinite(maxLength)) {
    return createToolMessage(toolCall, result, maxLength);
  }
  const parts = toolResultParts(result.result);
  const modelText = parts
    ? toolPartsToText(parts.filter((part) => part.type !== 'image'))
    : JSON.stringify(result.result ?? null);
  if (modelText.length <= maxLength) return createToolMessage(toolCall, result, maxLength);

  const full = parts
    ? toolPartsToText(parts)
    : typeof result.result === 'string'
      ? result.result
      : JSON.stringify(result.result ?? null, null, 2);
  const path = toolResultPath(offload.runId, toolCall.id);
  const { workspace } = offload;
  try {
    if (!(await workspace.exists(SERVICE_GITIGNORE)))
      await workspace.write(SERVICE_GITIGNORE, '*\n');
    await workspace.write(path, full);
  } catch (error) {
    getLogger().warn('Could not save a long tool result to the workspace, it is only cut', {
      tool: toolCall.name,
      path,
      error: error instanceof Error ? error.message : String(error),
    });
    return createToolMessage(toolCall, result, maxLength);
  }
  await pruneToolResults(
    workspace,
    pathSegment(offload.runId),
    offload.retention ?? DEFAULT_TOOL_RESULT_RETENTION
  );

  const lines = full.length === 0 ? 0 : full.split('\n').length;
  const note = `[The full result (${full.length} characters, ${lines} lines) is saved in the workspace at ${path}. Read it with read_file: offset and limit page through the lines, and for a line too long to show at once read_file returns nextColumn to continue it with column.]`;
  const message = createToolMessage(toolCall, result, Math.max(1, maxLength - note.length - 2));
  const content: MessageContent =
    typeof message.content === 'string'
      ? `${message.content}\n\n${note}`
      : [...message.content, { type: 'text', text: note }];
  return { ...message, content };
}

const SERVICE_GITIGNORE = '.cogitator/.gitignore';

/** Removes the saved results of runs other than `current` last changed more than `retention` ago. */
async function pruneToolResults(
  workspace: Workspace,
  current: string,
  retention: number
): Promise<void> {
  if (!Number.isFinite(retention)) return;
  try {
    const cutoff = Date.now() - retention;
    const runs = await workspace.list(TOOL_RESULTS_DIR, { includeHidden: true });
    for (const run of runs) {
      if (run.name === current || run.modifiedAt >= cutoff) continue;
      await workspace.remove(run.path, { recursive: true });
    }
  } catch (error) {
    if (error instanceof WorkspaceError && error.code === 'BUSY') return;
    getLogger().warn('Could not remove old tool results from the workspace', {
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

function pathSegment(value: string): string {
  const safe = value.replace(/[^A-Za-z0-9._-]/g, '_').replace(/^\.+/, '_');
  if (safe === value && safe.length > 0 && safe.length <= 100) return safe;
  return `${safe.slice(0, 100) || '_'}-${fnv1a(value)}`;
}

/** A short, stable hash of `text` (FNV-1a, 32 bits, hex). */
function fnv1a(text: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, '0');
}
