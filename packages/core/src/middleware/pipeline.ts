import type {
  ChatResponse,
  Message,
  RunMiddlewareContext,
  ModelCallHandler,
  ModelCallRequest,
  ModelResponseEvent,
  ModelTurnEvent,
  RunEndEvent,
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

  /**
   * Runs every `afterRun` hook, in order, once a run finished. The run is done by then, so a hook
   * that throws is logged and the next one still runs.
   */
  async afterRun(event: RunEndEvent, context: RunMiddlewareContext<TDeps>): Promise<void> {
    for (const layer of this.layers) {
      if (!layer.afterRun) continue;
      try {
        await layer.afterRun(event, context);
      } catch (error) {
        getLogger().warn('An afterRun hook failed after the run finished', {
          middleware: layer.name,
          runId: event.result.runId,
          error: error instanceof Error ? error.message : String(error),
        });
      }
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
      if (!layer) {
        return async (pristine, approved, changed) => {
          const request = prepare(pristine, approved, changed);
          return 'tool' in request ? run(request) : request;
        };
      }
      const inner = through(index + 1);
      const wrap = layer.wrapToolCall;
      if (!wrap) return inner;
      return async (pristine, approved, changed) => {
        const request = prepare(pristine, approved, changed);
        if (!('tool' in request)) return request;
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

/**
 * A copy of tool call arguments a middleware can edit without touching anyone else's: plain
 * objects, arrays, maps and sets are copied all the way down (cycles kept), anything else (a
 * `Buffer`, a `Date`, a `URL`, an instance of a class or of a subclass of `Map`) is kept as it is,
 * so a tool gets values of the types it was called with. Keys are copied as data, so a
 * `__proto__` key stays a key.
 */
function copyArguments(args: Record<string, unknown>): Record<string, unknown> {
  return copyValue(args, new Map()) as Record<string, unknown>;
}

function copyValue(value: unknown, copies: Map<object, unknown>): unknown {
  if (value === null || typeof value !== 'object') return value;
  const done = copies.get(value);
  if (done !== undefined) return done;
  const prototype: unknown = Object.getPrototypeOf(value);
  if (prototype === Array.prototype) {
    const copy: unknown[] = [];
    copies.set(value, copy);
    for (const item of value as unknown[]) copy.push(copyValue(item, copies));
    return copy;
  }
  if (prototype === Map.prototype) {
    const copy = new Map<unknown, unknown>();
    copies.set(value, copy);
    for (const [key, item] of value as Map<unknown, unknown>)
      copy.set(key, copyValue(item, copies));
    return copy;
  }
  if (prototype === Set.prototype) {
    const copy = new Set<unknown>();
    copies.set(value, copy);
    for (const item of value as Set<unknown>) copy.add(copyValue(item, copies));
    return copy;
  }
  if (prototype !== Object.prototype && prototype !== null) return value;
  const copy: Record<string, unknown> = prototype === null ? Object.create(null) : {};
  copies.set(value, copy);
  for (const [key, item] of Object.entries(value)) {
    Object.defineProperty(copy, key, {
      value: copyValue(item, copies),
      enumerable: true,
      writable: true,
      configurable: true,
    });
  }
  return copy;
}

/**
 * Tool call arguments as text that is the same exactly when their content is: key order aside,
 * with maps, sets, dates, binary data, `NaN`, `-0`, `undefined` and cycles told apart. A value
 * with `toJSON` (a `URL`, a `Buffer`) is read through it, another instance of a class by its own
 * fields, so a change it keeps in private fields is not seen.
 */
function canonicalArguments(value: unknown): string {
  const ancestors = new Set<object>();
  const seen = new Map<object, string>();
  const walk = (item: unknown): string => {
    if (item === undefined) return 'undefined';
    if (item === null || typeof item === 'boolean') return String(item);
    if (typeof item === 'number') return Object.is(item, -0) ? 'number:-0' : `number:${item}`;
    if (typeof item === 'bigint') return `bigint:${item.toString()}`;
    if (typeof item === 'string') return JSON.stringify(item);
    if (typeof item !== 'object') return typeof item;
    if (ancestors.has(item)) return 'circular';
    const known = seen.get(item);
    if (known !== undefined) return known;
    ancestors.add(item);
    try {
      const text = describe(item, walk);
      seen.set(item, text);
      return text;
    } finally {
      ancestors.delete(item);
    }
  };
  return walk(value);
}

function describe(item: object, walk: (value: unknown) => string): string {
  if (Array.isArray(item)) return `[${item.map(walk).join(',')}]`;
  if (item instanceof Map) {
    const entries = [...item].map(([key, entry]) => `${walk(key)}=>${walk(entry)}`);
    return `Map{${entries.sort().join(',')}}`;
  }
  if (item instanceof Set) return `Set{${[...item].map(walk).sort().join(',')}}`;
  if (item instanceof Date) return `Date(${item.getTime()})`;
  if (item instanceof ArrayBuffer) return `ArrayBuffer(${new Uint8Array(item).join(',')})`;
  if (ArrayBuffer.isView(item)) {
    const bytes = new Uint8Array(item.buffer, item.byteOffset, item.byteLength);
    return `${item.constructor.name}(${bytes.join(',')})`;
  }
  const kind = (Object.getPrototypeOf(item) as { constructor?: { name?: string } } | null)
    ?.constructor?.name;
  const toJSON = (item as { toJSON?: unknown }).toJSON;
  if (typeof toJSON === 'function') {
    return `${kind ?? 'null'}(${walk((toJSON as () => unknown).call(item))})`;
  }
  const record = item as Record<string, unknown>;
  const fields = Object.keys(record)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${walk(record[key])}`);
  return `${kind ?? 'null'}{${fields.join(',')}}`;
}

/** What `hook` returns, a tripwire it throws claimed for the middleware `name`. */
async function claimed<T>(name: string, hook: () => T | Promise<T>): Promise<T> {
  try {
    return await hook();
  } catch (error) {
    throw claimTripwire(error, name);
  }
}
