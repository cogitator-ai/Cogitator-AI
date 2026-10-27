import { isRecord } from './schema';

/** A tool call of a transcript, under the name the transcript gives it */
export interface TranscriptToolCall {
  id: string;
  name: string;
  input: Record<string, unknown>;
}

/** One message of a session, in the order it happened */
export type TranscriptEntry =
  | { role: 'user'; text: string }
  | { role: 'assistant'; text: string; toolCalls: TranscriptToolCall[] }
  | { role: 'tool'; toolUseId: string; name: string; content: string; isError: boolean };

/**
 * A `.jsonl` transcript read into its messages: Claude Code's session lines (`{ type: 'user' |
 * 'assistant', message: { role, content } }`, content a string or text, tool_use and
 * tool_result blocks) or plain `{ role, content }` lines. Other lines (summaries, snapshots,
 * system events) are skipped, thinking blocks are left out
 */
export function parseTranscript(text: string): TranscriptEntry[] | { error: string } {
  const entries: TranscriptEntry[] = [];
  const toolNames = new Map<string, string>();
  const lines = text.split('\n');
  for (const [index, raw] of lines.entries()) {
    const line = raw.trim();
    if (line === '') continue;
    let json: unknown;
    try {
      json = JSON.parse(line);
    } catch {
      return { error: `line ${index + 1} is not JSON` };
    }
    if (!isRecord(json)) return { error: `line ${index + 1} is not a JSON object` };
    const message = isRecord(json.message) ? json.message : json;
    const role = message.role;
    if (role !== 'user' && role !== 'assistant') continue;
    if (json.type !== undefined && json.type !== 'user' && json.type !== 'assistant') continue;
    const content = message.content;
    if (typeof content === 'string') {
      entries.push(
        role === 'user' ? { role, text: content } : { role, text: content, toolCalls: [] }
      );
      continue;
    }
    if (!Array.isArray(content)) {
      return { error: `line ${index + 1} has no content string or list of blocks` };
    }
    const texts: string[] = [];
    const toolCalls: TranscriptToolCall[] = [];
    for (const block of content) {
      if (!isRecord(block)) continue;
      if (block.type === 'text' && typeof block.text === 'string') texts.push(block.text);
      else if (block.type === 'tool_use' && role === 'assistant') {
        const id = typeof block.id === 'string' ? block.id : `call_${index}_${toolCalls.length}`;
        const name = typeof block.name === 'string' ? block.name : 'unknown';
        toolNames.set(id, name);
        toolCalls.push({ id, name, input: isRecord(block.input) ? block.input : {} });
      } else if (block.type === 'tool_result' && role === 'user') {
        const toolUseId = typeof block.tool_use_id === 'string' ? block.tool_use_id : '';
        entries.push({
          role: 'tool',
          toolUseId,
          name: toolNames.get(toolUseId) ?? 'unknown',
          content: blockText(block.content),
          isError: block.is_error === true,
        });
      }
    }
    const joined = texts.join('\n');
    if (role === 'assistant') {
      if (joined !== '' || toolCalls.length > 0) {
        entries.push({ role, text: joined, toolCalls });
      }
    } else if (joined !== '') entries.push({ role, text: joined });
  }
  return entries;
}

function blockText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return content === undefined ? '' : JSON.stringify(content);
  return content
    .map((part) =>
      isRecord(part) && typeof part.text === 'string' ? part.text : JSON.stringify(part)
    )
    .join('\n');
}

/** The session as JSON, one message per line, in the shape of Claude Code's transcripts */
export function traceLines(entries: readonly TranscriptEntry[]): string[] {
  return entries.map((entry) => {
    switch (entry.role) {
      case 'user':
        return JSON.stringify({ type: 'user', message: { role: 'user', content: entry.text } });
      case 'assistant':
        return JSON.stringify({
          type: 'assistant',
          message: {
            role: 'assistant',
            content: [
              ...(entry.text !== '' ? [{ type: 'text', text: entry.text }] : []),
              ...entry.toolCalls.map((call) => ({
                type: 'tool_use',
                id: call.id,
                name: call.name,
                input: call.input,
              })),
            ],
          },
        });
      case 'tool':
        return JSON.stringify({
          type: 'user',
          message: {
            role: 'user',
            content: [
              {
                type: 'tool_result',
                tool_use_id: entry.toolUseId,
                content: entry.content,
                ...(entry.isError && { is_error: true }),
              },
            ],
          },
        });
    }
  });
}

const READABLE_LIMIT = 4000;

/** A transcript as plain text a judge reads: who said what, each tool call and a cut result */
export function readableTranscript(entries: readonly TranscriptEntry[]): string {
  return entries
    .map((entry) => {
      switch (entry.role) {
        case 'user':
          return `[user]\n${entry.text}`;
        case 'assistant':
          return [
            entry.text !== '' ? `[assistant]\n${entry.text}` : '',
            ...entry.toolCalls.map(
              (call) => `[tool call ${call.name}] ${cut(JSON.stringify(call.input))}`
            ),
          ]
            .filter((part) => part !== '')
            .join('\n');
        case 'tool':
          return `[tool result ${entry.name}${entry.isError ? ', error' : ''}]\n${cut(entry.content)}`;
      }
    })
    .join('\n\n');
}

function cut(text: string): string {
  return text.length <= READABLE_LIMIT
    ? text
    : `${text.slice(0, READABLE_LIMIT)}... (${text.length - READABLE_LIMIT} more characters)`;
}
