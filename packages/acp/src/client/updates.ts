import type { SessionUpdate, ToolCallContent } from '@agentclientprotocol/sdk';
import type { StreamEvent } from '@cogitator-ai/server-shared';
import type { TodoItem } from '@cogitator-ai/types';

type Part = 'text' | 'reasoning';

interface CallState {
  name: string;
  title: string;
  settled: boolean;
}

/** The text of a tool call's content, as a tool result reads it */
export function contentText(content: readonly ToolCallContent[] | null | undefined): string {
  return (content ?? [])
    .map((item) => {
      if (item.type === 'content') return item.content.type === 'text' ? item.content.text : '';
      if (item.type === 'diff') return `Edited ${item.path}`;
      return `Terminal ${item.terminalId}`;
    })
    .filter((text) => text !== '')
    .join('\n');
}

/**
 * The events of the stream protocol from the `session/update` notifications of an external ACP
 * agent's turn, so app-server clients see its turns as those of any agent: message chunks as
 * text, thought chunks as reasoning, tool calls with their arguments, progress and results, and
 * the plan as a `write_todos` call. Updates about the session itself (modes, commands, usage)
 * are no events of a turn
 */
export class AcpStreamMapper {
  private open: { kind: Part; id: string } | undefined;
  private readonly calls = new Map<string, CallState>();
  private parts = 0;
  private plans = 0;
  private text = '';

  constructor(private readonly emit: (event: StreamEvent) => void) {}

  /** What the agent said in the turn */
  get output(): string {
    return this.text;
  }

  update(update: SessionUpdate): void {
    switch (update.sessionUpdate) {
      case 'agent_message_chunk':
        if (update.content.type === 'text' && update.content.text !== '') {
          this.text += update.content.text;
          this.delta('text', update.content.text);
        }
        return;
      case 'agent_thought_chunk':
        if (update.content.type === 'text' && update.content.text !== '') {
          this.delta('reasoning', update.content.text);
        }
        return;
      case 'tool_call': {
        this.endPart();
        const name = update.name ?? update.title;
        const known = this.calls.get(update.toolCallId);
        if (!known) {
          this.calls.set(update.toolCallId, { name, title: update.title, settled: false });
          this.emit({ type: 'tool-call-start', id: update.toolCallId, toolName: name });
          if (update.rawInput !== undefined) {
            this.emit({
              type: 'tool-call-delta',
              id: update.toolCallId,
              argsTextDelta: JSON.stringify(update.rawInput),
            });
          }
          this.emit({ type: 'tool-call-end', id: update.toolCallId });
        }
        this.settle(update.toolCallId, update.status, update.rawOutput, update.content);
        return;
      }
      case 'tool_call_update': {
        this.endPart();
        let call = this.calls.get(update.toolCallId);
        if (!call) {
          const name = update.name ?? update.title ?? 'tool';
          call = { name, title: update.title ?? name, settled: false };
          this.calls.set(update.toolCallId, call);
          this.emit({ type: 'tool-call-start', id: update.toolCallId, toolName: name });
          this.emit({ type: 'tool-call-end', id: update.toolCallId });
        }
        if (update.title) call.title = update.title;
        if (update.status === 'completed' || update.status === 'failed') {
          this.settle(update.toolCallId, update.status, update.rawOutput, update.content);
          return;
        }
        const args =
          update.rawInput !== null &&
          typeof update.rawInput === 'object' &&
          !Array.isArray(update.rawInput)
            ? (update.rawInput as Record<string, unknown>)
            : undefined;
        const text = contentText(update.content);
        if (args || text !== '' || update.title) {
          this.emit({
            type: 'tool-update',
            toolCallId: update.toolCallId,
            ...(args && { arguments: args }),
            ...(text !== '' && { content: text }),
            ...(update.title && { presentation: { label: update.title } }),
          });
        }
        return;
      }
      case 'plan': {
        this.endPart();
        const id = `plan_${++this.plans}`;
        const todos: TodoItem[] = update.entries.map((entry, index) => ({
          id: String(index + 1),
          content: entry.content,
          status: entry.status,
        }));
        this.emit({ type: 'tool-call-start', id, toolName: 'write_todos' });
        this.emit({ type: 'tool-call-delta', id, argsTextDelta: JSON.stringify({ todos }) });
        this.emit({ type: 'tool-call-end', id });
        this.emit({
          type: 'tool-result',
          id: `${id}_result`,
          toolCallId: id,
          result: { todos },
          presentation: { label: 'Plan', icon: 'list-todo' },
        });
        return;
      }
      default:
        return;
    }
  }

  /** Closes what is open once the turn ended: the text or reasoning going on */
  end(): void {
    this.endPart();
  }

  private settle(
    id: string,
    status: string | null | undefined,
    rawOutput: unknown,
    content: readonly ToolCallContent[] | null | undefined
  ): void {
    const call = this.calls.get(id);
    if (!call || call.settled || (status !== 'completed' && status !== 'failed')) return;
    call.settled = true;
    const text = contentText(content);
    const result =
      status === 'failed'
        ? { error: text !== '' ? text : 'The tool call failed' }
        : rawOutput !== undefined
          ? rawOutput
          : text;
    this.emit({
      type: 'tool-result',
      id: `${id}_result`,
      toolCallId: id,
      result,
      presentation: { label: call.title },
    });
  }

  private delta(kind: Part, delta: string): void {
    if (this.open?.kind !== kind) {
      this.endPart();
      this.open = { kind, id: `${kind}_${++this.parts}` };
      this.emit(
        kind === 'text'
          ? { type: 'text-start', id: this.open.id }
          : { type: 'reasoning-start', id: this.open.id }
      );
    }
    this.emit(
      kind === 'text'
        ? { type: 'text-delta', id: this.open.id, delta }
        : { type: 'reasoning-delta', id: this.open.id, delta }
    );
  }

  private endPart(): void {
    const open = this.open;
    if (!open) return;
    this.open = undefined;
    this.emit(
      open.kind === 'text'
        ? { type: 'text-end', id: open.id }
        : { type: 'reasoning-end', id: open.id }
    );
  }
}
