import type {
  PlanEntry,
  SessionUpdate,
  ToolCallContent,
  ToolCallUpdate,
  ToolKind,
} from '@agentclientprotocol/sdk';
import type { StreamEvent } from '@cogitator-ai/server-shared';
import type { TodoItem, Tool, ToolResult, Workspace } from '@cogitator-ai/types';
import { diffOfToolCall, kindOf, resultContent, viewOfToolCall } from './tool-calls.js';

/** An update, or one still being worked out (a diff read from a file), sent in the order given */
export type PendingUpdate = SessionUpdate | Promise<SessionUpdate | undefined>;

export interface TurnUpdatesOptions {
  /** The tool of a name, for its presentation and what it touches */
  tool: (name: string) => Tool | undefined;
  /** The workspace of the session, where the diffs of edits are read */
  workspace?: Workspace;
  /** Where relative paths start, the session's directory */
  root: string;
  send: (update: PendingUpdate) => void;
}

/** Tools an editor never sees as calls: the todo list goes out as the plan */
const HIDDEN_TOOLS = new Set(['write_todos']);

/** How the turn's stream finished, from its `finish` event */
export interface TurnFinish {
  truncated?: boolean;
  blocked?: string;
  iterationLimitReached?: boolean;
}

interface CallState {
  name: string;
  args: string;
  input?: Record<string, unknown>;
  kind: ToolKind;
  diff?: Promise<ToolCallContent | undefined>;
  terminal?: string;
  settled: boolean;
}

/** The todo list of the agent as the plan of the session */
export function planOf(todos: readonly TodoItem[]): SessionUpdate {
  return {
    sessionUpdate: 'plan',
    entries: todos.map((todo): PlanEntry => ({
      content: todo.content,
      priority: 'medium',
      status: todo.status,
    })),
  };
}

function parseArgs(text: string): Record<string, unknown> | undefined {
  if (text.trim() === '') return {};
  try {
    const value: unknown = JSON.parse(text);
    return value !== null && typeof value === 'object' && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : undefined;
  } catch {
    return undefined;
  }
}

/**
 * The `session/update` notifications of one turn, from the events of its stream: text as
 * message chunks, reasoning as thought chunks, each tool call as a `tool_call` updated as its
 * arguments come in, as it runs and as it ends, with the diff of an edit and the terminal a
 * command runs in. Events of runs the turn delegated stay out: their tool call shows them
 */
export class TurnUpdates {
  private readonly calls = new Map<string, CallState>();
  private readonly errors = new Map<string, string>();
  private finished: TurnFinish | undefined;

  constructor(private readonly options: TurnUpdatesOptions) {}

  /** How the last turn's stream finished, once it did */
  get finish(): TurnFinish | undefined {
    return this.finished;
  }

  /** Whether the editor was told of tool call `id` */
  known(id: string): boolean {
    return this.calls.has(id);
  }

  /** The command a tool call runs, once its arguments are known */
  commandOf(id: string): string | undefined {
    const command = this.calls.get(id)?.input?.command;
    return typeof command === 'string' ? command : undefined;
  }

  event(event: StreamEvent): void {
    switch (event.type) {
      case 'text-delta':
        if (event.delta !== '') {
          this.options.send({
            sessionUpdate: 'agent_message_chunk',
            content: { type: 'text', text: event.delta },
          });
        }
        return;
      case 'reasoning-delta':
        if (event.delta !== '') {
          this.options.send({
            sessionUpdate: 'agent_thought_chunk',
            content: { type: 'text', text: event.delta },
          });
        }
        return;
      case 'tool-call-start':
        this.start(event.id, event.toolName);
        return;
      case 'tool-call-delta': {
        const call = this.calls.get(event.id);
        if (call) call.args += event.argsTextDelta;
        return;
      }
      case 'tool-call-end':
        if (event.dropped) return;
        this.ready(event.id);
        return;
      case 'tool-update':
        this.progress(event.toolCallId, event.arguments, event.content);
        return;
      case 'tool-result':
        this.settle(event.toolCallId, event.result, event.dropped === true);
        return;
      case 'finish':
        this.finished = {
          ...(event.truncated && { truncated: true }),
          ...(event.blocked !== undefined && { blocked: event.blocked }),
          ...(event.iterationLimitReached && { iterationLimitReached: true }),
        };
        return;
      default:
        return;
    }
  }

