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
import { isCallToolResult, type CallToolResult } from '@modelcontextprotocol/client';
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

/** The result of a call of the run as the app's `tool-result`: what the tool returned, as MCP has it */
export function recordResult(call: Pick<ToolCallRecord, 'result' | 'error'>): CallToolResult {
  if (call.error !== undefined) return errorResult(call.error);
  const { result } = call;
  if (typeof result === 'string') return { content: [{ type: 'text', text: result }] };
  if (result === undefined || result === null) return { content: [] };
  return {
    content: [{ type: 'text', text: JSON.stringify(result) }],
    ...(isRecord(result) && { structuredContent: result }),
  };
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
