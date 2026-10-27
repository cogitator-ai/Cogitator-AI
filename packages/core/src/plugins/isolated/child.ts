/**
 * The loader of an isolated plugin's process. It runs under Node's permission model (the host
 * starts it with `--permission`, reading only the plugin's folder and this file, writing only the
 * plugin's data folder, without child processes, workers or native addons), closes the network
 * before the plugin's code runs, and gives `activate` a context whose every registration and
 * request goes to the host over the IPC channel. It imports nothing but Node's own modules
 */

import dgram from 'node:dgram';
import { EventEmitter } from 'node:events';
import dns from 'node:dns';
import { syncBuiltinESMExports } from 'node:module';
import net from 'node:net';
import { pathToFileURL } from 'node:url';
import type {
  HostMessage,
  ProcessMessage,
  ProcessRequest,
  WireError,
  WireIdentity,
  WireRegistration,
} from './protocol';

type Disposer = () => void | Promise<void>;

interface PendingReply {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
}

interface ToolLike {
  name?: unknown;
  description?: unknown;
  parameters?: unknown;
  requiresApproval?: unknown;
  readOnly?: unknown;
  timeout?: unknown;
  annotations?: { readOnlyHint?: unknown };
  execute?: (args: unknown, context: unknown) => unknown;
  toJSON?: () => { parameters?: unknown };
}

interface BackendLike {
  chat?: (request: unknown) => Promise<unknown>;
  chatStream?: (request: unknown) => AsyncIterable<unknown>;
  complete?: (request: unknown) => Promise<unknown>;
}

interface LLMPluginLike {
  provider?: unknown;
  metadata?: unknown;
  factory?: (config: unknown) => BackendLike;
  validateConfig?: (config: unknown) => boolean;
}

interface PanelLike {
  handlers?: Record<string, (params: unknown) => unknown>;
  [key: string]: unknown;
}

interface PluginLike {
  activate?: (context: unknown) => unknown;
}

const send = (message: ProcessMessage): void => {
  process.send?.(message);
};

function closeNetwork(): void {
  function refuse(): never {
    const error = new Error(
      'The network is closed to an isolated plugin: ask the host with context.fetch, which its permissions must allow'
    ) as NodeJS.ErrnoException;
    error.code = 'ERR_ACCESS_DENIED';
    throw error;
  }
  const seal = (target: object, key: string): void => {
    Object.defineProperty(target, key, { value: refuse, writable: false, configurable: false });
  };
  const sealFunctions = (target: object, skip: ReadonlySet<string> = new Set()): void => {
    for (const key of Object.getOwnPropertyNames(target)) {
      if (skip.has(key)) continue;
      const descriptor = Object.getOwnPropertyDescriptor(target, key);
      if (descriptor && typeof descriptor.value === 'function') seal(target, key);
    }
  };
  const sealClass = (type: unknown): void => {
    if (typeof type !== 'function') return;
    for (
      let prototype: object | null = (type as { prototype: object }).prototype;
      prototype && prototype !== Object.prototype && prototype !== EventEmitter.prototype;
      prototype = Object.getPrototypeOf(prototype) as object | null
    ) {
      sealFunctions(prototype, new Set(['constructor']));
    }
  };
  seal(net.Socket.prototype, 'connect');
  seal(net.Server.prototype, 'listen');
  sealClass(dgram.Socket);
  for (const key of ['connect', 'createConnection', 'createServer']) seal(net, key);
  seal(dgram, 'createSocket');
  sealClass(dns.Resolver);
  sealClass(dns.promises.Resolver);
  const readOnly = new Set(['getDefaultResultOrder', 'getServers']);
  sealFunctions(dns, readOnly);
  sealFunctions(dns.promises, readOnly);
  syncBuiltinESMExports();
}

function wireError(error: unknown): WireError {
  if (error instanceof Error) {
    const code = (error as NodeJS.ErrnoException).code;
    return { name: error.name, message: error.message, ...(typeof code === 'string' && { code }) };
  }
  return { name: 'Error', message: String(error) };
}

function errorOf(wire: WireError): Error {
  const error = new Error(wire.message) as NodeJS.ErrnoException;
  error.name = wire.name;
  if (wire.code !== undefined) error.code = wire.code;
  return error;
}

closeNetwork();

let nextRequest = 0;
let nextHandle = 0;
const replies = new Map<number, PendingReply>();
const tools = new Map<number, ToolLike>();
const panels = new Map<number, PanelLike>();
const llmPlugins = new Map<number, LLMPluginLike>();
const backends = new Map<number, BackendLike>();
const calls = new Map<number, AbortController>();
const disposers: Disposer[] = [];
const unload = new AbortController();
let activated = false;

