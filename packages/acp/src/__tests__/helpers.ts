import {
  client as createClientApp,
  type ClientCapabilities,
  type CreateTerminalRequest,
  type RequestPermissionRequest,
  type RequestPermissionResponse,
  type SessionNotification,
  type SessionUpdate,
} from '@agentclientprotocol/sdk';
import { SessionHost, type SessionHostOptions } from '@cogitator-ai/app-server';
import { Agent, Cogitator, type AgentConfig } from '@cogitator-ai/core';
import type {
  ChatRequest,
  ChatResponse,
  ChatStreamChunk,
  CogitatorConfig,
  LLMBackend,
  ToolCall,
} from '@cogitator-ai/types';
import { createAcpAgent, type AcpAgent, type AcpAgentOptions } from '../agent/acp-agent';

const USAGE = { inputTokens: 10, outputTokens: 5, totalTokens: 15 };

export function answer(content: string): ChatResponse {
  return { id: `r_${content.length}`, content, finishReason: 'stop', usage: USAGE };
}

export function callTools(calls: ToolCall[], content = ''): ChatResponse {
  return { id: 'r_tools', content, toolCalls: calls, finishReason: 'tool_calls', usage: USAGE };
}

export type ScriptedTurn =
  | ChatResponse
  | { hold: true; first?: string }
  | ((request: ChatRequest) => ChatResponse | Promise<ChatResponse>);

function untilAborted(signal: AbortSignal | undefined): Promise<never> {
  return new Promise<never>((_, reject) => {
    const fail = () =>
      reject(signal?.reason instanceof Error ? signal.reason : new Error('aborted'));
    if (signal?.aborted) fail();
    signal?.addEventListener('abort', fail, { once: true });
  });
}

/** A backend answering its calls from `turns` in order, the last one again once they run out */
export function scriptedBackend(turns: ScriptedTurn[]) {
  const requests: ChatRequest[] = [];
  let next = 0;
  const take = (request: ChatRequest): ScriptedTurn => {
    requests.push({ ...request, messages: [...request.messages] });
    const turn = turns[Math.min(next, turns.length - 1)]!;
    next++;
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
  return { backend, requests };
}

export interface TestAgentOptions {
  backend: LLMBackend;
  agent?: Partial<AgentConfig>;
  config?: CogitatorConfig;
  host?: Partial<Omit<SessionHostOptions, 'cogitator' | 'agents'>>;
  acp?: Partial<Omit<AcpAgentOptions, 'host' | 'cogitator'>>;
}

/** An ACP agent over a host whose `coder` agent answers from `backend` */
export function createTestAgent(options: TestAgentOptions) {
  const cogitator = new Cogitator({
    memory: { adapter: 'memory' },
    ...options.config,
    llm: { backends: { mock: options.backend } },
  });
  const agent = new Agent({
    name: 'coder',
    model: 'mock/m',
    instructions: 'Help.',
    ...options.agent,
  });
  const host = new SessionHost({
    cogitator,
    agents: { coder: agent },
    exposeErrors: true,
    ...options.host,
  });
  const acp = createAcpAgent({ host, cogitator, models: ['mock/m', 'mock/other'], ...options.acp });
  return { cogitator, agent, host, acp };
}

export interface FakeTerminal {
  request: CreateTerminalRequest;
  output: string;
  exitCode: number;
  released: boolean;
}

export interface TestClientOptions {
  capabilities?: ClientCapabilities;
  onPermission?: (
    params: RequestPermissionRequest
  ) => RequestPermissionResponse | Promise<RequestPermissionResponse>;
  files?: Map<string, string>;
  /** What a terminal running `command` prints and exits with */
  terminal?: (request: CreateTerminalRequest) => { output: string; exitCode: number };
}

/** An ACP client connected to `acp` in this process, recording what it is sent */
export function connectClient(acp: AcpAgent, options: TestClientOptions = {}) {
  const notifications: SessionNotification[] = [];
  const permissions: RequestPermissionRequest[] = [];
  const writes: Array<{ path: string; content: string }> = [];
  const reads: string[] = [];
  const terminals = new Map<string, FakeTerminal>();
  const files = options.files ?? new Map<string, string>();
  const app = createClientApp({ name: 'test-editor' })
    .onNotification('session/update', ({ params }) => {
      notifications.push(params);
    })
    .onRequest('session/request_permission', async ({ params }) => {
      permissions.push(params);
      return (
        (await options.onPermission?.(params)) ?? {
          outcome: { outcome: 'selected', optionId: 'allow_once' },
        }
      );
    })
    .onRequest('fs/read_text_file', ({ params }) => {
      reads.push(params.path);
      const content = files.get(params.path);
      if (content === undefined) throw new Error(`No file ${params.path}`);
      return { content };
    })
    .onRequest('fs/write_text_file', ({ params }) => {
      writes.push({ path: params.path, content: params.content });
      files.set(params.path, params.content);
      return {};
    })
    .onRequest('terminal/create', ({ params }) => {
      const id = `term_${terminals.size + 1}`;
      const run = options.terminal?.(params) ?? { output: '', exitCode: 0 };
      terminals.set(id, { request: params, ...run, released: false });
      return { terminalId: id };
    })
    .onRequest('terminal/output', ({ params }) => {
      const terminal = terminals.get(params.terminalId)!;
      return {
        output: terminal.output,
        truncated: false,
        exitStatus: { exitCode: terminal.exitCode },
      };
    })
    .onRequest('terminal/wait_for_exit', ({ params }) => ({
      exitCode: terminals.get(params.terminalId)!.exitCode,
    }))
    .onRequest('terminal/kill', () => ({}))
    .onRequest('terminal/release', ({ params }) => {
      terminals.get(params.terminalId)!.released = true;
      return {};
    });
  const connection = app.connect(acp.app);
  const updates = (sessionId?: string): SessionUpdate[] =>
    notifications
      .filter((notification) => sessionId === undefined || notification.sessionId === sessionId)
      .map((notification) => notification.update);
  const initialize = () =>
    connection.agent.request('initialize', {
      protocolVersion: 1,
      clientCapabilities: options.capabilities ?? {},
      clientInfo: { name: 'test-editor', version: '1.0.0' },
    });
  return {
    agent: connection.agent,
    connection,
    notifications,
    permissions,
    writes,
    reads,
    terminals,
    files,
    updates,
    initialize,
  };
}

/** The text of the agent message chunks of `updates` */
export function messageText(updates: readonly SessionUpdate[]): string {
  return updates
    .map((update) =>
      update.sessionUpdate === 'agent_message_chunk' && update.content.type === 'text'
        ? update.content.text
        : ''
    )
    .join('');
}

/** Resolves once `predicate` holds */
export async function waitUntil(predicate: () => boolean, timeoutMs = 5000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error('Timed out waiting');
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}
