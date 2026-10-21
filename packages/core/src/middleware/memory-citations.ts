import type { Message, RunMiddleware, RunMiddlewareContext, ToolResult } from '@cogitator-ai/types';

/** Where the references a run opened are kept in the run's middleware state */
const OPENED = 'memory.citations.opened';

/** Brackets in an answer that may cite memory, with the space before them */
const BRACKETS = /(\s?)[[［]([^\]］[［]*)[\]］]/g;

/**
 * A reference to memory, as an answer may write it (`turn:<id>`, `item: <id>`, `Turn:<id>`):
 * an id as the tools hand them out holds a digit, `_` or `-`, so `[item: string]` is not one
 */
const CITED = /^(turn|item)\s*:\s*([A-Za-z0-9_-]*[0-9_-][A-Za-z0-9_-]*)$/i;

/** Code in an answer, which the lock leaves as it is */
const CODE = /(```[\s\S]*?```|`[^`\n]*`)/;

/** A `ref` field of a memory tool's result, as its JSON holds it, whole or cut */
const REF_FIELD = /"ref"\s*:\s*"((?:turn|item):[^"\\]+)"/g;

/** A reference the memory tools hand out */
const HANDED_OUT = /^(?:turn|item):\S+$/;

export interface MemoryCitationsOptions {
  /** Tools whose results hand out references, the memory search tools by default */
  tools?: readonly string[];
  /** Called with the references an answer made to what the run never opened */
  onUncited?: (references: string[], context: RunMiddlewareContext) => void;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * The references a memory tool's result hands out: the `ref` of each item a search returned and
 * of each turn `open_turns` opened. Text inside the results, such as an earlier answer that
 * cited something, hands out nothing.
 */
function referencesOf(result: unknown): string[] {
  if (!isRecord(result)) return [];
  return ['results', 'turns'].flatMap((field) => {
    const list = result[field];
    if (!Array.isArray(list)) return [];
    return list.flatMap((entry) =>
      isRecord(entry) && typeof entry.ref === 'string' && HANDED_OUT.test(entry.ref)
        ? [entry.ref]
        : []
    );
  });
}

function textOf(message: Message): string {
  if (typeof message.content === 'string') return message.content;
  return message.content.map((part) => ('text' in part ? part.text : '')).join('\n');
}

/**
 * The references a tool message of a memory tool handed out: the `ref` fields of its JSON, read
 * also from a message cut short, while text inside its strings, quoted and escaped, hands out
 * nothing
 */
function referencesInMessage(message: Message): string[] {
  return [...textOf(message).matchAll(REF_FIELD)].flatMap((match) =>
    match[1] && HANDED_OUT.test(match[1]) ? [match[1]] : []
  );
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
        for (const reference of referencesOf(result.result)) opened.add(reference);
      }
      return result;
    },
    afterModel({ response, messages }, context) {
      if ((response.toolCalls?.length ?? 0) > 0 || !/[[［]/.test(response.content)) return;
      const opened = new Set(openedOf(context));
      for (const message of messages) {
        if (message.role === 'tool' && message.name !== undefined && tools.has(message.name)) {
          for (const reference of referencesInMessage(message)) opened.add(reference);
        }
      }
      const uncited: string[] = [];
      const check = (text: string) =>
        text.replace(BRACKETS, (marker, space: string, inside: string) => {
          const parts = inside.split(/\s*[,;]\s*/);
          const cited = parts.map((part) => CITED.exec(part.trim()));
          if (cited.every((match) => match === null)) return marker;
          const kept = parts.filter((_, at) => {
            const match = cited[at];
            if (!match) return true;
            const reference = `${match[1]!.toLowerCase()}:${match[2]}`;
            if (opened.has(reference)) return true;
            uncited.push(reference);
            return false;
          });
          if (kept.length === parts.length) return marker;
          if (kept.length === 0) return space.includes('\n') ? space : '';
          return `${space}[${kept.join(', ')}]`;
        });
      const content = response.content
        .split(CODE)
        .map((piece, at) => (at % 2 === 1 ? piece : check(piece)))
        .join('');
      if (uncited.length === 0) return;
      options.onUncited?.(uncited, context);
      return { content };
    },
  };
}
