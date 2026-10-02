import type { Tool, ToolCall, ToolResult, ToolContext, Message } from '@cogitator-ai/types';
import { ToolRegistry } from '../registry';
import { getLogger } from '../logger';
import type { SandboxManager } from './initializers';
import type { ConstitutionalAI } from '../constitutional/index';
import { createLinkedAbortController } from '../utils/abort';

type ExtraToolContext = {
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
  extraContext?: ExtraToolContext
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
      context
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

  if (tool.sandbox?.type === 'docker' || tool.sandbox?.type === 'wasm') {
    return executeInSandbox(
      tool,
      { ...toolCall, arguments: validatedArgs as Record<string, unknown> },
      runId,
      agentId,
      sandboxManager,
      initializeSandbox,
      signal,
      extraContext
    );
  }

  return executeNatively(tool, toolCall, validatedArgs, runId, agentId, signal, extraContext);
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
    agentId,
    runId,
    signal: abort?.signal ?? signal ?? new AbortController().signal,
    ...extraContext,
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
  signal?: AbortSignal,
  extraContext?: ExtraToolContext
): Promise<ToolResult> {
  const manager = sandboxManager ?? (await initializeSandbox());

  if (!manager) {
    getLogger().warn('Sandbox unavailable, executing natively', { tool: tool.name });
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

export function createToolMessage(toolCall: ToolCall, result: ToolResult): Message {
  const content = result.error
    ? JSON.stringify({ error: result.error })
    : JSON.stringify(result.result ?? null);
  return {
    role: 'tool',
    content,
    toolCallId: toolCall.id,
    name: toolCall.name,
  };
}
