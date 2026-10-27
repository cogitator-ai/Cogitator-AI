/**
 * The host's side of an isolated plugin: a child process under Node's permission model that reads
 * only the plugin's folder and writes only its data folder, with the network closed. Whatever the
 * plugin registers there is registered here through the host's own `PluginContext`, so it gets
 * the same checks as a plugin in the host's process, and whatever it asks for beyond its folder
 * goes through that context's permission checks
 */

import { fork, type ChildProcess } from 'node:child_process';
import { existsSync, realpathSync } from 'node:fs';
import { readdir, realpath } from 'node:fs/promises';
import { join, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import { RoutineSchema, TriggerSpecSchema } from '../../triggers/schema';
import {
  CogitatorError,
  ErrorCode,
  type ChatRequest,
  type ChatResponse,
  type ChatStreamChunk,
  type CommandDefinitionInput,
  type LLMBackend,
  type PluginContext,
  type PluginDisposer,
  type PluginIsolationConfig,
  type PluginToolCallContext,
  type SubagentDefinitionInput,
} from '@cogitator-ai/types';
import type { HostMessage, ProcessMessage, WireError, WireIdentity } from './protocol';

const DEFAULT_ACTIVATE_TIMEOUT_MS = 10_000;
const DEFAULT_CALL_TIMEOUT_MS = 120_000;
const DEFAULT_MAX_HEAP_MB = 256;
const DISPOSE_GRACE_MS = 3_000;
const MAX_LOG_LINE = 4_000;

/** The loader the process runs: the built `child.js`, or `child.ts` when the core runs from source */
function childFile(): string {
  const built = fileURLToPath(new URL('./child.js', import.meta.url));
  if (existsSync(built)) return built;
  return fileURLToPath(new URL('./child.ts', import.meta.url));
}

/** The flag that turns Node's permission model on in this version of Node */
function permissionFlag(): string {
  if (process.allowedNodeEnvironmentFlags.has('--permission')) return '--permission';
  if (process.allowedNodeEnvironmentFlags.has('--experimental-permission')) {
    return '--experimental-permission';
  }
  throw new CogitatorError({
    message: `Node ${process.version} has no permission model, so an isolated plugin cannot be started: use Node 22.12 or later`,
    code: ErrorCode.PLUGIN_ACTIVATION_FAILED,
  });
}

const WireErrorSchema = z.object({
  name: z.string(),
  message: z.string(),
  code: z.string().optional(),
});

const RegistrationSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('tool'),
    name: z.string().min(1).max(128),
    description: z.string(),
    parameters: z.record(z.string(), z.unknown()),
    requiresApproval: z.boolean().optional(),
    readOnly: z.boolean().optional(),
    timeout: z.number().positive().optional(),
  }),
  z.object({ kind: z.literal('skill'), skill: z.record(z.string(), z.unknown()) }),
  z.object({
    kind: z.literal('agent'),
    name: z.string().min(1),
    definition: z.record(z.string(), z.unknown()),
  }),
  z.object({ kind: z.literal('command'), name: z.string().min(1), command: z.unknown() }),
  z.object({ kind: z.literal('hooks'), hooks: z.record(z.string(), z.unknown()) }),
  z.object({
    kind: z.literal('mcp'),
    name: z.string().min(1),
    config: z.record(z.string(), z.unknown()),
  }),
  z.object({
    kind: z.literal('llm'),
    provider: z.string().min(1),
    metadata: z.record(z.string(), z.unknown()),
  }),
  z.object({
    kind: z.literal('panel'),
    panel: z.record(z.string(), z.unknown()),
    methods: z.array(z.string()),
  }),
  z.object({ kind: z.literal('routine'), routine: z.record(z.string(), z.unknown()) }),
  z.object({
    kind: z.literal('trigger'),
    routineId: z.string().min(1),
    trigger: z.record(z.string(), z.unknown()),
  }),
]);

