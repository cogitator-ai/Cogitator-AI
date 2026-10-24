import type {
  ChatRequest,
  ChatResponse,
  ChatStreamChunk,
  LLMBackend,
  ToolCall,
} from '@cogitator-ai/types';

/** What one model call of a scripted backend does */
export type ScriptedTurn =
  | ChatResponse
  | { stream: string[]; thenWait: true }
  | { chunks: ChatStreamChunk[] }
  | ((request: ChatRequest) => ChatResponse | Promise<ChatResponse>);

const USAGE = { inputTokens: 10, outputTokens: 5, totalTokens: 15 };

/** A final answer */
export function answer(content: string): ChatResponse {
  return { id: `r_${content.length}`, content, finishReason: 'stop', usage: USAGE };
}

/** A turn that calls `calls` */
export function callTools(calls: ToolCall[], content = ''): ChatResponse {
  return { id: 'r_tools', content, toolCalls: calls, finishReason: 'tool_calls', usage: USAGE };
}

/** A promise with its resolve at hand */
export function deferred<T = void>(): {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (error: unknown) => void;
} {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

/** The reason `signal` aborted with, as an error */
export function abortReason(signal: AbortSignal | undefined): Error {
  const reason: unknown = signal?.reason;
  return reason instanceof Error ? reason : new Error(String(reason ?? 'aborted'));
}

function untilAborted(signal: AbortSignal | undefined): Promise<never> {
  return new Promise<never>((_, reject) => {
    if (signal?.aborted) reject(abortReason(signal));
    signal?.addEventListener('abort', () => reject(abortReason(signal)), { once: true });
  });
}

/**
 * A backend that answers its model calls in turn from `turns`, the last one again once they run
 * out. A `stream` turn streams its pieces and then waits until the call is aborted, a `chunks`
 * turn streams its chunks as they are. Every
 * request is kept, with a copy of its messages
 */
export function scriptedBackend(turns: ScriptedTurn[]): {
  backend: LLMBackend;
  requests: ChatRequest[];
} {
  const requests: ChatRequest[] = [];
  let next = 0;
  const take = (request: ChatRequest): ScriptedTurn => {
    requests.push({ ...request, messages: [...request.messages] });
    const turn = turns[Math.min(next, turns.length - 1)];
    next++;
    return turn;
  };
  const respond = async (turn: ScriptedTurn, request: ChatRequest): Promise<ChatResponse> => {
    if (typeof turn === 'function') return turn(request);
    if ('stream' in turn) return untilAborted(request.signal);
    if ('chunks' in turn) throw new Error('A chunks turn only streams');
    return turn;
  };
  const backend: LLMBackend = {
    provider: 'openai',
    chat: async (request) => respond(take(request), request),
    async *chatStream(request): AsyncGenerator<ChatStreamChunk> {
      const turn = take(request);
      if (typeof turn !== 'function' && 'stream' in turn) {
        for (const piece of turn.stream) yield { id: 's', delta: { content: piece } };
        await untilAborted(request.signal);
        return;
      }
      if (typeof turn !== 'function' && 'chunks' in turn) {
        yield* turn.chunks;
        return;
      }
      const response = await respond(turn, request);
      if (response.content) yield { id: 's', delta: { content: response.content } };
      yield {
        id: 's',
        delta: response.toolCalls ? { toolCalls: response.toolCalls } : {},
        finishReason: response.finishReason,
        usage: response.usage,
      };
    },
  };
  return { backend, requests };
}

/** The text of the user messages a request sent */
export function userTexts(request: ChatRequest): string[] {
  return request.messages
    .filter((message) => message.role === 'user')
    .map((message) =>
      typeof message.content === 'string'
        ? message.content
        : message.content.map((part) => (part.type === 'text' ? part.text : '')).join('')
    );
}
