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
import { claimTripwire } from './tripwire';

/**
 * How a tool call's new arguments are read: what the tool's schema made of them, or why they do
 * not fit it.
 */
export type ToolArgumentsParser = (
  call: ToolCallRequest
) => { ok: true; args: unknown } | { ok: false; error: string };

/**
 * The middleware of a run in the order they apply (see `RunMiddleware`): `before*` hooks run
 * first to last, `wrap*` hooks nest with the first outermost, `afterModel` runs last to first.
 * A tripwire a hook throws names the middleware it came from.
 */
export class MiddlewarePipeline<TDeps = unknown> {
  constructor(private readonly layers: readonly RunMiddleware<TDeps>[]) {}

  /** Whether a streamed turn's text waits for the `afterModel` hooks, see `holdsStream`. */
  get holdsStream(): boolean {
    return this.layers.some((layer) => layer.holdsStream === true && layer.afterModel);
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
   * `call` through every `wrapToolCall` hook, `run` running the tool at the end. A layer that
   * hands on new arguments has them read by `parse` first, and a call they do not fit answers
   * with the reason instead of going on.
   */
  callTool(
    call: ToolCallRequest,
    run: ToolCallHandler,
    context: RunMiddlewareContext<TDeps>,
    parse: ToolArgumentsParser
  ): Promise<ToolResult> {
    const checked =
      (handler: ToolCallHandler, seen: ToolCallRequest): ToolCallHandler =>
      async (current) => {
        if (current.toolCall.arguments === seen.toolCall.arguments) {
          return handler(current.args === seen.args ? current : { ...current, args: seen.args });
        }
        const parsed = parse(current);
        if (!parsed.ok) {
          return {
            callId: current.toolCall.id,
            name: current.toolCall.name,
            result: null,
            error: `Invalid arguments: ${parsed.error}`,
          };
        }
        return handler({ ...current, args: parsed.args });
      };
    const through = (index: number): ToolCallHandler => {
      const layer = this.layers[index];
      if (!layer) return run;
      const inner = through(index + 1);
      const wrap = layer.wrapToolCall;
      if (!wrap) return inner;
      return (current) =>
        claimed(layer.name, () => wrap.call(layer, current, checked(inner, current), context));
    };
    return through(0)(call);
  }
}

/** What `hook` returns, a tripwire it throws claimed for the middleware `name`. */
async function claimed<T>(name: string, hook: () => T | Promise<T>): Promise<T> {
  try {
    return await hook();
  } catch (error) {
    throw claimTripwire(error, name);
  }
}
