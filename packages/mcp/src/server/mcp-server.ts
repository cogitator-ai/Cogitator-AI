/**
 * MCP Server
 *
 * Exposes Cogitator tools as an MCP server that can be used by
 * other MCP clients (e.g., Claude Desktop, other AI assistants).
 * Serves clients of protocol 2026-07-28 and of 2025-11-25.
 */

import { createHash, randomUUID } from 'node:crypto';
import type { IncomingMessage, Server as HttpServer, ServerResponse } from 'node:http';
import {
  CLIENT_CAPABILITIES_META_KEY,
  McpServer,
  MissingRequiredClientCapabilityError,
  ResourceTemplate,
  SdkError,
  SdkErrorCode,
  createMcpHandler,
  inputRequired,
  isLegacyRequest,
  type AuthInfo,
  type CallToolResult,
  type ClientCapabilities,
  type InputRequest,
  type InputRequiredResult,
  type McpHttpHandler,
  type ServerContext,
} from '@modelcontextprotocol/server';
import { serveStdio, type StdioServerHandle } from '@modelcontextprotocol/server/stdio';
import {
  NodeStreamableHTTPServerTransport,
  toNodeHandler,
  toWebRequest,
  type NodeMcpRequestHandler,
} from '@modelcontextprotocol/node';
import { Cogitator, withParsedArguments } from '@cogitator-ai/core';
import type {
  Tool,
  ToolApprovalDecision,
  ToolApprovalRequest,
  ToolInvoker,
} from '@cogitator-ai/types';
import type {
  MCPElicitRequest,
  MCPElicitResult,
  MCPToolContext,
  MCPCaller,
  MCPServerConfig,
  MCPResourceConfig,
  MCPResourceReadContent,
  MCPPromptConfig,
  MCPPromptMessage,
  MCPProtectedResourceConfig,
  MCPToolContent,
} from '../types';
import { mcpOutputSchema, resultToMCPContent } from '../adapter/tool-adapter';
import { approvalDecision, approvalForm, elicitApproval } from './approval';
import {
  CallExecution,
  type ExecutionStep,
  type ServerContent,
  type ServerToolResult,
} from './execution';
import {
  REJECTED_STATE,
  callDigest,
  callStateCodec,
  randomStateKey,
  type CallState,
  type GrantedApproval,
  type VerifiedState,
} from './request-state';
import { DEFAULT_PROMOTE_AFTER_MS, ServerTasks, TASKS_EXTENSION, parseElicitResult } from './tasks';
import { z } from 'zod';

type MCPPromptContent = MCPPromptMessage['content'];

function toServerContent(item: MCPToolContent | MCPPromptContent): ServerContent {
  switch (item.type) {
    case 'text':
      return { type: 'text', text: item.text ?? '' };
    case 'image':
    case 'audio':
      if (typeof item.data === 'string' && typeof item.mimeType === 'string') {
        return { type: item.type, data: item.data, mimeType: item.mimeType };
      }
      break;
    case 'resource':
    case 'resource_link': {
      const resource = item.resource;
      if (resource && typeof resource.blob === 'string') {
        return {
          type: 'resource',
          resource: { uri: resource.uri, mimeType: resource.mimeType, blob: resource.blob },
        };
      }
      if (resource && typeof resource.text === 'string') {
        return {
          type: 'resource',
          resource: { uri: resource.uri, mimeType: resource.mimeType, text: resource.text },
        };
      }
      break;
    }
  }
  return { type: 'text', text: JSON.stringify(item) };
}

function errorMessageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

const PERMISSIVE_INPUT_SCHEMA = z.looseObject({});

/** How long an elicitation waits for the user by default: 10 minutes. */
const DEFAULT_ELICITATION_TIMEOUT_MS = 10 * 60 * 1000;

/** The longest delay a Node timer keeps, a longer one fires at once. */
const MAX_TIMER_DELAY_MS = 2_147_483_647;

const APPROVAL_KEY = 'approval';

const TaskIdParams = z.looseObject({ taskId: z.string().min(1) });
const TaskUpdateParams = z.looseObject({
  taskId: z.string().min(1),
  inputResponses: z.record(z.string(), z.unknown()).optional(),
});
const AnyResult = z.looseObject({});

/** Who a built SDK server serves: the protocol era, the caller, and whether it can ask them */
interface ServeScope {
  era: 'modern' | 'legacy';
  caller: MCPCaller | undefined;
  /** Whom tasks, waiting runs and round states belong to, see `ownerOf` */
  owner: string;
  /** For the 2025 era: whether a request of the server can reach the client (stdio, sessions) */
  legacyCanAsk: boolean;
  server?: McpServer;
}

/**
 * How a run of a tool call asks: by ending rounds (2026-07-28), in place as a task, in place by
 * a request to a client of an earlier revision (`legacy`, with its `elicit`), or not at all
 */
interface RunMode {
  mode: 'round' | 'task' | 'legacy' | 'direct';
  elicit?: (request: MCPElicitRequest) => Promise<MCPElicitResult | undefined>;
  /** The approvals the person gave in earlier rounds, by the digest of the request */
  approvals?: GrantedApproval[];
  input?: { responses: Record<string, MCPElicitResult>; state: unknown; stateRejected: boolean };
}

/**
 * MCP Server for exposing Cogitator tools
 *
 * @example
 * ```typescript
 * // Create server with tools
 * const server = new MCPServer({
 *   name: 'my-cogitator-server',
 *   version: '1.0.0',
 *   transport: 'stdio',
 * });
 *
 * // Register tools
 * server.registerTool(calculatorTool);
 * server.registerTool(fileReadTool);
 * server.registerTools([searchTool, weatherTool]);
 *
 * // Start serving
 * await server.start();
 * ```
 */
export class MCPServer {
  private stdio?: StdioServerHandle;
  private config: MCPServerConfig;
  private tools = new Map<string, Tool>();
  private resources = new Map<string, MCPResourceConfig>();
  private prompts = new Map<string, MCPPromptConfig>();
  private started = false;
  private ownInvoker?: Cogitator;
  private httpServer?: HttpServer;
  private httpHandler?: McpHttpHandler;
  private readonly stateKey: string | Uint8Array;
  private readonly parked = new Map<string, CallExecution>();
  private readonly tasks: ServerTasks | undefined;
  private readonly sessions = new Map<
    string,
    {
      transport: NodeStreamableHTTPServerTransport;
      server: McpServer;
      caller: MCPCaller | undefined;
      owner: string;
    }
  >();

