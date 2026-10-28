import { spawn, type ChildProcess } from 'node:child_process';
import { resolve } from 'node:path';
import {
  PROTOCOL_VERSION,
  RequestError,
  client as createClientApp,
  type AgentApp,
  type AvailableCommand,
  type ClientApp,
  type ClientCapabilities,
  type ClientConnection,
  type ContentBlock,
  type InitializeResponse,
  type McpServer,
  type PermissionOption,
  type RequestPermissionRequest,
  type RequestPermissionResponse,
  type SessionConfigOption,
  type SessionModeState,
  type SessionUpdate,
} from '@agentclientprotocol/sdk';
import type {
  SessionProvider,
  SessionProviderResult,
  SessionProviderTurn,
  UserInput,
} from '@cogitator-ai/app-server';
import {
  WorkspaceError,
  type PermissionMode,
  type ToolApprovalRequest,
  type Workspace,
} from '@cogitator-ai/types';
import {
  AcpPermissions,
  commandLine,
  subjectOf,
  type AcpCallSubject,
  type AcpPermissionOptions,
} from './permissions.js';
import { nodeNdJsonStream } from '../agent/stdio.js';
import { AcpTerminals } from './terminals.js';
import { AcpStreamMapper } from './updates.js';

/** An external ACP agent: a command to launch, or an agent app in this process */
export type AcpAgentTarget =
  | {
      command: string;
      args?: readonly string[];
      env?: Readonly<Record<string, string>>;
    }
  | { app: AgentApp };

export interface AcpAgentProviderOptions {
  /** The agent: a command the provider launches (an ACP agent on stdio), or an app in this process */
  agent: AcpAgentTarget;
  /**
   * The workspace the agent works in: sessions start in its current directory, and the files and
   * terminals the agent asks the editor for are served from it, inside its root
   */
  workspace: Workspace;
  /** A name for the agent in permission rules, `acp__<name>__<tool>` for its own tools (default `agent`) */
  name?: string;
  description?: string;
  /** The model the agent runs, when known, for clients to show */
  model?: string;
  /** How the runtime's permission engine decides what the agent asks to do */
  permissions?: AcpPermissionOptions;
  /** MCP servers every session of the agent connects to */
  mcpServers?: readonly McpServer[];
  /** The auth method to authenticate with once initialized, when the agent asks for one */
  authMethodId?: string;
  /** What the provider says of itself in `initialize` */
  clientInfo?: { name: string; version: string };
  /** Milliseconds a command the agent runs in a terminal may take (default 30 minutes) */
  terminalTimeout?: number;
  /** Hears what the launched agent writes to stderr */
  onStderr?: (chunk: string) => void;
  /** Hears what went wrong outside a turn, such as the agent exiting */
  onError?: (error: Error) => void;
}

/** The thread metadata key the provider keeps the agent's session id under */
export const ACP_AGENT_SESSION_KEY = 'acp.agentSessionId';

interface Connected {
  connection: ClientConnection;
  child?: ChildProcess;
  init: InitializeResponse;
  sessions: Set<string>;
  closed: boolean;
}

interface SessionState {
  modes?: SessionModeState | null;
  configOptions?: SessionConfigOption[] | null;
  commands?: AvailableCommand[];
}

interface ActiveTurn {
  turn: SessionProviderTurn;
  mapper: AcpStreamMapper;
  edits: Set<string>;
  commands: Set<string>;
}

/** The error a file or terminal request of the agent gets when the permissions refuse it */
function permissionRefused(what: string): RequestError {
  return RequestError.invalidRequest(
    { reason: 'permission_denied' },
    `Permission denied: ${what} (the permission rules or the user refused it)`
  );
}

/**
 * An external ACP agent (Claude Code, Codex, Gemini CLI and any other of the registry) as a
 * session provider of an app-server host, next to the runtime's own agents: each thread is a
 * session of the agent, each turn a prompt, and its `session/update` stream reaches app-server
 * clients as the events of the turn. Every `session/request_permission` of the agent is decided
 * by the runtime's permission engine (rules, settings files and the thread's mode), asking the
 * client of the turn only when the engine says to ask. The files and terminals the agent asks
 * for are served from the provider's workspace, checked by the same engine.
 *
 * The agent is launched with the first turn and again after it exits. Close the provider when
 * done: it stops the agent and its commands
 */