const RequestSchema = z.discriminatedUnion('op', [
  z.object({ op: z.literal('secret'), key: z.string() }),
  z.object({ op: z.literal('files.readFile'), path: z.string() }),
  z.object({ op: z.literal('files.writeFile'), path: z.string(), content: z.string() }),
  z.object({ op: z.literal('files.list'), path: z.string() }),
  z.object({
    op: z.literal('fetch'),
    url: z.string(),
    init: z
      .object({
        method: z.string().optional(),
        headers: z.record(z.string(), z.string()).optional(),
        body: z.string().optional(),
      })
      .optional(),
  }),
  z.object({
    op: z.literal('exec'),
    command: z.string(),
    options: z
      .object({ cwd: z.string().optional(), timeoutMs: z.number().positive().optional() })
      .optional(),
  }),
]);

const MessageSchema = z.discriminatedUnion('t', [
  z.object({ t: z.literal('ready') }),
  z.object({ t: z.literal('activated') }),
  z.object({ t: z.literal('activate-failed'), error: WireErrorSchema }),
  z.object({
    t: z.literal('register'),
    handle: z.number().int(),
    registration: RegistrationSchema,
  }),
  z.object({ t: z.literal('unregister'), handle: z.number().int() }),
  z.object({ t: z.literal('request'), id: z.number().int(), request: RequestSchema }),
  z.object({
    t: z.literal('log'),
    level: z.enum(['debug', 'info', 'warn', 'error']),
    message: z.string(),
    details: z.unknown().optional(),
  }),
  z.object({
    t: z.literal('result'),
    id: z.number().int(),
    ok: z.boolean(),
    value: z.unknown().optional(),
    error: WireErrorSchema.optional(),
  }),
  z.object({ t: z.literal('chunk'), id: z.number().int(), chunk: z.unknown() }),
  z.object({ t: z.literal('end'), id: z.number().int() }),
  z.object({ t: z.literal('disposed') }),
]);

const UsageSchema = z.looseObject({
  inputTokens: z.number(),
  outputTokens: z.number(),
  totalTokens: z.number(),
});

const ChatResponseSchema = z.looseObject({
  id: z.string(),
  content: z.string(),
  finishReason: z.string(),
  usage: UsageSchema,
  toolCalls: z.array(z.looseObject({ id: z.string(), name: z.string() })).optional(),
});

const ChunkSchema = z.looseObject({
  id: z.string(),
  delta: z.looseObject({ content: z.string().optional() }),
  usage: UsageSchema.optional(),
});

const SkillSchema = z.object({
  name: z.string(),
  description: z.string(),
  instructions: z.string(),
  files: z.record(z.string(), z.string()).optional(),
  allowedTools: z.array(z.string()).optional(),
});

const AgentSchema = z.object({
  description: z.string(),
  prompt: z.string().optional(),
  tools: z.array(z.string()).optional(),
  disallowedTools: z.array(z.string()).optional(),
  model: z.string().optional(),
  maxTurns: z.number().int().positive().optional(),
  skills: z.array(z.string()).optional(),
  memory: z.enum(['user', 'project', 'local']).optional(),
  background: z.boolean().optional(),
  isolation: z.literal('worktree').optional(),
  color: z.enum(['red', 'blue', 'green', 'yellow', 'purple', 'orange', 'pink', 'cyan']).optional(),
  effort: z.enum(['low', 'medium', 'high', 'xhigh', 'max']).optional(),
});

const CommandSchema = z.union([
  z.string(),
  z.object({
    template: z.string(),
    description: z.string().optional(),
    argumentHint: z.string().optional(),
    arguments: z.array(z.string()).optional(),
    allowedTools: z.array(z.string()).optional(),
    disallowedTools: z.array(z.string()).optional(),
    model: z.string().optional(),
    effort: z.enum(['low', 'medium', 'high', 'xhigh', 'max']).optional(),
  }),
]);