  constructor(config: MCPServerConfig) {
    this.config = config;
    this.stateKey = config.requestStateKey ?? randomStateKey();
    const keyBytes =
      typeof this.stateKey === 'string'
        ? Buffer.byteLength(this.stateKey, 'utf8')
        : this.stateKey.length;
    if (keyBytes < 32) throw new RangeError('requestStateKey must be at least 32 bytes long');
    this.tasks =
      config.tasks === false
        ? undefined
        : new ServerTasks(
            config.tasks ?? {},
            (message) => this.log('error', message),
            () => this.elicitationTimeout()
          );
  }

  /**
   * Register a single Cogitator tool
   */
  registerTool(tool: Tool): void {
    if (this.started) {
      throw new Error('Cannot register tools after server has started');
    }
    this.tools.set(tool.name, tool);
  }

  /**
   * Register multiple Cogitator tools
   */
  registerTools(tools: readonly Tool[]): void {
    for (const tool of tools) {
      this.registerTool(tool);
    }
  }

  /**
   * Unregister a tool by name.
   * Only works before server.start() — tools registered on the underlying
   * MCP transport cannot be removed at runtime.
   */
  unregisterTool(name: string): boolean {
    if (this.started) {
      throw new Error('Cannot unregister tools after server has started');
    }
    return this.tools.delete(name);
  }

  /**
   * Get list of registered tool names
   */
  getRegisteredTools(): string[] {
    return Array.from(this.tools.keys());
  }

  /**
   * Register a single resource
   */
  registerResource(config: MCPResourceConfig): void {
    if (this.started) {
      throw new Error('Cannot register resources after server has started');
    }

    this.resources.set(config.uri, config);
  }

  /**
   * Register multiple resources
   */
  registerResources(configs: MCPResourceConfig[]): void {
    for (const config of configs) {
      this.registerResource(config);
    }
  }

  /**
   * Unregister a resource by URI.
   * Only works before server.start().
   */
  unregisterResource(uri: string): boolean {
    if (this.started) {
      throw new Error('Cannot unregister resources after server has started');
    }
    return this.resources.delete(uri);
  }

  /**
   * Get list of registered resource URIs
   */
  getRegisteredResources(): string[] {
    return Array.from(this.resources.keys());
  }

  /**
   * Register a single prompt
   */
  registerPrompt(config: MCPPromptConfig): void {
    if (this.started) {
      throw new Error('Cannot register prompts after server has started');
    }

    this.prompts.set(config.name, config);
  }

  /**
   * Register multiple prompts
   */
  registerPrompts(configs: MCPPromptConfig[]): void {
    for (const config of configs) {
      this.registerPrompt(config);
    }
  }

  /**
   * Unregister a prompt by name.
   * Only works before server.start().
   */
  unregisterPrompt(name: string): boolean {
    if (this.started) {
      throw new Error('Cannot unregister prompts after server has started');
    }
    return this.prompts.delete(name);
  }

  /**
   * Get list of registered prompt names
   */
  getRegisteredPrompts(): string[] {
    return Array.from(this.prompts.keys());
  }

  /**
   * Build a fresh SDK McpServer instance and register every tool, resource
   * and prompt from the local maps onto it.
   *
   * The maps are the single source of truth: registration with the SDK is
   * deferred until a connection (stdio) or each incoming request (HTTP), so
   * unregister* calls made before start() are fully honoured and concurrent
   * HTTP requests never share a single server/transport binding.
   */
  private buildServer(scope: ServeScope): McpServer {
    const codec = callStateCodec(this.stateKey, scope.owner, this.elicitationTimeout());
    const server = new McpServer(
      { name: this.config.name, version: this.config.version },
      {
        ...(this.tasks && { capabilities: { extensions: { [TASKS_EXTENSION]: {} } } }),
        requestState: { verify: codec.verify },
        inputRequired: { roundTimeoutMs: this.elicitationTimeout() },
      }
    );
    scope.server = server;

    for (const tool of this.tools.values()) {
      this.registerMCPTool(server, tool, scope, codec.mint);
    }
    for (const resource of this.resources.values()) {
      this.registerMCPResource(server, resource, scope.caller);
    }
    for (const prompt of this.prompts.values()) {
      this.registerMCPPrompt(server, prompt, scope.caller);
    }
    if (this.tasks) this.registerTaskHandlers(server, scope, this.tasks);

    return server;
  }

  /**
   * Register a tool with the MCP server
   */
  private registerMCPTool(
    server: McpServer,
    tool: Tool,
    scope: ServeScope,
    mint: (state: CallState, ctx: ServerContext) => Promise<string>
  ): void {
    const outputSchema = mcpOutputSchema(tool);
    server.registerTool(
      tool.name,
      {
        ...(tool.title !== undefined && { title: tool.title }),
        description: tool.description,
        inputSchema: this.buildInputSchema(tool),
        ...(outputSchema && { outputSchema }),
        ...(tool.annotations && { annotations: { ...tool.annotations } }),
      },
      async (args: unknown, ctx: ServerContext): Promise<CallToolResult | InputRequiredResult> =>
        this.handleToolCall(tool, args, ctx, scope, mint, outputSchema)
    );
  }

  /**
   * Resolve the Zod schema the SDK uses to advertise and validate tool input.
   *
   * The full tool schema is handed to the SDK (not just its shape) so object
   * modifiers, refinements and transforms are honoured, and the SDK passes
   * already-parsed arguments to the handler. Tools without a schema accept
   * any object.
   */
  private buildInputSchema(tool: Tool): z.ZodType {
    const params: unknown = tool.parameters;
    return params instanceof z.ZodType ? params : PERMISSIVE_INPUT_SCHEMA;
  }

