import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { InMemoryPushNotificationStore, PushNotificationSender } from '../push-notifications';
import { A2AServer } from '../server';
import type { A2ATask } from '../types';
import { expectResponse, userMessage } from './helpers';
import { echoCogitator, mockAgent, v1UserMessage } from './v1-helpers';

interface Delivery {
  headers: http.IncomingHttpHeaders;
  body: Record<string, unknown>;
}

const deliveries: Delivery[] = [];
let hook: http.Server;
let hookUrl: string;

beforeAll(async () => {
  hook = http.createServer((req, res) => {
    let body = '';
    req.on('data', (chunk) => (body += chunk));
    req.on('end', () => {
      deliveries.push({
        headers: req.headers,
        body: JSON.parse(body) as Record<string, unknown>,
      });
      res.writeHead(200).end();
    });
  });
  await new Promise<void>((resolve) => hook.listen(0, '127.0.0.1', resolve));
  hookUrl = `http://127.0.0.1:${(hook.address() as AddressInfo).port}/hook`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => hook.close(() => resolve()));
});

beforeEach(() => {
  deliveries.length = 0;
});

const task: A2ATask = {
  kind: 'task',
  id: 'task_1',
  contextId: 'ctx_1',
  status: { state: 'completed', timestamp: '2026-10-28T10:00:00.000Z' },
};

describe('push notifications over A2A 1.0', () => {
  it('posts { task } in its 1.0 form as application/a2a+json with the scheme as given', async () => {
    const store = new InMemoryPushNotificationStore();
    await store.create('task_1', {
      url: hookUrl,
      token: 'notify-token',
      authentication: { schemes: ['Token'], credentials: 'abc' },
      protocolVersion: '1.0',
    });
    await new PushNotificationSender(store, true).notify(task);

    expect(deliveries).toHaveLength(1);
    const [delivery] = deliveries;
    expect(delivery.headers['content-type']).toBe('application/a2a+json');
    expect(delivery.headers.authorization).toBe('Token abc');
    expect(delivery.headers['x-a2a-notification-token']).toBe('notify-token');
    expect(delivery.body).toEqual({
      task: {
        id: 'task_1',
        contextId: 'ctx_1',
        status: { state: 'TASK_STATE_COMPLETED', timestamp: '2026-10-28T10:00:00.000Z' },
      },
    });
  });

  it('keeps 0.3 webhooks as they were', async () => {
    const store = new InMemoryPushNotificationStore();
    await store.create('task_1', {
      url: hookUrl,
      authentication: { schemes: ['Token', 'Bearer'], credentials: 'abc' },
    });
    await new PushNotificationSender(store, true).notify(task);

    const [delivery] = deliveries;
    expect(delivery.headers['content-type']).toBe('application/json');
    expect(delivery.headers.authorization).toBe('Bearer abc');
    expect(delivery.body).toEqual(task);
  });

  it('registers the config of SendMessage over 1.0 and calls it in 1.0 form', async () => {
    const server = new A2AServer({
      agents: { helper: mockAgent('helper') },
      cogitator: echoCogitator(),
      allowPrivateUrls: true,
    });
    const response = expectResponse(
      await server.handleJsonRpc(
        {
          jsonrpc: '2.0',
          id: 1,
          method: 'SendMessage',
          params: {
            message: v1UserMessage('push me'),
            configuration: {
              taskPushNotificationConfig: {
                url: hookUrl,
                authentication: { scheme: 'Bearer', credentials: 'jwt' },
              },
            },
          },
        },
        undefined,
        { protocolVersion: '1.0' }
      )
    );
    const created = (response.result as { task: { id: string } }).task;
    await expect
      .poll(() =>
        deliveries.some(
          (delivery) =>
            (delivery.body.task as { status?: { state?: string } } | undefined)?.status?.state ===
            'TASK_STATE_COMPLETED'
        )
      )
      .toBe(true);
    const final = deliveries.find(
      (delivery) =>
        (delivery.body.task as { status: { state: string } }).status.state ===
        'TASK_STATE_COMPLETED'
    )!;
    expect((final.body.task as { id: string }).id).toBe(created.id);
    expect(final.headers.authorization).toBe('Bearer jwt');
    expect(final.headers['content-type']).toBe('application/a2a+json');

    const legacyList = expectResponse(
      await server.handleJsonRpc({
        jsonrpc: '2.0',
        id: 2,
        method: 'tasks/pushNotificationConfig/list',
        params: { id: created.id },
      })
    ).result as { pushNotificationConfig: Record<string, unknown> }[];
    expect(legacyList[0].pushNotificationConfig).toEqual({
      url: hookUrl,
      id: legacyList[0].pushNotificationConfig.id,
      authentication: { schemes: ['Bearer'], credentials: 'jwt' },
    });
  });

  it('keeps a config registered over 0.3 on the 0.3 payload', async () => {
    const server = new A2AServer({
      agents: { helper: mockAgent('helper') },
      cogitator: echoCogitator(),
      allowPrivateUrls: true,
    });
    expectResponse(
      await server.handleJsonRpc({
        jsonrpc: '2.0',
        id: 1,
        method: 'message/send',
        params: {
          message: userMessage('push me'),
          configuration: { pushNotificationConfig: { url: hookUrl } },
        },
      })
    );
    await expect
      .poll(() => deliveries.some((delivery) => delivery.body.kind === 'task'))
      .toBe(true);
    expect(
      deliveries.every((delivery) => delivery.headers['content-type'] === 'application/json')
    ).toBe(true);
  });
});