const PanelSchema = z.object({
  id: z.string(),
  title: z.string(),
  description: z.string().optional(),
  icon: z.string().optional(),
  html: z.string().optional(),
  entry: z.string().optional(),
});

function errorOf(wire: WireError, plugin: string): Error {
  const error = new Error(`${wire.message}`);
  error.name = wire.name;
  if (wire.code === ErrorCode.PLUGIN_PERMISSION_DENIED || wire.code === 'ERR_ACCESS_DENIED') {
    return new CogitatorError({
      message: wire.message,
      code: ErrorCode.PLUGIN_PERMISSION_DENIED,
      details: { plugin },
    });
  }
  return error;
}

function wireError(error: unknown): WireError {
  if (error instanceof CogitatorError) {
    return { name: error.name, message: error.message, code: error.code };
  }
  if (error instanceof Error) return { name: error.name, message: error.message };
  return { name: 'Error', message: String(error) };
}

/** Most entries of a plugin folder `linkOutside` walks before it gives up */
const MAX_CHECKED_ENTRIES = 100_000;

/**
 * The first link under `root` whose target is outside it: the permission model follows links, so
 * such a link would let the process read outside the folders it was given. A folder too large to
 * walk counts as one
 */
async function linkOutside(root: string): Promise<string | undefined> {
  let seen = 0;
  const walk = async (dir: string): Promise<string | undefined> => {
    const entries = await readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
      if (++seen > MAX_CHECKED_ENTRIES) return `more than ${MAX_CHECKED_ENTRIES} files to check`;
      const path = join(dir, entry.name);
      if (entry.isSymbolicLink()) {
        const target = await realpath(path).catch(() => undefined);
        if (target === undefined) continue;
        if (target !== root && !target.startsWith(`${root}${sep}`)) return path;
      } else if (entry.isDirectory()) {
        const found = await walk(path);
        if (found) return found;
      }
    }
    return undefined;
  };
  return walk(root);
}

/** Why `signal` aborted, as the error a cancelled call rejects with */
function abortReasonOf(signal: AbortSignal | undefined): Error {
  const reason: unknown = signal?.reason;
  return reason instanceof Error ? reason : new Error('Aborted');
}

interface PendingCall {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timer?: NodeJS.Timeout;
  onChunk?: (chunk: unknown) => void;
  onEnd?: () => void;
}

/** What starting an isolated plugin needs */
export interface IsolatedPluginOptions {
  identity: WireIdentity;
  /** The plugin's module, `main` of its manifest */
  entry: string;
  /** The option values that are not secrets */
  options: Record<string, unknown>;
  /** The host's context of the plugin, which every registration and request goes through */
  context: PluginContext;
  isolation?: PluginIsolationConfig;
  /** Called once when the process ends without being asked to */
  onExit: (error: Error) => void;
}

/** A running isolated plugin */
export class IsolatedPluginProcess {
  private nextCall = 0;
  private readonly pending = new Map<number, PendingCall>();
  private readonly registrations = new Map<number, PluginDisposer>();
  private disposing = false;
  private exited = false;
  /** Set once `activate` answered: a registration refused before fails the activation */
  private activated = false;
  private refused?: string;
  private readonly callTimeoutMs: number;

  private constructor(
    private readonly child: ChildProcess,
    private readonly options: IsolatedPluginOptions
  ) {
    this.callTimeoutMs = options.isolation?.callTimeoutMs ?? DEFAULT_CALL_TIMEOUT_MS;
  }

