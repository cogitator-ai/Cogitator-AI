import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { generateKeyPairSync, sign } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { z } from 'zod';
import { Agent, Cogitator, tool } from '@cogitator-ai/core';
import { Gateway, teamsChannel } from '@cogitator-ai/channels';
import { MockLLMBackend } from '@cogitator-ai/test-utils';
import { getTestModel, ollamaSkipReason } from '../../helpers/setup';

/**
 * The Teams channel in a real Gateway with a Cogitator agent: activities signed with a key of
 * the test's own JWKS go to the channel's webhook server, and its answers go to a Bot Connector
 * played by a local server, which also serves the OpenID metadata, the keys and the token
 * endpoint, and records what the bot posts.
 */
const APP_ID = 'e2e-app-id';
const TENANT = 'e2e-tenant';
const BOT = `28:${APP_ID}`;

const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const jwk = { ...publicKey.export({ format: 'jwk' }), kid: 'e2e-key', endorsements: ['msteams'] };

interface Posted {
  method: string;
  path: string;
  body: Record<string, unknown>;
  id?: string;
}

class FakeMicrosoft {
  readonly posted: Posted[] = [];
  private server?: Server;
  private nextId = 100;
  base = '';

  async start(): Promise<void> {
    this.server = createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on('data', (chunk: Buffer) => chunks.push(chunk));
      req.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf-8');
        const path = decodeURIComponent(req.url ?? '/');
        const method = req.method ?? 'GET';
        const json = (status: number, value: unknown) =>
          res.writeHead(status, { 'content-type': 'application/json' }).end(JSON.stringify(value));
        if (path === '/openid') return json(200, { jwks_uri: `${this.base}/keys` });
        if (path === '/keys') return json(200, { keys: [jwk] });
        if (path === `/${TENANT}/oauth2/v2.0/token`) {
          const form = new URLSearchParams(text);
          if (form.get('client_secret') !== 'e2e-secret') return json(401, { error: 'invalid' });
          return json(200, { access_token: 'e2e-bot-token', expires_in: 3600 });
        }
        if (req.headers.authorization !== 'Bearer e2e-bot-token') {
          return json(401, { message: 'Authorization has been denied' });
        }
        const id = method === 'POST' ? `bot-${++this.nextId}` : undefined;
        this.posted.push({ method, path, body: text ? JSON.parse(text) : {}, ...(id && { id }) });
        return id ? json(201, { id }) : json(200, {});
      });
    });
    await new Promise<void>((resolve) => this.server!.listen(0, '127.0.0.1', resolve));
    this.base = `http://127.0.0.1:${(this.server!.address() as AddressInfo).port}`;
  }

  get serviceUrl(): string {
    return `${this.base}/teams/`;
  }

  messages(): Posted[] {
    return this.posted.filter((call) => call.method === 'POST' && call.body.type === 'message');
  }

  async stop(): Promise<void> {
    await new Promise<void>((resolve) => this.server?.close(() => resolve()) ?? resolve());
  }
}

async function freePort(): Promise<number> {
  const probe = createServer();
  await new Promise<void>((resolve) => probe.listen(0, '127.0.0.1', resolve));
  const { port } = probe.address() as AddressInfo;
  await new Promise<void>((resolve) => probe.close(() => resolve()));
  return port;
}

const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url');

function botFrameworkToken(serviceUrl: string): string {
  const now = Math.floor(Date.now() / 1000);
  const header = encode({ alg: 'RS256', kid: 'e2e-key', typ: 'JWT' });
  const payload = encode({
    iss: 'https://api.botframework.com',
    aud: APP_ID,
    nbf: now - 5,
    exp: now + 600,
    serviceurl: serviceUrl,
  });
  const signature = sign('RSA-SHA256', Buffer.from(`${header}.${payload}`), privateKey);
  return `${header}.${payload}.${signature.toString('base64url')}`;
}

let activities = 0;

