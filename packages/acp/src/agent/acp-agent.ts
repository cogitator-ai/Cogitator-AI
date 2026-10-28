import { isAbsolute, relative, resolve } from 'node:path';
import {
  PROTOCOL_VERSION,
  RequestError,
  agent as createAgentApp,
  type AgentApp,
  type AgentContext,
  type AuthMethod,
  type ClientCapabilities,
  type ContentBlock,
  type ElicitationSchema,
  type InitializeResponse,
  type McpServer,
  type PermissionOption,
  type PromptResponse,
  type SessionConfigOption,
  type SessionInfo,
  type SessionModeState,
  type StopReason,
} from '@agentclientprotocol/sdk';
import type {
  ApprovalAsk,
  AppServerNotification,
  SessionHost,
  ThreadInfo,
  TurnInfo,
  TurnPending,
  TurnRunOptions,
  TurnStartParams,
  UserInput,
} from '@cogitator-ai/app-server';
import { LocalWorkspace, type Agent, type Cogitator } from '@cogitator-ai/core';
import type { PendingInterrupt } from '@cogitator-ai/server-shared';
import type {
  PermissionMode,
  RunMiddleware,
  SubagentMcpConnection,
  SubagentMcpConnector,
  Tool,
  ToolApprovalDecision,
  Workspace,
} from '@cogitator-ai/types';
import { AcpClientWorkspace } from './client-workspace.js';
import { expandSkill, sessionCommands, type SessionCommands } from './commands.js';
import {
  DEFAULT_ACP_EFFORTS,
  DEFAULT_ACP_MODES,
  applyConfigOption,
  configOptions,
  modeState,
  offeredMode,
  type SessionEffort,
  type SessionSettings,
  type SettingChoices,
} from './config.js';
import { connectMcpServers } from './mcp-servers.js';
import { inputText, titleOf, toUserInput } from './prompt.js';
import { viewOfToolCall } from './tool-calls.js';
import { TurnUpdates, planOf, type PendingUpdate, type TurnFinish } from './updates.js';

/** The thread metadata keys an ACP session keeps its own state in */
export const ACP_THREAD_KEYS = {
  cwd: 'acp.cwd',
  model: 'acp.model',
  effort: 'acp.effort',
  title: 'title',
} as const;

/** The auth method a Cogitator agent offers: it uses the providers of its configuration */
export const COGITATOR_AUTH_METHOD: AuthMethod = {
  id: 'cogitator',
  name: 'Cogitator providers',
  description:
    'Uses the model providers of your Cogitator configuration: API keys in the environment or cogitator.yml, or a local Ollama',
};

export interface AcpAgentOptions {
  /** The host whose threads are the sessions: a Cogitator thread is an ACP session */
  host: SessionHost;
  /** The runtime of the host, whose commands the sessions offer */
  cogitator: Cogitator;
  /** The agent of the host sessions run, by its name there (default: the host's default agent) */
  agent?: string;
  /** What `initialize` answers as `agentInfo` */
  agentInfo?: { name: string; title?: string; version: string };
  /** Models a session may switch to, as `provider/model` (default: only the agent's) */
  models?: readonly string[];
  /** Permission modes a session may switch to (default every mode but `auto`) */
  modes?: readonly PermissionMode[];
  /** The mode a new session starts in (default `default`) */
  defaultMode?: PermissionMode;
  /** Reasoning efforts a session may pick (default `default`, `low` to `max`) */
  efforts?: readonly SessionEffort[];
  /**
   * The workspace on this machine for a session's directory, which the editor's files and
   * terminals wrap (default a `LocalWorkspace` at `cwd`). The session owns and disposes it
   */
  workspace?: (cwd: string) => Workspace;
  /** Connects the MCP servers an editor gives a session (default the connector of `@cogitator-ai/mcp`) */
  mcp?: SubagentMcpConnector;
  /** Auth methods `initialize` offers (default {@link COGITATOR_AUTH_METHOD}) */
  authMethods?: readonly AuthMethod[];
  /** Checks an `authenticate` request, throwing when the method cannot be used (default: accepts) */
  authenticate?: (methodId: string) => void | Promise<void>;
  /**
   * The directories sessions may work in: a session whose directory is outside every one of them
   * is refused. For an agent whose project files (settings, commands, subagents, hooks) are read
   * from one directory, such as the one `cogitator acp` runs in. Default: any directory
   */
  roots?: readonly string[];
  /** Hears what went wrong outside a request, such as a notification that could not be sent */
  onError?: (error: Error) => void;
}

