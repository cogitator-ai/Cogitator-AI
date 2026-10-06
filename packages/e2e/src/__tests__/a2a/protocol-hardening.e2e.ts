import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import http from 'node:http';
import {
  A2AClient,
  A2AError,
  InMemoryPushNotificationStore,
  NOTIFICATION_TOKEN_HEADER,
  messageText,
} from '@cogitator-ai/a2a';
import type {
  A2AStreamEvent,
  A2ATask,
  AgentRunResult,
  CogitatorLike,
  A2AServerConfig,
} from '@cogitator-ai/a2a';
import { Cogitator } from '@cogitator-ai/core';
import type { Agent, AgentConfig } from '@cogitator-ai/types';
import {
  asTask,
  createStubAgent,
  startTestA2AServer,
  type TestA2AServer,
} from '../../helpers/a2a-server';
import { createTestAgent } from '../../helpers/setup';

const describeHeavy = process.env.OLLAMA_API_KEY ? describe : describe.skip;
const HEAVY_MODEL = 'gpt-oss:20b';
const OLLAMA_CLOUD_URL = process.env.OLLAMA_URL || 'https://ollama.com';

function mockAgent(name: string): Agent {
  const config: AgentConfig = { name, model: 'mock', instructions: 'test', description: name };
  return createStubAgent(config);
}

function runResult(output: string): AgentRunResult {
  return {
    output,
    runId: 'run',
    agentId: 'agent',
    threadId: 'thread',
    usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2, cost: 0, duration: 1 },
    toolCalls: [],
  };
}

async function startServer(
  cogitator: CogitatorLike,
  extra?: Partial<A2AServerConfig>
): Promise<TestA2AServer> {
  return startTestA2AServer({
    agents: { helper: mockAgent('helper') },
    cogitator,
    ...extra,
  });
}

async function collect(stream: AsyncGenerator<A2AStreamEvent>): Promise<A2AStreamEvent[]> {
  const events: A2AStreamEvent[] = [];
  for await (const event of stream) events.push(event);
  return events;
}