const ask = (request: ProcessRequest): Promise<unknown> =>
  new Promise((resolve, reject) => {
    const id = ++nextRequest;
    replies.set(id, { resolve, reject });
    send({ t: 'request', id, request });
  });

const register = (registration: WireRegistration, onDispose?: () => void): Disposer => {
  const handle = ++nextHandle;
  send({ t: 'register', handle, registration });
  let done = false;
  const dispose: Disposer = () => {
    if (done) return;
    done = true;
    onDispose?.();
    send({ t: 'unregister', handle });
  };
  disposers.push(dispose);
  return dispose;
};

const plainObject = (value: unknown, what: string): Record<string, unknown> => {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new TypeError(`${what} must be an object`);
  }
  return JSON.parse(JSON.stringify(value)) as Record<string, unknown>;
};

const logger =
  (level: 'debug' | 'info' | 'warn' | 'error') => (message: unknown, details?: unknown) =>
    send({
      t: 'log',
      level,
      message: String(message),
      ...(details !== undefined && { details: JSON.parse(JSON.stringify(details)) as unknown }),
    });

function contextOf(
  identity: WireIdentity,
  options: Record<string, unknown>
): Record<string, unknown> {
  return {
    plugin: { ...identity, isolated: true },
    options: Object.freeze({ ...options }),
    secret: (key: string) => ask({ op: 'secret', key }),
    logger: {
      debug: logger('debug'),
      info: logger('info'),
      warn: logger('warn'),
      error: logger('error'),
    },
    signal: unload.signal,
    files: {
      readFile: (path: string) => ask({ op: 'files.readFile', path }),
      writeFile: (path: string, content: string) => ask({ op: 'files.writeFile', path, content }),
      list: (path: string) => ask({ op: 'files.list', path }),
    },
    fetch: (
      url: string,
      init?: { method?: string; headers?: Record<string, string>; body?: string }
    ) => ask({ op: 'fetch', url, ...(init !== undefined && { init }) }),
    exec: (command: string, options?: { cwd?: string; timeoutMs?: number }) =>
      ask({ op: 'exec', command, ...(options !== undefined && { options }) }),
    registerTool(tool: ToolLike) {
      if (typeof tool.name !== 'string' || typeof tool.description !== 'string') {
        throw new TypeError('A tool needs a name and a description');
      }
      if (typeof tool.execute !== 'function')
        throw new TypeError(`Tool ${tool.name} needs execute`);
      const schema =
        tool.parameters !== undefined && !('_zod' in Object(tool.parameters))
          ? tool.parameters
          : typeof tool.toJSON === 'function'
            ? tool.toJSON().parameters
            : undefined;
      const readOnly = tool.readOnly === true || tool.annotations?.readOnlyHint === true;
      const registration: WireRegistration = {
        kind: 'tool',
        name: tool.name,
        description: tool.description,
        parameters: plainObject(
          schema ?? { type: 'object', properties: {} },
          `The parameters of ${tool.name}`
        ),
        ...(tool.requiresApproval === true && { requiresApproval: true }),
        ...(readOnly && { readOnly: true }),
        ...(typeof tool.timeout === 'number' && { timeout: tool.timeout }),
      };
      const handle = nextHandle + 1;
      tools.set(handle, tool);
      return register(registration, () => tools.delete(handle));
    },
    registerSkill: (skill: unknown) =>
      register({ kind: 'skill', skill: plainObject(skill, 'A skill') }),
    registerAgent: (name: string, definition: unknown) =>
      register({ kind: 'agent', name, definition: plainObject(definition, `Agent ${name}`) }),
    registerCommand: (name: string, command: unknown) =>
      register({
        kind: 'command',
        name,
        command: typeof command === 'string' ? command : plainObject(command, `Command ${name}`),
      }),
    registerHooks: (hooks: unknown) =>
      register({ kind: 'hooks', hooks: plainObject(hooks, 'Hooks') }),
    registerMcpServer: (name: string, config: unknown) =>
      register({ kind: 'mcp', name, config: plainObject(config, `MCP server ${name}`) }),
    registerLLMBackend(plugin: LLMPluginLike) {
      if (typeof plugin.provider !== 'string' || typeof plugin.factory !== 'function') {
        throw new TypeError('An LLM backend plugin needs a provider and a factory');
      }
      const handle = nextHandle + 1;
      llmPlugins.set(handle, plugin);
      return register(
        {
          kind: 'llm',
          provider: plugin.provider,
          metadata: plainObject(plugin.metadata ?? {}, 'metadata'),
        },
        () => llmPlugins.delete(handle)
      );
    },
    registerMiddleware() {
      throw new Error(
        'registerMiddleware needs the host process: an isolated plugin adds hooks, tools and backends instead'
      );
    },
    registerPanel(panel: PanelLike) {
      const { handlers, ...spec } = panel;
      const handle = nextHandle + 1;
      panels.set(handle, panel);
      return register(
        {
          kind: 'panel',
          panel: plainObject(spec, 'A panel'),
          methods: Object.keys(handlers ?? {}),
        },
        () => panels.delete(handle)
      );
    },
    onDispose(dispose: Disposer) {
      disposers.push(dispose);
      return dispose;
    },
  };
}