interface LiveSession {
  id: string;
  cwd: string;
  client: AgentContext;
  settings: SessionSettings;
  base: Workspace;
  workspace: AcpClientWorkspace;
  mcp: SubagentMcpConnection;
  commands: SessionCommands;
  titled: boolean;
  /** The turn going on, while a prompt runs */
  turnId?: string;
  updates?: TurnUpdates;
  prompting: boolean;
  /** Aborts when the prompt going on is cancelled or the session closed */
  cancel?: AbortController;
  queue: Promise<void>;
  compactions: number;
}

/** The answers a paused turn goes on with, or the question the user answers with the next prompt */
type Resolution =
  | { kind: 'resume'; resume: NonNullable<TurnStartParams['resume']> }
  | { kind: 'ask'; interrupt: PendingInterrupt };

/**
 * Serves the agent of a {@link SessionHost} to an editor over the Agent Client Protocol: each
 * ACP session is a thread of the host, a prompt is a turn, and the turn's stream reaches the
 * editor as `session/update` (message and thought chunks, tool calls with their diffs and
 * terminals, the plan from `write_todos`, compaction notices). Tool calls that need approval ask
 * with `session/request_permission`, and an "always" answer saves a rule to the permission
 * settings. When the editor offers them, the agent reads and writes files through it and runs
 * commands in its terminals. The MCP servers it names connect through `MCPClient`.
 *
 * One app serves one connection: make one per client.
 */
export class AcpAgent {
  readonly app: AgentApp;
  private readonly host: SessionHost;
  private readonly agentName: string;
  private readonly choices: SettingChoices;
  private readonly sessions = new Map<string, LiveSession>();
  private capabilities: ClientCapabilities | undefined;
  private readonly unsubscribe: () => void;
  private readonly listeners = new Set<(notification: AppServerNotification) => void>();

  constructor(private readonly options: AcpAgentOptions) {
    this.host = options.host;
    const agents = this.host.agents();
    const named = options.agent ?? agents.find((entry) => entry.default)?.name;
    const entry = agents.find((candidate) => candidate.name === named);
    if (!entry || entry.external) {
      throw new Error(
        named === undefined
          ? 'The host has no agent to serve over ACP'
          : `The agent ${named} is not an agent of the runtime the host can serve over ACP`
      );
    }
    this.agentName = entry.name;
    const modes = options.modes ?? DEFAULT_ACP_MODES;
    if (modes.length === 0) throw new Error('An ACP agent needs at least one permission mode');
    this.choices = {
      modes,
      models: options.models ?? (entry.model ? [entry.model] : []),
      efforts: options.efforts ?? DEFAULT_ACP_EFFORTS,
    };
    this.unsubscribe = this.host.subscribe((notification) => {
      for (const listener of [...this.listeners]) listener(notification);
    });
    this.app = this.build();
  }

  /** The agent the sessions run */
  private get agent(): Agent {
    const agent = this.host.agent(this.agentName);
    if (!agent) throw new Error(`The host has no agent ${this.agentName}`);
    return agent;
  }

  /** Ends every session: their turns are interrupted, their workspaces and MCP servers closed */
  async close(): Promise<void> {
    await Promise.allSettled([...this.sessions.keys()].map((id) => this.closeSession(id)));
    this.unsubscribe();
  }

