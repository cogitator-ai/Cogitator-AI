import { z } from 'zod';
import { BM25Index } from '@cogitator-ai/memory';
import type { Message, Tool, ToolCall } from '@cogitator-ai/types';
import { tool } from '../tool';
import { getTextContent } from '../cogitator/span-factory';

/** Name of the built-in tool that finds and loads deferred tools */
export const TOOL_SEARCH = 'tool_search';

const DEFAULT_RESULTS = 5;
const MAX_RESULTS = 20;
const MAX_RESULT_DESCRIPTION = 300;

/** What `tool_search` returns, and what a run reads back from its results to know what is loaded. */
const searchResultSchema = z.object({
  tools: z.array(z.object({ name: z.string(), description: z.string() })),
  note: z.string(),
});

/**
 * `text` with its identifiers also split into words: `readFile`, `read_file` and `read-file` each
 * add `read file`, `HTTPServer` adds `HTTP Server`. The original text stays, so a query for the
 * whole identifier still matches. One pass over the characters.
 */
export function withIdentifierWords(text: string): string {
  let split = '';
  for (let index = 0; index < text.length; index++) {
    const char = text[index]!;
    if (char === '_' || char === '-' || char === '.' || char === '/') {
      split += ' ';
      continue;
    }
    const previous = text[index - 1];
    const next = text[index + 1];
    if (isUpper(char) && previous !== undefined) {
      const startsWord =
        isLower(previous) ||
        isDigit(previous) ||
        (isUpper(previous) && next !== undefined && isLower(next));
      if (startsWord) split += ' ';
    }
    split += char;
  }
  return split === text ? text : `${text} ${split}`;
}

function isUpper(char: string): boolean {
  return char >= 'A' && char <= 'Z';
}

function isLower(char: string): boolean {
  return char >= 'a' && char <= 'z';
}

function isDigit(char: string): boolean {
  return char >= '0' && char <= '9';
}

/** The text a deferred tool is found by: its name (twice, it says most), description and parameters. */
function searchText(candidate: Tool): string {
  const parts = [candidate.name, candidate.name, candidate.description];
  try {
    const properties = candidate.toJSON().parameters.properties;
    for (const [name, schema] of Object.entries(properties)) {
      parts.push(name);
      const description = (schema as { description?: unknown } | null)?.description;
      if (typeof description === 'string') parts.push(description);
    }
  } catch {}
  return withIdentifierWords(parts.join(' '));
}

/**
 * The tools of `tools` that best match `query`, best first: BM25 over each tool's name,
 * description and parameter names and descriptions, with identifiers split into words. A query
 * that names a tool exactly finds it first.
 */
export function rankTools(tools: readonly Tool[], query: string, limit: number): Tool[] {
  const byName = new Map(tools.map((candidate) => [candidate.name, candidate]));
  const exact = query
    .split(/[\s,]+/)
    .map((word) => byName.get(word))
    .filter((found): found is Tool => found !== undefined);
  const index = new BM25Index();
  index.addDocuments(
    tools.map((candidate) => ({ id: candidate.name, content: searchText(candidate) }))
  );
  const ranked = index
    .search(withIdentifierWords(query), limit + exact.length)
    .map((hit) => byName.get(hit.id))
    .filter((found): found is Tool => found !== undefined);
  return [...new Set([...exact, ...ranked])].slice(0, limit);
}

export interface ToolSearchOptions {
  /** The deferred tools of the run, as they are when the model searches */
  deferred: () => readonly Tool[];
  /** Called with the names of the tools a search found, which the run loads */
  onFound?: (names: readonly string[]) => void;
}

/**
 * The `tool_search` tool: finds deferred tools (`Tool.deferred`) by what they do and loads the
 * best matches, whose schemas the run sends from the next model turn on. The run offers it while
 * it has deferred tools.
 */
export function toolSearchTool(options: ToolSearchOptions): Tool {
  return tool({
    name: TOOL_SEARCH,
    description:
      'Find more tools. Some tools are not loaded until searched for: describe what you need (an action, an object, a service) and the best matching tools are loaded, callable from your next turn. Search before deciding a tool you need is missing.',
    parameters: z.object({
      query: z.string().min(1).describe('What the tool should do, in a few words, or a tool name'),
      limit: z
        .number()
        .int()
        .min(1)
        .max(MAX_RESULTS)
        .default(DEFAULT_RESULTS)
        .describe(`Most tools to load (default ${DEFAULT_RESULTS})`),
    }),
    execute: async ({ query, limit }) => {
      const found = rankTools(options.deferred(), query, limit);
      options.onFound?.(found.map((candidate) => candidate.name));
      return {
        tools: found.map((candidate) => ({
          name: candidate.name,
          description: cut(candidate.description, MAX_RESULT_DESCRIPTION),
        })),
        note:
          found.length > 0
            ? 'These tools are loaded: call them from your next turn.'
            : 'No tool matches. Search again with other words: what the tool does, its object or its parameters.',
      } satisfies z.infer<typeof searchResultSchema>;
    },
  });
}

/** How the note that keeps loaded tools through a compaction starts. */
const LOADED_TOOLS_HEADER = 'Tools tool_search loaded earlier in this conversation, callable now:';

/** A system message that keeps `names` loaded after a compaction dropped the searches that found them. */
export function loadedToolsNote(names: Iterable<string>): Message {
  return { role: 'system', content: `${LOADED_TOOLS_HEADER}\n${[...names].join(', ')}` };
}

/** Whether `message` is a note {@link loadedToolsNote} made. */
export function isLoadedToolsNote(message: Message): boolean {
  return (
    message.role === 'system' &&
    getTextContent(message.content).startsWith(`${LOADED_TOOLS_HEADER}\n`)
  );
}

/**
 * Names of the tools the `tool_search` calls of `messages` loaded, read from their results (and
 * from the notes that kept them through a compaction), so a run that goes on from these messages
 * (resumed, forked, handed over or a later run of the thread) keeps them loaded.
 */
export function toolsFoundIn(messages: readonly Message[]): Set<string> {
  const searches = new Set<string>();
  const found = new Set<string>();
  for (const message of messages) {
    if (isLoadedToolsNote(message)) {
      const names = getTextContent(message.content).slice(LOADED_TOOLS_HEADER.length + 1);
      for (const name of names.split(',')) if (name.trim()) found.add(name.trim());
      continue;
    }
    if (message.role === 'assistant' && 'toolCalls' in message) {
      const calls: unknown = message.toolCalls;
      if (Array.isArray(calls)) {
        for (const call of calls as ToolCall[]) {
          if (call.name === TOOL_SEARCH) searches.add(call.id);
        }
      }
      continue;
    }
    if (message.role !== 'tool') continue;
    const isSearch =
      message.name === TOOL_SEARCH ||
      (message.toolCallId !== undefined && searches.has(message.toolCallId));
    if (!isSearch) continue;
    const result = searchResultSchema.safeParse(parseJson(getTextContent(message.content)));
    if (result.success) for (const entry of result.data.tools) found.add(entry.name);
  }
  return found;
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

function cut(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max - 3)}...`;
}