export class AcpAgentProvider implements SessionProvider {
  readonly description?: string;
  readonly model?: string;
  private connecting: Promise<Connected> | undefined;
  private readonly active = new Map<string, ActiveTurn>();
  private readonly loading = new Set<string>();
  private readonly states = new Map<string, SessionState>();
  private readonly permissions: AcpPermissions;
  private readonly terminals: AcpTerminals;
  private readonly name: string;

  constructor(private readonly options: AcpAgentProviderOptions) {
    if (options.description !== undefined) this.description = options.description;
    if (options.model !== undefined) this.model = options.model;
    this.name = options.name ?? 'agent';
    this.permissions = new AcpPermissions(options.workspace, options.permissions);
    this.terminals = new AcpTerminals(options.workspace, options.terminalTimeout);
  }

  /** What the agent answered to `initialize`, launching it when it is not running */
  async connect(): Promise<InitializeResponse> {
    return (await this.connection()).init;
  }

  /** The commands the agent offers in the session of thread metadata `metadata`, as it last said */
  commandsOf(sessionId: string): readonly AvailableCommand[] {
    return this.states.get(sessionId)?.commands ?? [];
  }

  async runTurn(turn: SessionProviderTurn): Promise<SessionProviderResult> {
    const connected = await this.connection();
    const sessionId = await this.sessionFor(turn, connected);
    if (this.active.has(sessionId)) {
      throw new Error(`A turn of the agent's session ${sessionId} goes on already`);
    }
    const mapper = new AcpStreamMapper((event) => turn.emit(event));
    this.active.set(sessionId, { turn, mapper, edits: new Set(), commands: new Set() });
    const cancel = () => {
      void connected.connection.agent
        .notify('session/cancel', { sessionId })
        .catch(() => undefined);
    };
    turn.signal.addEventListener('abort', cancel, { once: true });
    try {
      await this.align(connected, sessionId, turn);
      const response = await connected.connection.agent.request('session/prompt', {
        sessionId,
        prompt: this.promptOf(turn.input, connected.init),
      });
      mapper.end();
      if (response.stopReason === 'cancelled' && turn.signal.aborted) {
        throw new Error('The turn was cancelled');
      }
      return {
        output: mapper.output,
        ...(response.stopReason === 'max_tokens' && { truncated: true }),
        ...(response.stopReason === 'refusal' && { refused: true }),
      };
    } catch (error) {
      mapper.end();
      throw describe(error);
    } finally {
      turn.signal.removeEventListener('abort', cancel);
      this.active.delete(sessionId);
      await this.terminals.releaseAll(sessionId);
    }
  }

  /** Stops the agent and every command it runs */
  async close(): Promise<void> {
    const connecting = this.connecting;
    this.connecting = undefined;
    await this.terminals.releaseAll();
    if (!connecting) return;
    const connected = await connecting.catch(() => undefined);
    if (connected) shutdown(connected);
  }

  private connection(): Promise<Connected> {
    const current = this.connecting;
    if (current) {
      return current.then((connected) => {
        if (!connected.closed) return connected;
        if (this.connecting === current) this.connecting = undefined;
        return this.connection();
      });
    }
    const started = this.start();
    this.connecting = started;
    started.catch(() => {
      if (this.connecting === started) this.connecting = undefined;
    });
    return started;
  }