async function runDisposers(): Promise<void> {
  unload.abort(new Error('The plugin unloads'));
  for (const dispose of disposers.splice(0).reverse()) {
    try {
      await dispose();
    } catch (error) {
      send({ t: 'log', level: 'warn', message: `A disposer failed: ${wireError(error).message}` });
    }
  }
}

async function activate(
  identity: WireIdentity,
  entry: string,
  options: Record<string, unknown>
): Promise<void> {
  try {
    const module = (await import(pathToFileURL(entry).href)) as { default?: PluginLike };
    const definition = module.default;
    if (!definition || typeof definition !== 'object') {
      throw new TypeError(`${entry} has no default export with the plugin's definition`);
    }
    if (typeof definition.activate === 'function') {
      const returned = await definition.activate(contextOf(identity, options));
      if (typeof returned === 'function') disposers.push(returned as Disposer);
    }
    activated = true;
    send({ t: 'activated' });
  } catch (error) {
    send({ t: 'activate-failed', error: wireError(error) });
  }
}

async function answer(id: number, work: () => Promise<unknown>): Promise<void> {
  try {
    send({ t: 'result', id, ok: true, value: await work() });
  } catch (error) {
    send({ t: 'result', id, ok: false, error: wireError(error) });
  } finally {
    calls.delete(id);
  }
}

function backendOf(handle: number, backend: number): BackendLike {
  const created = backends.get(backend);
  if (!created || !llmPlugins.has(handle)) throw new Error('The backend is not there any more');
  return created;
}

process.on('message', (raw: unknown) => {
  const message = raw as HostMessage;
  switch (message.t) {
    case 'activate':
      if (!activated) void activate(message.identity, message.entry, message.options);
      return;
    case 'reply': {
      const pending = replies.get(message.id);
      if (!pending) return;
      replies.delete(message.id);
      if (message.ok) pending.resolve(message.value);
      else pending.reject(errorOf(message.error));
      return;
    }
    case 'cancel':
      calls.get(message.id)?.abort(new Error('The call was cancelled'));
      return;
    case 'call': {
      const controller = new AbortController();
      calls.set(message.id, controller);
      const target = message.target;
      void answer(message.id, async () => {
        if (target.kind === 'tool') {
          const tool = tools.get(target.handle);
          if (!tool?.execute) throw new Error('The tool is not there any more');
          return tool.execute(message.payload, { ...message.context, signal: controller.signal });
        }
        if (target.kind === 'panel') {
          const handler = panels.get(target.handle)?.handlers?.[target.method];
          if (typeof handler !== 'function')
            throw new Error(`The panel has no handler ${target.method}`);
          return handler(message.payload);
        }
        const backend = backendOf(target.handle, target.backend);
        const method = target.op === 'chat' ? backend.chat : backend.complete;
        if (typeof method !== 'function') throw new Error(`The backend has no ${target.op}`);
        return method.call(backend, { ...(message.payload as object), signal: controller.signal });
      });
      return;
    }
    case 'llm.create':
      void answer(message.id, async () => {
        const plugin = llmPlugins.get(message.handle);
        if (!plugin?.factory) throw new Error('The backend plugin is not there any more');
        if (plugin.validateConfig && !plugin.validateConfig(message.config)) {
          throw new Error(`Invalid configuration for provider '${String(plugin.provider)}'`);
        }
        const backend = plugin.factory(message.config);
        const id = ++nextHandle;
        backends.set(id, backend);
        return id;
      });
      return;
    case 'stream': {
      const controller = new AbortController();
      calls.set(message.id, controller);
      void (async () => {
        try {
          const backend = backendOf(message.handle, message.backend);
          if (typeof backend.chatStream !== 'function')
            throw new Error('The backend cannot stream');
          for await (const chunk of backend.chatStream({
            ...(message.request as object),
            signal: controller.signal,
          })) {
            send({ t: 'chunk', id: message.id, chunk });
          }
          send({ t: 'end', id: message.id });
        } catch (error) {
          send({ t: 'result', id: message.id, ok: false, error: wireError(error) });
        } finally {
          calls.delete(message.id);
        }
      })();
      return;
    }
    case 'dispose':
      void runDisposers().finally(() => {
        send({ t: 'disposed' });
        process.disconnect?.();
      });
      return;
  }
});

process.on('disconnect', () => {
  void runDisposers().finally(() => process.exit(0));
});

send({ t: 'ready' });
