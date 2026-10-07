import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest';
import { readFileSync } from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import express from 'express';
import { Ajv, type ValidateFunction } from 'ajv';
import type { Agent, AgentConfig } from '@cogitator-ai/types';
import { A2AServer } from '../server';
import { a2aExpress } from '../adapters/express';
import type { AgentRunResult, CogitatorLike } from '../types';

/**
 * Wire conformance with A2A protocol v0.3.0. Every response is validated against the official JSON
 * schema (a2aproject/A2A, tag v0.3.0, specification/json/a2a.json) and the requests are the ones
 * the specification shows in its examples.
 */
const schema = JSON.parse(
  readFileSync(new URL('./fixtures/a2a-v0.3.0.schema.json', import.meta.url), 'utf8')
) as Record<string, unknown>;
const ajv = new Ajv({ strict: false, allErrors: true });
ajv.addSchema(schema, 'a2a');
const validators = new Map<string, ValidateFunction>();

function expectValid(definition: string, value: unknown): void {
  let validate = validators.get(definition);
  if (!validate) {
    validate = ajv.compile({ $ref: `a2a#/definitions/${definition}` });
    validators.set(definition, validate);
  }
  const valid = validate(value);
  expect(
    valid,
    `${definition}: ${ajv.errorsText(validate.errors)}\n${JSON.stringify(value, null, 2)}`
  ).toBe(true);
}

function mockAgent(name: string): Agent {
  const config: AgentConfig = {
    name,
    model: 'test',
    instructions: 'private instructions',
    description: `${name} agent`,
  };
  return {
    id: `agent_${name}`,
    name,
    config,
    model: config.model,
    instructions: config.instructions,
    tools: [],
    clone: vi.fn() as Agent['clone'],
    serialize: vi.fn() as Agent['serialize'],
  };
}

function runResult(output: string): AgentRunResult {
  return {
    output,
    runId: 'run_1',
    agentId: 'agent_1',
    threadId: 'thread_1',
    usage: { inputTokens: 1, outputTokens: 2, totalTokens: 3, cost: 0, duration: 1 },
    toolCalls: [],
  };
}

const releaseSlowRuns = new Set<() => void>();

const cogitator: CogitatorLike = {
  run: async (_agent, options) => {
    if (options.input.includes('slow')) {
      await new Promise<void>((resolve) => {
        releaseSlowRuns.add(resolve);
        options.signal?.addEventListener('abort', () => resolve(), { once: true });
      });
      if (options.signal?.aborted) throw new Error('aborted');
    }
    for (const token of ['Hel', 'lo', ' there']) options.onToken?.(token);
    return runResult('Hello there');
  },
};

interface Served {
  url: string;
  close(): Promise<void>;
}

async function serve(server: A2AServer): Promise<Served> {
  const app = express();
  app.use(a2aExpress(server));
  const httpServer = http.createServer(app);
  await new Promise<void>((resolve) => httpServer.listen(0, '127.0.0.1', resolve));
  return {
    url: `http://127.0.0.1:${(httpServer.address() as AddressInfo).port}`,
    close: () =>
      new Promise<void>((resolve) => {
        for (const release of releaseSlowRuns) release();
        httpServer.closeAllConnections();
        httpServer.close(() => resolve());
      }),
  };
}

async function rpc(
  url: string,
  method: string,
  params: unknown,
  id: string | number = 1,
  headers: Record<string, string> = {}
): Promise<{ status: number; body: Record<string, unknown> }> {
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...headers },
    body: JSON.stringify({ jsonrpc: '2.0', id, method, params }),
  });
  return { status: response.status, body: (await response.json()) as Record<string, unknown> };
}

async function stream(
  url: string,
  method: string,
  params: unknown,
  id: string | number = 7
): Promise<{ contentType: string | null; frames: string[] }> {
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'text/event-stream' },
    body: JSON.stringify({ jsonrpc: '2.0', id, method, params }),
  });
  const text = await response.text();
  const frames = text
    .split('\n\n')
    .map((frame) =>
      frame
        .split('\n')
        .filter((line) => line.startsWith('data:'))
        .map((line) => line.slice(5).trim())
        .join('\n')
    )
    .filter((data) => data.length > 0);
  return { contentType: response.headers.get('content-type'), frames };
}

function specMessage(text: string, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    role: 'user',
    parts: [{ kind: 'text', text }],
    messageId: `msg-${Math.random().toString(36).slice(2)}`,
    kind: 'message',
    ...extra,
  };
}

