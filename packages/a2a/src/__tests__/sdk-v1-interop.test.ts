import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { generateKeyPairSync, randomUUID } from 'node:crypto';
import express from 'express';
import {
  AgentCard as SdkAgentCard,
  GetTaskRequest,
  ListTasksRequest,
  Message as SdkMessage,
  SendMessageRequest,
  SubscribeToTaskRequest,
  Task as SdkTask,
  TaskArtifactUpdateEvent as SdkArtifactUpdate,
  TaskState as SdkTaskState,
  TaskStatusUpdateEvent as SdkStatusUpdate,
  verifyAgentCardSignature,
} from '@a2a-js/sdk-v1';
import {
  AgentEvent,
  DefaultRequestHandler,
  InMemoryTaskStore as SdkTaskStore,
  type AgentExecutor,
} from '@a2a-js/sdk-v1/server';
import {
  agentCardHandler,
  jsonRpcHandler,
  restHandler,
  UserBuilder,
} from '@a2a-js/sdk-v1/server/express';
import { ClientFactory, ClientFactoryOptions } from '@a2a-js/sdk-v1/client';
import type { Agent, AgentConfig } from '@cogitator-ai/types';
import { A2AServer } from '../server';
import { A2AClient } from '../client';
import { a2aExpress } from '../adapters/express';
import type { A2AStreamEvent, AgentRunResult, CogitatorLike } from '../types';

/**
 * Interoperability with the official A2A JavaScript SDK 1.3 (protocol 1.0): its clients talk to
 * an A2AServer over JSON-RPC and HTTP+JSON, and A2AClient talks to a server built with the SDK.
 */

interface Served {
  url: string;
  close(): Promise<void>;
}