  /** The invoker tool calls run through: `config.toolInvoker`, else a Cogitator of its own. */
  private invoker(): ToolInvoker {
    if (this.config.toolInvoker) return this.config.toolInvoker;
    this.ownInvoker ??= new Cogitator();
    return this.ownInvoker;
  }

  /**
   * One round of a tool call. A call that needs the person at the client (an approval,
   * `context.elicit()`, `context.input.ask()`) ends its round with the questions and a signed
   * state, and the client calls again with the answers: on protocol 2026-07-28 the client does,
   * on earlier revisions the MCP SDK asks the client and calls again itself. A call still
   * running after `tasks.promoteAfterMs` becomes a task, for clients that take tasks
   */
  private async handleToolCall(
    tool: Tool,
    args: unknown,
    ctx: ServerContext,
    scope: ServeScope,
    mint: (state: CallState, ctx: ServerContext) => Promise<string>,
    outputSchema: z.ZodType | undefined
  ): Promise<CallToolResult | InputRequiredResult> {
    const capabilities = this.clientCapabilities(ctx, scope);
    const owner = scope.owner;
    const takesTasks =
      scope.era === 'modern' && capabilities?.extensions?.[TASKS_EXTENSION] !== undefined;
    if (capabilities?.elicitation === undefined || scope.era === 'legacy') {
      const mode = capabilities?.elicitation === undefined ? 'direct' : 'legacy';
      const execution = this.startExecution(tool, args, owner, '', scope.caller, outputSchema, {
        mode,
        elicit: (request) => this.legacyElicit(ctx, request),
      });
      return this.drive(execution, ctx, scope, tool, args, mint, outputSchema, takesTasks, mode);
    }

    const digest = callDigest(tool.name, args);
    const verified: VerifiedState = ctx.mcpReq.requestState<VerifiedState>();
    const state =
      verified !== REJECTED_STATE && verified?.tool === tool.name && verified.digest === digest
        ? verified
        : undefined;
    const responses = elicitResults(ctx.mcpReq.inputResponses);

    if (state?.kind === 'parked') {
      const execution = this.parked.get(state.id);
      const question = execution?.question;
      if (execution?.owner !== owner || !question || execution.finished) {
        return this.toolError(
          tool,
          'The question of this call expired or was answered already: call the tool again'
        ) as CallToolResult;
      }
      const answer = responses[question.key];
      if (!answer) return this.askInRound(execution, question, ctx, mint);
      this.parked.delete(execution.id);
      execution.respond(answer);
      return this.drive(execution, ctx, scope, tool, args, mint, outputSchema, takesTasks, 'task');
    }

    let approvals = state?.approvals ?? [];
    let input: { responses: Record<string, MCPElicitResult>; state: unknown } | undefined;
    if (state?.kind === 'approval') {
      const reply = responses[state.key];
      if (reply) {
        const decision = approvalDecision(reply);
        approvals = [
          ...approvals.filter((granted) => granted.digest !== state.pending),
          decision.approved
            ? { digest: state.pending, approved: true }
            : {
                digest: state.pending,
                approved: false,
                ...(decision.reason !== undefined && { reason: decision.reason }),
              },
        ];
      }
      if (state.resume) {
        input = { responses: elicitResults(state.resume.responses), state: state.resume.data };
      }
    } else if (state?.kind === 'tool') {
      input = { responses, state: state.data };
    }
    const execution = this.startExecution(tool, args, owner, digest, scope.caller, outputSchema, {
      mode: 'round',
      approvals,
      input: {
        responses: input?.responses ?? {},
        state: input?.state,
        stateRejected:
          verified === REJECTED_STATE || (verified !== undefined && state === undefined),
      },
    });
    return this.drive(execution, ctx, scope, tool, args, mint, outputSchema, takesTasks, 'task');
  }

  /**
   * What the round of `execution` answers: its result, its questions with the state of the call,
   * or the task it became
   */
  private async drive(
    execution: CallExecution,
    ctx: ServerContext,
    scope: ServeScope,
    tool: Tool,
    args: unknown,
    mint: (state: CallState, ctx: ServerContext) => Promise<string>,
    outputSchema: z.ZodType | undefined,
    takesTasks: boolean,
    taskMode: 'task' | 'direct' | 'legacy'
  ): Promise<CallToolResult | InputRequiredResult> {
    const tasks = takesTasks ? this.tasks : undefined;
    let kept = false;
    const onAbort = (): void => {
      if (!kept) execution.cancel(ctx.mcpReq.signal.reason);
    };
    ctx.mcpReq.signal.addEventListener('abort', onAbort, { once: true });
    try {
      const step = tasks ? await execution.nextWithin(this.promoteAfter()) : await execution.next();
      if (step === undefined && tasks) {
        kept = true;
        this.parked.delete(execution.id);
        const task = await tasks.start(execution.owner, execution, (resume) =>
          this.startExecution(
            tool,
            args,
            execution.owner,
            execution.digest,
            scope.caller,
            outputSchema,
            {
              mode: taskMode === 'legacy' ? 'direct' : taskMode,
              approvals: execution.carry.approvals,
              ...(resume.input && { input: { ...resume.input, stateRejected: false } }),
            }
          )
        );
        return taskResult(task);
      }
      if (step === undefined) throw new Error('A tool call ended without a result');
      if (step.kind !== 'ask') this.parked.delete(execution.id);
      return await this.roundAnswer(step, execution, ctx, mint, () => {
        kept = true;
      });
    } catch (error) {
      return this.toolError(tool, errorMessageOf(error)) as CallToolResult;
    } finally {
      ctx.mcpReq.signal.removeEventListener('abort', onAbort);
    }
  }

