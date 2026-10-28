/**
 * The studio as the host of an MCP App (extension `io.modelcontextprotocol/ui`): the AppBridge of a
 * tool call's app, which tells the app the call's arguments and result, runs the tool calls the
 * app asks for through the studio, after the person allowed the ones that need it, and sizes the
 * frame as the app asks. The file uses no DOM types, so the UI and the tests share it.
 */

import {
  AppBridge,
  type McpUiHostContext,
  type McpUiSizeChangedNotification,
} from '@modelcontextprotocol/ext-apps/app-bridge';
import {
  isCallToolResult,
  type CallToolResult,
  type ContentBlock,
} from '@modelcontextprotocol/client';
import type { ToolAppCallResult } from '@cogitator-ai/types';
import type { ToolAppCallOutcome, ToolCallRecord } from '../protocol';

/** The studio as it introduces itself to apps */
export const STUDIO_HOST_INFO = { name: 'Cogitator Studio', version: '1.0.0' };

export interface ToolAppHostOptions {
  /**
   * Runs a tool call the app asked for: `approved` once the person allowed it. Answers the result,
   * or that the call waits for approval
   */
  callTool: (
    name: string,
    args: Record<string, unknown>,
    approved: boolean
  ) => Promise<ToolAppCallOutcome>;
  /** Asks the person whether the app may call `name` with `args`, resolving with their answer */
  confirm: (name: string, args: Record<string, unknown>) => Promise<boolean>;
  /** The app asked for another size of its frame */
  onSize?: (size: McpUiSizeChangedNotification['params']) => void;
  /** The app asked to open a link, which the studio opens in a new tab */
  openLink?: (url: string) => void;
  /** What the app is told of the studio: theme, size of its frame */
  hostContext?: McpUiHostContext;
}

/** What the app is told a tool call returned, an MCP `CallToolResult` */
export function toolCallResult(result: ToolAppCallResult): CallToolResult {
  if (isCallToolResult(result)) return result;
  return errorResult('The tool answered with something that is no tool result');
}

function errorResult(message: string): CallToolResult {
  return { content: [{ type: 'text', text: message }], isError: true };
}

/**
 * The result of a call of the run as the app's `tool-result`: what the tool returned, as MCP has
 * it. A result with media (a `toolContent()` result, as a tool of an MCP server whose answer held
 * images, audio or resources gives) goes back to its content blocks
 */
export function recordResult(call: Pick<ToolCallRecord, 'result' | 'error'>): CallToolResult {
  if (call.error !== undefined) return errorResult(call.error);
  const { result } = call;
  const blocks = contentBlocksOf(result);
  if (blocks) return { content: blocks };
  if (result === undefined) return { content: [] };
  return {
    content: [{ type: 'text', text: typeof result === 'string' ? result : JSON.stringify(result) }],
    structuredContent: isRecord(result) ? result : { result },
  };
}

/** The content blocks of a `toolContent()` result, undefined for any other result */
function contentBlocksOf(result: unknown): ContentBlock[] | undefined {
  if (!isRecord(result) || result.type !== 'tool-content' || !Array.isArray(result.content)) {
    return undefined;
  }
  const blocks: ContentBlock[] = [];
  for (const [index, part] of result.content.entries()) {
    const block = isRecord(part) ? contentBlockOf(part, index) : undefined;
    if (!block) return undefined;
    blocks.push(block);
  }
  return blocks;
}

