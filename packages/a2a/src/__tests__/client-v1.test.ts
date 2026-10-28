import { describe, it, expect, afterEach } from 'vitest';
import http from 'node:http';
import { A2AClient } from '../client';
import { A2AError } from '../errors';
import type { AgentCard } from '../types';
import type { V1AgentCard } from '../v1/types';
import { echoCogitator, listen, mockAgent, serveExpress, type Served } from './v1-helpers';

interface Recorded {
  method: string;
  url: string;
  headers: http.IncomingHttpHeaders;
  body: string;
}

/** A server that serves a fixed card and records every other request. */
async function cardServer(card: (url: string) => object): Promise<{
  url: string;
  requests: Recorded[];
  close(): Promise<void>;
}> {
  const requests: Recorded[] = [];
  let base = '';
  const listening = await listen((req, res) => {
    let body = '';
    req.on('data', (chunk) => (body += chunk));
    req.on('end', () => {
      if (req.url === '/.well-known/agent-card.json') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(card(base)));
        return;
      }
      requests.push({ method: req.method ?? '', url: req.url ?? '', headers: req.headers, body });
      const task = { id: 't1', contextId: 'c', status: { state: 'TASK_STATE_WORKING' } };
      const legacyTask = { kind: 'task', id: 't1', contextId: 'c', status: { state: 'working' } };
      res.writeHead(200, { 'Content-Type': 'application/json' });
      if (req.url !== '/rpc') {
        res.end(JSON.stringify(task));
        return;
      }
      const v1 = req.headers['a2a-version'] === '1.0';
      res.end(JSON.stringify({ jsonrpc: '2.0', id: 1, result: v1 ? task : legacyTask }));
    });
  });
  base = listening.url;
  return { ...listening, requests };
}

const legacyCard = (url: string): AgentCard => ({
  protocolVersion: '0.3.0',
  name: 'legacy',
  description: 'legacy',
  url: `${url}/rpc`,
  version: '1.0.0',
  capabilities: {},
  defaultInputModes: ['text/plain'],
  defaultOutputModes: ['text/plain'],
  skills: [],
});

const v1Card = (url: string): V1AgentCard => ({
  name: 'modern',
  description: 'modern',
  supportedInterfaces: [
    { url: `${url}/rest`, protocolBinding: 'HTTP+JSON', tenant: 'acme', protocolVersion: '1.0' },
    { url: `${url}/rpc`, protocolBinding: 'JSONRPC', tenant: 'acme', protocolVersion: '1.0' },
  ],
  version: '1.0.0',
  capabilities: {},
  defaultInputModes: ['text/plain'],
  defaultOutputModes: ['text/plain'],
  skills: [{ id: 's', name: 's', description: 's', tags: ['t'] }],
});