  /** Starts the process and activates the plugin in it, throwing when either fails */
  static async start(options: IsolatedPluginOptions): Promise<IsolatedPluginProcess> {
    const { identity } = options;
    const escape = await linkOutside(identity.root);
    if (escape) {
      throw new CogitatorError({
        message: `The plugin folder holds a link that leads outside it (${escape}), which its process could read through: remove it`,
        code: ErrorCode.PLUGIN_INVALID,
      });
    }
    const loader = realpathSync(childFile());
    const execArgv = [
      permissionFlag(),
      `--allow-fs-read=${loader}`,
      `--allow-fs-read=${identity.root}`,
      `--allow-fs-read=${identity.dataDir}`,
      `--allow-fs-write=${identity.dataDir}`,
      `--max-old-space-size=${options.isolation?.maxHeapMb ?? DEFAULT_MAX_HEAP_MB}`,
    ];
    const child = fork(loader, [], {
      cwd: identity.dataDir,
      execArgv,
      serialization: 'advanced',
      stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
      env: { NODE_ENV: process.env.NODE_ENV ?? 'production', PATH: '' },
    });
    const isolated = new IsolatedPluginProcess(child, options);
    await isolated.activate();
    return isolated;
  }

  private activate(): Promise<void> {
    const { child, options } = this;
    const timeoutMs = options.isolation?.activateTimeoutMs ?? DEFAULT_ACTIVATE_TIMEOUT_MS;
    return new Promise<void>((resolve, reject) => {
      let settled = false;
      const settle = (error?: Error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (error) {
          this.kill();
          reject(error);
        } else resolve();
      };
      const timer = setTimeout(
        () =>
          settle(
            new CogitatorError({
              message: `Plugin ${options.identity.id} did not activate within ${timeoutMs} ms`,
              code: ErrorCode.PLUGIN_ACTIVATION_FAILED,
            })
          ),
        timeoutMs
      );
      this.forward(child.stdout, 'info');
      this.forward(child.stderr, 'warn');
      child.on('message', (raw: unknown) => {
        const parsed = MessageSchema.safeParse(raw);
        if (!parsed.success) {
          options.context.logger.warn(
            'The plugin process sent a message the host does not read, it is ignored'
          );
          return;
        }
        const message = parsed.data as ProcessMessage;
        if (message.t === 'ready') {
          this.send({
            t: 'activate',
            identity: options.identity,
            entry: options.entry,
            options: options.options,
          });
        } else if (message.t === 'activated') {
          if (this.refused !== undefined) {
            settle(
              new CogitatorError({
                message: `Plugin ${options.identity.id} failed to activate: a registration was refused: ${this.refused}`,
                code: ErrorCode.PLUGIN_ACTIVATION_FAILED,
              })
            );
            return;
          }
          this.activated = true;
          settle();
        } else if (message.t === 'activate-failed') {
          settle(
            new CogitatorError({
              message: `Plugin ${options.identity.id} failed to activate: ${message.error.message}`,
              code:
                message.error.code === ErrorCode.PLUGIN_PERMISSION_DENIED ||
                message.error.code === 'ERR_ACCESS_DENIED'
                  ? ErrorCode.PLUGIN_PERMISSION_DENIED
                  : ErrorCode.PLUGIN_ACTIVATION_FAILED,
            })
          );
        } else {
          this.handle(message);
        }
      });
      child.on('error', (error) => settle(error));
      child.on('exit', (code, signal) => {
        this.exited = true;
        const error = new CogitatorError({
          message: `The process of plugin ${options.identity.id} exited (${signal ?? `code ${String(code)}`})`,
          code: ErrorCode.PLUGIN_ACTIVATION_FAILED,
        });
        for (const [, call] of this.pending) {
          clearTimeout(call.timer);
          call.reject(error);
        }
        this.pending.clear();
        if (!settled) settle(error);
        else if (!this.disposing) options.onExit(error);
      });
    });
  }

  private forward(stream: NodeJS.ReadableStream | null, level: 'info' | 'warn'): void {
    stream?.setEncoding?.('utf8');
    stream?.on('data', (text: string) => {
      for (const line of text.split('\n')) {
        if (line.trim() !== '') this.options.context.logger[level](line.slice(0, MAX_LOG_LINE));
      }
    });
  }

  private send(message: HostMessage): void {
    if (this.exited || !this.child.connected) return;
    this.child.send(message);
  }