  private build(): AgentApp {
    return createAgentApp({ name: 'cogitator' })
      .onRequest('initialize', ({ params }) => {
        this.capabilities = params.clientCapabilities;
        return this.initialize(params.protocolVersion);
      })
      .onRequest('authenticate', async ({ params }) => {
        const known = (this.options.authMethods ?? [COGITATOR_AUTH_METHOD]).some(
          (method) => method.id === params.methodId
        );
        if (!known) {
          throw RequestError.invalidParams(
            { methodId: params.methodId },
            `Unknown auth method ${params.methodId}`
          );
        }
        await this.options.authenticate?.(params.methodId);
        return {};
      })
      .onRequest('session/new', async ({ params, client }) => {
        this.refuseOutside(resolve(params.cwd));
        const thread = await this.host.startThread({
          agent: this.agentName,
          metadata: { [ACP_THREAD_KEYS.cwd]: params.cwd },
          permissionMode: this.options.defaultMode ?? this.choices.modes[0]!,
        });
        const session = await this.open(thread, params.cwd, params.mcpServers, client);
        this.later(session, () => this.sendCommands(session));
        return { sessionId: session.id, ...this.state(session) };
      })
      .onRequest('session/load', async ({ params, client }) => {
        const thread = await this.thread(params.sessionId);
        const session = await this.open(thread, params.cwd, params.mcpServers, client);
        const { messages } = await this.host.resumeThread(params.sessionId);
        for (const message of messages) {
          if (message.text === '') continue;
          if (message.role === 'user') {
            this.send(session, {
              sessionUpdate: 'user_message_chunk',
              content: { type: 'text', text: message.text },
            });
          } else if (message.role === 'assistant') {
            this.send(session, {
              sessionUpdate: 'agent_message_chunk',
              content: { type: 'text', text: message.text },
            });
          }
        }
        await session.queue;
        this.later(session, () => this.sendCommands(session));
        return this.state(session);
      })
      .onRequest('session/resume', async ({ params, client }) => {
        const thread = await this.thread(params.sessionId);
        const session = await this.open(thread, params.cwd, params.mcpServers ?? [], client);
        this.later(session, () => this.sendCommands(session));
        return this.state(session);
      })
      .onRequest('session/list', async ({ params }) => {
        const page = await this.host.listThreads({
          agent: this.agentName,
          archived: false,
          limit: 50,
          ...(params.cursor && { cursor: params.cursor }),
        });
        const sessions: SessionInfo[] = page.threads
          .filter((thread) => !params.cwd || cwdOf(thread) === resolve(params.cwd))
          .map((thread) => {
            const title = thread.metadata[ACP_THREAD_KEYS.title];
            return {
              sessionId: thread.id,
              cwd: cwdOf(thread) ?? process.cwd(),
              updatedAt: thread.updatedAt,
              ...(typeof title === 'string' && { title }),
            };
          });
        return { sessions, ...(page.nextCursor !== undefined && { nextCursor: page.nextCursor }) };
      })
      .onRequest('session/close', async ({ params }) => {
        this.live(params.sessionId);
        await this.closeSession(params.sessionId);
        return {};
      })
      .onRequest('session/delete', async ({ params }) => {
        await this.thread(params.sessionId);
        await this.closeSession(params.sessionId);
        await this.host.deleteThread(params.sessionId);
        return {};
      })
      .onRequest('session/set_mode', async ({ params }) => {
        const session = this.live(params.sessionId);
        const mode = offeredMode(params.modeId, this.choices);
        if (!mode) {
          throw RequestError.invalidParams(
            { modeId: params.modeId },
            `Unknown session mode ${params.modeId}`
          );
        }
        await this.setMode(session, mode);
        return {};
      })
      .onRequest('session/set_config_option', async ({ params }) => {
        const session = this.live(params.sessionId);
        const settings = applyConfigOption(
          session.settings,
          params.configId,
          params.value,
          this.choices
        );
        if (settings.mode !== session.settings.mode) {
          await this.setMode(session, settings.mode);
        } else {
          session.settings = settings;
          await this.host.updateThread(session.id, {
            [ACP_THREAD_KEYS.model]: settings.model,
            [ACP_THREAD_KEYS.effort]: settings.effort,
          });
        }
        return { configOptions: this.configOptions(session) };
      })
      .onRequest('session/prompt', async ({ params, client }) =>
        this.prompt(this.live(params.sessionId), params.prompt, client)
      )
      .onNotification('session/cancel', ({ params }) => {
        const session = this.sessions.get(params.sessionId);
        if (session) this.cancel(session);
      });
  }

  private initialize(requested: number): InitializeResponse {
    const methods = this.options.authMethods ?? [COGITATOR_AUTH_METHOD];
    return {
      protocolVersion: Math.min(requested, PROTOCOL_VERSION),
      agentCapabilities: {
        loadSession: true,
        promptCapabilities: { image: true, audio: false, embeddedContext: true },
        mcpCapabilities: { http: true, sse: true },
        sessionCapabilities: { list: {}, delete: {}, resume: {}, close: {} },
      },
      authMethods: methods.filter(
        (method) =>
          !('type' in method) ||
          method.type !== 'terminal' ||
          this.capabilities?.auth?.terminal === true
      ),
      agentInfo: this.options.agentInfo ?? {
        name: 'cogitator',
        title: 'Cogitator',
        version: '0.1.0',
      },
    };
  }