describe('A2AClient protocol versions', () => {
  let target: Awaited<ReturnType<typeof cardServer>> | undefined;
  let served: Served | undefined;

  afterEach(async () => {
    await target?.close();
    await served?.close();
    target = undefined;
    served = undefined;
  });

  it('speaks 0.3 to a server whose card offers only 0.3, without a version header', async () => {
    target = await cardServer(legacyCard);
    const client = new A2AClient(target.url);
    expect(await client.endpoint()).toEqual({
      protocolVersion: '0.3',
      transport: 'JSONRPC',
      url: `${target.url}/rpc`,
    });
    await expect(client.getTask('t1')).resolves.toBeDefined();
    const [call] = target.requests;
    expect(call.headers['a2a-version']).toBeUndefined();
    expect(JSON.parse(call.body).method).toBe('tasks/get');
  });

  it('refuses protocolVersion 1.0 against a 0.3-only card', async () => {
    target = await cardServer(legacyCard);
    const client = new A2AClient(target.url, { protocolVersion: '1.0' });
    await expect(client.endpoint()).rejects.toMatchObject({ code: -32009 });
  });

  it('takes the first 1.0 interface of a pure 1.0 card with its tenant', async () => {
    target = await cardServer(v1Card);
    const client = new A2AClient(target.url);
    expect(await client.endpoint()).toEqual({
      protocolVersion: '1.0',
      transport: 'HTTP+JSON',
      url: `${target.url}/rest`,
      tenant: 'acme',
    });
    const card = await client.agentCard();
    expect(card).toMatchObject({
      name: 'modern',
      protocolVersion: '1.0',
      url: `${target.url}/rest`,
    });
  });

  it('prefers the configured transport and sends the tenant in params', async () => {
    target = await cardServer(v1Card);
    const client = new A2AClient(target.url, { transport: 'JSONRPC' });
    const task = await client.getTask('t1');
    expect(task.status.state).toBe('working');
    const [call] = target.requests;
    expect(call.url).toBe('/rpc');
    expect(call.headers['a2a-version']).toBe('1.0');
    expect(JSON.parse(call.body)).toMatchObject({
      method: 'GetTask',
      params: { id: 't1', tenant: 'acme' },
    });
  });

  it('puts the tenant in the REST path', async () => {
    target = await cardServer(v1Card);
    const client = new A2AClient(target.url);
    await client.getTask('task 1', 2);
    expect(target.requests[0]).toMatchObject({
      method: 'GET',
      url: '/rest/acme/tasks/task%201?historyLength=2',
    });
  });

  it('cannot speak 0.3 to a pure 1.0 card', async () => {
    target = await cardServer(v1Card);
    const client = new A2AClient(target.url, { protocolVersion: '0.3' });
    await expect(client.endpoint()).rejects.toBeInstanceOf(A2AError);
  });

  it('reads the hybrid card of a Cogitator server and picks 1.0, or 0.3 when asked', async () => {
    served = await serveExpress({
      agents: { helper: mockAgent('helper') },
      cogitator: echoCogitator(),
    });
    const auto = new A2AClient(served.url);
    expect((await auto.agentCard()).protocolVersion).toBe('0.3.0');
    expect(await auto.endpoint()).toMatchObject({
      protocolVersion: '1.0',
      transport: 'JSONRPC',
      tenant: 'helper',
    });

    const legacy = new A2AClient(served.url, { protocolVersion: '0.3' });
    expect(await legacy.endpoint()).toEqual({
      protocolVersion: '0.3',
      transport: 'JSONRPC',
      url: `${served.url}/a2a`,
    });
    const result = await legacy.sendMessage({
      role: 'user',
      parts: [{ kind: 'text', text: 'old' }],
    });
    expect(result.kind).toBe('task');
    await expect(legacy.listTasksPage()).rejects.toMatchObject({ code: -32004 });
    expect(await legacy.listTasks()).toHaveLength(1);
  });

  it('pages tasks with listTasksPage and lists them all with listTasks over 1.0', async () => {
    served = await serveExpress({
      agents: { helper: mockAgent('helper') },
      cogitator: echoCogitator(),
    });
    const client = new A2AClient(served.url, { transport: 'HTTP+JSON' });
    for (const text of ['a', 'b', 'c']) {
      await client.sendMessage({ role: 'user', parts: [{ kind: 'text', text }] });
    }
    const first = await client.listTasksPage({ pageSize: 2 });
    expect(first.tasks).toHaveLength(2);
    expect(first.totalSize).toBe(3);
    expect(first.tasks[0]).not.toHaveProperty('artifacts');
    const second = await client.listTasksPage({ pageSize: 2, pageToken: first.nextPageToken });
    expect(second.tasks).toHaveLength(1);
    expect(second.nextPageToken).toBe('');

    const all = await client.listTasks();
    expect(all).toHaveLength(3);
    expect(all.every((task) => (task.artifacts ?? []).length > 0)).toBe(true);
    expect(await client.listTasks({ offset: 1, limit: 1 })).toHaveLength(1);
  });

  it('manages push configs and fetches the extended card over 1.0', async () => {
    served = await serveExpress({
      agents: { helper: mockAgent('helper') },
      cogitator: echoCogitator(),
      extendedCardGenerator: () => ({
        ...legacyCard('https://x.example'),
        name: 'helper',
        description: 'more',
      }),
    });
    for (const transport of ['JSONRPC', 'HTTP+JSON'] as const) {
      const client = new A2AClient(served.url, { transport });
      const task = await client.sendMessage({ role: 'user', parts: [{ kind: 'text', text: 'p' }] });
      if (task.kind !== 'task') throw new Error('expected a task');
      const created = await client.setPushNotificationConfig(task.id, {
        url: 'https://hooks.example.com/x',
        authentication: { schemes: ['Bearer'], credentials: 'c' },
      });
      expect(created.pushNotificationConfig).toMatchObject({
        url: 'https://hooks.example.com/x',
        authentication: { schemes: ['Bearer'], credentials: 'c' },
      });
      const id = created.pushNotificationConfig.id!;
      expect((await client.getPushNotificationConfig(task.id, id)).pushNotificationConfig.id).toBe(
        id
      );
      expect((await client.getPushNotificationConfig(task.id)).pushNotificationConfig.id).toBe(id);
      expect(await client.listPushNotificationConfigs(task.id)).toHaveLength(1);
      await client.deletePushNotificationConfig(task.id, id);
      expect(await client.listPushNotificationConfigs(task.id)).toHaveLength(0);
      await expect(client.getPushNotificationConfig(task.id)).rejects.toMatchObject({
        code: -32602,
      });

      const extended = await client.extendedAgentCard();
      expect(extended.description).toBe('more');
      expect(extended.supportsAuthenticatedExtendedCard).toBe(true);
    }
  });

  it('continues, cancels and resubscribes over the 1.0 REST binding', async () => {
    served = await serveExpress({
      agents: { helper: mockAgent('helper') },
      cogitator: echoCogitator(),
    });
    const client = new A2AClient(served.url, { transport: 'HTTP+JSON' });
    const asked = await client.sendMessage({
      role: 'user',
      parts: [{ kind: 'text', text: 'please ask' }],
    });
    if (asked.kind !== 'task') throw new Error('expected a task');
    expect(asked.status.state).toBe('input-required');

    const events = [];
    for await (const event of client.resubscribeTask(asked.id)) events.push(event);
    expect(events.map((event) => event.kind)).toEqual(['task']);

    const answered = await client.continueTask(asked.id, 'here');
    expect(answered.kind === 'task' && answered.status.state).toBe('completed');
    await expect(client.cancelTask(asked.id)).rejects.toMatchObject({ code: -32002 });
  });
});
