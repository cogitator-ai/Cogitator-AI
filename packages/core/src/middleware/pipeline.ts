import type {
  ChatResponse,
  Message,
  RunMiddlewareContext,
  ModelCallHandler,
  ModelCallRequest,
  ModelResponseEvent,
  ModelTurnEvent,
  RunInputEvent,
  RunMiddleware,
  ToolCallHandler,
  ToolCallRequest,
  ToolResult,
} from '@cogitator-ai/types';
import { getLogger } from '../logger';
import { claimTripwire } from './tripwire';

/**
 * How a tool call's arguments are read: what the tool's schema made of them, or the error the call
 * answers with when they do not fit it. `changed` marks arguments a middleware gave, which also
 * must not need an approval nobody gave for them.
 */
export type ToolArgumentsParser = (
  call: ToolCallRequest,
  changed: boolean
) => { ok: true; args: unknown } | { ok: false; error: string };

/**
 * The middleware of a run in the order they apply (see `RunMiddleware`): `before*` hooks run
 * first to last, `wrap*` hooks nest with the first outermost, `afterModel` runs last to first.
 * A tripwire a hook throws names the middleware it came from.
 */
export class MiddlewarePipeline<TDeps = unknown> {
  constructor(private readonly layers: readonly RunMiddleware<TDeps>[]) {}

  /** Whether a streamed turn's text waits until the turn is done, see `holdsStream`. */
  get holdsStream(): boolean {
    return this.layers.some((layer) => layer.holdsStream === true);
  }

  async beforeRun(event: RunInputEvent, context: RunMiddlewareContext<TDeps>): Promise<void> {
    for (const layer of this.layers) {
      if (!layer.beforeRun) continue;
      await claimed(layer.name, () => layer.beforeRun?.(event, context));
    }
  }

  /** The conversation after every `beforeModel` hook, or `undefined` when none changed it. */
  async beforeModel(
    event: ModelTurnEvent,
    context: RunMiddlewareContext<TDeps>
  ): Promise<Message[] | undefined> {
    let messages: Message[] | undefined;
    for (const layer of this.layers) {
      if (!layer.beforeModel) continue;
      const turn = messages ? { ...event, messages } : event;
      const update = await claimed(layer.name, () => layer.beforeModel?.(turn, context));
      if (update?.messages) messages = update.messages;
    }
    return messages;
  }

  /** `call` through every `wrapModelCall` hook, `send` making the call at the end. */
  callModel(
    call: ModelCallRequest,
    send: ModelCallHandler,
    context: RunMiddlewareContext<TDeps>
  ): Promise<ChatResponse> {
    const through = (index: number): ModelCallHandler => {
      const layer = this.layers[index];
      if (!layer) return send;
      const next = through(index + 1);
      const wrap = layer.wrapModelCall;
      if (!wrap) return next;
      return (current) => claimed(layer.name, () => wrap.call(layer, current, next, context));
    };
    return through(0)(call);
  }

  /** The answer after every `afterModel` hook, last middleware first. */
  async afterModel(
    event: ModelResponseEvent,
    context: RunMiddlewareContext<TDeps>
  ): Promise<ChatResponse> {
    let response = event.response;
    for (const layer of [...this.layers].reverse()) {
      if (!layer.afterModel) continue;
      const seen = response === event.response ? event : { ...event, response };
      const update = await claimed(layer.name, () => layer.afterModel?.(seen, context));
      if (!update) continue;
      response = {
        ...response,
        ...(update.content !== undefined && { content: update.content }),
        ...(update.toolCalls !== undefined && { toolCalls: update.toolCalls }),
      };
    }
    return response;
  }

  /**
   * `call` through every `wrapToolCall` hook, `run` running the tool at the end. A layer can
   * change only the arguments of the call. Each layer and the tool get their own copy of them,
   * parsed afresh, so a layer that edits its copy in place changes nothing. Arguments a layer
   * hands on with different content are read by `parse` as changed: a call they do not fit
   * answers with the reason instead of going on, and an approval given for the old ones does not
   * carry over. The tool, the call's id and name and its approval stay as they came.
   */
  callTool(
    call: ToolCallRequest,
    run: ToolCallHandler,
    context: RunMiddlewareContext<TDeps>,
    parse: ToolArgumentsParser
  ): Promise<ToolResult> {
    if (!this.layers.some((layer) => layer.wrapToolCall)) return run(call);
    const refused = (error: string): ToolResult => ({
      callId: call.toolCall.id,
      name: call.toolCall.name,
      result: null,
      error,
    });
    const prepare = (
      args: Record<string, unknown>,
      approved: boolean,
      changed: boolean
    ): ToolCallRequest | ToolResult => {
      const toolCall = { ...call.toolCall, arguments: copyArguments(args) };
      const parsed = parse(
        { toolCall, tool: call.tool, args: toolCall.arguments, approved },
        changed
      );
      if (!parsed.ok) return refused(parsed.error);
      return { toolCall, tool: call.tool, args: parsed.args, approved };
    };
    const through = (
      index: number
    ): ((
      pristine: Record<string, unknown>,
      approved: boolean,
      changed: boolean
    ) => Promise<ToolResult>) => {
      const layer = this.layers[index];
      const inner = layer ? through(index + 1) : undefined;
      const wrap = layer?.wrapToolCall;
      return async (pristine, approved, changed) => {
        const request = prepare(pristine, approved, changed);
        if (!('tool' in request)) return request;
        if (!layer || !inner) return run(request);
        if (!wrap) return inner(pristine, approved, false);
        const snapshot = canonicalArguments(pristine);
        const next: ToolCallHandler = async (current) => {
          if (current.args !== request.args) {
            getLogger().warn(
              'A middleware changed the parsed args of a tool call, which it cannot: change toolCall.arguments instead',
              { middleware: layer.name, tool: call.tool.name }
            );
          }
          const args = current.toolCall.arguments;
          if (canonicalArguments(args) === snapshot) return inner(pristine, approved, false);
          return inner(copyArguments(args), false, true);
        };
        return claimed(layer.name, () => wrap.call(layer, request, next, context));
      };
    };
    return through(0)(copyArguments(call.toolCall.arguments), call.approved, false);
  }
}

/** A copy of tool call arguments a middleware can edit without touching anyone else's. */
function copyArguments(args: Record<string, unknown>): Record<string, unknown> {
  try {
    return structuredClone(args);
  } catch {
    return { ...args };
  }
}

/** Tool call arguments as text that is the same for the same content, whatever the key order. */
function canonicalArguments(value: unknown): string {
  return JSON.stringify(value, (_key, item: unknown) => {
    if (typeof item === 'bigint') return item.toString();
    if (item === null || typeof item !== 'object' || Array.isArray(item)) return item;
    return Object.fromEntries(
      Object.keys(item)
        .sort()
        .map((key) => [key, (item as Record<string, unknown>)[key]])
    );
  });
}

/** What `hook` returns, a tripwire it throws claimed for the middleware `name`. */
async function claimed<T>(name: string, hook: () => T | Promise<T>): Promise<T> {
  try {
    return await hook();
  } catch (error) {
    throw claimTripwire(error, name);
  }
}
