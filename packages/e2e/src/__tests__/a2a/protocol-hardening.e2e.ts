import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import http from 'node:http';
import { A2AClient, A2AError, InMemoryPushNotificationStore } from '@cogitator-ai/a2a';
import type {
  A2AStreamEvent,
  A2ATask,
  AgentRunResult,
  CogitatorLike,
  A2AServerConfig,
} from '@cogitator-ai/a2a';
import { Cogitator } from '@cogitator-ai/core';
import type { Agent, AgentConfig } from '@cogitator-ai/types';
import { startTestA2AServer, type TestA2AServer } from '../../helpers/a2a-server';
import { createTestAgent } from '../../helpers/setup';

const describeHeavy = process.env.OLLAMA_API_KEY ? describe : describe.skip;
const HEAVY_MODEL = 'gpt-oss:20b';
const OLLAMA_CLOUD_URL = process.env.OLLAMA_URL || 'https://ollama.com';

function mockAgent(name: string): Agent {
  const config: AgentConfig = { name, model: 'mock', instructions: 'test', description: name };
  return {
    id: `agent_${name}`,
    name,
    config,
    model: config.model,
    instructions: config.instructions,
    tools: [],
    clone: (() => {}) as Agent['clone'],
    serialize: (() => {}) as Agent['serialize'],
  };
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
        .sendMessage({ role: 'user', parts: [{ type: 'text', text: 'hi' }] })
        .catch((e: unknown) => e);
      expect(error).toBeInstanceOf(A2AError);
      expect((error as A2AError).code).toBe(-32000);
    });

    it('accepts requests and streams with a valid bearer token', async () => {
      const client = new A2AClient(server.url, { headers: { Authorization: 'Bearer e2e-token' } });

      const task = await client.sendMessage({
        role: 'user',
        parts: [{ type: 'text', text: 'hi' }],
      });
      expect(task.status.state).toBe('completed');

      const events = await collect(
        client.sendMessageStream({ role: 'user', parts: [{ type: 'text', text: 'hi' }] })
      );
      const last = events.at(-1);
      expect(last?.type === 'status-update' && last.status.state).toBe('completed');
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

    it('delivers the artifact before the final status', async () => {
      const events = await collect(
        new A2AClient(server.url).sendMessageStream({
          role: 'user',
          parts: [{ type: 'text', text: 'go' }],
        })
      );
      const kinds = events.map((e) => (e.type === 'status-update' ? e.status.state : e.type));

      expect(kinds).toEqual(['working', 'artifact-update', 'completed']);
    });
  });

  describe('non-blocking send with push notifications', () => {
    let server: TestA2AServer;
    let webhook: http.Server;
    let webhookUrl: string;
    const received: A2AStreamEvent[] = [];
    let release: (() => void) | undefined;

    beforeAll(async () => {
      webhook = http.createServer((req, res) => {
        let body = '';
        req.on('data', (chunk: Buffer) => (body += chunk.toString()));
        req.on('end', () => {
          received.push(JSON.parse(body) as A2AStreamEvent);
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

    it('returns a working task immediately and pushes the completion', async () => {
      const client = new A2AClient(server.url);
      const task: A2ATask = await client.sendMessage(
        { role: 'user', parts: [{ type: 'text', text: 'long job' }] },
        { blocking: false, pushNotificationConfig: { webhookUrl } }
      );
      expect(task.status.state).toBe('working');

      for (let i = 0; i < 50 && !release; i++) await new Promise((r) => setTimeout(r, 10));
      release!();

      for (let i = 0; i < 100; i++) {
        if (received.some((e) => e.type === 'status-update' && e.status.state === 'completed')) {
          break;
        }
        await new Promise((r) => setTimeout(r, 20));
      }

      const completed = received.find(
        (e) => e.type === 'status-update' && e.status.state === 'completed'
      );
      expect(completed?.taskId).toBe(task.id);

      const final = await client.getTask(task.id, 1);
      expect(final.status.state).toBe('completed');
      expect(final.history).toHaveLength(1);
      expect(final.history[0].role).toBe('agent');
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

  it('remembers earlier turns of the same task without a memory adapter', async () => {
    const client = new A2AClient(server.url, { timeout: 120_000 });

    const first = await client.sendMessage({
      role: 'user',
      parts: [{ type: 'text', text: 'My favourite colour is turquoise. Just acknowledge it.' }],
    });
    expect(first.status.state).toBe('completed');

    const second = await client.continueTask(first.id, 'What is my favourite colour?');
    expect(second.status.state).toBe('completed');

    const answer = second.history.at(-1);
    const text = answer?.parts.find((p) => p.type === 'text');
    expect(text?.type === 'text' && text.text.toLowerCase()).toContain('turquoise');
  });
});
