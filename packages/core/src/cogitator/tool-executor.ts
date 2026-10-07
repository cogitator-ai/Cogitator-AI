import type {
  Message,
  MessageContent,
  Tool,
  ToolCall,
  ToolContext,
  ToolResult,
} from '@cogitator-ai/types';
import { ToolRegistry } from '../registry';
import { getLogger } from '../logger';
import type { SandboxManager } from './initializers';

type SandboxRunOutput = NonNullable<Awaited<ReturnType<SandboxManager['execute']>>['data']>;
import type { ConstitutionalAI } from '../constitutional/index';
import { createLinkedAbortController } from '../utils/abort';
import { toolPartsToMessageContent, toolPartsToText, toolResultParts } from '../tool-content';

type ExtraToolContext = Record<string, unknown> & {
  threadId?: string;
  userId?: string;
  channelType?: string;
  channelId?: string;
};

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
  const tool = registry.get(toolCall.name);

  if (!tool) {
    return {
      callId: toolCall.id,
      name: toolCall.name,
      result: null,
      error: `Tool not found: ${toolCall.name}`,
    };
  }

  const isZod = typeof tool.parameters.safeParse === 'function';
  let validatedArgs: unknown = toolCall.arguments;

  if (isZod) {
    const parseResult = tool.parameters.safeParse(toolCall.arguments);
    if (!parseResult.success) {
      return {
        callId: toolCall.id,
        name: toolCall.name,
        result: null,
        error: `Invalid arguments: ${parseResult.error.message}`,
      };
    }
    validatedArgs = parseResult.data;
  }

  if (constitutionalAI && filterToolCalls) {
    const context: ToolContext = {
      agentId,
      runId,
      signal: signal ?? new AbortController().signal,
      ...extraContext,
    };
    const guardResult = await constitutionalAI.guardTool(
      tool,
      validatedArgs as Record<string, unknown>,
      context,
      { approvedByUser }
    );
    if (!guardResult.approved) {
      return {
        callId: toolCall.id,
        name: toolCall.name,
        result: null,
        error: `Tool blocked: ${guardResult.reason ?? 'Policy violation'}`,
      };
    }
  }

  const result =
    tool.sandbox?.type === 'docker' || tool.sandbox?.type === 'wasm'
      ? await executeInSandbox(
          tool,
          { ...toolCall, arguments: validatedArgs as Record<string, unknown> },
          runId,
          agentId,
          sandboxManager,
          initializeSandbox,
          allowNativeFallback,
          signal,
          extraContext
        )
      : await executeNatively(tool, toolCall, validatedArgs, runId, agentId, signal, extraContext);

  if (!constitutionalAI || result.error) return result;

  const filtered = await constitutionalAI.filterToolResult(
    tool.name,
    toolResultText(result.result)
  );
  if (filtered.allowed) return result;
  return {
    ...result,
    result: null,
    error: `Tool result blocked: ${filtered.blockedReason ?? 'Policy violation'}`,
  };
}

function toolResultText(value: unknown): string {
  if (typeof value === 'string') return value;
  const parts = toolResultParts(value);
  if (parts) return toolPartsToText(parts);
  return JSON.stringify(value) ?? String(value);
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
      }
    : {
        command: ['sh', '-c', String(args.command ?? '')],
        cwd: args.cwd as string | undefined,
        env: args.env as Record<string, string> | undefined,
        timeout: tool.timeout,
      };

  const result = await manager.execute(request, sandboxConfig);

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
 * text, and files only as a description.
 */
export function createToolMessage(toolCall: ToolCall, result: ToolResult): Message {
  const parts = result.error ? undefined : toolResultParts(result.result);
  const content: MessageContent = result.error
    ? JSON.stringify({ error: result.error })
    : parts
      ? toolPartsToMessageContent(parts)
      : JSON.stringify(result.result ?? null);
  return {
    role: 'tool',
    content,
    toolCallId: toolCall.id,
    name: toolCall.name,
  };
}