  private handle(message: ProcessMessage): void {
    const { context } = this.options;
    switch (message.t) {
      case 'register': {
        try {
          const dispose = this.register(message.handle, message.registration);
          this.registrations.set(message.handle, dispose);
        } catch (error) {
          const text = error instanceof Error ? error.message : String(error);
          if (!this.activated) this.refused ??= text;
          else context.logger.error(`A registration of the plugin was refused: ${text}`);
        }
        return;
      }
      case 'unregister': {
        const dispose = this.registrations.get(message.handle);
        this.registrations.delete(message.handle);
        void Promise.resolve(dispose?.()).catch(() => undefined);
        return;
      }
      case 'request':
        void this.answer(message.id, message.request);
        return;
      case 'log':
        context.logger[message.level](message.message.slice(0, MAX_LOG_LINE));
        return;
      case 'result': {
        const call = this.pending.get(message.id);
        if (!call) return;
        this.pending.delete(message.id);
        clearTimeout(call.timer);
        if (message.ok) call.resolve(message.value);
        else {
          call.reject(
            errorOf(
              message.error ?? { name: 'Error', message: 'The plugin call failed' },
              this.options.identity.id
            )
          );
        }
        return;
      }
      case 'chunk':
        this.pending.get(message.id)?.onChunk?.(message.chunk);
        return;
      case 'end': {
        const call = this.pending.get(message.id);
        this.pending.delete(message.id);
        if (call) {
          clearTimeout(call.timer);
          call.onEnd?.();
        }
        return;
      }
      default:
        return;
    }
  }

  private async answer(id: number, request: z.infer<typeof RequestSchema>): Promise<void> {
    const { context } = this.options;
    try {
      let value: unknown;
      switch (request.op) {
        case 'secret':
          value = await context.secret(request.key);
          break;
        case 'files.readFile':
          value = await context.files.readFile(request.path);
          break;
        case 'files.writeFile':
          await context.files.writeFile(request.path, request.content);
          break;
        case 'files.list':
          value = await context.files.list(request.path);
          break;
        case 'fetch':
          value = await context.fetch(request.url, request.init);
          break;
        case 'exec':
          value = await context.exec(request.command, request.options);
          break;
      }
      this.send({ t: 'reply', id, ok: true, value });
    } catch (error) {
      this.send({ t: 'reply', id, ok: false, error: wireError(error) });
    }
  }

  /** Calls into the process, cancelled with `signal`, timed out after `timeoutMs` */
  private call(
    message:
      | Omit<Extract<HostMessage, { t: 'call' }>, 'id'>
      | Omit<Extract<HostMessage, { t: 'llm.create' }>, 'id'>,
    signal?: AbortSignal,
    timeoutMs = this.callTimeoutMs
  ): Promise<unknown> {
    if (this.exited) return Promise.reject(this.notRunning());
    if (signal?.aborted) return Promise.reject(abortReasonOf(signal));
    const id = ++this.nextCall;
    return new Promise((resolve, reject) => {
      const onAbort = () => {
        if (!this.pending.delete(id)) return;
        clearTimeout(call.timer);
        this.send({ t: 'cancel', id });
        call.reject(abortReasonOf(signal));
      };
      const done = () => signal?.removeEventListener('abort', onAbort);
      const call: PendingCall = {
        resolve: (value) => {
          done();
          resolve(value);
        },
        reject: (error) => {
          done();
          reject(error);
        },
      };
      call.timer = setTimeout(() => {
        this.pending.delete(id);
        this.send({ t: 'cancel', id });
        call.reject(this.timeoutError(timeoutMs));
      }, timeoutMs);
      this.pending.set(id, call);
      signal?.addEventListener('abort', onAbort, { once: true });
      this.send({ ...message, id } as HostMessage);
    });
  }

  private notRunning(): Error {
    return new CogitatorError({
      message: `The process of plugin ${this.options.identity.id} is not running`,
      code: ErrorCode.PLUGIN_ACTIVATION_FAILED,
    });
  }