  private async roundAnswer(
    step: ExecutionStep,
    execution: CallExecution,
    ctx: ServerContext,
    mint: (state: CallState, ctx: ServerContext) => Promise<string>,
    keep: () => void
  ): Promise<CallToolResult | InputRequiredResult> {
    const base = {
      tool: execution.tool,
      digest: execution.digest,
      ...(execution.carry.approvals.length > 0 && { approvals: execution.carry.approvals }),
    };
    switch (step.kind) {
      case 'done':
        if (step.pendingApproval && execution.digest !== '') {
          const carried = execution.carry.input;
          const resumable =
            carried && (Object.keys(carried.responses).length > 0 || carried.state !== undefined);
          return inputRequired({
            inputRequests: { [APPROVAL_KEY]: elicitInput(approvalForm(step.pendingApproval)) },
            requestState: await mint(
              {
                kind: 'approval',
                ...base,
                key: APPROVAL_KEY,
                pending: approvalDigest(step.pendingApproval),
                ...(resumable && {
                  resume: { responses: { ...carried.responses }, data: carried.state },
                }),
              },
              ctx
            ),
          });
        }
        return step.result as CallToolResult;
      case 'ask':
        keep();
        return this.askInRound(execution, step, ctx, mint);
      case 'input':
        return inputRequired({
          inputRequests: Object.fromEntries(
            Object.entries(step.requests).map(([key, request]) => [key, elicitInput(request)])
          ),
          requestState: await mint({ kind: 'tool', ...base, data: step.state }, ctx),
        });
    }
  }

  /** Ends the round with the question `execution` waits on, keeping it waiting for the answer */
  private async askInRound(
    execution: CallExecution,
    question: { key: string; request: MCPElicitRequest },
    ctx: ServerContext,
    mint: (state: CallState, ctx: ServerContext) => Promise<string>
  ): Promise<InputRequiredResult> {
    this.parked.set(execution.id, execution);
    execution.park(this.elicitationTimeout(), () => {
      this.log('info', `Nobody answered the elicitation within ${this.elicitationTimeout()} ms`);
      this.parked.delete(execution.id);
    });
    return inputRequired({
      inputRequests: { [question.key]: elicitInput(question.request) },
      requestState: await mint(
        { kind: 'parked', tool: execution.tool, digest: execution.digest, id: execution.id },
        ctx
      ),
    });
  }

  /**
   * A run of a tool call through the tool invoker, the way an agent run executes it: schema
   * validation, approval, guardrails, sandbox and `tool.timeout`. In `round` mode an approval the
   * round has no decision for ends the run, to be asked; in `task` mode it is asked in place; in
   * `direct` mode nobody can approve and the call does not run
   */
  private startExecution(
    tool: Tool,
    args: unknown,
    owner: string,
    digest: string,
    caller: MCPCaller | undefined,
    outputSchema: z.ZodType | undefined,
    run: RunMode
  ): CallExecution {
    const carry = {
      approvals: [...(run.approvals ?? [])],
      ...(run.input && { input: { responses: run.input.responses, state: run.input.state } }),
    };
    return new CallExecution(owner, tool.name, digest, carry, async (askers) => {
      let pendingApproval: ToolApprovalRequest | undefined;
      const elicit: MCPToolContext['elicit'] =
        run.mode === 'direct' ? undefined : run.mode === 'legacy' ? run.elicit : askers.elicit;
      const input = run.input
        ? askers.input(run.input.responses, run.input.state, run.input.stateRejected)
        : undefined;
      const onApproval = async (
        request: ToolApprovalRequest
      ): Promise<ToolApprovalDecision | undefined> => {
        const granted = carry.approvals.find((entry) => entry.digest === approvalDigest(request));
        if (granted) {
          return granted.approved
            ? { approved: true }
            : { approved: false, ...(granted.reason !== undefined && { reason: granted.reason }) };
        }
        if (run.mode === 'task' || run.mode === 'legacy') return elicitApproval(elicit, request);
        if (run.mode === 'round') pendingApproval = request;
        return undefined;
      };
      const result = await this.invoker().invokeTool(withParsedArguments(tool), args ?? {}, {
        runId: `mcp_${randomUUID()}`,
        agentId: 'mcp-server',
        signal: askers.signal,
        ...(caller?.userId !== undefined && { userId: caller.userId }),
        ...((elicit || input) && {
          context: { ...(elicit && { elicit }), ...(input && { input }) },
        }),
        onApproval,
      });
      const asked = askers.asked();
      if (asked) return { kind: 'input', requests: asked.requests, state: asked.state };
      if (result.pendingApproval) {
        return {
          kind: 'done',
          result: this.toolError(
            tool,
            `Tool "${tool.name}" needs the user's approval, and nobody could approve this call: ` +
              'the client cannot answer MCP elicitation requests (or the server has no sessions). ' +
              'Use a client that supports elicitation, or decide approvals on the server with ' +
              'guardrails.onToolApproval.'
          ),
          ...(pendingApproval && { pendingApproval }),
        };
      }
      if (result.error !== undefined) {
        return { kind: 'done', result: this.toolError(tool, result.error) };
      }
      if (outputSchema) {
        return {
          kind: 'done',
          result: await this.structuredResult(tool, outputSchema, result.result),
        };
      }
      return {
        kind: 'done',
        result: { content: resultToMCPContent(result.result).map(toServerContent) },
      };
    });
  }

  /**
   * The result of a tool with an output schema: `structuredContent`, with its JSON as text for
   * clients that read only `content`. It is the result as the schema parses it, so defaults are
   * filled in and unknown keys dropped the way the advertised JSON Schema expects. A result the
   * schema rejects is a tool error that says why, since MCP requires structured content to match
   * the advertised schema.
   */
  private async structuredResult(
    tool: Tool,
    outputSchema: z.ZodType,
    value: unknown
  ): Promise<ServerToolResult> {
    const parsed = await outputSchema.safeParseAsync(value);
    if (!parsed.success) {
      return this.toolError(
        tool,
        `The result does not match the tool's outputSchema: ${z.prettifyError(parsed.error)}`
      );
    }
    const reparsed = await outputSchema.safeParseAsync(parsed.data);
    if (!reparsed.success) {
      return this.toolError(
        tool,
        "The tool's outputSchema rejects what it parses itself (a transform changes the value), " +
          'and MCP checks structured content against it again: use an output schema without transforms'
      );
    }
    return {
      content: resultToMCPContent(parsed.data).map(toServerContent),
      structuredContent: parsed.data,
    };
  }

  private toolError(tool: Tool, message: string): ServerToolResult {
    this.log('error', `Tool ${tool.name} error: ${message}`);
    return { content: [{ type: 'text', text: `Error: ${message}` }], isError: true };
  }