async function listen(app: express.Express): Promise<Served> {
  const server = http.createServer(app);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return {
    url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}

function mockAgent(name: string): Agent {
  const config: AgentConfig = { name, model: 'test', instructions: 'test', description: name };
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

const cogitator: CogitatorLike = {
  run: async (agent, options) => {
    const output = `${(agent as Agent).name} heard: ${options.input}`;
    if (options.onToken) {
      for (const word of output.split(/(?= )/)) options.onToken(word);
    }
    return runResult(output);
  },
};

function sdkRequest(text: string): SendMessageRequest {
  return SendMessageRequest.fromJSON({
    message: { messageId: randomUUID(), role: 'ROLE_USER', parts: [{ text }] },
  });
}

function textOf(task: SdkTask): string {
  return task.artifacts
    .flatMap((artifact) => artifact.parts)
    .map((part) => (part.content?.$case === 'text' ? part.content.value : ''))
    .join('');
}

function isSdkTask(result: SdkTask | SdkMessage): result is SdkTask {
  return 'status' in result;
}

const transports = [
  { name: 'JSON-RPC', preferred: 'JSONRPC' },
  { name: 'HTTP+JSON', preferred: 'HTTP+JSON' },
] as const;

describe('official A2A SDK 1.3 client against A2AServer', () => {
  let served: Served;
  const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' });

  beforeAll(async () => {
    const app = express();
    app.use(
      a2aExpress(
        new A2AServer({
          agents: { helper: mockAgent('helper'), writer: mockAgent('writer') },
          cogitator,
          cardSigning: { alg: 'ES256', privateKey, kid: 'card-key' },
        })
      )
    );
    served = await listen(app);
  });

  afterAll(async () => {
    await served.close();
  });

  function factory(preferred: 'JSONRPC' | 'HTTP+JSON'): ClientFactory {
    return new ClientFactory(
      ClientFactoryOptions.createFrom(ClientFactoryOptions.default, {
        preferredTransports: [preferred],
      })
    );
  }

  it('verifies the signature of the A2A 1.0 card with the SDK verifier', async () => {
    const client = await new ClientFactory().createFromUrl(served.url);
    const card = await client.getAgentCard();
    expect(card.signatures).toHaveLength(1);
    await expect(
      verifyAgentCardSignature(async (kid) => {
        expect(kid).toBe('card-key');
        return publicKey;
      })(card)
    ).resolves.toBeUndefined();
  });

  for (const { name, preferred } of transports) {
    describe(`over ${name}`, () => {
      it('picks the 1.0 interface with the agent as tenant and sends a message', async () => {
        const client = await factory(preferred).createFromUrl(served.url);
        expect(client.protocolVersion).toBe('1.0');
        const card = await client.getAgentCard();
        expect(card.name).toBe('helper');
        expect(card.supportedInterfaces.map((entry) => entry.protocolBinding)).toEqual([
          'JSONRPC',
          'HTTP+JSON',
          'JSONRPC',
        ]);

        const result = await client.sendMessage(sdkRequest('ping'));
        expect(isSdkTask(result)).toBe(true);
        if (!isSdkTask(result)) return;
        expect(result.status?.state).toBe(SdkTaskState.TASK_STATE_COMPLETED);
        expect(textOf(result)).toBe('helper heard: ping');

        const fetched = await client.getTask(
          GetTaskRequest.fromJSON({ id: result.id, historyLength: 0 })
        );
        expect(fetched.id).toBe(result.id);
        expect(fetched.history).toEqual([]);

        const listed = await client.listTasks(ListTasksRequest.fromJSON({ pageSize: 10 }));
        expect(listed.tasks.some((task) => task.id === result.id)).toBe(true);
        expect(listed.totalSize).toBeGreaterThanOrEqual(1);
      });

      it('streams a message until the task completes', async () => {
        const client = await factory(preferred).createFromUrl(served.url);
        const cases: string[] = [];
        let streamed = '';
        for await (const event of client.sendMessageStream(sdkRequest('stream it'))) {
          cases.push(event.payload?.$case ?? 'none');
          if (event.payload?.$case === 'artifactUpdate') {
            streamed += event.payload.value.artifact?.parts
              .map((part) => (part.content?.$case === 'text' ? part.content.value : ''))
              .join('');
          }
        }
        expect(cases[0]).toBe('task');
        expect(cases.at(-1)).toBe('statusUpdate');
        expect(streamed).toBe('helper heard: stream it');
      });

      it('refuses to subscribe to a task that already ended', async () => {
        const client = await factory(preferred).createFromUrl(served.url);
        const result = await client.sendMessage(sdkRequest('done'));
        if (!isSdkTask(result)) throw new Error('expected a task');
        const subscribe = async () => {
          for await (const _event of client.resubscribeTask(
            SubscribeToTaskRequest.fromJSON({ id: result.id })
          )) {
            return;
          }
        };
        await expect(subscribe()).rejects.toThrow();
      });

      it("reaches a second agent through its own card and tenant, not another agent's tasks", async () => {
        const writer = await factory(preferred).createFromUrl(`${served.url}/a2a/writer/`);
        expect((await writer.getAgentCard()).name).toBe('writer');
        const result = await writer.sendMessage(sdkRequest('hi'));
        if (!isSdkTask(result)) throw new Error('expected a task');
        expect(textOf(result)).toBe('writer heard: hi');

        const helper = await factory(preferred).createFromUrl(served.url);
        await expect(helper.getTask(GetTaskRequest.fromJSON({ id: result.id }))).rejects.toThrow();
      });
    });
  }
});

describe('A2AClient against a server built with the official A2A SDK 1.3', () => {
  let served: Served;
  const card = SdkAgentCard.fromJSON({
    name: 'sdk-echo',
    description: 'Echoes what it hears',
    supportedInterfaces: [],
    version: '1.0.0',
    capabilities: { streaming: true, pushNotifications: false },
    defaultInputModes: ['text/plain'],
    defaultOutputModes: ['text/plain'],
    skills: [{ id: 'echo', name: 'Echo', description: 'Echoes the input', tags: ['echo'] }],
  });

  beforeAll(async () => {
    const executor: AgentExecutor = {
      async execute(context, bus) {
        const { taskId, contextId, userMessage } = context;
        if (!context.task) {
          bus.publish(
            AgentEvent.task(
              SdkTask.fromJSON({
                id: taskId,
                contextId,
                status: { state: 'TASK_STATE_SUBMITTED' },
                history: [SdkMessage.toJSON(userMessage)],
              })
            )
          );
        }
        bus.publish(
          AgentEvent.statusUpdate(
            SdkStatusUpdate.fromJSON({ taskId, contextId, status: { state: 'TASK_STATE_WORKING' } })
          )
        );
        const heard = userMessage.parts
          .map((part) => (part.content?.$case === 'text' ? part.content.value : ''))
          .join('');
        bus.publish(
          AgentEvent.artifactUpdate(
            SdkArtifactUpdate.fromJSON({
              taskId,
              contextId,
              artifact: { artifactId: 'echo', parts: [{ text: `echo: ${heard}` }] },
              lastChunk: true,
            })
          )
        );
        bus.publish(
          AgentEvent.statusUpdate(
            SdkStatusUpdate.fromJSON({
              taskId,
              contextId,
              status: {
                state: 'TASK_STATE_COMPLETED',
                message: {
                  messageId: randomUUID(),
                  role: 'ROLE_AGENT',
                  parts: [{ text: `echo: ${heard}` }],
                },
              },
            })
          )
        );
        bus.finished();
      },
      async cancelTask() {},
    };
    const handler = new DefaultRequestHandler(card, new SdkTaskStore(), executor);
    const app = express();
    app.use('/.well-known/agent-card.json', agentCardHandler({ agentCardProvider: handler }));
    app.use(
      '/rpc',
      jsonRpcHandler({ requestHandler: handler, userBuilder: UserBuilder.noAuthentication })
    );
    app.use(
      '/rest',
      restHandler({ requestHandler: handler, userBuilder: UserBuilder.noAuthentication })
    );
    served = await listen(app);
    card.supportedInterfaces.push(
      { url: `${served.url}/rpc`, protocolBinding: 'JSONRPC', tenant: '', protocolVersion: '1.0' },
      {
        url: `${served.url}/rest`,
        protocolBinding: 'HTTP+JSON',
        tenant: '',
        protocolVersion: '1.0',
      }
    );
  });

  afterAll(async () => {
    await served.close();
  });

  for (const { name, preferred } of transports) {
    describe(`over ${name}`, () => {
      it('reads the pure 1.0 card and sends a message', async () => {
        const client = new A2AClient(served.url, { transport: preferred });
        const read = await client.agentCard();
        expect(read.name).toBe('sdk-echo');
        expect(read.protocolVersion).toBe('1.0');
        expect(await client.endpoint()).toMatchObject({
          protocolVersion: '1.0',
          transport: preferred,
        });

        const result = await client.sendMessage({
          role: 'user',
          parts: [{ kind: 'text', text: 'hello' }],
        });
        expect(result.kind).toBe('task');
        if (result.kind !== 'task') return;
        expect(result.status.state).toBe('completed');
        expect(result.artifacts?.[0].parts).toEqual([{ kind: 'text', text: 'echo: hello' }]);

        const fetched = await client.getTask(result.id);
        expect(fetched.status.state).toBe('completed');

        const page = await client.listTasksPage({ pageSize: 5, includeArtifacts: true });
        expect(page.tasks.some((task) => task.id === result.id)).toBe(true);
        expect(page.nextPageToken === '' || typeof page.nextPageToken === 'string').toBe(true);
      });

      it('streams events until the task completes', async () => {
        const client = new A2AClient(served.url, { transport: preferred });
        const events: A2AStreamEvent[] = [];
        for await (const event of client.sendMessageStream({
          role: 'user',
          parts: [{ kind: 'text', text: 'streamed' }],
        })) {
          events.push(event);
        }
        const last = events.at(-1)!;
        expect(last.kind).toBe('status-update');
        expect(last.kind === 'status-update' && last.final).toBe(true);
        expect(events.some((event) => event.kind === 'artifact-update')).toBe(true);
      });

      it('surfaces an SDK error with its A2A code', async () => {
        const client = new A2AClient(served.url, { transport: preferred });
        await expect(client.getTask('no-such-task')).rejects.toMatchObject({ code: -32001 });
      });
    });
  }

  it('works as a tool for a Cogitator agent', async () => {
    const tool = new A2AClient(served.url).asTool();
    const result = await tool.execute(
      { task: 'as a tool' },
      { agentId: 'a', runId: 'r', signal: new AbortController().signal }
    );
    expect(result).toMatchObject({ success: true, output: 'echo: as a tool', state: 'completed' });
  });
});
