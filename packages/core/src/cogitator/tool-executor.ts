import type {
  ImageBase64ContentPart,
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
import type { ConstitutionalAI } from '../constitutional/index';
import { createLinkedAbortController } from '../utils/abort';

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
 * The message that answers a tool call. A result object carrying a base64
 * image in `image` or `imageBase64` (a PNG, JPEG, GIF or WebP, plain or as a
 * `data:` URL) reaches the model as an image after the rest of the result as
 * JSON, so vision models see a screenshot instead of its base64 text.
 */
export function createToolMessage(toolCall: ToolCall, result: ToolResult): Message {
  const image = result.error ? undefined : findImage(result.result);
  const content: MessageContent = result.error
    ? JSON.stringify({ error: result.error })
    : image
      ? [
          { type: 'text', text: JSON.stringify({ ...image.rest, [image.key]: IMAGE_PLACEHOLDER }) },
          { type: 'image_base64', image_base64: { data: image.data, media_type: image.mediaType } },
        ]
      : JSON.stringify(result.result ?? null);
  return {
    role: 'tool',
    content,
    toolCallId: toolCall.id,
    name: toolCall.name,
  };
}

type ImageMediaType = ImageBase64ContentPart['image_base64']['media_type'];

const IMAGE_PLACEHOLDER = '(image attached)';
const IMAGE_KEYS = ['image', 'imageBase64'] as const;
const IMAGE_SIGNATURES: readonly (readonly [string, ImageMediaType])[] = [
  ['iVBORw0KGgo', 'image/png'],
  ['/9j/', 'image/jpeg'],
  ['R0lGOD', 'image/gif'],
  ['UklGR', 'image/webp'],
];
const DATA_URL = /^data:image\/[a-z+.-]+;base64,/i;

function findImage(
  value: unknown
):
  | { key: string; data: string; mediaType: ImageMediaType; rest: Record<string, unknown> }
  | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  for (const key of IMAGE_KEYS) {
    const raw = record[key];
    if (typeof raw !== 'string') continue;
    const data = raw.replace(DATA_URL, '');
    const mediaType = IMAGE_SIGNATURES.find(([signature]) => data.startsWith(signature))?.[1];
    if (!mediaType) continue;
    const { [key]: _image, ...rest } = record;
    return { key, data, mediaType, rest };
  }
  return undefined;
}