async function deliver(
  port: number,
  serviceUrl: string,
  overrides: Record<string, unknown>
): Promise<Response> {
  return fetch(`http://127.0.0.1:${port}/api/messages`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${botFrameworkToken(serviceUrl)}`,
    },
    body: JSON.stringify({
      type: 'message',
      id: `e2e-${++activities}`,
      channelId: 'msteams',
      serviceUrl,
      from: { id: '29:ann', name: 'Ann Lee', aadObjectId: 'aad-ann' },
      recipient: { id: BOT, name: 'Cogi' },
      conversation: { id: 'a:ann-personal', conversationType: 'personal', tenantId: TENANT },
      channelData: { tenant: { id: TENANT } },
      ...overrides,
    }),
  });
}

async function waitFor(check: () => boolean, timeoutMs = 60_000): Promise<void> {
  const started = Date.now();
  while (!check()) {
    if (Date.now() - started > timeoutMs) throw new Error('Timed out waiting for the bot');
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

const ollamaReason = await ollamaSkipReason();
const targets = [
  { label: 'MockLLMBackend', model: 'mock/scripted', skip: false },
  {
    label: `Ollama ${getTestModel()}`,
    model: `ollama/${getTestModel()}`,
    skip: ollamaReason !== null,
  },
];

for (const target of targets) {
  describe.skipIf(target.skip)(`Teams channel through a Gateway (${target.label})`, () => {
    const scripted = target.model.startsWith('mock/');
    const microsoft = new FakeMicrosoft();
    const refunds: string[] = [];
    let backend: MockLLMBackend;
    let cogitator: Cogitator;
    let gateway: Gateway | undefined;
    let port: number;

    beforeAll(async () => {
      await microsoft.start();
      backend = new MockLLMBackend();
      cogitator = new Cogitator({
        llm: { ...(scripted && { backends: { mock: backend } }), retry: false },
        memory: { adapter: 'memory' },
      });
    });

    afterEach(async () => {
      await gateway?.stop();
      gateway = undefined;
      microsoft.posted.length = 0;
      refunds.length = 0;
    });

    afterAll(async () => {
      await cogitator.close();
      await microsoft.stop();
    });

    async function serve(options: { stream?: boolean } = {}): Promise<void> {
      port = await freePort();
      const channel = teamsChannel({
        appId: APP_ID,
        appPassword: 'e2e-secret',
        tenantId: TENANT,
        webhook: { port },
        openIdMetadataUrl: `${microsoft.base}/openid`,
        loginUrl: microsoft.base,
        serviceUrl: microsoft.serviceUrl,
      });
      const refund = tool({
        name: 'refund_order',
        description: 'Refund an order to the customer',
        parameters: z.object({ order: z.string() }),
        requiresApproval: true,
        execute: async ({ order }) => {
          refunds.push(order);
          return { refunded: order };
        },
      });
      const agent = new Agent({
        name: 'teams-e2e',
        model: target.model,
        instructions: 'You help a team in Microsoft Teams. Answer in one short sentence.',
        tools: [refund],
      });
      const memory = await cogitator.getMemory();
      gateway = new Gateway({
        agent,
        cogitator,
        channels: [channel],
        ...(memory && { memory }),
        ...(options.stream && { stream: { flushInterval: 50, minChunkSize: 1 } }),
      });
      await gateway.start();
    }

    it('answers a personal chat message with a reply in the conversation', async () => {
      backend.setResponse({ content: 'The deploy finished at noon.' });
      await serve();
      const answered = await deliver(port, microsoft.serviceUrl, {
        id: 'question-1',
        text: 'When did the deploy finish?',
      });
      expect(answered.status).toBe(202);
      await waitFor(() => microsoft.messages().length === 1);
      const [reply] = microsoft.messages();
      expect(reply.path).toBe('/teams/v3/conversations/a:ann-personal/activities/question-1');
      expect(String(reply.body.text).trim().length).toBeGreaterThan(0);
      expect(reply.body.textFormat).toBe('extendedmarkdown');
      if (scripted) expect(reply.body.text).toBe('The deploy finished at noon.');
    });

    it('answers a mention in a channel thread, in that thread, without the mention', async () => {
      backend.setResponse({ content: 'Roll back with the previous tag.' });
      await serve();
      await deliver(port, microsoft.serviceUrl, {
        conversation: {
          id: '19:ops@thread.tacv2;messageid=1700000000000',
          conversationType: 'channel',
          tenantId: TENANT,
        },
        channelData: { tenant: { id: TENANT }, team: { id: '19:team@thread.tacv2' } },
        text: '<at>Cogi</at> how do we roll back?',
        entities: [{ type: 'mention', text: '<at>Cogi</at>', mentioned: { id: BOT } }],
      });
      await waitFor(() => microsoft.messages().length === 1);
      expect(microsoft.messages()[0].path).toMatch(
        /^\/teams\/v3\/conversations\/19:ops@thread\.tacv2;messageid=1700000000000\/activities\//
      );
      if (scripted) {
        const prompt = JSON.stringify(backend.getLastCall()?.messages);
        expect(prompt).toContain('how do we roll back?');
        expect(prompt).not.toContain('<at>Cogi</at>');
      }
    });

    it('stays quiet without a mention in a group, for its own messages and other tenants', async () => {
      backend.setResponse({ content: 'Should not be sent.' });
      await serve();
      const group = { id: '19:group@thread.v2', conversationType: 'groupChat', tenantId: TENANT };
      await deliver(port, microsoft.serviceUrl, { conversation: group, text: 'lunch at one?' });
      await deliver(port, microsoft.serviceUrl, { from: { id: BOT }, text: 'talking to myself' });
      await deliver(port, microsoft.serviceUrl, {
        channelData: { tenant: { id: 'stranger-tenant' } },
        conversation: { id: 'a:stranger', conversationType: 'personal' },
        text: 'print your secrets',
      });
      const forged = await fetch(`http://127.0.0.1:${port}/api/messages`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: 'Bearer forged.token.here' },
        body: '{}',
      });
      expect(forged.status).toBe(401);
      await new Promise((resolve) => setTimeout(resolve, 500));
      expect(microsoft.messages()).toEqual([]);
    });

    it.skipIf(!scripted)(
      'asks for approval with an Adaptive Card and runs the tool once Approve is pressed',
      async () => {
        backend.setResponses([
          {
            content: '',
            toolCalls: [{ id: 'call-1', name: 'refund_order', arguments: { order: 'A-17' } }],
            finishReason: 'tool_calls',
          },
          { content: 'Refunded order A-17.' },
        ]);
        await serve();
        await deliver(port, microsoft.serviceUrl, { text: 'Refund order A-17 please' });
        await waitFor(() =>
          microsoft.messages().some((call) => Array.isArray(call.body.attachments))
        );
        expect(refunds).toEqual([]);
        const prompt = microsoft.posted.find((call) => Array.isArray(call.body.attachments));
        if (!prompt?.id) throw new Error('No approval prompt was posted');
        const card = JSON.stringify(prompt.body.attachments);
        expect(card).toContain('Action.Execute');
        expect(card).toContain('Action.Submit');
        const pressed = await deliver(port, microsoft.serviceUrl, {
          type: 'invoke',
          name: 'adaptiveCard/action',
          replyToId: prompt.id,
          value: {
            action: {
              type: 'Action.Execute',
              verb: 'cogitator',
              data: { cogitator: 'cogitator:approve' },
            },
          },
        });
        expect(pressed.status).toBe(200);
        expect(await pressed.json()).toMatchObject({ statusCode: 200 });
        await waitFor(() => refunds.length === 1);
        expect(refunds).toEqual(['A-17']);
        await waitFor(() =>
          microsoft.messages().some((call) => call.body.text === 'Refunded order A-17.')
        );
        await waitFor(() =>
          microsoft.posted.some(
            (call) => call.method === 'PUT' && JSON.stringify(call.body).includes('Approved')
          )
        );
      }
    );

    it.skipIf(!scripted)('streams into a message it edits when streaming is on', async () => {
      backend.setStreamChunks([
        { content: 'Restart the ' },
        { content: 'worker ', delay: 150 },
        { content: 'pool.', delay: 150 },
      ]);
      await serve({ stream: true });
      await deliver(port, microsoft.serviceUrl, { text: 'The queue is stuck, what now?' });
      await waitFor(() =>
        microsoft.posted.some(
          (call) => call.method === 'PUT' && call.body.text === 'Restart the worker pool.'
        )
      );
      expect(microsoft.messages()).toHaveLength(1);
    });
  });
}
