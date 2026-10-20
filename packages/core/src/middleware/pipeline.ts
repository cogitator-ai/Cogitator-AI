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
 * How a tool call's new arguments are read: what the tool's schema made of them, or the error the
 * call answers with when they do not fit it or would need an approval nobody gave.
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
   * `call` through every `wrapToolCall` hook, `run` running the tool at the end. A layer can
   * change only the arguments of the call: new ones are read by `parse` first, a call they do not
   * fit answers with the reason instead of going on, and an approval given for the old ones does
   * not carry over. The tool, the call's id and name and its approval stay as they came.
   */
  callTool(
    call: ToolCallRequest,
    run: ToolCallHandler,
    context: RunMiddlewareContext<TDeps>,
    parse: ToolArgumentsParser
  ): Promise<ToolResult> {
    const checked =
      (handler: ToolCallHandler, seen: ToolCallRequest, layer: string): ToolCallHandler =>
      async (current) => {
        const { arguments: args } = current.toolCall;
        if (args === seen.toolCall.arguments) {
          if (current.args !== seen.args) {
            getLogger().warn(
              'A middleware changed the parsed args of a tool call, which it cannot: change toolCall.arguments instead',
              { middleware: layer, tool: seen.tool.name }
            );
          }
          const unchanged =
            current.tool === seen.tool &&
            current.toolCall === seen.toolCall &&
            current.args === seen.args &&
            current.approved === seen.approved;
          return handler(unchanged ? current : seen);
        }
        const toolCall = { ...seen.toolCall, arguments: args };
        const parsed = parse({ ...seen, toolCall, approved: false });
        if (!parsed.ok) {
          return { callId: toolCall.id, name: toolCall.name, result: null, error: parsed.error };
        }
        return handler({ toolCall, tool: seen.tool, args: parsed.args, approved: false });
      };
    const through = (index: number): ToolCallHandler => {
      const layer = this.layers[index];
      if (!layer) return run;
      const inner = through(index + 1);
      const wrap = layer.wrapToolCall;
      if (!wrap) return inner;
      return (current) =>
        claimed(layer.name, () =>
          wrap.call(layer, current, checked(inner, current, layer.name), context)
        );
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