describe('A2A v0.3.0 conformance', () => {
  let served: Served;
  let rpcUrl: string;

  beforeAll(async () => {
    served = await serve(
      new A2AServer({
        agents: { helper: mockAgent('helper'), writer: mockAgent('writer') },
        cogitator,
        extendedCardGenerator: (name) => ({
          ...new A2AServer({ agents: { [name]: mockAgent(name) }, cogitator }).getAgentCard(),
          description: `extended card of ${name}`,
        }),
      })
    );
    rpcUrl = `${served.url}/a2a`;
  });

  afterAll(async () => {
    await served.close();
  });

  describe('agent card', () => {
    it('is served at the well-known agent-card.json path as one AgentCard', async () => {
      const response = await fetch(`${served.url}/.well-known/agent-card.json`);
      expect(response.status).toBe(200);
      const card = (await response.json()) as Record<string, unknown>;
      expectValid('AgentCard', card);
      expect(card.protocolVersion).toBe('0.3.0');
      expect(card.preferredTransport).toBe('JSONRPC');
      expect(card.name).toBe('helper');
      expect(card.url).toBe(rpcUrl);
      expect(JSON.stringify(card)).not.toContain('private instructions');
    });

    it('serves each agent its own card and endpoint', async () => {
      const response = await fetch(`${rpcUrl}/writer/.well-known/agent-card.json`);
      const card = (await response.json()) as Record<string, unknown>;
      expectValid('AgentCard', card);
      expect(card.name).toBe('writer');
      expect(card.url).toBe(`${rpcUrl}/writer`);

      const sent = await rpc(card.url as string, 'message/send', {
        message: specMessage('who are you?'),
      });
      expectValid('SendMessageSuccessResponse', sent.body);
    });

    it('keeps the legacy agent.json path as an alias', async () => {
      const response = await fetch(`${served.url}/.well-known/agent.json`);
      expect(response.status).toBe(200);
    });
  });

  describe('message/send', () => {
    it('answers the specification example with a Task', async () => {
      const { status, body } = await rpc(
        rpcUrl,
        'message/send',
        {
          message: {
            role: 'user',
            parts: [{ kind: 'text', text: 'tell me a joke' }],
            messageId: '9229e770-767c-417b-a0b0-f0741243c589',
          },
          metadata: {},
        },
        1
      );
      expect(status).toBe(200);
      expectValid('SendMessageSuccessResponse', body);
      expect(body.id).toBe(1);
      const task = body.result as Record<string, unknown>;
      expectValid('Task', task);
      expect(task.kind).toBe('task');
      expect((task.status as Record<string, unknown>).state).toBe('completed');
      const history = task.history as Record<string, unknown>[];
      expect(history[0].messageId).toBe('9229e770-767c-417b-a0b0-f0741243c589');
      expect(history[0].taskId).toBe(task.id);
      expect(history[0].contextId).toBe(task.contextId);
      expect(history.at(-1)?.role).toBe('agent');
      const artifacts = task.artifacts as Record<string, unknown>[];
      expect(artifacts[0].artifactId).toEqual(expect.any(String));
      expect(artifacts[0].parts).toEqual([{ kind: 'text', text: 'Hello there' }]);
    });

    it('accepts file parts with bytes and with a uri, and data parts', async () => {
      const { body } = await rpc(rpcUrl, 'message/send', {
        message: specMessage('look', {
          parts: [
            { kind: 'text', text: 'look at these' },
            { kind: 'file', file: { bytes: 'aGVsbG8=', mimeType: 'text/plain', name: 'a.txt' } },
            { kind: 'file', file: { uri: 'https://example.com/b.png', mimeType: 'image/png' } },
            { kind: 'data', data: { answer: 42 } },
          ],
        }),
      });
      expectValid('SendMessageSuccessResponse', body);
    });

    it('requires a messageId', async () => {
      const { body } = await rpc(rpcUrl, 'message/send', {
        message: { role: 'user', parts: [{ kind: 'text', text: 'hi' }] },
      });
      expectValid('JSONRPCErrorResponse', body);
      expectValid('InvalidParamsError', body.error);
    });

    it('refuses to continue a task in a terminal state', async () => {
      const first = await rpc(rpcUrl, 'message/send', { message: specMessage('hi') });
      const task = first.body.result as Record<string, unknown>;
      const { body } = await rpc(rpcUrl, 'message/send', {
        message: specMessage('again', { taskId: task.id, contextId: task.contextId }),
      });
      expectValid('JSONRPCErrorResponse', body);
    });

    it('returns a working task without waiting when blocking is false', async () => {
      const { body } = await rpc(rpcUrl, 'message/send', {
        message: specMessage('slow job'),
        configuration: { blocking: false },
      });
      expectValid('SendMessageSuccessResponse', body);
      const task = body.result as { id: string; status: { state: string } };
      expect(['submitted', 'working']).toContain(task.status.state);

      const canceled = await rpc(rpcUrl, 'tasks/cancel', { id: task.id }, 'cancel-1');
      expectValid('CancelTaskSuccessResponse', canceled.body);
      expect((canceled.body.result as { status: { state: string } }).status.state).toBe('canceled');

      const again = await rpc(rpcUrl, 'tasks/cancel', { id: task.id }, 'cancel-2');
      expectValid('JSONRPCErrorResponse', again.body);
      expectValid('TaskNotCancelableError', again.body.error);
    });
  });

  describe('message/stream', () => {
    it('sends every event as a JSON-RPC response and ends with a final status update', async () => {
      const { contentType, frames } = await stream(rpcUrl, 'message/stream', {
        message: specMessage('write a long paper'),
        metadata: {},
      });
      expect(contentType).toMatch(/^text\/event-stream/);
      expect(frames).not.toContain('[DONE]');

      const responses = frames.map((frame) => JSON.parse(frame) as Record<string, unknown>);
      for (const response of responses) {
        expectValid('SendStreamingMessageSuccessResponse', response);
        expect(response.id).toBe(7);
      }

      const results = responses.map((r) => r.result as Record<string, unknown>);
      expect(results[0].kind).toBe('task');
      const last = results.at(-1)!;
      expect(last.kind).toBe('status-update');
      expect(last.final).toBe(true);
      expect((last.status as Record<string, unknown>).state).toBe('completed');
      expect(results.filter((r) => r.kind === 'status-update' && r.final === true)).toHaveLength(1);

      const chunks = results.filter((r) => r.kind === 'artifact-update');
      const artifactIds = new Set(
        chunks.map((c) => (c.artifact as { artifactId: string }).artifactId)
      );
      expect(artifactIds.size).toBe(1);
      expect(chunks[0].append).not.toBe(true);
      expect(chunks.slice(1).every((c) => c.append === true)).toBe(true);
      expect(chunks.at(-1)?.lastChunk).toBe(true);
      const text = chunks
        .flatMap((c) => (c.artifact as { parts: { text?: string }[] }).parts)
        .map((p) => p.text ?? '')
        .join('');
      expect(text).toBe('Hello there');
    });

    it('answers an invalid request with a JSON-RPC error before any stream starts', async () => {
      const { status, body } = await rpc(
        rpcUrl,
        'message/stream',
        { message: { role: 'user', parts: [{ kind: 'text', text: 'no id' }] } },
        7
      );
      expect(status).toBe(200);
      expectValid('JSONRPCErrorResponse', body);
      expectValid('InvalidParamsError', body.error);
      expect(body.id).toBe(7);
    });
  });

  describe('tasks', () => {
    it('gets a task and reports an unknown one as TaskNotFoundError', async () => {
      const sent = await rpc(rpcUrl, 'message/send', { message: specMessage('hi') });
      const task = sent.body.result as { id: string };

      const got = await rpc(rpcUrl, 'tasks/get', { id: task.id, historyLength: 1 });
      expectValid('GetTaskSuccessResponse', got.body);
      expect((got.body.result as { history: unknown[] }).history).toHaveLength(1);

      const missing = await rpc(rpcUrl, 'tasks/get', { id: 'nope' });
      expectValid('JSONRPCErrorResponse', missing.body);
      expectValid('TaskNotFoundError', missing.body.error);
    });

    it('resubscribes to a task: the task first, then nothing more once it ended', async () => {
      const sent = await rpc(rpcUrl, 'message/send', { message: specMessage('hi') });
      const task = sent.body.result as { id: string };

      const { frames } = await stream(rpcUrl, 'tasks/resubscribe', { id: task.id });
      expect(frames).toHaveLength(1);
      const response = JSON.parse(frames[0]) as Record<string, unknown>;
      expectValid('SendStreamingMessageSuccessResponse', response);
      expect((response.result as { kind: string }).kind).toBe('task');
    });

    it('reports an unknown method as MethodNotFoundError', async () => {
      const { body } = await rpc(rpcUrl, 'tasks/foo', {});
      expectValid('JSONRPCErrorResponse', body);
      expectValid('MethodNotFoundError', body.error);
    });
  });

  describe('push notification config', () => {
    it('sets, gets, lists and deletes a config with the specification shapes', async () => {
      const sent = await rpc(rpcUrl, 'message/send', { message: specMessage('hi') });
      const task = sent.body.result as { id: string };

      const set = await rpc(rpcUrl, 'tasks/pushNotificationConfig/set', {
        taskId: task.id,
        pushNotificationConfig: {
          url: 'https://client.example.com/webhook/a2a-notifications',
          token: 'secure-client-token',
          authentication: { schemes: ['Bearer'] },
        },
      });
      expectValid('SetTaskPushNotificationConfigSuccessResponse', set.body);
      const configId = (set.body.result as { pushNotificationConfig: { id: string } })
        .pushNotificationConfig.id;
      expect(configId).toEqual(expect.any(String));

      const got = await rpc(rpcUrl, 'tasks/pushNotificationConfig/get', {
        id: task.id,
        pushNotificationConfigId: configId,
      });
      expectValid('GetTaskPushNotificationConfigSuccessResponse', got.body);

      const listed = await rpc(rpcUrl, 'tasks/pushNotificationConfig/list', { id: task.id });
      expectValid('ListTaskPushNotificationConfigSuccessResponse', listed.body);
      expect(listed.body.result).toHaveLength(1);

      const deleted = await rpc(rpcUrl, 'tasks/pushNotificationConfig/delete', {
        id: task.id,
        pushNotificationConfigId: configId,
      });
      expectValid('DeleteTaskPushNotificationConfigSuccessResponse', deleted.body);
    });
  });

  describe('agent/getAuthenticatedExtendedCard', () => {
    it('returns the extended AgentCard', async () => {
      const { body } = await rpc(rpcUrl, 'agent/getAuthenticatedExtendedCard', undefined);
      expectValid('GetAuthenticatedExtendedCardSuccessResponse', body);
      expect((body.result as { description: string }).description).toBe('extended card of helper');
    });

    it('reports AuthenticatedExtendedCardNotConfiguredError without a generator', async () => {
      const plain = await serve(
        new A2AServer({ agents: { helper: mockAgent('helper') }, cogitator })
      );
      try {
        const card = (await (
          await fetch(`${plain.url}/.well-known/agent-card.json`)
        ).json()) as Record<string, unknown>;
        expect(card.supportsAuthenticatedExtendedCard).not.toBe(true);
        const { body } = await rpc(
          `${plain.url}/a2a`,
          'agent/getAuthenticatedExtendedCard',
          undefined
        );
        expectValid('JSONRPCErrorResponse', body);
        expectValid('AuthenticatedExtendedCardNotConfiguredError', body.error);
      } finally {
        await plain.close();
      }
    });
  });

  describe('authentication', () => {
    it('declares the scheme on the card and answers missing credentials with HTTP 401', async () => {
      const secured = await serve(
        new A2AServer({
          agents: { helper: mockAgent('helper') },
          cogitator,
          auth: { type: 'bearer', validate: async (token) => token === 'good' },
        })
      );
      try {
        const card = (await (
          await fetch(`${secured.url}/.well-known/agent-card.json`)
        ).json()) as Record<string, unknown>;
        expectValid('AgentCard', card);
        expect(card.securitySchemes).toEqual({ bearer: { type: 'http', scheme: 'bearer' } });
        expect(card.security).toEqual([{ bearer: [] }]);

        const response = await fetch(`${secured.url}/a2a`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tasks/get', params: { id: 'x' } }),
        });
        expect(response.status).toBe(401);
        expect(response.headers.get('www-authenticate')).toMatch(/^Bearer/);
        expectValid('JSONRPCErrorResponse', await response.json());

        const ok = await rpc(
          `${secured.url}/a2a`,
          'message/send',
          { message: specMessage('hi') },
          2,
          { Authorization: 'Bearer good' }
        );
        expectValid('SendMessageSuccessResponse', ok.body);
      } finally {
        await secured.close();
      }
    });
  });
});