  /**
   * Ask a client of a revision before 2026-07-28 through MCP elicitation, a request tied to the
   * tool call, for as long as `elicitationTimeoutMs` allows (an answer that does not come in time
   * counts as dismissed). `undefined` when the client cannot answer.
   */
  private async legacyElicit(
    ctx: ServerContext,
    request: MCPElicitRequest
  ): Promise<MCPElicitResult | undefined> {
    const timeout = this.elicitationTimeout();
    try {
      const result = await ctx.mcpReq.send(
        {
          method: 'elicitation/create',
          params: { mode: 'form', message: request.message, requestedSchema: request.schema },
        },
        { timeout, signal: ctx.mcpReq.signal }
      );
      return result.action === 'accept'
        ? { action: 'accept', content: { ...(result.content ?? {}) } }
        : { action: result.action };
    } catch (error) {
      if (error instanceof SdkError && error.code === SdkErrorCode.RequestTimeout) {
        this.log('info', `Nobody answered the elicitation within ${timeout} ms`);
        return { action: 'cancel' };
      }
      this.log('info', `Elicitation unavailable: ${errorMessageOf(error)}`);
      return undefined;
    }
  }

  /** The capabilities of the client of this request: its own on 2026-07-28, the handshake's before */
  private clientCapabilities(
    ctx: ServerContext,
    scope: ServeScope
  ): ClientCapabilities | undefined {
    if (scope.era === 'modern') {
      const envelope: Record<string, unknown> | undefined = ctx.mcpReq.envelope;
      const declared = envelope?.[CLIENT_CAPABILITIES_META_KEY];
      return isRecord(declared) ? (declared as ClientCapabilities) : undefined;
    }
    if (!scope.legacyCanAsk) return undefined;
    return scope.server?.server.getClientCapabilities();
  }

  private registerTaskHandlers(server: McpServer, scope: ServeScope, tasks: ServerTasks): void {
    const owner = scope.owner;
    const requireTasks = (ctx: ServerContext): void => {
      if (this.clientCapabilities(ctx, scope)?.extensions?.[TASKS_EXTENSION] === undefined) {
        throw new MissingRequiredClientCapabilityError({
          requiredCapabilities: { extensions: { [TASKS_EXTENSION]: {} } },
        });
      }
    };
    server.server.setRequestHandler(
      'tasks/get',
      { params: TaskIdParams, result: AnyResult },
      async (params, ctx) => {
        requireTasks(ctx);
        return { ...(await tasks.get(params.taskId, owner)) };
      }
    );
    server.server.setRequestHandler(
      'tasks/update',
      { params: TaskUpdateParams, result: AnyResult },
      async (params, ctx) => {
        requireTasks(ctx);
        await tasks.update(
          params.taskId,
          owner,
          params.inputResponses ?? ctx.mcpReq.inputResponses ?? {}
        );
        return {};
      }
    );
    server.server.setRequestHandler(
      'tasks/cancel',
      { params: TaskIdParams, result: AnyResult },
      async (params, ctx) => {
        requireTasks(ctx);
        await tasks.cancel(params.taskId, owner);
        return {};
      }
    );
  }

  /**
   * Write a diagnostic line to stderr when logging is enabled.
   *
   * stdout is reserved for JSON-RPC frames on the stdio transport, so every
   * log line goes to stderr regardless of level.
   */
  private log(level: 'info' | 'error', message: string): void {
    if (!this.config.logging) {
      return;
    }
    const prefix = level === 'error' ? '[MCPServer] ERROR' : '[MCPServer]';
    console.error(`${prefix} ${message}`);
  }

  /**
   * Register a resource with the MCP server
   */
  private registerMCPResource(
    server: McpServer,
    config: MCPResourceConfig,
    caller?: MCPCaller
  ): void {
    const isTemplate = config.uri.includes('{');

    const formatContents = (
      result: MCPResourceReadContent | MCPResourceReadContent[],
      uriHref: string
    ) => {
      const contents = Array.isArray(result) ? result : [result];
      return contents.map((c) => {
        const base: { uri: string; mimeType?: string } = {
          uri: c.uri || uriHref,
        };
        if (c.mimeType || config.mimeType) {
          base.mimeType = c.mimeType || config.mimeType;
        }
        if (typeof c.blob === 'string') {
          return { ...base, blob: c.blob };
        }
        return { ...base, text: c.text ?? '' };
      });
    };

    const readResource = async (params: Record<string, string>) => {
      try {
        return await config.read(params, caller);
      } catch (error) {
        this.log('error', `Resource ${config.name} error: ${errorMessageOf(error)}`);
        throw error;
      }
    };

    const metadata = {
      ...(config.description !== undefined && { description: config.description }),
      ...(config.mimeType !== undefined && { mimeType: config.mimeType }),
    };

    if (isTemplate) {
      server.registerResource(
        config.name,
        new ResourceTemplate(config.uri, { list: undefined }),
        metadata,
        async (uri: URL, variables: Record<string, string | string[]>) => {
          const params: Record<string, string> = {};
          for (const [key, value] of Object.entries(variables)) {
            params[key] = Array.isArray(value) ? value.join(',') : value;
          }
          return { contents: formatContents(await readResource(params), uri.href) };
        }
      );
    } else {
      server.registerResource(config.name, config.uri, metadata, async (uri: URL) => {
        return { contents: formatContents(await readResource({}), uri.href) };
      });
    }
  }

