import type { Message, RunMiddleware, RunMiddlewareContext, ToolResult } from '@cogitator-ai/types';

/** Where the references a run opened are kept in the run's middleware state */
const OPENED = 'memory.citations.opened';

/** A reference to memory in an answer: `[turn:<id>]` or `[item:<id>]` */
const REFERENCE = /\s?\[(turn|item):([^\]\s]+)\]/g;

/** A reference as the memory tools hand it out, inside their results */
const HANDED_OUT = /\b(turn|item):([A-Za-z0-9_-]+)/g;

export interface MemoryCitationsOptions {
  /** Tools whose results hand out references, the memory search tools by default */
  tools?: readonly string[];
  /** Called with the references an answer made to what the run never opened */
  onUncited?: (references: string[], context: RunMiddlewareContext) => void;
}

function referencesIn(text: string): string[] {
  return [...text.matchAll(HANDED_OUT)].map((match) => `${match[1]}:${match[2]}`);
}

function textOf(message: Message): string {
  if (typeof message.content === 'string') return message.content;
  return message.content.map((part) => ('text' in part ? part.text : '')).join('\n');
}

function openedOf(context: RunMiddlewareContext): Set<string> {
  let opened = context.state.get(OPENED);
  if (!(opened instanceof Set)) {
    opened = new Set<string>();
    context.state.set(OPENED, opened);
  }
  return opened as Set<string>;
}

/**
 * Locks what an answer cites from memory to what the run actually opened. The memory search tools
 * hand out references, `[item:<id>]` with a memory item a search returned and `[turn:<id>]` with a
 * turn `open_turns` opened. A final answer that cites a reference no tool of the run handed out
 * has that reference taken out, and `onUncited` hears of it. An answer without references is left
 * as it is. What was opened is read from the run's tool results, so a resumed run, or one whose
 * old tool outputs were cleared, still knows what it opened.
 *
 * @example
 * ```ts
 * const cog = new Cogitator({ memory, middleware: [memoryCitations()] });
 * const tools = await cog.memorySearchTools('concierge');
 * const agent = new Agent({ name: 'concierge', model, instructions, tools });
 * ```
 */
export function memoryCitations(options: MemoryCitationsOptions = {}): RunMiddleware {
  const tools = new Set(options.tools ?? ['search_memory', 'open_turns']);
  return {
    name: 'memory.citations',
    holdsStream: true,
    async wrapToolCall(call, next, context): Promise<ToolResult> {
      const result = await next(call);
      if (tools.has(call.tool.name) && result.error === undefined) {
        const opened = openedOf(context);
        for (const reference of referencesIn(JSON.stringify(result.result ?? null))) {
          opened.add(reference);
        }
      }
      return result;
    },
    afterModel({ response, messages }, context) {
      if ((response.toolCalls?.length ?? 0) > 0 || !response.content.includes('[')) return;
      const opened = new Set(openedOf(context));
      for (const message of messages) {
        if (message.role === 'tool' && message.name !== undefined && tools.has(message.name)) {
          for (const reference of referencesIn(textOf(message))) opened.add(reference);
        }
      }
      const uncited: string[] = [];
      const content = response.content.replace(REFERENCE, (marker, kind: string, id: string) => {
        const reference = `${kind}:${id}`;
        if (opened.has(reference)) return marker;
        uncited.push(reference);
        return '';
      });
      if (uncited.length === 0) return;
      options.onUncited?.(uncited, context);
      return { content };
    },
  };
}
