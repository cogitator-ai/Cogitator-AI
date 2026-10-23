import type {
  Message,
  MessageContent,
  RunMiddlewareContext,
  Tool,
  ToolCall,
  ToolCallRequest,
  ToolContext,
  ToolResult,
  Workspace,
} from '@cogitator-ai/types';
import { ToolRegistry } from '../registry';
import { getLogger } from '../logger';
import type { SandboxManager } from './initializers';

type SandboxRunOutput = NonNullable<Awaited<ReturnType<SandboxManager['execute']>>['data']>;
import type { ConstitutionalAI } from '../constitutional/index';
import { createLinkedAbortController } from '../utils/abort';
import { guardrailsMiddleware } from '../middleware/builtins';
import { MiddlewarePipeline, type ToolArgumentsParser } from '../middleware/pipeline';
import { isTripwire } from '../middleware/tripwire';
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
}

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
    parseCallArguments
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

function runTool(call: ToolCallRequest, execution: ToolCallExecution): Promise<ToolResult> {
  const { tool, toolCall, args } = call;
  const { runId, agentId, signal, extraContext } = execution;
  return tool.sandbox?.type === 'docker' || tool.sandbox?.type === 'wasm'
    ? executeInSandbox(
        tool,
        { ...toolCall, arguments: args as Record<string, unknown> },
        runId,
        agentId,
        execution.sandboxManager,
        execution.initializeSandbox,
        execution.allowNativeFallback,
        signal,
        extraContext
      )
    : executeNatively(tool, toolCall, args, runId, agentId, signal, extraContext);
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
    },
  });
}

async function executeNatively(
  tool: Tool,
  toolCall: ToolCall,
  args: unknown,
  runId: string,
  agentId: string,
  signal?: AbortSignal,
  extraContext?: ExtraToolContext
): Promise<ToolResult> {
  const timeoutMs = tool.timeout && tool.timeout > 0 ? tool.timeout : undefined;
  const abort = timeoutMs ? createLinkedAbortController(signal, timeoutMs) : undefined;
  const context: ToolContext = {
    ...extraContext,
    agentId,
    runId,
    signal: abort?.signal ?? signal ?? new AbortController().signal,
    toolCallId: toolCall.id,
  };

  try {
    const execution = tool.execute(args as Parameters<typeof tool.execute>[0], context);
    const result = abort
      ? await raceWithAbort(execution, abort.signal, () =>
          abort.timedOut
            ? new Error(`Tool "${tool.name}" timed out after ${timeoutMs}ms`)
            : toError(abort.signal.reason, `Tool "${tool.name}" aborted`)
        )
      : await execution;
    return {
      callId: toolCall.id,
      name: toolCall.name,
      result,
    };
  } catch (error) {
    if (isTripwire(error)) throw error;
    return {
      callId: toolCall.id,
      name: toolCall.name,
      result: null,
      error: error instanceof Error ? error.message : String(error),
    };
  } finally {
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

function toError(reason: unknown, fallbackMessage: string): Error {
  if (reason instanceof Error) return reason;
  if (reason === undefined || reason === null) return new Error(fallbackMessage);
  return new Error(String(reason));
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
  extraContext?: ExtraToolContext
): Promise<ToolResult> {
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
      extraContext
    );
  }

  const args = toolCall.arguments;
  const sandboxConfig = tool.sandbox!;

  const isWasm = sandboxConfig.type === 'wasm';
  const request = isWasm
    ? {
        command: [],
        stdin: JSON.stringify(args),
        timeout: tool.timeout,
        signal,
      }
    : {
        command: ['sh', '-c', String(args.command ?? '')],
        cwd: args.cwd as string | undefined,
        env: args.env as Record<string, string> | undefined,
        timeout: tool.timeout,
        signal,
      };

  const result = await manager.execute(request, sandboxConfig);

  if (signal?.aborted) {
    return {
      callId: toolCall.id,
      name: toolCall.name,
      result: null,
      error: toError(signal.reason, `Tool "${tool.name}" aborted`).message,
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
      return { callId: toolCall.id, name: toolCall.name, result: null, error: failure };
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

/** Where the run's workspace keeps one tool result: `.cogitator/tool-results/<runId>/<toolCallId>.txt`. */
export function toolResultPath(runId: string, toolCallId: string): string {
  return `${TOOL_RESULTS_DIR}/${pathSegment(runId)}/${pathSegment(toolCallId)}.txt`;
}

/**
 * The message that answers a tool call, as {@link createToolMessage} makes it, except that a
 * result longer than `maxLength` is saved in full to `offload.workspace` first (see
 * {@link toolResultPath}): the model gets the cut preview and a note with the path and how to
 * page through it with `read_file`. Without a workspace, for an error, and when saving fails
 * (logged), the result is only cut.
 */
export async function createToolMessageWithOffload(
  toolCall: ToolCall,
  result: ToolResult,
  maxLength = DEFAULT_TOOL_RESULT_MAX_LENGTH,
  offload?: { workspace: Workspace; runId: string }
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
  try {
    await offload.workspace.write(path, full);
  } catch (error) {
    getLogger().warn('Could not save a long tool result to the workspace, it is only cut', {
      tool: toolCall.name,
      path,
      error: error instanceof Error ? error.message : String(error),
    });
    return createToolMessage(toolCall, result, maxLength);
  }

  const lines = full.length === 0 ? 0 : full.split('\n').length;
  const note = `[The full result (${full.length} characters, ${lines} lines) is saved in the workspace at ${path}. Read it with read_file, using offset and limit to page through the lines.]`;
  const message = createToolMessage(toolCall, result, Math.max(1, maxLength - note.length - 2));
  const content: MessageContent =
    typeof message.content === 'string'
      ? `${message.content}\n\n${note}`
      : [...message.content, { type: 'text', text: note }];
  return { ...message, content };
}

function pathSegment(value: string): string {
  const safe = value.replace(/[^A-Za-z0-9._-]/g, '_').replace(/^\.+/, '_');
  return safe.length > 0 ? safe.slice(0, 128) : '_';
}
