import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { randomUUID } from 'node:crypto';
import express from 'express';
import type {
  AgentCard as SdkAgentCard,
  Message as SdkMessage,
  Task as SdkTask,
} from '@a2a-js/sdk';
import {
  DefaultRequestHandler,
  InMemoryTaskStore as SdkTaskStore,
  type AgentExecutor,
} from '@a2a-js/sdk/server';
import { agentCardHandler, jsonRpcHandler, UserBuilder } from '@a2a-js/sdk/server/express';
import { ClientFactory } from '@a2a-js/sdk/client';
import type { Agent, AgentConfig } from '@cogitator-ai/types';
import { A2AServer } from '../server';
import { A2AClient } from '../client';
import { a2aExpress } from '../adapters/express';
import type { A2AStreamEvent, AgentRunResult, CogitatorLike } from '../types';

/**
 * Interoperability with the official A2A JavaScript SDK (@a2a-js/sdk 0.3.x, protocol v0.3.0): its
 * client talks to an A2AServer, and A2AClient talks to a server built with the SDK.
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

function sdkUserMessage(text: string): SdkMessage {
  return {
    kind: 'message',
    messageId: randomUUID(),
    role: 'user',
    parts: [{ kind: 'text', text }],
  };
}

function textOf(task: SdkTask): string {
  return (task.artifacts ?? [])
    .flatMap((artifact) => artifact.parts)
    .map((part) => (part.kind === 'text' ? part.text : ''))
    .join('');
}

describe('official A2A SDK client against A2AServer', () => {
  let served: Served;

  beforeAll(async () => {
    const app = express();
    app.use(
      a2aExpress(
        new A2AServer({
          agents: { helper: mockAgent('helper'), writer: mockAgent('writer') },
          cogitator,
        })
      )
    );
    served = await listen(app);
  });

  afterAll(async () => {
    await served.close();
  });

  it('discovers the card and sends a message', async () => {
    const client = await new ClientFactory().createFromUrl(served.url);
    const card = await client.getAgentCard();
    expect(card.name).toBe('helper');

    const result = await client.sendMessage({ message: sdkUserMessage('ping') });
    expect(result.kind).toBe('task');
    const task = result as SdkTask;
    expect(task.status.state).toBe('completed');
    expect(textOf(task)).toBe('helper heard: ping');

    const fetched = await client.getTask({ id: task.id });
    expect(fetched.id).toBe(task.id);
    expect(fetched.status.state).toBe('completed');
  });

  it('streams a message to the end', async () => {
    const client = await new ClientFactory().createFromUrl(served.url);
    const events = [];
    for await (const event of client.sendMessageStream({ message: sdkUserMessage('stream it') })) {
      events.push(event);
    }
    expect(events[0].kind).toBe('task');
    const last = events.at(-1)!;
    expect(last.kind).toBe('status-update');
    expect(last.kind === 'status-update' && last.final).toBe(true);
    const streamed = events
      .flatMap((event) => (event.kind === 'artifact-update' ? event.artifact.parts : []))
      .map((part) => (part.kind === 'text' ? part.text : ''))
      .join('');
    expect(streamed).toBe('helper heard: stream it');
  });

  it('reaches a second agent through its own card', async () => {
    const client = await new ClientFactory().createFromUrl(`${served.url}/a2a/writer/`);
    expect((await client.getAgentCard()).name).toBe('writer');
    const result = (await client.sendMessage({ message: sdkUserMessage('hi') })) as SdkTask;
    expect(textOf(result)).toBe('writer heard: hi');
  });
});

describe('A2AClient against a server built with the official A2A SDK', () => {
  let served: Served;

  beforeAll(async () => {
    const card: SdkAgentCard = {
      protocolVersion: '0.3.0',
      name: 'sdk-echo',
      description: 'Echoes what it hears',
      url: '',
      preferredTransport: 'JSONRPC',
      version: '1.0.0',
      capabilities: { streaming: true, pushNotifications: false },
      defaultInputModes: ['text/plain'],
      defaultOutputModes: ['text/plain'],
      skills: [{ id: 'echo', name: 'Echo', description: 'Echoes the input', tags: ['echo'] }],
    };
    const executor: AgentExecutor = {
      async execute(context, bus) {
        const { taskId, contextId, userMessage } = context;
        const timestamp = new Date().toISOString();
        if (!context.task) {
          bus.publish({
            kind: 'task',
            id: taskId,
            contextId,
            status: { state: 'submitted', timestamp },
            history: [userMessage],
          });
        }
        bus.publish({
          kind: 'status-update',
          taskId,
          contextId,
          status: { state: 'working', timestamp },
          final: false,
        });
        const heard = userMessage.parts
          .map((part) => (part.kind === 'text' ? part.text : ''))
          .join('');
        bus.publish({
          kind: 'artifact-update',
          taskId,
          contextId,
          artifact: { artifactId: 'echo', parts: [{ kind: 'text', text: `echo: ${heard}` }] },
          lastChunk: true,
        });
        bus.publish({
          kind: 'status-update',
          taskId,
          contextId,
          status: {
            state: 'completed',
            timestamp,
            message: {
              kind: 'message',
              messageId: randomUUID(),
              role: 'agent',
              parts: [{ kind: 'text', text: `echo: ${heard}` }],
              taskId,
              contextId,
            },
          },
          final: true,
        });
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
    served = await listen(app);
    card.url = `${served.url}/rpc`;
  });

  afterAll(async () => {
    await served.close();
  });

  it('reads the card and sends a message to the endpoint it names', async () => {
    const client = new A2AClient(served.url);
    const card = await client.agentCard();
    expect(card.name).toBe('sdk-echo');

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
  });

  it('streams events until the final status update', async () => {
    const client = new A2AClient(served.url);
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

  it('works as a tool for a Cogitator agent', async () => {
    const tool = new A2AClient(served.url).asTool();
    const result = await tool.execute(
      { task: 'as a tool' },
      {
        agentId: 'a',
        runId: 'r',
        signal: new AbortController().signal,
      }
    );
    expect(result).toMatchObject({ success: true, output: 'echo: as a tool', state: 'completed' });
  });
});
