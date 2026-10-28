import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { randomUUID } from 'node:crypto';
import { vi } from 'vitest';
import express from 'express';
import type { Agent, AgentConfig } from '@cogitator-ai/types';
import { A2AServer } from '../server';
import { a2aExpress } from '../adapters/express';
import type { A2AServerConfig, AgentRunResult, CogitatorLike } from '../types';
import type { V1Message } from '../v1/types';

export function mockAgent(name: string, config: Partial<AgentConfig> = {}): Agent {
  const full: AgentConfig = {
    name,
    model: 'test',
    instructions: 'private instructions',
    description: `${name} agent`,
    ...config,
  };
  return {
    id: `agent_${name}`,
    name,
    config: full,
    model: full.model,
    instructions: full.instructions,
    tools: [],
    clone: vi.fn() as Agent['clone'],
    serialize: vi.fn() as Agent['serialize'],
  };
}

export function runResult(output: string): AgentRunResult {
  return {
    output,
    runId: 'run_1',
    agentId: 'agent_1',
    threadId: 'thread_1',
    usage: { inputTokens: 1, outputTokens: 2, totalTokens: 3, cost: 0, duration: 1 },
    toolCalls: [],
  };
}

/**
 * A Cogitator that echoes: `<agent> heard: <input>`, token by token when streamed. An input with
 * `ask` ends `input-required`, one with `slow` waits until released or aborted.
 */
export function echoCogitator(): CogitatorLike & {
  release(): void;
  timeouts: (number | undefined)[];
} {
  const waiting = new Set<() => void>();
  const timeouts: (number | undefined)[] = [];
  return {
    timeouts,
    release() {
      for (const resolve of waiting) resolve();
      waiting.clear();
    },
    run: async (agent, options) => {
      timeouts.push(options.timeout);
      if (options.input.includes('slow')) {
        await new Promise<void>((resolve) => {
          waiting.add(resolve);
          options.signal?.addEventListener('abort', () => resolve(), { once: true });
        });
        if (options.signal?.aborted) throw new Error('aborted');
      }
      const output = `${(agent as Agent).name} heard: ${options.input}`;
      if (options.onToken) {
        for (const word of output.split(/(?= )/)) options.onToken(word);
      }
      return { ...runResult(output), requiresInput: options.input.endsWith('ask') };
    },
  };
}

export interface Served {
  url: string;
  server: A2AServer;
  close(): Promise<void>;
}

export async function listen(handler: http.RequestListener): Promise<{
  url: string;
  close(): Promise<void>;
}> {
  const httpServer = http.createServer(handler);
  await new Promise<void>((resolve) => httpServer.listen(0, '127.0.0.1', resolve));
  return {
    url: `http://127.0.0.1:${(httpServer.address() as AddressInfo).port}`,
    close: () =>
      new Promise<void>((resolve) => {
        httpServer.closeAllConnections();
        httpServer.close(() => resolve());
      }),
  };
}

/** An A2AServer behind Express. */
export async function serveExpress(config: A2AServerConfig): Promise<Served> {
  const server = new A2AServer(config);
  const app = express();
  app.use(a2aExpress(server));
  const listening = await listen(app);
  return { ...listening, server };
}

/** A user message in its A2A 1.0 form. */
export function v1UserMessage(text: string, extra: Partial<V1Message> = {}): V1Message {
  return { messageId: randomUUID(), role: 'ROLE_USER', parts: [{ text }], ...extra };
}

export interface RpcReply {
  status: number;
  headers: Headers;
  body: {
    jsonrpc: string;
    id: unknown;
    result?: Record<string, unknown>;
    error?: { code: number; message: string; data?: unknown };
  };
}

/** A JSON-RPC request over HTTP, as A2A 1.0 by default. */
export async function rpc(
  url: string,
  method: string,
  params?: unknown,
  headers: Record<string, string> = { 'A2A-Version': '1.0' }
): Promise<RpcReply> {
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...headers },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method,
      ...(params !== undefined && { params }),
    }),
  });
  return {
    status: response.status,
    headers: response.headers,
    body: (await response.json()) as RpcReply['body'],
  };
}

/** The `data` of every SSE event of a response, parsed. */
export async function sseData(response: Response): Promise<unknown[]> {
  const text = await response.text();
  return text
    .split('\n\n')
    .map((frame) =>
      frame
        .split('\n')
        .filter((line) => line.startsWith('data:'))
        .map((line) => line.slice(5).trimStart())
        .join('\n')
    )
    .filter(Boolean)
    .map((data) => JSON.parse(data) as unknown);
}