  /** Opens the live side of a session: its workspace over the editor, its MCP servers, its commands */
  private async open(
    thread: ThreadInfo,
    cwd: string,
    mcpServers: readonly McpServer[],
    client: AgentContext
  ): Promise<LiveSession> {
    const root = resolve(cwd);
    this.refuseOutside(root);
    await this.closeSession(thread.id);
    const base = this.options.workspace?.(root) ?? new LocalWorkspace({ root });
    let mcp: SubagentMcpConnection | undefined;
    try {
      await base.start();
      mcp = await connectMcpServers(mcpServers, {
        cwd: root,
        agent: this.agentName,
        signal: AbortSignal.timeout(60_000),
        ...(this.options.mcp && { connector: this.options.mcp }),
      });
    } catch (error) {
      await base.dispose().catch(() => undefined);
      throw RequestError.internalError(
        { error: messageOf(error) },
        `The session could not start: ${messageOf(error)}`
      );
    }
    const workspace = new AcpClientWorkspace({
      base,
      client,
      sessionId: thread.id,
      capabilities: this.capabilities,
      onTerminal: async (terminalId, command) => {
        const live = this.sessions.get(thread.id);
        live?.updates?.terminal(terminalId, command);
        await live?.queue;
      },
    });
    const session: LiveSession = {
      id: thread.id,
      cwd: root,
      client,
      settings: this.settingsOf(thread),
      base,
      workspace,
      mcp,
      commands: { commands: [], skills: new Set() },
      titled: typeof thread.metadata[ACP_THREAD_KEYS.title] === 'string',
      prompting: false,
      queue: Promise.resolve(),
      compactions: 0,
    };
    if (cwdOf(thread) !== root) {
      await this.host.updateThread(thread.id, { [ACP_THREAD_KEYS.cwd]: root });
    }
    this.sessions.set(thread.id, session);
    return session;
  }

  /** Refuses a session directory outside the agent's `roots` */
  private refuseOutside(cwd: string): void {
    const roots = this.options.roots;
    if (!roots || roots.some((root) => isInside(cwd, resolve(root)))) return;
    throw RequestError.invalidParams(
      { cwd, roots: [...roots] },
      `This agent works in ${roots.join(', ')}: ${cwd} is outside it. Start the agent in ${cwd} to work there`
    );
  }

  private settingsOf(thread: ThreadInfo): SessionSettings {
    const model = thread.metadata[ACP_THREAD_KEYS.model];
    const effort = thread.metadata[ACP_THREAD_KEYS.effort];
    const mode = thread.permissionMode;
    return {
      mode:
        mode && this.choices.modes.includes(mode)
          ? mode
          : (this.options.defaultMode ?? this.choices.modes[0]!),
      model:
        typeof model === 'string'
          ? model
          : (this.agent.config.model ?? this.choices.models[0] ?? 'default'),
      effort:
        typeof effort === 'string' && (this.choices.efforts as readonly string[]).includes(effort)
          ? (effort as SessionEffort)
          : (this.choices.efforts[0] ?? 'default'),
    };
  }

  private state(session: LiveSession): {
    modes: SessionModeState;
    configOptions: SessionConfigOption[];
  } {
    return {
      modes: modeState(this.choices.modes, session.settings.mode),
      configOptions: this.configOptions(session),
    };
  }

  private configOptions(session: LiveSession): SessionConfigOption[] {
    return configOptions(session.settings, this.choices);
  }

  private async setMode(session: LiveSession, mode: PermissionMode): Promise<void> {
    await this.host.setPermissionMode(session.id, mode);
    session.settings = { ...session.settings, mode };
    this.send(session, { sessionUpdate: 'current_mode_update', currentModeId: mode });
    this.send(session, {
      sessionUpdate: 'config_option_update',
      configOptions: this.configOptions(session),
    });
    await session.queue;
  }

  private async sendCommands(session: LiveSession): Promise<void> {
    session.commands = await sessionCommands(
      this.options.cogitator,
      this.agent,
      session.cwd,
      session.workspace
    );
    this.send(session, {
      sessionUpdate: 'available_commands_update',
      availableCommands: session.commands.commands,
    });
  }

  /** Runs `work` once the answer to the request at hand went out */
  private later(session: LiveSession, work: () => Promise<void>): void {
    setImmediate(() => {
      if (this.sessions.get(session.id) !== session) return;
      work().catch((error: unknown) => this.report(error));
    });
  }

  /** Queues an update of a session, sent once the ones before it went out */
  private send(session: LiveSession, update: PendingUpdate): void {
    session.queue = session.queue.then(async () => {
      const ready = await Promise.resolve(update).catch(() => undefined);
      if (!ready) return;
      await session.client
        .notify('session/update', { sessionId: session.id, update: ready })
        .catch((error: unknown) => this.report(error));
    });
  }

  private async prompt(
    session: LiveSession,
    prompt: readonly ContentBlock[],
    client: AgentContext
  ): Promise<PromptResponse> {
    if (session.prompting) {
      throw RequestError.invalidRequest(
        { sessionId: session.id },
        'A prompt of this session is still running: cancel it first'
      );
    }
    session.prompting = true;
    session.client = client;
    session.cancel = new AbortController();
    try {
      const input = withSkill(toUserInput(prompt), session.commands.skills);
      if (input.length === 0) return { stopReason: 'end_turn' };
      await this.title(session, input);
      if (this.stopped(session)) return { stopReason: 'cancelled' };
      return await this.runPrompt(session, input);
    } finally {
      session.prompting = false;
      session.cancel = undefined;
      session.turnId = undefined;
      session.updates = undefined;
      await session.queue;
    }
  }