  /**
   * Register a prompt with the MCP server
   */
  private registerMCPPrompt(server: McpServer, config: MCPPromptConfig, caller?: MCPCaller): void {
    const render = async (args: Record<string, string>) => {
      let result: Awaited<ReturnType<MCPPromptConfig['get']>>;
      try {
        result = await config.get(args, caller);
      } catch (error) {
        this.log('error', `Prompt ${config.name} error: ${errorMessageOf(error)}`);
        throw error;
      }
      return {
        ...(result.description !== undefined && { description: result.description }),
        messages: result.messages.map((m) => ({
          role: m.role,
          content:
            typeof m.content === 'string'
              ? { type: 'text' as const, text: m.content }
              : toServerContent(m.content),
        })),
      };
    };

    const metadata = {
      title: config.title || config.name,
      ...(config.description !== undefined && { description: config.description }),
    };
    const promptArgs = config.arguments ?? [];

    if (promptArgs.length === 0) {
      server.registerPrompt(config.name, metadata, async () => render({}));
      return;
    }

    const argsShape: Record<string, z.ZodType<string | undefined>> = {};
    for (const arg of promptArgs) {
      const base = arg.description ? z.string().describe(arg.description) : z.string();
      argsShape[arg.name] = arg.required ? base : base.optional();
    }

    server.registerPrompt(
      config.name,
      { ...metadata, argsSchema: z.object(argsShape) },
      async (args: Record<string, unknown>) => {
        const stringArgs: Record<string, string> = {};
        for (const [key, value] of Object.entries(args ?? {})) {
          if (typeof value === 'string') {
            stringArgs[key] = value;
          }
        }
        return render(stringArgs);
      }
    );
  }

  /**
   * Start the MCP server
   */
  async start(): Promise<void> {
    if (this.started) {
      throw new Error('Server already started');
    }

    this.log('info', `Starting ${this.config.name} v${this.config.version}`);
    this.log('info', `Registered tools: ${this.getRegisteredTools().join(', ') || '(none)'}`);
    this.log(
      'info',
      `Registered resources: ${this.getRegisteredResources().join(', ') || '(none)'}`
    );
    this.log('info', `Registered prompts: ${this.getRegisteredPrompts().join(', ') || '(none)'}`);

    switch (this.config.transport) {
      case 'stdio': {
        this.stdio = serveStdio(
          (ctx) =>
            this.buildServer({ era: ctx.era, caller: undefined, owner: '', legacyCanAsk: true }),
          {
            legacy: this.config.legacyClients === false ? 'reject' : 'serve',
            onerror: (error) => this.log('error', `stdio error: ${error.message}`),
          }
        );
        break;
      }

      case 'http':
      case 'sse': {
        await this.startHttpServer();
        break;
      }

      default:
        throw new Error(`Unknown transport: ${String(this.config.transport)}`);
    }

    this.started = true;
    this.log('info', `Server started on ${this.config.transport} transport`);
  }

  /** The ms an elicitation waits: `elicitationTimeoutMs`, `0` as the longest timer Node keeps. */
  private elicitationTimeout(): number {
    const configured = this.config.elicitationTimeoutMs ?? DEFAULT_ELICITATION_TIMEOUT_MS;
    return configured > 0 ? Math.min(configured, MAX_TIMER_DELAY_MS) : MAX_TIMER_DELAY_MS;
  }

  private promoteAfter(): number {
    const tasks = this.config.tasks;
    return (
      (typeof tasks === 'object' ? tasks.promoteAfterMs : undefined) ?? DEFAULT_PROMOTE_AFTER_MS
    );
  }

  /**
   * The caller of an HTTP request per `config.auth`: `undefined` when the
   * server has no `auth`, `null` when the request is refused.
   */
  private async authenticate(req: IncomingMessage): Promise<MCPCaller | undefined | null> {
    if (!this.config.auth) return undefined;
    try {
      return (await this.config.auth(req)) ?? null;
    } catch (error) {
      this.log('error', `Auth error: ${errorMessageOf(error)}`);
      return null;
    }
  }

  /**
   * A request of a 2025-era client in session mode: a request without a session id starts a
   * session (an `initialize`), the others go to their session's transport. A session belongs to
   * the caller that started it.
   */
  private async handleSessionRequest(
    req: IncomingMessage & { auth?: AuthInfo },
    res: ServerResponse,
    body: unknown,
    caller: MCPCaller | undefined,
    owner: string
  ): Promise<void> {
    const header = req.headers['mcp-session-id'];
    const sessionId = Array.isArray(header) ? header[0] : header;

    if (sessionId) {
      const session = this.sessions.get(sessionId);
      if (!session) {
        writeJsonRpcError(res, 404, -32001, 'Session not found');
        return;
      }
      if (session.owner !== owner) {
        writeJsonRpcError(res, 403, -32001, 'The session belongs to another caller');
        return;
      }
      await session.transport.handleRequest(req, res, body);
      return;
    }

    const server = this.buildServer({ era: 'legacy', caller, owner, legacyCanAsk: true });
    const transport: NodeStreamableHTTPServerTransport = new NodeStreamableHTTPServerTransport({
      sessionIdGenerator: () => randomUUID(),
      onsessioninitialized: (id) => {
        this.sessions.set(id, { transport, server, caller, owner });
      },
    });
    transport.onclose = () => {
      if (transport.sessionId) this.sessions.delete(transport.sessionId);
      server.close().catch(() => {});
    };
    await server.connect(transport);
    await transport.handleRequest(req, res, body);
  }

  /** A request of a 2025-era client without sessions: served on its own */
  private async handleStatelessLegacyRequest(
    req: IncomingMessage & { auth?: AuthInfo },
    res: ServerResponse,
    body: unknown,
    caller: MCPCaller | undefined,
    owner: string
  ): Promise<void> {
    const server = this.buildServer({ era: 'legacy', caller, owner, legacyCanAsk: false });
    const transport = new NodeStreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    res.on('close', () => {
      transport.close().catch(() => {});
      server.close().catch(() => {});
    });
    await server.connect(transport);
    await transport.handleRequest(req, res, body);
  }

  /** The origins browsers may call the server from, undefined for any */
  private allowedOrigins(): readonly string[] | undefined {
    if (this.config.allowedOrigins) return this.config.allowedOrigins;
    const corsOrigin = this.config.corsOrigin ?? '*';
    return corsOrigin === '*' ? undefined : [corsOrigin];
  }

