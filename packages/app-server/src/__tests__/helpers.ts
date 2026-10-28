import { Agent, Cogitator } from '@cogitator-ai/core';
import type {
  ChatRequest,
  ChatResponse,
  ChatStreamChunk,
  CogitatorConfig,
  LLMBackend,
  Tool,
  ToolCall,
} from '@cogitator-ai/types';
import { AppServerClient, type AppServerClientTransport } from '../client/generated';
import { SessionHost, type SessionHostOptions } from '../host/session-host';
import { createAppServer, type AppServerConnection } from '../server/app-server';
import type { AppServerNotification } from '../protocol/types';

const USAGE = { inputTokens: 10, outputTokens: 5, totalTokens: 15 };

/** A model answer */
export function answer(content: string): ChatResponse {
  return { id: `r_${content.length}`, content, finishReason: 'stop', usage: USAGE };
}

/** A model turn that calls tools */
export function callTools(calls: ToolCall[], content = ''): ChatResponse {
  return { id: 'r_tools', content, toolCalls: calls, finishReason: 'tool_calls', usage: USAGE };
}

/** What one model call of {@link scriptedBackend} does: answer, or hold until aborted */
export type ScriptedTurn =
  | ChatResponse
  | { hold: true; first?: string }
  | ((request: ChatRequest) => ChatResponse | Promise<ChatResponse>);

export function deferred<T = void>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function untilAborted(signal: AbortSignal | undefined): Promise<never> {
  return new Promise<never>((_, reject) => {
    const fail = () =>
      reject(signal?.reason instanceof Error ? signal.reason : new Error('aborted'));
    if (signal?.aborted) fail();
    signal?.addEventListener('abort', fail, { once: true });
  });
}

/**
 * A backend answering its calls from `turns` in order, the last one again once they run out:
 * a response streams as one chunk, `hold` streams `first` and waits until the call is aborted
 */
export function scriptedBackend(turns: ScriptedTurn[]) {
  const requests: ChatRequest[] = [];
  const reached: Array<() => void> = [];
  let next = 0;
  const take = (request: ChatRequest): ScriptedTurn => {
    requests.push({ ...request, messages: [...request.messages] });
    const turn = turns[Math.min(next, turns.length - 1)]!;
    next++;
    for (const notify of reached.splice(0)) notify();
    return turn;
  };
  const backend: LLMBackend = {
    provider: 'openai',
    chat: async (request) => {
      const turn = take(request);
      if (typeof turn === 'function') return turn(request);
      if ('hold' in turn) return untilAborted(request.signal);
      return turn;
    },
    async *chatStream(request): AsyncGenerator<ChatStreamChunk> {
      const turn = take(request);
      if (typeof turn !== 'function' && 'hold' in turn) {
        if (turn.first) yield { id: 's', delta: { content: turn.first } };
        await untilAborted(request.signal);
        return;
      }
      const response = typeof turn === 'function' ? await turn(request) : turn;
      if (response.content) yield { id: 's', delta: { content: response.content } };
      yield {
        id: 's',
        delta: response.toolCalls ? { toolCalls: response.toolCalls } : {},
        finishReason: response.finishReason,
        usage: response.usage,
      };
    },
  };
  return {
    backend,
    requests,
    /** Resolves once the next model call arrived */
    nextCall: () => new Promise<void>((resolve) => reached.push(resolve)),
  };
}

/** The text of the user messages of a request */
export function userTexts(request: ChatRequest | undefined): string[] {
  return (request?.messages ?? [])
    .filter((message) => message.role === 'user')
    .map((message) =>
      typeof message.content === 'string'
        ? message.content
        : message.content.map((part) => (part.type === 'text' ? part.text : '')).join('')
    );
}

export interface TestHostOptions extends Partial<Omit<SessionHostOptions, 'cogitator'>> {
  backend: LLMBackend;
  tools?: Tool[];
  config?: CogitatorConfig;
}

/** A host over an in-memory runtime whose `assistant` agent answers from `backend` */
export function createTestHost(options: TestHostOptions) {
  const { backend, tools, config, ...hostOptions } = options;
  const cogitator = new Cogitator({
    memory: { adapter: 'memory' },
    ...config,
    llm: { backends: { mock: backend } },
  });
  const agent = new Agent({
    name: 'assistant',
    model: 'mock/m',
    instructions: 'Help.',
    ...(tools && { tools }),
  });
  const host = new SessionHost({
    cogitator,
    agents: { assistant: agent },
    exposeErrors: true,
    ...hostOptions,
  });
  const notifications: AppServerNotification[] = [];
  host.subscribe((notification) => notifications.push(notification));
  return { cogitator, agent, host, notifications };
}

/** Resolves once `predicate` holds, checked as notifications arrive */
export async function waitUntil(predicate: () => boolean, timeoutMs = 5000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error('Timed out waiting');
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

/** The `turn/completed` of `turnId`, once it arrives */
export async function completed(notifications: AppServerNotification[], turnId: string) {
  let found: Extract<AppServerNotification, { method: 'turn/completed' }> | undefined;
  await waitUntil(() => {
    found = notifications.find(
      (n): n is Extract<AppServerNotification, { method: 'turn/completed' }> =>
        n.method === 'turn/completed' && n.params.turn.id === turnId
    );
    return found !== undefined;
  });
  return found!.params.turn;
}

/**
 * The generated client wired to a connection of an app-server over `host` in memory, with every
 * line each side sent, in order
 */
export function connectClient(host: SessionHost) {
  const lines: Array<{ from: 'client' | 'server'; message: Record<string, unknown> }> = [];
  let deliver: ((line: string) => void) | undefined;
  const server = createAppServer(host);
  const connection: AppServerConnection = server.connect((message) => {
    const line = JSON.stringify(message);
    lines.push({ from: 'server', message: JSON.parse(line) as Record<string, unknown> });
    queueMicrotask(() => deliver?.(line));
  });
  const transport: AppServerClientTransport = {
    send: (line) => {
      lines.push({ from: 'client', message: JSON.parse(line) as Record<string, unknown> });
      void connection.receive(JSON.parse(line));
    },
    onLine: (callback) => {
      deliver = callback;
    },
    close: () => {
      void connection.close();
    },
  };
  const client = new AppServerClient(transport);
  return { client, connection, lines };
}