  private async title(session: LiveSession, input: readonly UserInput[]): Promise<void> {
    if (session.titled) return;
    const title = titleOf(inputText(input));
    if (!title) return;
    session.titled = true;
    const thread = await this.host.updateThread(session.id, { [ACP_THREAD_KEYS.title]: title });
    this.send(session, {
      sessionUpdate: 'session_info_update',
      title,
      updatedAt: thread.updatedAt,
    });
  }

  /**
   * Runs turns until the prompt is answered: a paused thread first goes on with the answers its
   * questions get (the prompt answers a question the agent asked the user), then the prompt's
   * own turn, each pause in it asked about and resumed
   */
  private async runPrompt(session: LiveSession, input: UserInput[]): Promise<PromptResponse> {
    const completed = new Map<string, TurnInfo>();
    const waiting = new Map<string, (turn: TurnInfo) => void>();
    const updates = new TurnUpdates({
      tool: (name) => this.toolNamed(session, name),
      workspace: session.workspace,
      root: session.cwd,
      send: (update) => this.send(session, update),
    });
    session.updates = updates;
    const listener = (notification: AppServerNotification) => {
      if (notification.method === 'turn/event') {
        const params = notification.params;
        if (params.threadId === session.id && params.parentToolCallId === undefined) {
          updates.event(params.event);
        }
      } else if (notification.method === 'turn/completed') {
        const turn = notification.params.turn;
        if (turn.threadId !== session.id) return;
        const wake = waiting.get(turn.id);
        if (wake) wake(turn);
        else completed.set(turn.id, turn);
      }
    };
    this.listeners.add(listener);
    const finished = (turnId: string) =>
      new Promise<TurnInfo>((done) => {
        const turn = completed.get(turnId);
        if (turn) done(turn);
        else waiting.set(turnId, done);
      });
    try {
      let unsent: UserInput[] | undefined = input;
      let next: TurnStartParams = { threadId: session.id, input };
      const thread = await this.host.getThread(session.id);
      if (this.stopped(session)) return { stopReason: 'cancelled' };
      if (thread.status === 'paused') {
        const { pending } = await this.host.resumeThread(session.id);
        if (this.stopped(session)) return { stopReason: 'cancelled' };
        const resolution = pending
          ? await this.resolve(session, pending, inputText(input))
          : undefined;
        if (this.stopped(session)) return { stopReason: 'cancelled' };
        if (resolution?.kind === 'ask') return this.askUser(session, resolution.interrupt);
        if (resolution) {
          if (pending?.interrupts.some((interrupt) => interrupt.kind === 'input'))
            unsent = undefined;
          next = { threadId: session.id, resume: resolution.resume };
        }
      } else {
        unsent = undefined;
      }
      for (;;) {
        if (this.stopped(session)) return { stopReason: 'cancelled' };
        const turn = await this.host.startTurn(this.turnParams(session, next), {
          owner: this,
          onApproval: (ask) => this.approve(session, updates, ask),
          run: this.runOptions(session, updates),
        });
        session.turnId = turn.id;
        if (this.stopped(session)) this.interrupt(session);
        const done = await finished(turn.id);
        session.turnId = undefined;
        if (done.status === 'interrupted' || this.stopped(session)) {
          return { stopReason: 'cancelled' };
        }
        if (done.status === 'failed') {
          throw new RequestError(-32603, done.error?.message ?? 'The turn failed', {
            ...(done.error?.code !== undefined && { code: done.error.code }),
          });
        }
        if (done.status === 'paused' && done.pending) {
          const resolution = await this.resolve(session, done.pending, undefined);
          if (this.stopped(session)) return { stopReason: 'cancelled' };
          if (resolution.kind === 'ask') return this.askUser(session, resolution.interrupt);
          next = { threadId: session.id, resume: resolution.resume };
          continue;
        }
        if (unsent) {
          next = { threadId: session.id, input: unsent };
          unsent = undefined;
          continue;
        }
        return { stopReason: stopReasonOf(updates.finish) };
      }
    } finally {
      this.listeners.delete(listener);
    }
  }

  private turnParams(session: LiveSession, params: TurnStartParams): TurnStartParams {
    const model = session.settings.model;
    const agentModel = this.agent.config.model;
    return {
      ...params,
      ...(model !== 'default' && model !== agentModel && { model }),
    };
  }