  private timeoutError(timeoutMs: number): Error {
    return new CogitatorError({
      message: `Plugin ${this.options.identity.id} did not answer within ${timeoutMs} ms`,
      code: ErrorCode.TOOL_TIMEOUT,
    });
  }

  private register(
    handle: number,
    registration: z.infer<typeof RegistrationSchema>
  ): PluginDisposer {
    const { context } = this.options;
    switch (registration.kind) {
      case 'tool':
        return context.registerTool({
          name: registration.name,
          description: registration.description,
          parameters: registration.parameters,
          ...(registration.requiresApproval !== undefined && {
            requiresApproval: registration.requiresApproval,
          }),
          ...(registration.readOnly !== undefined && { readOnly: registration.readOnly }),
          ...(registration.timeout !== undefined && { timeout: registration.timeout }),
          execute: (args: Record<string, unknown>, call: PluginToolCallContext) =>
            this.call(
              {
                t: 'call',
                target: { kind: 'tool', handle },
                payload: args,
                context: {
                  ...(call.runId !== undefined && { runId: call.runId }),
                  ...(call.toolCallId !== undefined && { toolCallId: call.toolCallId }),
                  ...(call.threadId !== undefined && { threadId: call.threadId }),
                },
              },
              call.signal,
              registration.timeout ?? this.callTimeoutMs
            ),
        });
      case 'skill':
        return context.registerSkill(SkillSchema.parse(registration.skill));
      case 'agent':
        return context.registerAgent(
          registration.name,
          AgentSchema.parse(registration.definition) as SubagentDefinitionInput
        );
      case 'command':
        return context.registerCommand(
          registration.name,
          CommandSchema.parse(registration.command) as string | CommandDefinitionInput
        );
      case 'hooks':
        return context.registerHooks(registration.hooks);
      case 'mcp':
        return context.registerMcpServer(registration.name, registration.config);
      case 'llm':
        return context.registerLLMBackend({
          provider: registration.provider,
          metadata: {
            name:
              typeof registration.metadata.name === 'string'
                ? registration.metadata.name
                : registration.provider,
            ...(typeof registration.metadata.version === 'string' && {
              version: registration.metadata.version,
            }),
            ...(typeof registration.metadata.description === 'string' && {
              description: registration.metadata.description,
            }),
          },
          factory: (config: unknown) => this.backend(handle, registration.provider, config),
        });
      case 'routine':
        return context.registerRoutine(RoutineSchema.parse(registration.routine));
      case 'trigger':
        return context.registerTrigger(
          registration.routineId,
          TriggerSpecSchema.parse(registration.trigger)
        );
      case 'panel': {
        const spec = PanelSchema.parse(registration.panel);
        return context.registerPanel({
          ...spec,
          handlers: Object.fromEntries(
            registration.methods.map((method) => [
              method,
              (params: unknown) =>
                this.call({
                  t: 'call',
                  target: { kind: 'panel', handle, method },
                  payload: params,
                }),
            ])
          ),
        });
      }
    }
  }

  /** A backend whose calls go to the process: created there on its first call */
  private backend(handle: number, provider: string, config: unknown): LLMBackend {
    let created: Promise<number> | undefined;
    const backendId = (): Promise<number> => {
      created ??= this.call({ t: 'llm.create', handle, config }).then((id) => {
        if (typeof id !== 'number') throw new Error('The plugin did not create its backend');
        return id;
      });
      return created;
    };
    const strip = (request: ChatRequest): Omit<ChatRequest, 'signal'> => {
      const { signal: _signal, ...rest } = request;
      return rest;
    };
    const response = (value: unknown): ChatResponse => {
      const parsed = ChatResponseSchema.safeParse(value);
      if (!parsed.success) {
        throw new CogitatorError({
          message: `The backend of plugin ${this.options.identity.id} answered with something that is not a chat response`,
          code: ErrorCode.LLM_INVALID_RESPONSE,
        });
      }
      return parsed.data as unknown as ChatResponse;
    };
    return {
      provider,
      chat: async (request) => {
        const backend = await backendId();
        return response(
          await this.call(
            {
              t: 'call',
              target: { kind: 'llm', handle, backend, op: 'chat' },
              payload: strip(request),
            },
            request.signal
          )
        );
      },
      complete: async (request) => {
        const backend = await backendId();
        return response(
          await this.call(
            {
              t: 'call',
              target: { kind: 'llm', handle, backend, op: 'complete' },
              payload: { ...request, signal: undefined },
            },
            request.signal
          )
        );
      },
      chatStream: (request) => this.streamOf(handle, backendId, strip(request), request.signal),
    };
  }