function text(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

/**
 * One part of a `toolContent()` result as the MCP block it came from: text, an image, audio, a
 * resource with its contents, or a link to one without
 */
function contentBlockOf(part: Record<string, unknown>, index: number): ContentBlock | undefined {
  const data = text(part.data);
  const mediaType = text(part.mediaType);
  switch (part.type) {
    case 'text': {
      const value = text(part.text);
      return value === undefined ? undefined : { type: 'text', text: value };
    }
    case 'json':
      return { type: 'text', text: JSON.stringify(part.value ?? null) };
    case 'image':
      return data !== undefined && mediaType !== undefined
        ? { type: 'image', data, mimeType: mediaType }
        : undefined;
    case 'file': {
      if (data === undefined || mediaType === undefined) return undefined;
      if (mediaType.startsWith('audio/')) return { type: 'audio', data, mimeType: mediaType };
      const name = text(part.filename) ?? `file-${index + 1}`;
      const uri = name.includes('://') ? name : `attachment:///${encodeURIComponent(name)}`;
      return { type: 'resource', resource: { uri, mimeType: mediaType, blob: data } };
    }
    case 'resource': {
      const uri = text(part.uri);
      if (uri === undefined) return undefined;
      const contents = text(part.text);
      const mime = mediaType === undefined ? {} : { mimeType: mediaType };
      if (contents !== undefined) {
        return { type: 'resource', resource: { uri, ...mime, text: contents } };
      }
      if (data !== undefined) return { type: 'resource', resource: { uri, ...mime, blob: data } };
      const description = text(part.description);
      return {
        type: 'resource_link',
        uri,
        name: text(part.name) ?? uri,
        ...mime,
        ...(description !== undefined && { description }),
      };
    }
    default:
      return undefined;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function argumentsOf(value: unknown): Record<string, unknown> {
  return isRecord(value) ? value : {};
}

/**
 * A tool call's app, once it connected: `show` tells it the call as it stands, its arguments,
 * then its result or that it failed, each once
 */
export interface ToolAppHost {
  bridge: AppBridge;
  /** Tells the app what it has not been told of the call yet, once it is initialized */
  show(call: Pick<ToolCallRecord, 'arguments' | 'result' | 'error'>): void;
  close(): Promise<void>;
}

/**
 * The AppBridge of a tool call's app, its handlers set before it connects: the app may call tools
 * (through `callTool`, a call that needs approval first confirmed with the person), open links,
 * resize its frame and log. Connect it with `bridge.connect(transport)`
 */
export function createToolAppHost(options: ToolAppHostOptions): ToolAppHost {
  const bridge = new AppBridge(
    null,
    STUDIO_HOST_INFO,
    { serverTools: {}, openLinks: {}, logging: {} },
    { hostContext: { platform: 'web', displayMode: 'inline', ...options.hostContext } }
  );

  bridge.oncalltool = async (params) => {
    const args = argumentsOf(params.arguments);
    try {
      let outcome = await options.callTool(params.name, args, false);
      if (outcome.status === 'approval') {
        if (!(await options.confirm(params.name, args))) {
          return errorResult(`The user declined the call of ${params.name}`);
        }
        outcome = await options.callTool(params.name, args, true);
      }
      return outcome.status === 'done'
        ? toolCallResult(outcome.result)
        : errorResult(`The call of ${params.name} still waits for approval`);
    } catch (error) {
      return errorResult(error instanceof Error ? error.message : String(error));
    }
  };
  bridge.onsizechange = (size) => options.onSize?.(size);
  bridge.onopenlink = async ({ url }) => {
    if (/^https?:\/\//i.test(url)) {
      options.openLink?.(url);
      return {};
    }
    return { isError: true };
  };
  bridge.onloggingmessage = () => undefined;

  let initialized = false;
  let latest: Pick<ToolCallRecord, 'arguments' | 'result' | 'error'> | undefined;
  let sentInput = false;
  let sentEnd = false;

  const flush = () => {
    if (!initialized || !latest) return;
    if (!sentInput) {
      sentInput = true;
      void bridge.sendToolInput({ arguments: argumentsOf(latest.arguments) });
    }
    if (sentEnd) return;
    if (latest.error !== undefined && latest.result === undefined) {
      sentEnd = true;
      void bridge.sendToolCancelled({ reason: latest.error });
    } else if (latest.result !== undefined || latest.error !== undefined) {
      sentEnd = true;
      void bridge.sendToolResult(recordResult(latest));
    }
  };

  bridge.oninitialized = () => {
    initialized = true;
    flush();
  };

  return {
    bridge,
    show(call) {
      latest = call;
      flush();
    },
    close: () => bridge.close(),
  };
}

/** A tool call of an app that waits for the person to allow it */
export interface PendingAppCall {
  name: string;
  args: Record<string, unknown>;
}

/**
 * The calls of an app that wait for the person, in the order the app asked: the first one is
 * shown, each gets its own answer, and the ones left when the frame goes away are declined
 */
export interface ConfirmQueue {
  /** Waits for the person's answer to the call, after the calls asked before it */
  ask(name: string, args: Record<string, unknown>): Promise<boolean>;
  /** Answers the call shown, and shows the next one */
  answer(allowed: boolean): void;
  /** Declines every call still waiting */
  dispose(): void;
}

export function createConfirmQueue(
  onChange: (shown: PendingAppCall | undefined) => void
): ConfirmQueue {
  const waiting: Array<PendingAppCall & { resolve: (allowed: boolean) => void }> = [];
  let disposed = false;
  const show = () => {
    const [first] = waiting;
    onChange(first && { name: first.name, args: first.args });
  };
  return {
    ask(name, args) {
      if (disposed) return Promise.resolve(false);
      return new Promise<boolean>((resolve) => {
        waiting.push({ name, args, resolve });
        if (waiting.length === 1) show();
      });
    },
    answer(allowed) {
      const first = waiting.shift();
      if (!first) return;
      first.resolve(allowed);
      show();
    },
    dispose() {
      disposed = true;
      for (const entry of waiting.splice(0)) entry.resolve(false);
      onChange(undefined);
    },
  };
}