  private runOptions(session: LiveSession, updates: TurnUpdates): TurnRunOptions {
    const tools = session.mcp.tools;
    const effort = session.settings.effort;
    return {
      workspace: session.workspace,
      ...(effort !== 'default' && { reasoning: { effort } }),
      ...(tools.length > 0 && {
        agent: (agent: Agent) =>
          agent.clone({
            ...(agent.config.id !== undefined && { id: agent.config.id }),
            tools: [...agent.tools, ...tools],
          }),
      }),
      middleware: [this.compactionNotices(session)],
      onTodos: (todos) => this.send(session, planOf(todos)),
      onToolResult: (result) => updates.toolResult(result),
    };
  }

  private toolNamed(session: LiveSession, name: string): Tool | undefined {
    return (
      this.agent.tools.find((tool) => tool.name === name) ??
      session.mcp.tools.find((tool) => tool.name === name)
    );
  }

  /** Tells the editor of compactions: as compaction updates, notices, or thoughts, as it takes them */
  private compactionNotices(session: LiveSession): RunMiddleware {
    const ids: string[] = [];
    const session_ = this.capabilities?.session;
    const announce = (status: 'in_progress' | 'completed', summary?: string): void => {
      if (session_?.compaction) {
        const compactionId =
          status === 'in_progress'
            ? `compaction_${++session.compactions}`
            : (ids.pop() ?? `compaction_${++session.compactions}`);
        if (status === 'in_progress') ids.push(compactionId);
        this.send(session, {
          sessionUpdate: 'compaction_update',
          compactionId,
          status,
          ...(summary && { summary: [{ type: 'text', text: summary }] }),
        });
        return;
      }
      if (status === 'in_progress') return;
      if (session_?.notices) {
        this.send(session, {
          sessionUpdate: 'notice',
          severity: 'info',
          title: 'Compacted the conversation',
          ...(summary && { description: summary }),
        });
        return;
      }
      this.send(session, {
        sessionUpdate: 'agent_thought_chunk',
        content: {
          type: 'text',
          text: '\n[The conversation was compacted to fit the context window]\n',
        },
      });
    };
    return {
      name: 'acp-compaction-notices',
      beforeCompaction: () => announce('in_progress'),
      afterCompaction: (event) => announce('completed', event.summary),
    };
  }

  /** Asks the editor about a tool call that needs approval */
  private async approve(
    session: LiveSession,
    updates: TurnUpdates,
    ask: ApprovalAsk
  ): Promise<ToolApprovalDecision> {
    const request = ask.request;
    if (!updates.known(request.toolCallId)) {
      updates.announce(request.toolCallId, request.toolName, request.arguments);
    }
    const view = viewOfToolCall(
      request.toolName,
      request.arguments,
      this.toolNamed(session, request.toolName),
      session.cwd
    );
    const diff = await updates.diffOf(request.toolCallId);
    await session.queue;
    const options: PermissionOption[] = [
      { optionId: 'allow_once', name: 'Allow', kind: 'allow_once' },
      {
        optionId: 'allow_always',
        name: request.suggestedRule ? `Always allow ${request.suggestedRule}` : 'Always allow',
        kind: 'allow_always',
      },
      { optionId: 'reject_once', name: 'Reject', kind: 'reject_once' },
      {
        optionId: 'reject_always',
        name: request.suggestedRule ? `Always reject ${request.suggestedRule}` : 'Always reject',
        kind: 'reject_always',
      },
    ];
    try {
      const answer = await session.client.request(
        'session/request_permission',
        {
          sessionId: session.id,
          toolCall: {
            toolCallId: request.toolCallId,
            title: request.subagent ? `${view.title} (${request.subagent})` : view.title,
            kind: view.kind,
            status: 'pending',
            rawInput: request.arguments,
            ...(view.locations.length > 0 && { locations: view.locations }),
            ...(diff && { content: [diff] }),
          },
          options,
          ...(request.reason !== undefined && { _meta: { reason: request.reason } }),
        },
        { cancellationSignal: this.signalOf(session, ask.signal) }
      );
      if (answer.outcome.outcome === 'cancelled') {
        return { approved: false, reason: 'The user cancelled the question' };
      }
      switch (answer.outcome.optionId) {
        case 'allow_once':
          return { approved: true };
        case 'allow_always':
          return { approved: true, remember: true };
        case 'reject_always':
          return { approved: false, remember: true };
        default:
          return { approved: false };
      }
    } catch (error) {
      this.report(error);
      return { approved: false, reason: 'The editor did not answer the question' };
    }
  }