  /** Records a tool result's error, heard before its event */
  toolResult(result: ToolResult): void {
    if (result.error !== undefined) this.errors.set(result.callId, result.error);
  }

  /**
   * Tells the editor of a call it has not heard of, such as one a subagent asks approval for, so
   * a question about it names a call it shows
   */
  announce(id: string, name: string, args: Record<string, unknown>): void {
    if (this.calls.has(id)) return;
    this.start(id, name);
    const call = this.calls.get(id);
    if (call) call.args = JSON.stringify(args);
    this.ready(id);
  }

  /** The diff an edit call makes, when it is one */
  diffOf(id: string): Promise<ToolCallContent | undefined> {
    return this.calls.get(id)?.diff ?? Promise.resolve(undefined);
  }

  /** Embeds the terminal a command runs in into the call that runs it, the oldest running one */
  terminal(terminalId: string, command: string): void {
    for (const [id, call] of this.calls) {
      if (call.settled || call.kind !== 'execute' || call.terminal !== undefined) continue;
      if (this.commandOf(id) !== command) continue;
      call.terminal = terminalId;
      this.options.send({
        sessionUpdate: 'tool_call_update',
        toolCallId: id,
        status: 'in_progress',
        content: [{ type: 'terminal', terminalId }],
      });
      return;
    }
  }

  private start(id: string, name: string): void {
    if (this.calls.has(id)) return;
    const tool = this.options.tool(name);
    const kind = kindOf(name, tool);
    this.calls.set(id, { name, args: '', kind, settled: false });
    if (HIDDEN_TOOLS.has(name)) return;
    this.options.send({
      sessionUpdate: 'tool_call',
      toolCallId: id,
      title: name,
      kind,
      status: 'pending',
    });
  }

  private ready(id: string): void {
    const call = this.calls.get(id);
    if (!call || call.input !== undefined) return;
    const input = parseArgs(call.args);
    if (!input) return;
    this.describe(id, call, input);
  }

  private progress(id: string, args: Record<string, unknown> | undefined, content: unknown): void {
    const call = this.calls.get(id);
    if (!call || HIDDEN_TOOLS.has(call.name)) return;
    if (args) this.describe(id, call, args);
    if (content !== undefined && call.terminal === undefined) {
      this.options.send({
        sessionUpdate: 'tool_call_update',
        toolCallId: id,
        status: 'in_progress',
        content: resultContent(content),
      });
    }
  }

  private describe(id: string, call: CallState, input: Record<string, unknown>): void {
    call.input = input;
    if (HIDDEN_TOOLS.has(call.name)) return;
    const tool = this.options.tool(call.name);
    const view = viewOfToolCall(call.name, input, tool, this.options.root);
    call.kind = view.kind;
    call.diff = diffOfToolCall(call.name, input, this.options.workspace);
    const update: ToolCallUpdate = {
      toolCallId: id,
      title: view.title,
      kind: view.kind,
      rawInput: input,
      ...(view.locations.length > 0 && { locations: view.locations }),
    };
    this.options.send(
      call.diff.then((diff): SessionUpdate => ({
        sessionUpdate: 'tool_call_update',
        ...update,
        ...(diff && { content: [diff] }),
      }))
    );
  }

  private settle(id: string, result: unknown, dropped: boolean): void {
    const call = this.calls.get(id);
    if (!call || call.settled) return;
    call.settled = true;
    if (HIDDEN_TOOLS.has(call.name)) return;
    const error = dropped ? 'The call never ran' : this.errors.get(id);
    this.errors.delete(id);
    const diff = call.diff ?? Promise.resolve(undefined);
    const terminal = call.terminal;
    this.options.send(
      diff.then((change): SessionUpdate => ({
        sessionUpdate: 'tool_call_update',
        toolCallId: id,
        status: error === undefined ? 'completed' : 'failed',
        content: [
          ...(terminal !== undefined
            ? [{ type: 'terminal' as const, terminalId: terminal }]
            : resultContent(result, error)),
          ...(change && error === undefined ? [change] : []),
        ],
        ...(result !== undefined && { rawOutput: result }),
      }))
    );
  }
}