  /**
   * Start HTTP server for MCP
   */
  private async startHttpServer(): Promise<void> {
    const { createServer } = await import('node:http');

    const port = this.config.port ?? 3000;
    const host = this.config.host ?? 'localhost';
    const maxBodySize = this.config.maxBodySize ?? 10 * 1024 * 1024;
    const corsOrigin = this.config.corsOrigin ?? '*';
    const allowedOrigins = this.allowedOrigins();

    const modern = createMcpHandler(
      (ctx) =>
        this.buildServer({
          era: 'modern',
          caller: callerOf(ctx.authInfo),
          owner: ownerOfAuthInfo(ctx.authInfo),
          legacyCanAsk: false,
        }),
      {
        legacy: 'reject',
        maxRequestBodySize: maxBodySize,
        onerror: (error) => this.log('error', `HTTP error: ${error.message}`),
      }
    );
    this.httpHandler = modern;
    const serveModern: NodeMcpRequestHandler = toNodeHandler(modern, {
      maxRequestBodySize: maxBodySize,
      onerror: (error) => this.log('error', `HTTP error: ${error.message}`),
    });

    this.httpServer = createServer(async (req: IncomingMessage & { auth?: AuthInfo }, res) => {
      const origin = req.headers.origin;
      res.setHeader('Access-Control-Allow-Origin', corsOrigin);
      res.setHeader('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
      res.setHeader('Access-Control-Allow-Headers', allowedHeaders(req));
      res.setHeader('Access-Control-Expose-Headers', 'Mcp-Session-Id, MCP-Protocol-Version');

      if (origin !== undefined && !originAllowed(origin, allowedOrigins, host)) {
        writeJsonRpcError(res, 403, -32001, 'Forbidden: this origin may not call the server');
        return;
      }

      if (req.method === 'OPTIONS') {
        res.writeHead(204);
        res.end();
        return;
      }

      const pathname = new URL(req.url ?? '/', 'http://localhost').pathname;
      const protectedResource = this.config.protectedResource;
      if (protectedResource && pathname.startsWith(PRM_PATH) && req.method === 'GET') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(protectedResourceMetadata(protectedResource, req)));
        return;
      }
      if (pathname !== '/mcp') {
        res.writeHead(404);
        res.end('Not Found');
        return;
      }

      const caller = await this.authenticate(req);
      if (caller === null) {
        res.writeHead(401, {
          'Content-Type': 'application/json',
          'WWW-Authenticate': protectedResource
            ? `Bearer resource_metadata="${requestOrigin(req)}${PRM_PATH}/mcp"`
            : 'Bearer',
        });
        res.end(
          JSON.stringify({
            jsonrpc: '2.0',
            error: { code: -32001, message: 'Unauthorized' },
            id: null,
          })
        );
        return;
      }

      try {
        if (req.method !== 'POST' && req.method !== 'GET' && req.method !== 'DELETE') {
          res.writeHead(405, { 'Content-Type': 'text/plain' });
          res.end('Method Not Allowed');
          return;
        }
        const owner = ownerOf(caller, req, this.config.auth !== undefined);
        if (owner === undefined) {
          writeJsonRpcError(
            res,
            401,
            -32001,
            'Unauthorized: auth gave no userId and the request has no credential to tell callers apart'
          );
          return;
        }
        const body = req.method === 'POST' ? await readJsonBody(req, res, maxBodySize) : undefined;
        if (body === null) return;
        req.auth = authInfoOf(caller, owner);

        const legacy =
          this.config.legacyClients !== false &&
          (await isLegacyRequest(await toWebRequest(req, body), body));
        if (!legacy) {
          await serveModern(req, res, body);
          return;
        }
        if (this.config.sessions) {
          await this.handleSessionRequest(req, res, body, caller, owner);
          return;
        }
        await this.handleStatelessLegacyRequest(req, res, body, caller, owner);
      } catch (error) {
        this.log('error', `HTTP request error: ${errorMessageOf(error)}`);
        if (!res.headersSent) {
          res.writeHead(500, { 'Content-Type': 'text/plain' });
          res.end('Internal Server Error');
        }
      }
    });

    const httpServer = this.httpServer;
    try {
      await new Promise<void>((resolve, reject) => {
        httpServer.once('error', reject);
        httpServer.listen(port, host, () => {
          httpServer.off('error', reject);
          resolve();
        });
      });
    } catch (error) {
      this.httpServer = undefined;
      await modern.close().catch(() => {});
      this.httpHandler = undefined;
      throw error;
    }

    this.log('info', `HTTP server listening on http://${host}:${this.getPort() ?? port}/mcp`);
  }

  /**
   * Port the HTTP transport is listening on (useful with `port: 0`).
   * Returns undefined for stdio or before the server has started.
   */
  getPort(): number | undefined {
    const address = this.httpServer?.address();
    return address && typeof address === 'object' ? address.port : undefined;
  }

  /**
   * Stop the server
   */
  async stop(): Promise<void> {
    if (!this.started) {
      return;
    }

    try {
      const sessions = [...this.sessions.values()];
      this.sessions.clear();
      await Promise.all(sessions.map(({ transport }) => transport.close().catch(() => {})));
      for (const execution of this.parked.values())
        execution.cancel(new Error('The server stopped'));
      this.parked.clear();
      this.tasks?.closeAll();
      const handler = this.httpHandler;
      this.httpHandler = undefined;
      await handler?.close().catch(() => {});
      const httpServer = this.httpServer;
      if (httpServer) {
        this.httpServer = undefined;
        await new Promise<void>((resolve, reject) => {
          httpServer.close((err) => (err ? reject(err) : resolve()));
          httpServer.closeAllConnections();
        });
      }
    } finally {
      const stdio = this.stdio;
      this.stdio = undefined;
      this.started = false;
      const own = this.ownInvoker;
      this.ownInvoker = undefined;
      if (stdio) {
        await stdio.close();
      }
      await own?.close();
    }

    this.log('info', 'Server stopped');
  }

  /**
   * Check if server is running
   */
  isRunning(): boolean {
    return this.started;
  }
}

/**
 * Create and start an MCP server with the given tools
 *
 * @example
 * ```typescript
 * await serveMCPTools([calculator, datetime], {
 *   name: 'my-tools',
 *   version: '1.0.0',
 *   transport: 'stdio',
 * });
 * ```
 */
export async function serveMCPTools(
  tools: readonly Tool[],
  config: MCPServerConfig
): Promise<MCPServer> {
  const server = new MCPServer(config);
  server.registerTools(tools);
  await server.start();
  return server;
}