  private async *streamOf(
    handle: number,
    backendId: () => Promise<number>,
    request: Omit<ChatRequest, 'signal'>,
    signal: AbortSignal | undefined
  ): AsyncGenerator<ChatStreamChunk> {
    yield* this.stream(handle, await backendId(), request, signal);
  }

  private async *stream(
    handle: number,
    backend: number,
    request: Omit<ChatRequest, 'signal'>,
    signal: AbortSignal | undefined
  ): AsyncGenerator<ChatStreamChunk> {
    if (signal?.aborted) throw abortReasonOf(signal);
    const id = ++this.nextCall;
    const queue: ChatStreamChunk[] = [];
    let finished = false;
    let failure: Error | undefined;
    let wake: (() => void) | undefined;
    const notify = () => {
      wake?.();
      wake = undefined;
    };
    const timeoutMs = this.callTimeoutMs;
    const call: PendingCall = {
      resolve: () => {
        finished = true;
        notify();
      },
      reject: (error) => {
        failure = error;
        finished = true;
        notify();
      },
      onChunk: (chunk) => {
        const parsed = ChunkSchema.safeParse(chunk);
        if (parsed.success) queue.push(parsed.data as unknown as ChatStreamChunk);
        idle();
        notify();
      },
      onEnd: () => {
        finished = true;
        notify();
      },
    };
    const idle = () => {
      clearTimeout(call.timer);
      call.timer = setTimeout(() => {
        if (!this.pending.delete(id)) return;
        this.send({ t: 'cancel', id });
        call.reject(this.timeoutError(timeoutMs));
      }, timeoutMs);
    };
    const onAbort = () => {
      if (!this.pending.delete(id)) return;
      clearTimeout(call.timer);
      this.send({ t: 'cancel', id });
      call.reject(abortReasonOf(signal));
    };
    signal?.addEventListener('abort', onAbort, { once: true });
    this.pending.set(id, call);
    idle();
    this.send({ t: 'stream', id, handle, backend, request });
    try {
      for (;;) {
        while (queue.length > 0) yield queue.shift()!;
        if (failure) throw failure;
        if (finished) return;
        await new Promise<void>((resolve) => {
          wake = resolve;
        });
      }
    } finally {
      clearTimeout(call.timer);
      signal?.removeEventListener('abort', onAbort);
      if (this.pending.delete(id)) this.send({ t: 'cancel', id });
    }
  }

  private kill(): void {
    if (this.exited) return;
    try {
      this.child.kill('SIGKILL');
    } catch {
      return;
    }
  }

  /**
   * Unloads the plugin: its own disposers run in its process, its registrations here are undone,
   * and the process is stopped, killed if it does not exit in time
   */
  async dispose(): Promise<void> {
    if (this.disposing) return;
    this.disposing = true;
    if (!this.exited) {
      await new Promise<void>((resolve) => {
        const timer = setTimeout(() => {
          this.kill();
          resolve();
        }, DISPOSE_GRACE_MS);
        this.child.once('exit', () => {
          clearTimeout(timer);
          resolve();
        });
        this.send({ t: 'dispose' });
      });
    }
    for (const dispose of [...this.registrations.values()].reverse()) {
      try {
        await dispose();
      } catch {
        continue;
      }
    }
    this.registrations.clear();
  }
}