  private async start(): Promise<Connected> {
    const app = this.clientApp();
    const target = this.options.agent;
    let child: ChildProcess | undefined;
    let connection: ClientConnection;
    if ('app' in target) {
      connection = app.connect(target.app);
    } else {
      child = spawn(target.command, [...(target.args ?? [])], {
        cwd: resolve(this.options.workspace.root, this.options.workspace.cwd),
        env: { ...process.env, ...target.env },
        stdio: ['pipe', 'pipe', 'pipe'],
      });
      const spawned = child;
      await new Promise<void>((done, fail) => {
        spawned.once('spawn', () => done());
        spawned.once('error', (error) =>
          fail(new Error(`Could not launch the ACP agent ${target.command}: ${error.message}`))
        );
      });
      spawned.stderr?.on('data', (chunk: Buffer) => this.options.onStderr?.(chunk.toString()));
      connection = app.connect(nodeNdJsonStream(spawned.stdin!, spawned.stdout!));
    }
    const connected: Connected = {
      connection,
      ...(child && { child }),
      init: { protocolVersion: PROTOCOL_VERSION },
      sessions: new Set(),
      closed: false,
    };
    const lost = () => {
      if (connected.closed) return;
      connected.closed = true;
      connection.close();
    };
    child?.once('exit', (code, signal) => {
      if (!connected.closed) {
        this.options.onError?.(
          new Error(`The ACP agent exited (${signal ?? `code ${String(code)}`})`)
        );
      }
      lost();
    });
    void connection.closed.then(lost, lost);
    try {
      connected.init = await connection.agent.request('initialize', {
        protocolVersion: PROTOCOL_VERSION,
        clientCapabilities: CLIENT_CAPABILITIES,
        clientInfo: this.options.clientInfo ?? { name: 'cogitator', version: '0.1.0' },
      });
      const method = this.options.authMethodId;
      if (method !== undefined && (connected.init.authMethods ?? []).some((m) => m.id === method)) {
        await connection.agent.request('authenticate', { methodId: method });
      }
    } catch (error) {
      shutdown(connected);
      throw describe(error);
    }
    return connected;
  }

  private clientApp(): ClientApp {
    return createClientApp({ name: 'cogitator' })
      .onNotification('session/update', ({ params }) => {
        this.onUpdate(params.sessionId, params.update);
      })
      .onRequest('session/request_permission', ({ params }) => this.onPermission(params))
      .onRequest('fs/read_text_file', async ({ params }) => {
        await this.check(
          params.sessionId,
          subjectOf({ kind: 'read', locations: [{ path: params.path }] }, this.name, this.root),
          `read ${params.path}`
        );
        const text = await this.options.workspace.read(params.path).catch(fsError);
        return { content: sliceLines(text, params.line ?? undefined, params.limit ?? undefined) };
      })
      .onRequest('fs/write_text_file', async ({ params }) => {
        const path = resolve(this.root, params.path);
        if (!this.active.get(params.sessionId)?.edits.has(path)) {
          await this.check(
            params.sessionId,
            subjectOf({ kind: 'edit', locations: [{ path }] }, this.name, this.root),
            `write ${params.path}`
          );
        }
        await this.options.workspace.write(params.path, params.content).catch(fsError);
        return {};
      })
      .onRequest('terminal/create', async ({ params }) => {
        const line = commandLine(params.command, params.args ?? []);
        if (!this.active.get(params.sessionId)?.commands.has(line)) {
          await this.check(
            params.sessionId,
            subjectOf({ kind: 'execute', rawInput: { command: line } }, this.name, this.root),
            `run ${line}`
          );
        }
        return { terminalId: this.terminals.create(params, line) };
      })
      .onRequest('terminal/output', ({ params }) =>
        this.terminals.output(params.sessionId, params.terminalId)
      )
      .onRequest('terminal/wait_for_exit', ({ params }) =>
        this.terminals.waitForExit(params.sessionId, params.terminalId)
      )
      .onRequest('terminal/kill', ({ params }) => {
        this.terminals.kill(params.sessionId, params.terminalId);
        return {};
      })
      .onRequest('terminal/release', ({ params }) => {
        this.terminals.release(params.sessionId, params.terminalId);
        return {};
      });
  }

  private get root(): string {
    return resolve(this.options.workspace.root, this.options.workspace.cwd);
  }

  private onUpdate(sessionId: string, update: SessionUpdate): void {
    const state = this.states.get(sessionId) ?? {};
    this.states.set(sessionId, state);
    switch (update.sessionUpdate) {
      case 'available_commands_update':
        state.commands = update.availableCommands;
        return;
      case 'current_mode_update':
        if (state.modes) state.modes = { ...state.modes, currentModeId: update.currentModeId };
        return;
      case 'config_option_update':
        state.configOptions = update.configOptions;
        return;
      default:
        break;
    }
    if (this.loading.has(sessionId)) return;
    this.active.get(sessionId)?.mapper.update(update);
  }