/** A task as the result of `tools/call` (`resultType: "task"`) */
function taskResult(task: Record<string, unknown>): CallToolResult {
  return { content: [], ...task, resultType: 'task' } as CallToolResult;
}

/** The digest an approval is kept by: the tool and arguments of the request it decides */
function approvalDigest(request: ToolApprovalRequest): string {
  return callDigest(request.toolName, request.arguments);
}

/** An elicitation form as an input request of `InputRequiredResult` */
function elicitInput(request: MCPElicitRequest): InputRequest {
  return inputRequired.elicit({
    message: request.message,
    requestedSchema: request.schema,
  });
}

/** The answers of a round, the entries that are elicitation results */
function elicitResults(
  responses: Record<string, unknown> | undefined
): Record<string, MCPElicitResult> {
  const results: Record<string, MCPElicitResult> = {};
  for (const [key, value] of Object.entries(responses ?? {})) {
    const parsed = parseElicitResult(value);
    if (parsed) results[key] = parsed;
  }
  return results;
}

/**
 * Whom the tasks, waiting runs and round states of a request belong to: everyone alike on a
 * server without `auth`, else the caller's `userId`, else the credential the request carries (a
 * digest of its `Authorization` or `Cookie` header). Undefined for a caller `auth` let in that
 * nothing tells apart from other callers, a request the server refuses
 */
function ownerOf(
  caller: MCPCaller | undefined,
  req: IncomingMessage,
  hasAuth: boolean
): string | undefined {
  if (!hasAuth) return '';
  if (caller?.userId !== undefined) return `user:${caller.userId}`;
  const credential = req.headers.authorization ?? req.headers.cookie;
  if (!credential) return undefined;
  return `credential:${createHash('sha256').update(credential).digest('base64url')}`;
}

/** The `AuthInfo` the MCP SDK carries for a caller to the server it builds for the request */
function authInfoOf(caller: MCPCaller | undefined, owner: string): AuthInfo {
  return {
    token: '',
    clientId: caller?.userId ?? 'anonymous',
    scopes: caller?.scopes ?? [],
    extra: { ...(caller && { caller }), owner },
  };
}

function callerOf(authInfo: AuthInfo | undefined): MCPCaller | undefined {
  const caller: unknown = authInfo?.extra?.caller;
  return isRecord(caller) ? (caller as MCPCaller) : undefined;
}

function ownerOfAuthInfo(authInfo: AuthInfo | undefined): string {
  const owner: unknown = authInfo?.extra?.owner;
  return typeof owner === 'string' ? owner : '';
}

const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]', '::1']);

function isLoopbackHost(host: string): boolean {
  return LOOPBACK_HOSTS.has(host) || host.startsWith('127.') || host.endsWith('.localhost');
}

/**
 * Whether a browser of `origin` may call the server: one of `allowed` when it is set, else a
 * loopback origin when the server listens on a loopback host (so a web page cannot reach a local
 * server through DNS rebinding), else any origin
 */
function originAllowed(
  origin: string,
  allowed: readonly string[] | undefined,
  host: string
): boolean {
  if (allowed) return allowed.includes(origin);
  if (!isLoopbackHost(host)) return true;
  try {
    return isLoopbackHost(new URL(origin).hostname);
  } catch {
    return false;
  }
}

const PRM_PATH = '/.well-known/oauth-protected-resource';

/** The origin a request reached the server at, from its `Host` header */
function requestOrigin(req: IncomingMessage): string {
  const forwarded = req.headers['x-forwarded-proto'];
  const proto = (Array.isArray(forwarded) ? forwarded[0] : forwarded) ?? 'http';
  return `${proto}://${req.headers.host ?? 'localhost'}`;
}

/** The OAuth Protected Resource Metadata of the server (RFC 9728) */
function protectedResourceMetadata(
  config: MCPProtectedResourceConfig,
  req: IncomingMessage
): Record<string, unknown> {
  return {
    resource: config.resource ?? `${requestOrigin(req)}/mcp`,
    authorization_servers: [...config.authorizationServers],
    bearer_methods_supported: ['header'],
    ...(config.scopesSupported && { scopes_supported: [...config.scopesSupported] }),
    ...(config.resourceName && { resource_name: config.resourceName }),
  };
}

const STANDARD_HEADERS =
  'Content-Type, Authorization, Mcp-Session-Id, MCP-Protocol-Version, Mcp-Method, Mcp-Name, Last-Event-ID';

/**
 * The headers a browser may send: the standard MCP ones and whatever the preflight asks for,
 * since the `Mcp-Param-*` headers of tool arguments are named by the tools
 */
function allowedHeaders(req: IncomingMessage): string {
  const requested = req.headers['access-control-request-headers'];
  const asked = (Array.isArray(requested) ? requested.join(',') : (requested ?? ''))
    .split(',')
    .map((name) => name.trim())
    .filter((name) => /^mcp-param-[!#$%&'*+.^_`|~0-9a-z-]+$/i.test(name));
  return asked.length > 0 ? `${STANDARD_HEADERS}, ${asked.join(', ')}` : STANDARD_HEADERS;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** The JSON body of a POST, or `null` when the request was answered (too large, invalid JSON). */
async function readJsonBody(
  req: IncomingMessage,
  res: ServerResponse,
  maxBodySize: number
): Promise<unknown> {
  const chunks: Buffer[] = [];
  let totalSize = 0;
  for await (const chunk of req) {
    const buffer = chunk as Buffer;
    totalSize += buffer.length;
    if (totalSize > maxBodySize) {
      res.writeHead(413, { 'Content-Type': 'text/plain' });
      res.end('Payload Too Large');
      req.destroy();
      return null;
    }
    chunks.push(buffer);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString()) as unknown;
  } catch {
    writeJsonRpcError(res, 400, -32700, 'Parse error: invalid JSON');
    return null;
  }
}

function writeJsonRpcError(
  res: ServerResponse,
  status: number,
  code: number,
  message: string
): void {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ jsonrpc: '2.0', error: { code, message }, id: null }));
}