describe('A2A: protocol hardening over HTTP', () => {
  describe('authentication', () => {
    let server: TestA2AServer;

    beforeAll(async () => {
      server = await startServer(
        { run: async () => runResult('secret answer') },
        { auth: { type: 'bearer', validate: async (token) => token === 'e2e-token' } }
      );
    });

    afterAll(async () => {
      await server?.close();
    });

    it('advertises the bearer scheme on the public agent card', async () => {
      const card = await new A2AClient(server.url).agentCard();
      expect(card.securitySchemes).toEqual({ bearer: { type: 'http', scheme: 'bearer' } });
    });

    it('rejects requests without credentials', async () => {
      const error = await new A2AClient(server.url)
        .sendMessage({ role: 'user', parts: [{ kind: 'text', text: 'hi' }] })
        .catch((e: unknown) => e);
      expect(error).toBeInstanceOf(A2AError);
      expect((error as A2AError).code).toBe(-32000);
    });

    it('answers missing credentials with HTTP 401', async () => {
      const response = await fetch(`${server.url}/a2a`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          method: 'tasks/get',
          params: { id: 'task_unknown' },
        }),
      });
      expect(response.status).toBe(401);
      expect(response.headers.get('www-authenticate')).toContain('Bearer');
      const body = (await response.json()) as { error?: { code: number } };
      expect(body.error?.code).toBe(-32000);
    });

    it('accepts requests and streams with a valid bearer token', async () => {
      const client = new A2AClient(server.url, { headers: { Authorization: 'Bearer e2e-token' } });

      const task = asTask(
        await client.sendMessage({
          role: 'user',
          parts: [{ kind: 'text', text: 'hi' }],
        })
      );
      expect(task.status.state).toBe('completed');

      const events = await collect(
        client.sendMessageStream({ role: 'user', parts: [{ kind: 'text', text: 'hi' }] })
      );
      const last = events.at(-1);
      expect(last?.kind === 'status-update' && last.status.state).toBe('completed');
      expect(last?.kind === 'status-update' && last.final).toBe(true);
    });
  });

  describe('streaming', () => {
    let server: TestA2AServer;

    beforeAll(async () => {
      server = await startServer({ run: async () => runResult('streamed answer') });
    });

    afterAll(async () => {
      await server?.close();
    });

    it('delivers the task, then the artifact before the final status', async () => {
      const events = await collect(
        new A2AClient(server.url).sendMessageStream({
          role: 'user',
          parts: [{ kind: 'text', text: 'go' }],
        })
      );
      const kinds = events.map((e) => (e.kind === 'status-update' ? e.status.state : e.kind));

      expect(kinds).toEqual(['task', 'working', 'artifact-update', 'completed']);

      const artifact = events.find((e) => e.kind === 'artifact-update');
      expect(artifact?.kind === 'artifact-update' && artifact.lastChunk).toBe(true);
      const final = events.at(-1);
      expect(final?.kind === 'status-update' && final.final).toBe(true);
    });
  });

  describe('non-blocking send with push notifications', () => {
    let server: TestA2AServer;
    let webhook: http.Server;
    let webhookUrl: string;
    const received: { task: A2ATask; token: string | undefined }[] = [];
    let release: (() => void) | undefined;

    beforeAll(async () => {
      webhook = http.createServer((req, res) => {
        let body = '';
        req.on('data', (chunk: Buffer) => (body += chunk.toString()));
        req.on('end', () => {
          const token = req.headers[NOTIFICATION_TOKEN_HEADER.toLowerCase()];
          received.push({
            task: JSON.parse(body) as A2ATask,
            token: Array.isArray(token) ? token[0] : token,
          });
          res.writeHead(200);
          res.end();
        });
      });
      await new Promise<void>((resolve) => webhook.listen(0, '127.0.0.1', resolve));
      const address = webhook.address();
      webhookUrl = `http://127.0.0.1:${typeof address === 'object' && address ? address.port : 0}/hook`;

      server = await startServer(
        {
          run: () =>
            new Promise<AgentRunResult>((resolve) => {
              release = () => resolve(runResult('background result'));
            }),
        },
        {
          allowPrivateUrls: true,
          pushNotificationStore: new InMemoryPushNotificationStore(),
        }
      );
    });

    afterAll(async () => {
      await server?.close();
      await new Promise<void>((resolve) => webhook.close(() => resolve()));
    });

    it('returns a submitted task immediately and pushes the completed task', async () => {
      const client = new A2AClient(server.url);
      const task = asTask(
        await client.sendMessage(
          { role: 'user', parts: [{ kind: 'text', text: 'long job' }] },
          { blocking: false, pushNotificationConfig: { url: webhookUrl, token: 'hook-secret' } }
        )
      );
      expect(task.status.state).toBe('submitted');

      for (let i = 0; i < 50 && !release; i++) await new Promise((r) => setTimeout(r, 10));
      release!();

      const isCompleted = (entry: { task: A2ATask }) =>
        entry.task.id === task.id && entry.task.status.state === 'completed';
      for (let i = 0; i < 100; i++) {
        if (received.some(isCompleted)) break;
        await new Promise((r) => setTimeout(r, 20));
      }

      const completed = received.find(isCompleted);
      expect(completed?.task.kind).toBe('task');
      expect(completed?.token).toBe('hook-secret');
      expect(messageText(completed?.task.status.message)).toBe('background result');

      const final = await client.getTask(task.id, 1);
      expect(final.status.state).toBe('completed');
      expect(final.history).toHaveLength(1);
      expect(final.history?.[0].role).toBe('agent');
    });
  });
});

describeHeavy('A2A: multi-turn context (heavy model)', () => {
  let cogitator: Cogitator;
  let server: TestA2AServer;

  beforeAll(async () => {
    cogitator = new Cogitator({
      llm: {
        defaultModel: `ollama/${HEAVY_MODEL}`,
        providers: {
          ollama: { baseUrl: OLLAMA_CLOUD_URL, apiKey: process.env.OLLAMA_API_KEY },
        },
      },
    });
    server = await startTestA2AServer({
      agents: {
        assistant: createTestAgent({
          name: 'assistant',
          model: `ollama/${HEAVY_MODEL}`,
          instructions: 'You are a concise assistant. Answer in one short sentence.',
        }),
      },
      cogitator,
    });
  });

  afterAll(async () => {
    await server?.close();
    await cogitator?.close();
  });

  it('remembers earlier tasks of the same context without a memory adapter', async () => {
    const client = new A2AClient(server.url, { timeout: 120_000 });

    const first = asTask(
      await client.sendMessage({
        role: 'user',
        parts: [{ kind: 'text', text: 'My favourite colour is turquoise. Just acknowledge it.' }],
      })
    );
    expect(first.status.state).toBe('completed');

    const second = asTask(
      await client.sendMessage({
        role: 'user',
        parts: [{ kind: 'text', text: 'What is my favourite colour?' }],
        contextId: first.contextId,
      })
    );
    expect(second.status.state).toBe('completed');
    expect(second.contextId).toBe(first.contextId);

    expect(messageText(second.status.message).toLowerCase()).toContain('turquoise');
  });
});