  /** Decides a request of the agent the editor would ask about, with the engine and the turn's client */
  private async onPermission(params: RequestPermissionRequest): Promise<RequestPermissionResponse> {
    const active = this.active.get(params.sessionId);
    const subject = subjectOf(params.toolCall, this.name, this.root);
    const allowed = await this.allowed(params.sessionId, subject, {
      toolCallId: params.toolCall.toolCallId,
      description: params.toolCall.title ?? subject.tool.name,
      rawInput: params.toolCall.rawInput,
    });
    if (allowed && active) {
      if (subject.tool.name === 'edit_file') {
        for (const path of subject.args.paths as string[]) active.edits.add(path);
      }
      if (subject.tool.name === 'run_command') active.commands.add(subject.args.command as string);
    }
    const option = pick(params.options, allowed);
    return option
      ? { outcome: { outcome: 'selected', optionId: option.optionId } }
      : { outcome: { outcome: 'cancelled' } };
  }

  /** Refuses a file or terminal request the engine does not allow */
  private async check(sessionId: string, subject: AcpCallSubject, what: string): Promise<void> {
    if (!(await this.allowed(sessionId, subject, { description: what }))) {
      throw permissionRefused(what);
    }
  }

  /**
   * Whether a call runs: the engine allows or refuses it in the turn's mode, and when it would
   * ask, the client of the turn answers (an "always" answer saving a rule). Without a turn or a
   * client to ask, what would ask is refused
   */
  private async allowed(
    sessionId: string,
    subject: AcpCallSubject,
    call: { toolCallId?: string; description: string; rawInput?: unknown }
  ): Promise<boolean> {
    const active = this.active.get(sessionId);
    const threadId = active?.turn.threadId ?? sessionId;
    const mode: PermissionMode = active?.turn.permissionMode() ?? 'default';
    const decision = await this.permissions.decide(subject, mode, threadId);
    if (decision.decision !== 'ask') return decision.decision === 'allow';
    const ask = active?.turn.onApproval;
    if (!ask || active.turn.signal.aborted) return false;
    const suggestedRule = this.permissions.suggest(subject);
    const request: ToolApprovalRequest = {
      toolCallId: call.toolCallId ?? `acp_${Date.now().toString(36)}`,
      toolName: subject.tool.name,
      arguments:
        call.rawInput !== null && typeof call.rawInput === 'object' && !Array.isArray(call.rawInput)
          ? (call.rawInput as Record<string, unknown>)
          : subject.args,
      description: call.description,
      threadId,
      reason: decision.reason,
      ...(decision.rule && { rule: decision.rule }),
      ...(suggestedRule !== undefined && { suggestedRule }),
      mode,
    };
    const answer = await ask(request).catch(() => 'pause' as const);
    if (answer === 'pause') return false;
    if (answer.remember) {
      await this.permissions
        .remember(subject, answer.approved ? 'allow' : 'deny', threadId)
        .catch((error: unknown) => this.report(error));
    }
    return answer.approved;
  }

  /** The agent's session of the turn's thread: the one it keeps, resumed or loaded, else a new one */
  private async sessionFor(turn: SessionProviderTurn, connected: Connected): Promise<string> {
    const agent = connected.connection.agent;
    const cwd = this.root;
    const mcpServers = [...(this.options.mcpServers ?? [])];
    const kept = turn.metadata[ACP_AGENT_SESSION_KEY];
    if (typeof kept === 'string') {
      if (connected.sessions.has(kept)) return kept;
      const capabilities = connected.init.agentCapabilities;
      try {
        if (capabilities?.sessionCapabilities?.resume) {
          const resumed = await agent.request('session/resume', {
            sessionId: kept,
            cwd,
            mcpServers,
          });
          this.keep(kept, resumed);
          connected.sessions.add(kept);
          return kept;
        }
        if (capabilities?.loadSession) {
          this.loading.add(kept);
          try {
            const loaded = await agent.request('session/load', {
              sessionId: kept,
              cwd,
              mcpServers,
            });
            this.keep(kept, loaded ?? {});
          } finally {
            this.loading.delete(kept);
          }
          connected.sessions.add(kept);
          return kept;
        }
      } catch (error) {
        this.report(error);
      }
    }
    const created = await agent.request('session/new', { cwd, mcpServers });
    this.keep(created.sessionId, created);
    connected.sessions.add(created.sessionId);
    await turn.saveMetadata({ [ACP_AGENT_SESSION_KEY]: created.sessionId });
    return created.sessionId;
  }

