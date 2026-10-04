import { encodeDone, type StreamEvent } from '@cogitator-ai/server-shared';

/** Every event type of the shared protocol; the record type keeps it in step with the union. */
const PROTOCOL_TYPES: Record<StreamEvent['type'], true> = {
  start: true,
  'text-start': true,
  'text-delta': true,
  'text-end': true,
  'reasoning-start': true,
  'reasoning-delta': true,
  'reasoning-end': true,
  'tool-call-start': true,
  'tool-call-delta': true,
  'tool-call-end': true,
  'tool-result': true,
  'approval-required': true,
  error: true,
  finish: true,
  workflow: true,
  swarm: true,
};

const DONE = encodeDone()
  .replace(/^data: /, '')
  .trim();

export interface SseRead {
  events: StreamEvent[];
  /** Whether the `[DONE]` terminator arrived, and as the last frame. */
  done: boolean;
  contentType: string;
}

function isProtocolEvent(value: unknown): value is StreamEvent {
  if (typeof value !== 'object' || value === null) return false;
  const type: unknown = Reflect.get(value, 'type');
  return typeof type === 'string' && Object.hasOwn(PROTOCOL_TYPES, type);
}

/** A fetch failure with its cause, e.g. `terminated (other side closed)`. */
export function networkFailure(error: unknown): string {
  if (!(error instanceof Error)) return String(error);
  return error.cause instanceof Error ? `${error.message} (${error.cause.message})` : error.message;
}

/** Reads a whole server-sent event stream and parses the Cogitator protocol frames. */
export async function readSse(response: Response): Promise<SseRead> {
  const contentType = response.headers.get('content-type') ?? '';
  let text: string;
  try {
    text = await response.text();
  } catch (error) {
    throw new Error(`The stream broke off: ${networkFailure(error)}`, { cause: error });
  }
  const events: StreamEvent[] = [];
  let done = false;
  for (const block of text.split(/\r?\n\r?\n/)) {
    const data = block
      .split(/\r?\n/)
      .filter((line) => line.startsWith('data:'))
      .map((line) => line.slice(5).replace(/^ /, ''))
      .join('\n');
    if (!data) continue;
    if (done) throw new Error(`A frame arrived after [DONE]: ${data.slice(0, 80)}`);
    if (data === DONE) {
      done = true;
      continue;
    }
    const parsed: unknown = JSON.parse(data);
    if (!isProtocolEvent(parsed)) {
      throw new Error(`Frame outside the shared protocol: ${data.slice(0, 120)}`);
    }
    events.push(parsed);
  }
  return { events, done, contentType };
}

export interface StreamSummary {
  events: number;
  /** Distinct event types, in first-seen order. */
  types: string[];
  text: string;
  toolNames: string[];
  toolResults: number;
  usage?: { inputTokens: number; outputTokens: number; totalTokens: number };
  finish: Extract<StreamEvent, { type: 'finish' }>;
}

/**
 * Checks the protocol rules every adapter promises: `start` first, `finish` last with the same
 * message id, then `[DONE]`; text, reasoning and tool-call parts opened before their deltas and
 * closed before the end; tool results answer a started call; no `error` event.
 */
export function validateAgentStream(read: SseRead): StreamSummary {
  if (!read.contentType.includes('text/event-stream')) {
    throw new Error(`Content-Type is "${read.contentType}", not text/event-stream`);
  }
  const { events } = read;
  const failure = events.find((event) => event.type === 'error');
  if (failure?.type === 'error') {
    throw new Error(`Stream reported an error: ${failure.message} (${failure.code ?? 'no code'})`);
  }
  const first = events[0];
  const last = events.at(-1);
  if (first?.type !== 'start')
    throw new Error(`First event is ${first?.type ?? 'missing'}, not start`);
  if (last?.type !== 'finish')
    throw new Error(`Last event is ${last?.type ?? 'missing'}, not finish`);
  if (last.messageId !== first.messageId) {
    throw new Error(
      `finish.messageId ${last.messageId} differs from start.messageId ${first.messageId}`
    );
  }
  if (!read.done) throw new Error('The stream did not end with data: [DONE]');

  const openText = new Set<string>();
  const openReasoning = new Set<string>();
  const openCalls = new Set<string>();
  const startedCalls = new Set<string>();
  const toolNames: string[] = [];
  let text = '';
  let toolResults = 0;

  for (const event of events.slice(1, -1)) {
    switch (event.type) {
      case 'start':
      case 'finish':
        throw new Error(`A second ${event.type} event arrived mid-stream`);
      case 'text-start':
        openText.add(event.id);
        break;
      case 'text-delta':
        if (!openText.has(event.id)) throw new Error(`text-delta for unopened part ${event.id}`);
        text += event.delta;
        break;
      case 'text-end':
        if (!openText.delete(event.id)) throw new Error(`text-end for unopened part ${event.id}`);
        break;
      case 'reasoning-start':
        openReasoning.add(event.id);
        break;
      case 'reasoning-delta':
        if (!openReasoning.has(event.id))
          throw new Error(`reasoning-delta for unopened part ${event.id}`);
        break;
      case 'reasoning-end':
        if (!openReasoning.delete(event.id))
          throw new Error(`reasoning-end for unopened part ${event.id}`);
        break;
      case 'tool-call-start':
        openCalls.add(event.id);
        startedCalls.add(event.id);
        toolNames.push(event.toolName);
        break;
      case 'tool-call-delta':
        if (!openCalls.has(event.id))
          throw new Error(`tool-call-delta for unopened call ${event.id}`);
        break;
      case 'tool-call-end':
        if (!openCalls.delete(event.id))
          throw new Error(`tool-call-end for unopened call ${event.id}`);
        break;
      case 'tool-result':
        if (!startedCalls.has(event.toolCallId)) {
          throw new Error(`tool-result answers unknown call ${event.toolCallId}`);
        }
        toolResults += 1;
        break;
      default:
        break;
    }
  }
  const unclosed = [...openText, ...openReasoning, ...openCalls];
  if (unclosed.length > 0) throw new Error(`Parts never closed: ${unclosed.join(', ')}`);

  return {
    events: events.length,
    types: [...new Set(events.map((event) => event.type))],
    text,
    toolNames,
    toolResults,
    usage: last.usage,
    finish: last,
  };
}