  /**
   * The answers to what a paused turn waits on: a plan or a budget asked about as a permission,
   * a tool's question asked as a form when the editor takes forms, else answered with `answer`
   * (the next prompt), else left for the user to answer
   */
  private async resolve(
    session: LiveSession,
    pending: TurnPending,
    answer: string | undefined
  ): Promise<Resolution> {
    const responses: Record<string, unknown> = {};
    const decisions: Record<string, { approved: false; reason: string }> = {};
    for (const approval of pending.approvals) {
      decisions[approval.toolCallId] = { approved: false, reason: 'Nobody answered the question' };
    }
    for (const interrupt of pending.interrupts) {
      if (interrupt.kind === 'approval') {
        if (interrupt.toolCallId !== undefined && !(interrupt.toolCallId in decisions)) {
          decisions[interrupt.toolCallId] = {
            approved: false,
            reason: 'Nobody answered the question',
          };
        }
        continue;
      }
      if (interrupt.kind === 'plan') {
        responses[interrupt.id] = await this.askPlan(session, interrupt);
        continue;
      }
      if (interrupt.kind === 'budget') {
        responses[interrupt.id] = await this.askBudget(session, interrupt);
        continue;
      }
      const form = await this.askForm(session, interrupt);
      if (form !== undefined) {
        responses[interrupt.id] = form;
      } else if (answer !== undefined) {
        responses[interrupt.id] = answer;
      } else {
        return { kind: 'ask', interrupt };
      }
    }
    return {
      kind: 'resume',
      resume: {
        ...(Object.keys(responses).length > 0 && { responses }),
        ...(Object.keys(decisions).length > 0 && { decisions }),
      },
    };
  }

  private async choose(
    session: LiveSession,
    interrupt: PendingInterrupt,
    title: string,
    kind: 'switch_mode' | 'other',
    content: string | undefined,
    options: PermissionOption[]
  ): Promise<string | undefined> {
    await session.queue;
    try {
      const answer = await session.client.request(
        'session/request_permission',
        {
          sessionId: session.id,
          toolCall: {
            toolCallId: interrupt.toolCallId ?? interrupt.id,
            title,
            kind,
            status: 'pending',
            ...(content !== undefined && {
              content: [{ type: 'content', content: { type: 'text', text: content } }],
            }),
          },
          options,
        },
        { cancellationSignal: this.signalOf(session) }
      );
      return answer.outcome.outcome === 'selected' ? answer.outcome.optionId : undefined;
    } catch (error) {
      this.report(error);
      return undefined;
    }
  }

  private async askPlan(
    session: LiveSession,
    interrupt: PendingInterrupt
  ): Promise<{ approved: boolean; mode?: 'default' | 'acceptEdits' }> {
    const plan = interrupt.details?.plan;
    const choice = await this.choose(
      session,
      interrupt,
      'Ready to code?',
      'switch_mode',
      typeof plan === 'string' ? plan : interrupt.message,
      [
        { optionId: 'accept_edits', name: 'Yes, and accept edits', kind: 'allow_always' },
        { optionId: 'default', name: 'Yes, and ask before edits', kind: 'allow_once' },
        { optionId: 'keep_planning', name: 'No, keep planning', kind: 'reject_once' },
      ]
    );
    if (choice !== 'accept_edits' && choice !== 'default') return { approved: false };
    const mode = choice === 'accept_edits' ? 'acceptEdits' : 'default';
    if (this.choices.modes.includes(mode)) {
      await this.host.setPermissionMode(session.id, mode);
      session.settings = { ...session.settings, mode };
      this.send(session, { sessionUpdate: 'current_mode_update', currentModeId: mode });
      this.send(session, {
        sessionUpdate: 'config_option_update',
        configOptions: this.configOptions(session),
      });
    }
    return { approved: true, mode };
  }

  private async askBudget(
    session: LiveSession,
    interrupt: PendingInterrupt
  ): Promise<{ action: 'continue' } | { action: 'stop' }> {
    const choice = await this.choose(session, interrupt, interrupt.message, 'other', undefined, [
      { optionId: 'continue', name: 'Go on', kind: 'allow_once' },
      { optionId: 'stop', name: 'Stop here', kind: 'reject_once' },
    ]);
    return choice === 'continue' ? { action: 'continue' } : { action: 'stop' };
  }

  /** A tool's question as a form, when the editor takes forms and the answer is an object */
  private async askForm(
    session: LiveSession,
    interrupt: PendingInterrupt
  ): Promise<Record<string, unknown> | undefined> {
    const schema = interrupt.responseSchema;
    if (this.capabilities?.elicitation?.form == null || !isFormSchema(schema)) return undefined;
    await session.queue;
    try {
      const answer = await session.client.request(
        'elicitation/create',
        {
          mode: 'form',
          sessionId: session.id,
          ...(interrupt.toolCallId !== undefined && { toolCallId: interrupt.toolCallId }),
          message: interrupt.message,
          requestedSchema: schema,
        },
        { cancellationSignal: this.signalOf(session) }
      );
      if (answer.action !== 'accept') return undefined;
      const content = 'content' in answer ? answer.content : undefined;
      return content && typeof content === 'object' ? { ...content } : {};
    } catch (error) {
      this.report(error);
      return undefined;
    }
  }