  private keep(
    sessionId: string,
    response: { modes?: SessionModeState | null; configOptions?: SessionConfigOption[] | null }
  ): void {
    const state = this.states.get(sessionId) ?? {};
    if (response.modes !== undefined) state.modes = response.modes;
    if (response.configOptions !== undefined) state.configOptions = response.configOptions;
    this.states.set(sessionId, state);
  }

  /**
   * Puts the agent's session in the turn's mode, when the agent has a mode of that name (the
   * modes of Claude Code are those of the runtime), and on the turn's model, when the agent
   * offers it
   */
  private async align(
    connected: Connected,
    sessionId: string,
    turn: SessionProviderTurn
  ): Promise<void> {
    const agent = connected.connection.agent;
    const state = this.states.get(sessionId);
    const mode = turn.permissionMode();
    if (
      state?.modes &&
      state.modes.currentModeId !== mode &&
      state.modes.availableModes.some((candidate) => candidate.id === mode)
    ) {
      await agent.request('session/set_mode', { sessionId, modeId: mode });
      state.modes = { ...state.modes, currentModeId: mode };
    }
    const model = turn.model;
    const selector = state?.configOptions?.find(
      (option) => option.category === 'model' && option.type === 'select'
    );
    if (model !== undefined && selector?.type === 'select' && selector.currentValue !== model) {
      const values = selector.options.flatMap((entry) =>
        'group' in entry ? entry.options.map((option) => option.value) : [entry.value]
      );
      if (values.includes(model)) {
        const answer = await agent.request('session/set_config_option', {
          sessionId,
          configId: selector.id,
          value: model,
        });
        if (state) state.configOptions = answer.configOptions;
      }
    }
  }

  private promptOf(input: readonly UserInput[], init: InitializeResponse): ContentBlock[] {
    const images = init.agentCapabilities?.promptCapabilities?.image === true;
    return input.map((part): ContentBlock => {
      if (part.type === 'text') return { type: 'text', text: part.text };
      if ('url' in part) return { type: 'resource_link', uri: part.url, name: 'image' };
      return images
        ? { type: 'image', data: part.data, mimeType: part.mimeType }
        : { type: 'text', text: '[An image the agent cannot take was left out]' };
    });
  }

  private report(error: unknown): void {
    this.options.onError?.(error instanceof Error ? error : new Error(String(error)));
  }
}

/** What the provider serves the agents it launches */
const CLIENT_CAPABILITIES: ClientCapabilities = {
  fs: { readTextFile: true, writeTextFile: true },
  terminal: true,
};

/** The option of a permission question that says yes, or no: once when it can */
function pick(options: readonly PermissionOption[], allow: boolean): PermissionOption | undefined {
  const order = allow ? ['allow_once', 'allow_always'] : ['reject_once', 'reject_always'];
  for (const kind of order) {
    const option = options.find((candidate) => candidate.kind === kind);
    if (option) return option;
  }
  return undefined;
}

/** `limit` lines of `text` from line `line` (1-based), all of it by default */
export function sliceLines(text: string, line?: number, limit?: number): string {
  if (line === undefined && limit === undefined) return text;
  const lines = text.split('\n');
  const start = Math.max((line ?? 1) - 1, 0);
  return lines.slice(start, limit === undefined ? undefined : start + limit).join('\n');
}

/** A workspace error as the agent reads it: a missing file as not found, the rest with its reason */
function fsError(error: unknown): never {
  if (WorkspaceError.is(error, 'NOT_FOUND')) throw RequestError.resourceNotFound(error.path);
  if (WorkspaceError.is(error)) {
    throw RequestError.invalidRequest({ code: error.code }, error.message);
  }
  throw error;
}

function shutdown(connected: Connected): void {
  connected.closed = true;
  connected.connection.close();
  const child = connected.child;
  if (child?.exitCode !== null) return;
  child.stdin?.end();
  const timer = setTimeout(() => child.kill('SIGKILL'), 2000);
  timer.unref();
  child.once('exit', () => clearTimeout(timer));
  child.kill('SIGTERM');
}

function describe(error: unknown): Error {
  if (error instanceof RequestError) {
    if (error.code === -32000) {
      return new Error(`The ACP agent needs authentication: ${error.message}`, { cause: error });
    }
    return new Error(`The ACP agent answered with an error: ${error.message}`, { cause: error });
  }
  return error instanceof Error ? error : new Error(String(error));
}