  /** Ends the prompt with the agent's question: the next prompt answers it */
  private askUser(session: LiveSession, interrupt: PendingInterrupt): PromptResponse {
    this.send(session, {
      sessionUpdate: 'agent_message_chunk',
      content: { type: 'text', text: `\n${interrupt.message}\n` },
    });
    return { stopReason: 'end_turn' };
  }

  /** Cancels the prompt going on in a session: its turn is interrupted, its questions dropped */
  private cancel(session: LiveSession): void {
    session.cancel?.abort(new Error('The prompt was cancelled'));
    this.interrupt(session);
  }

  /** Whether the prompt going on was cancelled, or its session closed */
  private stopped(session: LiveSession): boolean {
    return session.cancel?.signal.aborted === true || this.sessions.get(session.id) !== session;
  }

  /** What aborts a question of the prompt: a cancel, and `also` when given */
  private signalOf(session: LiveSession, also?: AbortSignal): AbortSignal | undefined {
    const signals = [session.cancel?.signal, also].filter(
      (signal): signal is AbortSignal => signal !== undefined
    );
    return signals.length > 0 ? AbortSignal.any(signals) : undefined;
  }

  private interrupt(session: LiveSession): void {
    const turnId = session.turnId;
    if (!turnId) return;
    try {
      this.host.interruptTurn(session.id, turnId);
    } catch {
      return;
    }
  }

  private async closeSession(sessionId: string): Promise<void> {
    const session = this.sessions.get(sessionId);
    if (!session) return;
    this.sessions.delete(sessionId);
    this.cancel(session);
    await this.host.waitForTurn(sessionId).catch(() => undefined);
    await session.queue;
    await Promise.allSettled([session.mcp.close(), session.base.dispose()]);
  }

  private async thread(sessionId: string): Promise<ThreadInfo> {
    let thread: ThreadInfo;
    try {
      thread = await this.host.getThread(sessionId);
    } catch {
      throw sessionNotFound(sessionId);
    }
    if ((await this.host.threadAgent(sessionId)) !== this.agentName) {
      throw sessionNotFound(sessionId);
    }
    return thread;
  }

  private live(sessionId: string): LiveSession {
    const session = this.sessions.get(sessionId);
    if (!session) throw sessionNotFound(sessionId);
    return session;
  }

  private report(error: unknown): void {
    this.options.onError?.(error instanceof Error ? error : new Error(String(error)));
  }
}

/** Creates an ACP agent over `options.host`: connect its `app` to one client */
export function createAcpAgent(options: AcpAgentOptions): AcpAgent {
  return new AcpAgent(options);
}

/** The error for a session the agent does not know, `-32002` with the session's id */
export function sessionNotFound(sessionId: string): RequestError {
  return new RequestError(-32002, `Session ${sessionId} not found`, { sessionId });
}

function isInside(path: string, root: string): boolean {
  const inner = relative(root, path);
  return inner === '' || (!inner.startsWith('..') && !isAbsolute(inner));
}

function cwdOf(thread: ThreadInfo): string | undefined {
  const cwd = thread.metadata[ACP_THREAD_KEYS.cwd];
  return typeof cwd === 'string' ? cwd : undefined;
}

/** Why a turn that completed stopped, from how its stream finished */
function stopReasonOf(finish: TurnFinish | undefined): StopReason {
  if (finish?.blocked !== undefined) return 'refusal';
  if (finish?.truncated) return 'max_tokens';
  if (finish?.iterationLimitReached) return 'max_turn_requests';
  return 'end_turn';
}

/** The prompt with a `/<skill>` request spelled out for the agent, see {@link expandSkill} */
function withSkill(input: UserInput[], skills: ReadonlySet<string>): UserInput[] {
  const first = input[0];
  if (first?.type !== 'text' || skills.size === 0) return input;
  return [{ ...first, text: expandSkill(first.text, skills) }, ...input.slice(1)];
}

function isFormSchema(schema: Record<string, unknown> | undefined): schema is ElicitationSchema {
  if (schema?.type !== 'object') return false;
  const properties = schema.properties;
  if (!properties || typeof properties !== 'object') return false;
  return Object.values(properties).every(
    (property) =>
      property !== null &&
      typeof property === 'object' &&
      ['string', 'number', 'integer', 'boolean', 'array'].includes(
        String((property as { type?: unknown }).type)
      )
  );
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
