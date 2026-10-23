import { afterEach, describe, expect, it, vi } from 'vitest';
import { generateKeyPairSync, sign, type KeyObject } from 'node:crypto';
import { connect, createServer } from 'node:net';
import type { ChannelAction, ChannelMessage } from '@cogitator-ai/types';
import { FeedError } from '../feeds/errors';
import {
  TEAMS_MIN_EDIT_INTERVAL,
  TEAMS_MESSAGE_CHARS,
  TeamsChannel,
  splitTeamsText,
  type TeamsChannelConfig,
  type TeamsWebhookRequest,
} from '../channels/teams/channel';
import { BOT_FRAMEWORK_OPENID_METADATA, TeamsTokenVerifier } from '../channels/teams/auth';
import { TeamsApiError, TeamsClient } from '../channels/teams/client';
import { ConversationPacer, TEAMS_RATE_LIMITS } from '../channels/teams/pacer';
import { TeamsCredentials } from '../channels/teams/token';
import { buttonsCard } from '../channels/teams/cards';
import { imagesAsLinks } from '../formatters/markdown-images';
import { defaultThreadKey } from '../thread-key';

const APP_ID = '00000000-1111-2222-3333-444444444444';
const TENANT = 'tenant-contoso';
const BOT = `28:${APP_ID}`;
const SERVICE = 'https://smba.test/emea/';
const METADATA = 'https://login.test/v1/.well-known/openidconfiguration';
const JWKS = 'https://login.test/v1/.well-known/keys';
const LOGIN = 'https://entra.test';

/** Whether `url` goes to the origin of `base`, compared as parsed URLs rather than by prefix */
const sameOrigin = (url: string, base: string) => new URL(url).origin === new URL(base).origin;

interface SigningPair {
  kid: string;
  privateKey: KeyObject;
  jwk: Record<string, unknown>;
}

function keyPair(kid: string, endorsements: string[] = ['msteams']): SigningPair {
  const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  return {
    kid,
    privateKey,
    jwk: { ...publicKey.export({ format: 'jwk' }), kid, use: 'sig', endorsements },
  };
}

const primary = keyPair('key-1');
const unendorsed = keyPair('key-2', ['webchat']);
const rotated = keyPair('key-3');
const stranger = keyPair('key-1');

const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url');

const signed = token;

function token(
  claims: Record<string, unknown> = {},
  options: { pair?: SigningPair; alg?: string; kid?: string; signer?: KeyObject } = {}
): string {
  const pair = options.pair ?? primary;
  const now = Math.floor(Date.now() / 1000);
  const header = encode({ alg: options.alg ?? 'RS256', kid: options.kid ?? pair.kid, typ: 'JWT' });
  const payload = encode({
    iss: 'https://api.botframework.com',
    aud: APP_ID,
    nbf: now - 10,
    exp: now + 3600,
    serviceurl: SERVICE,
    ...claims,
  });
  const signature = sign(
    'RSA-SHA256',
    Buffer.from(`${header}.${payload}`),
    options.signer ?? pair.privateKey
  ).toString('base64url');
  return `${header}.${payload}.${signature}`;
}

interface Call {
  method: string;
  url: string;
  path: string;
  body?: Record<string, unknown>;
  authorization?: string;
  form?: URLSearchParams;
}

type Route = (call: Call) => Response | Promise<Response> | undefined;

function microsoft(routes: Route[] = []) {
  const calls: Call[] = [];
  const keys = [primary.jwk, unendorsed.jwk];
  let next = 0;
  let tokens = 0;
  const fetchImpl = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input));
    const headers = new Headers(init?.headers);
    const raw = typeof init?.body === 'string' ? init.body : undefined;
    const call: Call = {
      method: init?.method ?? 'GET',
      url: url.href,
      path: decodeURIComponent(url.pathname),
      ...(raw &&
        (headers.get('content-type')?.includes('json')
          ? { body: JSON.parse(raw) as Record<string, unknown> }
          : { form: new URLSearchParams(raw) })),
      ...(headers.get('authorization') && { authorization: headers.get('authorization') ?? '' }),
    };
    calls.push(call);
    for (const route of routes) {
      const response = route(call);
      if (response) return response;
    }
    if (url.href === METADATA || url.href === BOT_FRAMEWORK_OPENID_METADATA) {
      return Response.json({ jwks_uri: JWKS });
    }
    if (url.href === JWKS) return Response.json({ keys });
    if (url.origin === LOGIN) {
      return Response.json({ access_token: `bot-token-${++tokens}`, expires_in: 3600 });
    }
    if (call.method === 'POST') return Response.json({ id: `m${++next}` }, { status: 201 });
    return Response.json({});
  });
  return {
    calls,
    keys,
    fetch: fetchImpl as unknown as typeof fetch,
    connector: () => calls.filter((call) => sameOrigin(call.url, SERVICE)),
    keyLoads: () => calls.filter((call) => call.url === JWKS).length,
  };
}

const channels: TeamsChannel[] = [];

afterEach(async () => {
  for (const channel of channels.splice(0)) await channel.stop();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

function created(api: ReturnType<typeof microsoft>, config: Partial<TeamsChannelConfig> = {}) {
  const channel = new TeamsChannel({
    appId: APP_ID,
    appPassword: 'client-secret',
    tenantId: TENANT,
    openIdMetadataUrl: METADATA,
    loginUrl: LOGIN,
    retry: { baseDelay: 1, maxDelay: 5 },
    serviceUrl: SERVICE,
    fetch: api.fetch,
    ...config,
  });
  channels.push(channel);
  const received: ChannelMessage[] = [];
  const actions: ChannelAction[] = [];
  channel.onMessage(async (msg) => void received.push(msg));
  channel.onAction(async (action) => void actions.push(action));
  return { channel, received, actions };
}

let activities = 0;

const alice = { id: '29:alice', name: 'Alice Doe', aadObjectId: 'aad-alice' };

function activity(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    type: 'message',
    id: `act-${++activities}`,
    channelId: 'msteams',
    serviceUrl: SERVICE,
    from: alice,
    recipient: { id: BOT, name: 'Cogi' },
    conversation: { id: 'a:personal-alice', conversationType: 'personal', tenantId: TENANT },
    channelData: { tenant: { id: TENANT } },
    text: 'hello there',
    ...overrides,
  };
}

const groupChat = { id: '19:group@thread.v2', conversationType: 'groupChat', tenantId: TENANT };
const channelThread = (root: string) => ({
  id: `19:general@thread.tacv2;messageid=${root}`,
  conversationType: 'channel',
  tenantId: TENANT,
});
const mention = (text = '<at>Cogi</at>', id = BOT) => ({
  type: 'mention',
  text,
  mentioned: { id, name: 'Cogi' },
});

function request(body: unknown, auth = token()): TeamsWebhookRequest {
  return {
    method: 'POST',
    headers: { authorization: `Bearer ${auth}`, 'content-type': 'application/json' },
    rawBody: typeof body === 'string' ? body : JSON.stringify(body),
  };
}

async function waitFor(check: () => boolean, timeoutMs = 5000): Promise<void> {
  const started = Date.now();
  while (!check()) {
    if (Date.now() - started > timeoutMs) throw new Error('Timed out waiting for a condition');
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

function freePort(): Promise<number> {
  return new Promise((resolve) => {
    const probe = createServer();
    probe.listen(0, () => {
      const address = probe.address();
      probe.close(() => resolve(typeof address === 'object' && address ? address.port : 0));
    });
  });
}

describe('TeamsTokenVerifier', () => {
  const verifier = (api: ReturnType<typeof microsoft>, now?: () => number) =>
    new TeamsTokenVerifier({
      appId: APP_ID,
      metadataUrl: METADATA,
      fetch: api.fetch,
      ...(now && { now }),
    });

  it('takes a token Bot Framework signed for the app, with its service URL and endorsements', async () => {
    const verified = await verifier(microsoft()).verify(token());
    expect(verified).toEqual({ serviceUrl: SERVICE, endorsements: ['msteams'] });
  });

  it('refuses another issuer, another audience and a bad signature', async () => {
    const check = verifier(microsoft());
    await expect(check.verify(token({ iss: 'https://evil.test' }))).rejects.toThrow(
      /not issued by Bot Framework/
    );
    await expect(check.verify(token({ aud: 'another-app' }))).rejects.toThrow(/another app/);
    await expect(check.verify(token({}, { signer: stranger.privateKey }))).rejects.toThrow(
      /signature is invalid/
    );
    const [header, , signature] = token().split('.');
    const forged = `${header}.${encode({ iss: 'https://api.botframework.com', aud: APP_ID, exp: 9e9 })}.${signature}`;
    await expect(check.verify(forged)).rejects.toThrow(/signature is invalid/);
  });

  it('refuses expired tokens and tokens not valid yet, allowing five minutes of skew', async () => {
    const check = verifier(microsoft());
    const now = Math.floor(Date.now() / 1000);
    await expect(check.verify(token({ exp: now - 301 }))).rejects.toThrow(/expired/);
    await expect(check.verify(token({ exp: now - 200 }))).resolves.toBeDefined();
    await expect(check.verify(token({ nbf: now + 301 }))).rejects.toThrow(/not valid yet/);
    await expect(check.verify(token({ nbf: now + 200 }))).resolves.toBeDefined();
    await expect(check.verify(token({ exp: undefined }))).rejects.toThrow(/cannot be read/);
  });

  it('refuses alg none, HS256 and anything but a signed JWT', async () => {
    const check = verifier(microsoft());
    const payload = encode({ iss: 'https://api.botframework.com', aud: APP_ID, exp: 9e9 });
    await expect(
      check.verify(`${encode({ alg: 'none', kid: 'key-1' })}.${payload}.`)
    ).rejects.toThrow(/not a signed JWT/);
    await expect(
      check.verify(`${encode({ alg: 'none', kid: 'key-1' })}.${payload}.c2ln`)
    ).rejects.toThrow(/none, not RS256/);
    await expect(check.verify(token({}, { alg: 'HS256' }))).rejects.toThrow(/HS256, not RS256/);
    await expect(check.verify('a.b')).rejects.toThrow(/not a signed JWT/);
    await expect(check.verify('x'.repeat(20_000))).rejects.toThrow(/too long/);
  });

  it('caches the keys, loads them again after a day, and once for an unknown key at most every five minutes', async () => {
    const api = microsoft();
    let now = Date.now();
    const check = verifier(api, () => now);
    const lasting = { exp: Math.floor(now / 1000) + 3 * 86_400 };
    const token = (
      claims: Record<string, unknown> = {},
      options: Parameters<typeof signed>[1] = {}
    ) => signed({ ...lasting, ...claims }, options);
    await check.verify(token());
    await check.verify(token());
    expect(api.keyLoads()).toBe(1);
    await expect(check.verify(token({}, { pair: rotated }))).rejects.toThrow(/unknown key/);
    expect(api.keyLoads()).toBe(2);
    await expect(check.verify(token({}, { pair: rotated }))).rejects.toThrow(/unknown key/);
    expect(api.keyLoads()).toBe(2);
    api.keys.push(rotated.jwk);
    now += 5 * 60 * 1000 + 1;
    await expect(check.verify(token({}, { pair: rotated }))).resolves.toBeDefined();
    expect(api.keyLoads()).toBe(3);
    now += 24 * 60 * 60 * 1000 + 1;
    await check.verify(token());
    await waitFor(() => api.keyLoads() === 4);
  });

  it('loads the keys once for requests that come together, and keeps old keys when a reload fails', async () => {
    let failing = false;
    const api = microsoft([
      (call) => (failing && call.url === JWKS ? new Response('down', { status: 500 }) : undefined),
    ]);
    let now = Date.now();
    const check = verifier(api, () => now);
    const token = () => signed({ exp: Math.floor(now / 1000) + 3 * 86_400 });
    await Promise.all([check.verify(token()), check.verify(token()), check.verify(token())]);
    expect(api.keyLoads()).toBe(1);
    failing = true;
    now += 24 * 60 * 60 * 1000 + 1;
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    await expect(check.verify(token())).resolves.toBeDefined();
  });

  it('answers 503 without hammering the metadata when the keys cannot be loaded', async () => {
    const api = microsoft([
      (call) => (call.url === METADATA ? new Response('down', { status: 500 }) : undefined),
    ]);
    const check = verifier(api);
    await expect(check.verify(token())).rejects.toMatchObject({ status: 503 });
    await expect(check.verify(token())).rejects.toMatchObject({ status: 503 });
    expect(api.calls.filter((call) => call.url === METADATA)).toHaveLength(1);
  });
});

describe('TeamsChannel webhook', () => {
  it('answers a valid activity at once and hands the message over', async () => {
    const { channel, received } = created(microsoft());
    const response = await channel.handleWebhook(request(activity()));
    expect(response.status).toBe(202);
    expect(received).toHaveLength(1);
    expect(received[0]).toMatchObject({
      channelType: 'teams',
      channelId: 'a:personal-alice',
      userId: 'aad-alice',
      userName: 'Alice Doe',
      text: 'hello there',
    });
    expect(received[0].groupId).toBeUndefined();
  });

  it('refuses requests without a valid token, and others of the wrong kind', async () => {
    const { channel, received } = created(microsoft());
    const body = activity();
    expect((await channel.handleWebhook({ ...request(body), headers: {} })).status).toBe(401);
    expect((await channel.handleWebhook(request(body, token({ aud: 'x' })))).status).toBe(401);
    expect((await channel.handleWebhook(request(body, 'not.a.token'))).status).toBe(401);
    expect((await channel.handleWebhook({ ...request(body), method: 'GET' })).status).toBe(405);
    expect((await channel.handleWebhook(request('{not json'))).status).toBe(400);
    expect((await channel.handleWebhook(request({ type: 'message' }))).status).toBe(400);
    expect(received).toEqual([]);
  });

  it('refuses a token issued for another service URL', async () => {
    const { channel, received } = created(microsoft());
    const response = await channel.handleWebhook(
      request(activity({ serviceUrl: 'https://evil.test/' }))
    );
    expect(response.status).toBe(401);
    const claimless = await channel.handleWebhook(
      request(activity(), token({ serviceurl: undefined }))
    );
    expect(claimless.status).toBe(401);
    expect(received).toEqual([]);
  });

  it('answers 403 when the signing key is not endorsed for the channel of the activity', async () => {
    const { channel, received } = created(microsoft());
    const response = await channel.handleWebhook(
      request(activity(), token({}, { pair: unendorsed }))
    );
    expect(response.status).toBe(403);
    expect(received).toEqual([]);
  });

  it('refuses service URLs outside the allowed hosts', async () => {
    const { channel, received } = created(microsoft(), {
      serviceUrlHosts: ['smba.trafficmanager.net'],
    });
    expect((await channel.handleWebhook(request(activity()))).status).toBe(403);
    expect(received).toEqual([]);
  });

  it('handles an activity Bot Framework sends again once', async () => {
    const { channel, received } = created(microsoft());
    const body = activity();
    await channel.handleWebhook(request(body));
    const again = await channel.handleWebhook(request(body));
    expect(again.body).toBe('Already received');
    expect(received).toHaveLength(1);
  });

  it('skips its own activities and activities that are not messages', async () => {
    const { channel, received } = created(microsoft());
    await channel.handleWebhook(request(activity({ from: { id: BOT, name: 'Cogi' } })));
    const update = await channel.handleWebhook(
      request(activity({ type: 'conversationUpdate', text: undefined }))
    );
    expect(update.status).toBe(202);
    expect(received).toEqual([]);
  });

  it("answers only the bot's own tenant by default, and the listed tenants and users", async () => {
    const api = microsoft();
    const own = created(api);
    const elsewhere = activity({
      channelData: { tenant: { id: 'tenant-other' } },
      conversation: { id: 'a:other', conversationType: 'personal', tenantId: 'tenant-other' },
    });
    await own.channel.handleWebhook(request(elsewhere));
    await own.channel.handleWebhook(request(activity()));
    const listed = created(api, { tenants: ['TENANT-OTHER'], users: ['aad-bob'] });
    await listed.channel.handleWebhook(request(elsewhere));
    await listed.channel.handleWebhook(
      request({ ...elsewhere, id: 'from-bob', from: { id: '29:bob', aadObjectId: 'aad-bob' } })
    );
    expect(own.received.map((m) => m.channelId)).toEqual(['a:personal-alice']);
    expect(listed.received.map((m) => m.userId)).toEqual(['aad-bob']);
  });

  it('warns at start when it answers every tenant or nobody', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    await created(microsoft(), { tenants: '*' }).channel.start();
    await created(microsoft(), { appType: 'MultiTenant', tenantId: undefined }).channel.start();
    expect(warn.mock.calls.map(([text]) => String(text))).toEqual([
      expect.stringContaining('every tenant'),
      expect.stringContaining('answers nobody'),
    ]);
  });

  it('refuses requests once stopped', async () => {
    const { channel } = created(microsoft());
    await channel.stop();
    expect((await channel.handleWebhook(request(activity()))).status).toBe(503);
  });

  it('cannot be created without what it needs to authenticate', () => {
    const api = microsoft();
    expect(() => new TeamsChannel({ appId: '', appPassword: 'x', tenantId: 't' })).toThrow(
      /appId is required/
    );
    expect(() => new TeamsChannel({ appId: APP_ID, appPassword: 'x', fetch: api.fetch })).toThrow(
      /tenantId is required for a SingleTenant bot/
    );
    expect(() => new TeamsChannel({ appId: APP_ID, tenantId: TENANT })).toThrow(
      /appPassword .* or tokenProvider is required/
    );
    expect(
      () => new TeamsChannel({ appId: APP_ID, tenantId: TENANT, appType: 'UserAssignedMSI' })
    ).toThrow(/tokenProvider is required/);
  });

  it('runs its own server when given a port, with a body cap and a safe request line', async () => {
    const port = await freePort();
    const github = vi.fn((_req: unknown, res: { writeHead(s: number): { end(): void } }) =>
      res.writeHead(204).end()
    );
    const { channel, received } = created(microsoft(), {
      webhook: { port, maxBody: 64 * 1024, routes: { '/github/webhook': github } },
    });
    await channel.start();
    const base = `http://127.0.0.1:${port}/api/messages`;
    const posted = await fetch(base, {
      method: 'POST',
      headers: { authorization: `Bearer ${token()}`, 'content-type': 'application/json' },
      body: JSON.stringify(activity()),
    });
    expect(posted.status).toBe(202);
    expect(received).toHaveLength(1);
    expect((await fetch(`http://127.0.0.1:${port}/elsewhere`)).status).toBe(404);
    expect(
      (await fetch(`http://127.0.0.1:${port}/github/webhook`, { method: 'POST' })).status
    ).toBe(204);
    const raw = await new Promise<string>((resolve, reject) => {
      const socket = connect(port, '127.0.0.1', () => {
        socket.end('POST //% HTTP/1.1\r\nHost: x\r\nContent-Length: 0\r\n\r\n');
      });
      let answer = '';
      socket.on('data', (chunk) => (answer += String(chunk)));
      socket.on('end', () => resolve(answer));
      socket.on('error', reject);
    });
    expect(raw).toMatch(/^HTTP\/1\.1 400/);
    const huge = await fetch(base, {
      method: 'POST',
      headers: { authorization: `Bearer ${token()}` },
      body: 'x'.repeat(64 * 1024 + 10),
    });
    expect(huge.status).toBe(413);
  });
});

describe('TeamsChannel conversations', () => {
  it('maps personal chats, group chats and channel threads, one thread key each', async () => {
    const { channel, received } = created(microsoft());
    await channel.handleWebhook(request(activity()));
    await channel.handleWebhook(
      request(
        activity({ conversation: groupChat, text: '<at>Cogi</at> hi', entities: [mention()] })
      )
    );
    await channel.handleWebhook(
      request(
        activity({
          conversation: channelThread('1700000000001'),
          channelData: { tenant: { id: TENANT }, team: { id: '19:team@thread.tacv2' } },
          text: '<at>Cogi</at> in a thread',
          entities: [mention()],
        })
      )
    );
    await channel.handleWebhook(
      request(
        activity({
          conversation: channelThread('1700000000002'),
          text: '<at>Cogi</at> another thread',
          entities: [mention()],
        })
      )
    );
    expect(
      received.map(({ channelId, topicId, groupId }) => ({ channelId, topicId, groupId }))
    ).toEqual([
      { channelId: 'a:personal-alice', topicId: undefined, groupId: undefined },
      { channelId: '19:group@thread.v2', topicId: undefined, groupId: '19:group@thread.v2' },
      {
        channelId: '19:general@thread.tacv2',
        topicId: '1700000000001',
        groupId: '19:team@thread.tacv2',
      },
      {
        channelId: '19:general@thread.tacv2',
        topicId: '1700000000002',
        groupId: '19:general@thread.tacv2',
      },
    ]);
    expect(new Set(received.map(defaultThreadKey)).size).toBe(4);
    expect(defaultThreadKey(received[2])).toBe(
      'teams:19:general@thread.tacv2:1700000000001:aad-alice'
    );
  });

  it('answers in groups and channels only when mentioned, without the mention', async () => {
    const { channel, received } = created(microsoft());
    await channel.handleWebhook(
      request(activity({ conversation: groupChat, text: 'just chatting' }))
    );
    await channel.handleWebhook(
      request(
        activity({
          conversation: groupChat,
          text: '<at>Bob</at> and <at>Cogi</at>, what is up?',
          entities: [mention('<at>Bob</at>', '29:bob'), mention()],
        })
      )
    );
    expect(received.map((m) => m.text)).toEqual(['<at>Bob</at> and , what is up?']);
    const all = created(microsoft(), { trigger: 'all' });
    await all.channel.handleWebhook(
      request(activity({ conversation: groupChat, text: 'no mention' }))
    );
    expect(all.received.map((m) => m.text)).toEqual(['no mention']);
  });

  it('hands over files sent in a personal chat and inline images from its own Bot Connector only', async () => {
    const api = microsoft([
      (call) =>
        call.url === `${SERVICE}v3/attachments/img/views/original`
          ? new Response(new Uint8Array([1, 2, 3]), { headers: { 'content-type': 'image/png' } })
          : undefined,
    ]);
    const { channel, received } = created(api);
    await channel.handleWebhook(
      request(
        activity({
          text: '',
          attachments: [
            {
              contentType: 'application/vnd.microsoft.teams.file.download.info',
              name: 'report.pdf',
              content: { downloadUrl: 'https://files.test/report.pdf', fileType: 'pdf' },
            },
            {
              contentType: 'image/png',
              contentUrl: `${SERVICE}v3/attachments/img/views/original`,
              name: 'shot.png',
            },
            { contentType: 'image/png', contentUrl: 'https://evil.test/steal', name: 'x.png' },
            { contentType: 'text/html', content: '<p>hi</p>' },
          ],
        })
      )
    );
    expect(received[0].attachments).toEqual([
      {
        type: 'file',
        url: 'https://files.test/report.pdf',
        mimeType: 'application/pdf',
        filename: 'report.pdf',
      },
      {
        type: 'image',
        buffer: Buffer.from([1, 2, 3]),
        mimeType: 'image/png',
        filename: 'shot.png',
      },
    ]);
    const image = api.calls.find((call) => call.url.includes('/attachments/img/'));
    expect(image?.authorization).toBe('Bearer bot-token-1');
    expect(api.calls.some((call) => sameOrigin(call.url, 'https://evil.test'))).toBe(false);
  });

  it('answers 503 for a message the gateway refuses while stopping, and takes it when sent again', async () => {
    const { channel } = created(microsoft());
    let refuse = true;
    const taken: string[] = [];
    channel.onMessage(async (msg) => {
      if (refuse) await channel.redeliver(msg);
      else taken.push(msg.text);
    });
    const body = activity();
    expect((await channel.handleWebhook(request(body))).status).toBe(503);
    refuse = false;
    expect((await channel.handleWebhook(request(body))).status).toBe(202);
    expect(taken).toEqual(['hello there']);
  });

  it('logs a message dropped after its request was answered', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { channel, received } = created(microsoft());
    await channel.handleWebhook(request(activity()));
    await channel.redeliver(received[0]);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('dropped unanswered'));
  });
});

describe('TeamsChannel sending', () => {
  it('posts replies with a client credentials token of the bot tenant, cached between requests', async () => {
    const api = microsoft();
    const { channel } = created(api);
    await channel.handleWebhook(request(activity({ id: 'question' })));
    const id = await channel.sendText('a:personal-alice', '**Sure**', { replyTo: 'question' });
    await channel.sendText('a:personal-alice', 'and more');
    expect(id).toBe('m1');
    const login = api.calls.filter((call) => sameOrigin(call.url, LOGIN));
    expect(login).toHaveLength(1);
    expect(login[0].path).toBe(`/${TENANT}/oauth2/v2.0/token`);
    expect(Object.fromEntries(login[0].form ?? [])).toEqual({
      grant_type: 'client_credentials',
      client_id: APP_ID,
      client_secret: 'client-secret',
      scope: 'https://api.botframework.com/.default',
    });
    const [reply, next] = api.connector();
    expect(reply.path).toBe('/emea/v3/conversations/a:personal-alice/activities/question');
    expect(reply.url).toContain('a%3Apersonal-alice');
    expect(reply.authorization).toBe('Bearer bot-token-1');
    expect(reply.body).toEqual({
      type: 'message',
      text: '**Sure**',
      textFormat: 'extendedmarkdown',
      replyToId: 'question',
    });
    expect(next.path).toBe('/emea/v3/conversations/a:personal-alice/activities');
  });

  it('uses the botframework.com tenant for a multi-tenant bot and a provider for a managed identity', async () => {
    const api = microsoft();
    const multi = created(api, { appType: 'MultiTenant', tenantId: undefined, tenants: [TENANT] });
    await multi.channel.sendText('a:x', 'hi');
    expect(api.calls.find((call) => sameOrigin(call.url, LOGIN))?.path).toBe(
      '/botframework.com/oauth2/v2.0/token'
    );
    const provider = vi.fn(async () => ({ token: 'msi-token', expiresAt: Date.now() + 3_600_000 }));
    const msi = created(api, {
      appType: 'UserAssignedMSI',
      appPassword: undefined,
      tokenProvider: provider,
    });
    await msi.channel.sendText('a:y', 'one');
    await msi.channel.sendText('a:y', 'two');
    expect(provider).toHaveBeenCalledTimes(1);
    expect(api.connector().at(-1)?.authorization).toBe('Bearer msi-token');
  });

  it('posts to the thread of a channel and to the service URL of the conversation', async () => {
    const api = microsoft();
    const { channel } = created(api, { serviceUrl: 'https://smba.test/fallback/' });
    await channel.handleWebhook(
      request(
        activity({
          conversation: channelThread('1700000000001'),
          text: '<at>Cogi</at> hi',
          entities: [mention()],
        })
      )
    );
    await channel.sendText('19:general@thread.tacv2', 'in the thread', {
      topicId: '1700000000001',
    });
    await channel.sendText('19:unknown@thread.v2', 'proactive');
    const calls = api.calls.filter((call) => call.method === 'POST' && call.body);
    expect(calls.map((call) => call.path)).toEqual([
      '/emea/v3/conversations/19:general@thread.tacv2;messageid=1700000000001/activities',
      '/fallback/v3/conversations/19:unknown@thread.v2/activities',
    ]);
  });

  it('splits text longer than a message holds, each part under 80 KB of JSON', async () => {
    const text = `${'\u0001'.repeat(TEAMS_MESSAGE_CHARS)}${'b'.repeat(500)}`;
    const parts = splitTeamsText(text);
    expect(parts).toHaveLength(2);
    for (const part of parts) {
      expect(Buffer.byteLength(JSON.stringify(part))).toBeLessThanOrEqual(80 * 1024);
    }
    const api = microsoft();
    const { channel } = created(api);
    const long = Array.from({ length: 3000 }, (_, i) => `line ${i} of a long answer`).join('\n');
    const id = await channel.sendText('a:personal-alice', long, {
      buttons: [[{ text: 'Ok', data: 'ok' }]],
    });
    const posted = api.connector();
    expect(posted.length).toBeGreaterThan(1);
    expect(id).toBe('m1');
    expect(posted.slice(0, -1).every((call) => !call.body?.attachments)).toBe(true);
    expect(posted.at(-1)?.body?.attachments).toBeDefined();
    expect(posted.map((call) => String(call.body?.text)).join('\n')).toBe(long);
  });

  it('retries throttled and failing requests with a backoff, honoring Retry-After', async () => {
    let failures = [429, 412, 502, 504];
    const api = microsoft([
      (call) => {
        if (!sameOrigin(call.url, SERVICE) || failures.length === 0) return undefined;
        const status = failures.shift() ?? 500;
        return Response.json(
          { error: { code: 'Throttled', message: 'slow down' } },
          { status, headers: status === 429 ? { 'retry-after': '0' } : {} }
        );
      },
    ]);
    const { channel } = created(api, { retry: { retries: 4, baseDelay: 1, maxDelay: 5 } });
    await expect(channel.sendText('a:x', 'eventually')).resolves.toBe('m1');
    expect(api.connector()).toHaveLength(5);
    failures = [429, 429, 429, 429];
    const tired = created(api, { retry: { retries: 2, baseDelay: 1, maxDelay: 5 } });
    await expect(tired.channel.sendText('a:x', 'no luck')).rejects.toMatchObject({
      code: 'rate_limited',
      status: 429,
    });
  });

  it('renews the token once when the Bot Connector refuses it', async () => {
    let refused = false;
    const api = microsoft([
      (call) => {
        if (!sameOrigin(call.url, SERVICE) || refused) return undefined;
        refused = true;
        return Response.json({ message: 'Authorization has been denied' }, { status: 401 });
      },
    ]);
    const { channel } = created(api);
    await channel.sendText('a:x', 'hi');
    expect(api.connector().map((call) => call.authorization)).toEqual([
      'Bearer bot-token-1',
      'Bearer bot-token-2',
    ]);
  });

  it('says clearly when the user blocked the bot, and maps other errors', async () => {
    const api = microsoft([
      (call) =>
        call.url.includes('blocked')
          ? Response.json(
              { error: { code: 'MessageWritesBlocked', message: 'Thread is blocked' } },
              { status: 403 }
            )
          : call.url.includes('missing')
            ? Response.json({ error: { code: 'ConversationNotFound' } }, { status: 404 })
            : undefined,
    ]);
    const { channel } = created(api);
    const blocked = await channel.sendText('a:blocked', 'hi').catch((error: unknown) => error);
    expect(blocked).toBeInstanceOf(TeamsApiError);
    expect(blocked).toBeInstanceOf(FeedError);
    expect(blocked).toMatchObject({ code: 'auth', status: 403, errorCode: 'MessageWritesBlocked' });
    expect(String(blocked)).toMatch(/user blocked the bot or removed the app/);
    await expect(channel.sendText('a:missing', 'hi')).rejects.toMatchObject({
      code: 'not_found',
      errorCode: 'ConversationNotFound',
    });
  });

  it('reports a token the tenant refuses', async () => {
    const api = microsoft([
      (call) =>
        sameOrigin(call.url, LOGIN)
          ? Response.json(
              { error: 'unauthorized_client', error_description: 'AADSTS700016: app not found' },
              { status: 400 }
            )
          : undefined,
    ]);
    const { channel } = created(api);
    await expect(channel.sendText('a:x', 'hi')).rejects.toThrow(/AADSTS700016/);
  });

  it('edits, deletes and shows typing, folding edits made while one is under way', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    let release = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const api = microsoft([
      (call) =>
        call.method === 'PUT' && call.body?.text === 'one'
          ? gate.then(() => Response.json({}))
          : undefined,
    ]);
    const { channel } = created(api);
    const id = await channel.sendText('a:x', 'draft');
    const first = channel.editText('a:x', id, 'one');
    await waitFor(() => api.connector().some((call) => call.method === 'PUT'));
    const later = [channel.editText('a:x', id, 'two'), channel.editText('a:x', id, 'three')];
    release();
    await vi.advanceTimersByTimeAsync(TEAMS_MIN_EDIT_INTERVAL);
    await Promise.all([first, ...later]);
    await channel.sendTyping('a:x');
    await channel.deleteMessage('a:x', id);
    const calls = api.connector();
    expect(calls.map((call) => call.method)).toEqual(['POST', 'PUT', 'PUT', 'POST', 'DELETE']);
    expect(calls[1].path).toBe('/emea/v3/conversations/a:x/activities/m1');
    expect(calls.filter((call) => call.method === 'PUT').map((call) => call.body)).toEqual([
      { type: 'message', id, text: 'one', textFormat: 'extendedmarkdown' },
      { type: 'message', id, text: 'three', textFormat: 'extendedmarkdown' },
    ]);
    expect(calls[3].body).toEqual({ type: 'typing' });
    await expect(channel.editText('a:x', id, 'x'.repeat(TEAMS_MESSAGE_CHARS + 1))).rejects.toThrow(
      /at most/
    );
  });
});

describe('TeamsChannel buttons', () => {
  const approve = [
    [
      { text: 'Approve', data: 'cogitator:approve', style: 'success' as const },
      { text: 'Deny', data: 'cogitator:deny', style: 'danger' as const },
    ],
  ];

  it('sends buttons as an Adaptive Card of Action.Execute falling back to Action.Submit', () => {
    const card = buttonsCard([
      ...approve,
      [
        { text: 'Docs', url: 'https://docs.test' },
        { text: 'Copy', copyText: 'npm i' },
        { text: 'Approved', disabled: true, style: 'success' },
      ],
    ]);
    expect(card).toMatchObject({ type: 'AdaptiveCard', version: '1.4' });
    const body = card.body as Record<string, unknown>[];
    expect(body[0]).toEqual({
      type: 'ActionSet',
      actions: [
        {
          type: 'Action.Execute',
          title: 'Approve',
          verb: 'cogitator',
          data: { cogitator: 'cogitator:approve' },
          style: 'positive',
          fallback: {
            type: 'Action.Submit',
            title: 'Approve',
            data: { cogitator: 'cogitator:approve' },
            style: 'positive',
          },
        },
        expect.objectContaining({ title: 'Deny', style: 'destructive' }),
      ],
    });
    expect(body[1]).toEqual({
      type: 'TextBlock',
      text: 'Approved',
      weight: 'Bolder',
      wrap: true,
      color: 'good',
    });
    expect(body[2]).toMatchObject({
      actions: [
        { type: 'Action.OpenUrl', url: 'https://docs.test' },
        { type: 'Action.ShowCard', title: 'Copy' },
      ],
    });
  });

  it('answers an Action.Execute press in its response with the press answer or the current card', async () => {
    const api = microsoft();
    const { channel, actions } = created(api);
    const cardId = await channel.sendText('a:personal-alice', 'Run the tool?', {
      buttons: approve,
    });
    const press = (data: string, extra: Record<string, unknown> = {}) =>
      activity({
        type: 'invoke',
        name: 'adaptiveCard/action',
        text: undefined,
        replyToId: cardId,
        value: { action: { type: 'Action.Execute', verb: 'cogitator', data: { cogitator: data } } },
        ...extra,
      });
    const quiet = await channel.handleWebhook(request(press('cogitator:approve')));
    expect(quiet.status).toBe(200);
    expect(quiet.contentType).toBe('application/json');
    expect(JSON.parse(quiet.body)).toEqual({
      statusCode: 200,
      type: 'application/vnd.microsoft.card.adaptive',
      value: buttonsCard(approve),
    });
    expect(actions[0]).toMatchObject({
      channelType: 'teams',
      channelId: 'a:personal-alice',
      userId: 'aad-alice',
      messageId: cardId,
      data: 'cogitator:approve',
    });
    channel.onAction(async (action) => {
      await channel.answerAction(action.id, { text: 'This prompt has expired', alert: true });
    });
    const noticed = await channel.handleWebhook(request(press('cogitator:deny')));
    expect(JSON.parse(noticed.body)).toEqual({
      statusCode: 200,
      type: 'application/vnd.microsoft.activity.message',
      value: 'This prompt has expired',
    });
    const unknown = await channel.handleWebhook(
      request(press('x', { value: { action: { verb: 'other', data: {} } } }))
    );
    expect(JSON.parse(unknown.body)).toMatchObject({ statusCode: 400 });
    const other = await channel.handleWebhook(request(press('x', { name: 'task/fetch' })));
    expect(other.status).toBe(501);
  });

  it('takes an Action.Submit press as a button press, answering it with a message', async () => {
    const api = microsoft();
    const { channel, received, actions } = created(api);
    await channel.handleWebhook(
      request(
        activity({
          conversation: channelThread('1700000000005'),
          text: undefined,
          replyToId: 'card-1',
          value: { cogitator: 'cogitator:deny' },
        })
      )
    );
    await waitFor(() => actions.length === 1);
    expect(received).toEqual([]);
    expect(actions).toHaveLength(1);
    expect(actions[0]).toMatchObject({
      channelId: '19:general@thread.tacv2',
      topicId: '1700000000005',
      messageId: 'card-1',
      data: 'cogitator:deny',
    });
    await channel.answerAction(actions[0].id, { text: 'Only the person asked can answer' });
    expect(api.connector().at(-1)?.path).toBe(
      '/emea/v3/conversations/19:general@thread.tacv2;messageid=1700000000005/activities'
    );
    expect(api.connector().at(-1)?.body?.text).toBe('Only the person asked can answer');
  });

  it('replaces and removes the buttons of a message, keeping its text', async () => {
    const api = microsoft();
    const { channel } = created(api);
    const id = await channel.sendText('a:x', 'Run it?', { buttons: approve });
    await channel.editButtons('a:x', id, [[{ text: 'Approved', disabled: true }]]);
    await channel.editButtons('a:x', id, null);
    const puts = api.connector().filter((call) => call.method === 'PUT');
    expect(puts[0].body).toMatchObject({ text: 'Run it?', attachments: [expect.any(Object)] });
    expect(puts[1].body).toEqual({
      type: 'message',
      id,
      text: 'Run it?',
      textFormat: 'extendedmarkdown',
    });
    await expect(channel.editButtons('a:x', 'unknown', null)).rejects.toThrow(/not known/);
  });
});

describe('TeamsChannel files', () => {
  it('asks for consent in a personal chat and uploads the file once accepted', async () => {
    const api = microsoft([
      (call) =>
        sameOrigin(call.url, 'https://onedrive.test/')
          ? new Response(null, { status: 201 })
          : undefined,
    ]);
    const { channel } = created(api);
    await channel.handleWebhook(request(activity()));
    const consentId = await channel.sendFile('a:personal-alice', {
      type: 'file',
      buffer: Buffer.from('a,b\n1,2'),
      mimeType: 'text/csv',
      filename: 'report.csv',
      caption: 'The report',
    });
    const consent = api.connector().at(-1);
    expect(consentId).toBeTruthy();
    const attachment = (consent?.body?.attachments as Record<string, unknown>[])[0];
    expect(attachment).toMatchObject({
      contentType: 'application/vnd.microsoft.teams.card.file.consent',
      name: 'report.csv',
      content: { description: 'The report', sizeInBytes: 7 },
    });
    const uploadId = (attachment.content as { acceptContext: { uploadId: string } }).acceptContext
      .uploadId;
    const accepted = await channel.handleWebhook(
      request(
        activity({
          type: 'invoke',
          name: 'fileConsent/invoke',
          text: undefined,
          value: {
            type: 'fileUpload',
            action: 'accept',
            context: { uploadId },
            uploadInfo: {
              name: 'report.csv',
              uploadUrl: 'https://onedrive.test/upload/1',
              contentUrl: 'https://onedrive.test/files/report.csv',
              uniqueId: 'unique-1',
              fileType: 'csv',
            },
          },
        })
      )
    );
    expect(accepted.status).toBe(200);
    await waitFor(() =>
      api.connector().some((call) => JSON.stringify(call.body).includes('card.file.info'))
    );
    const upload = api.calls.find((call) => call.url === 'https://onedrive.test/upload/1');
    expect(upload?.method).toBe('PUT');
    expect(upload?.authorization).toBeUndefined();
    expect(api.connector().at(-1)?.body).toMatchObject({
      text: 'The report',
      attachments: [
        {
          contentType: 'application/vnd.microsoft.teams.card.file.info',
          contentUrl: 'https://onedrive.test/files/report.csv',
          name: 'report.csv',
          content: { uniqueId: 'unique-1', fileType: 'csv' },
        },
      ],
    });
  });

  it('refuses uploads outside personal chats and links files with a public url', async () => {
    const api = microsoft();
    const { channel } = created(api);
    await expect(
      channel.sendFile('19:group@thread.v2', {
        type: 'file',
        buffer: new Uint8Array([1]),
        mimeType: 'text/plain',
      })
    ).rejects.toThrow(/personal chats only/);
    await channel.sendFile('19:group@thread.v2', {
      type: 'file',
      url: 'https://files.test/a.pdf',
      mimeType: 'application/pdf',
      filename: 'a.pdf',
    });
    await channel.sendFile('19:group@thread.v2', {
      type: 'image',
      url: 'https://files.test/a.png',
      mimeType: 'image/png',
      caption: 'Look',
    });
    const [link, image] = api.connector();
    expect(link.body?.text).toBe('[a.pdf](<https://files.test/a.pdf>)');
    expect(image.body).toMatchObject({
      text: 'Look',
      attachments: [{ contentType: 'image/png', contentUrl: 'https://files.test/a.png' }],
    });
    await expect(
      channel.sendFile('a:x', { type: 'file', url: 'file:///etc/passwd', mimeType: 'text/plain' })
    ).rejects.toThrow(/buffer .* or a public http/);
  });
});

describe('TeamsCredentials', () => {
  it('renews the token shortly before it expires, once for requests that come together', async () => {
    const api = microsoft();
    let now = Date.now();
    const credentials = new TeamsCredentials({
      appId: APP_ID,
      appPassword: 'secret',
      tenant: TENANT,
      loginUrl: LOGIN,
      fetch: api.fetch,
      now: () => now,
    });
    const tokens = await Promise.all([
      credentials.token(),
      credentials.token(),
      credentials.token(),
    ]);
    expect(new Set(tokens)).toEqual(new Set(['bot-token-1']));
    now += 54 * 60 * 1000;
    expect(await credentials.token()).toBe('bot-token-1');
    now += 2 * 60 * 1000;
    expect(await credentials.token()).toBe('bot-token-2');
  });
});

describe('ConversationPacer', () => {
  it('keeps every window of a conversation under its limit, and sends nothing before a block ends', async () => {
    vi.useFakeTimers();
    const pacer = new ConversationPacer(TEAMS_RATE_LIMITS, () => Date.now());
    const started = Date.now();
    const sent: number[] = [];
    const all = Array.from({ length: 70 }, () =>
      pacer.acquire('19:chat').then(() => sent.push(Date.now() - started))
    );
    await vi.advanceTimersByTimeAsync(40_000);
    await Promise.all(all);
    for (const { limit, window } of TEAMS_RATE_LIMITS) {
      for (const at of sent) {
        expect(
          sent.filter((other) => other >= at && other < at + window).length
        ).toBeLessThanOrEqual(limit);
      }
    }
    expect(sent[60]).toBeGreaterThanOrEqual(30_000);
    pacer.block('19:chat', 5000);
    const blockedAt = Date.now();
    let resumed = 0;
    const waiting = pacer.acquire('19:chat').then(() => (resumed = Date.now()));
    await vi.advanceTimersByTimeAsync(6000);
    await waiting;
    expect(resumed - blockedAt).toBeGreaterThanOrEqual(5000);
    expect(pacer.tryAcquire('19:other')).toBe(true);
  });

  it('leaves room for new messages when edits and typing fill a conversation', () => {
    vi.useFakeTimers();
    const pacer = new ConversationPacer(TEAMS_RATE_LIMITS, () => Date.now());
    let background = 0;
    while (pacer.tryAcquire('19:chat', 'background')) background++;
    expect(background).toBe(5);
    expect(pacer.tryAcquire('19:chat', 'send')).toBe(true);
  });

  it('blocks a conversation for every request when Teams throttles one', async () => {
    let throttled = false;
    const api = microsoft([
      (call) => {
        if (!sameOrigin(call.url, SERVICE) || throttled) return undefined;
        throttled = true;
        return Response.json({}, { status: 429, headers: { 'retry-after': '0.05' } });
      },
    ]);
    const pacer = new ConversationPacer();
    const block = vi.spyOn(pacer, 'block');
    const client = new TeamsClient({
      credentials: new TeamsCredentials({
        appId: APP_ID,
        appPassword: 'secret',
        tenant: TENANT,
        loginUrl: LOGIN,
        fetch: api.fetch,
      }),
      pacer,
      fetch: api.fetch,
    });
    await client.request('POST', SERVICE, '/v3/conversations/a%3Ax/activities', {}, { key: 'a:x' });
    expect(block).toHaveBeenCalledWith('a:x', 50);
    expect(api.connector()).toHaveLength(2);
  });
});

describe('TeamsChannel limits and failures', () => {
  it('gives up on a request that gets no answer in time, and does not post twice', async () => {
    const api = microsoft([
      (call) =>
        sameOrigin(call.url, SERVICE)
          ? new Promise<Response>(() => {
              return;
            })
          : undefined,
    ]);
    const fetchWithSignal = (async (input: string | URL | Request, init?: RequestInit) => {
      const answer = api.fetch(input, init);
      const signal = init?.signal;
      if (!signal) return answer;
      return Promise.race([
        answer,
        new Promise<Response>((_, reject) =>
          signal.addEventListener('abort', () =>
            reject(signal.reason instanceof Error ? signal.reason : new Error('aborted'))
          )
        ),
      ]);
    }) as typeof fetch;
    const { channel } = created(api, { fetch: fetchWithSignal, requestTimeout: 30 });
    const failed = await channel.sendText('a:x', 'hi').catch((error: unknown) => error);
    expect(failed).toBeInstanceOf(TeamsApiError);
    expect(failed).toMatchObject({ code: 'unavailable', timedOut: true });
    expect(api.connector()).toHaveLength(1);
  });

  it('stops writing to a conversation that blocks the bot until it writes again', async () => {
    let blocked = true;
    const api = microsoft([
      (call) =>
        blocked && sameOrigin(call.url, SERVICE)
          ? Response.json({ error: { code: 'MessageWritesBlocked' } }, { status: 403 })
          : undefined,
    ]);
    const { channel } = created(api);
    await expect(channel.sendText('a:personal-alice', 'one')).rejects.toMatchObject({
      errorCode: 'MessageWritesBlocked',
    });
    await expect(channel.sendText('a:personal-alice', 'two')).rejects.toThrow(/skipped/);
    await channel.sendTyping('a:personal-alice');
    expect(api.connector()).toHaveLength(1);
    blocked = false;
    await channel.handleWebhook(request(activity()));
    await expect(channel.sendText('a:personal-alice', 'three')).resolves.toBe('m1');
  });

  it('sends the newest text of a streamed answer when an earlier edit fails', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    let release = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const api = microsoft([
      (call) =>
        call.method === 'PUT' && call.body?.text === 'partial'
          ? gate.then(() => Response.json({ error: { code: 'BadArgument' } }, { status: 400 }))
          : undefined,
    ]);
    const { channel } = created(api);
    const id = await channel.sendText('a:x', 'draft');
    const first = channel.editText('a:x', id, 'partial');
    await waitFor(() => api.connector().some((call) => call.method === 'PUT'));
    const last = channel.editText('a:x', id, 'the whole answer');
    release();
    await vi.advanceTimersByTimeAsync(TEAMS_MIN_EDIT_INTERVAL);
    await Promise.all([first, last]);
    expect(
      api
        .connector()
        .filter((call) => call.method === 'PUT')
        .map((call) => call.body?.text)
    ).toEqual(['partial', 'the whole answer']);
  });

  it('keeps the buttons a pending change set when the text is edited meanwhile', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const api = microsoft();
    const { channel } = created(api);
    const id = await channel.sendText('a:x', 'Run it?', {
      buttons: [[{ text: 'Approve', data: 'cogitator:approve' }]],
    });
    const changes = Promise.all([
      channel.editButtons('a:x', id, [[{ text: 'Approved', disabled: true }]]),
      channel.editText('a:x', id, 'Run it? Yes'),
    ]);
    await vi.advanceTimersByTimeAsync(TEAMS_MIN_EDIT_INTERVAL);
    await changes;
    const puts = api.connector().filter((call) => call.method === 'PUT');
    expect(JSON.stringify(puts.at(-1)?.body)).toContain('Approved');
    expect(JSON.stringify(puts.at(-1)?.body)).not.toContain('Action.Execute');
    expect(puts.at(-1)?.body?.text).toBe('Run it? Yes');
  });

  it('turns images of answers into links, outside code', async () => {
    const api = microsoft();
    const { channel } = created(api);
    await channel.sendText('a:x', 'See ![chart](https://evil.test/?q=secret) and `![x](y)`');
    expect(api.connector()[0].body?.text).toBe(
      'See [chart](https://evil.test/?q=secret) and `![x](y)`'
    );
  });

  it('reads code spans and fences as CommonMark does, so no image hides behind fake code', () => {
    const cases: Array<[string, string]> = [
      ['\\`![a](http://e/?q=s)`', '\\`[a](http://e/?q=s)`'],
      ['``![a](http://e/?q=s)`', '``[a](http://e/?q=s)`'],
      ['`![a](x)` and ``![b](y)``', '`![a](x)` and ``![b](y)``'],
      ['`a\\`![c](http://e/)`', '`a\\`[c](http://e/)`'],
      [
        '```js\n![d](http://e/)\n```\n![e](http://e/)',
        '```js\n![d](http://e/)\n```\n[e](http://e/)',
      ],
      ['``` x ` y\n![f](http://e/)', '``` x ` y\n[f](http://e/)'],
      ['~~~\n![g](u)\n````\n~~~\n![h](u)', '~~~\n![g](u)\n````\n~~~\n[h](u)'],
      ['<img src="http://e/?q=s"> <IMG SRC=x>', '&lt;img src="http://e/?q=s"> &lt;IMG SRC=x>'],
      ['\\![not an image](u)', '\\![not an image](u)'],
      ['`span\n![i](u)` over two lines', '`span\n![i](u)` over two lines'],
      ['`open\n\n![j](u)` in the next paragraph', '`open\n\n[j](u)` in the next paragraph'],
    ];
    for (const [input, expected] of cases) expect(imagesAsLinks(input)).toBe(expected);
    const hostile = `x${'`'.repeat(100_000)}![k](u)${'`` '.repeat(50_000)}`;
    expect(imagesAsLinks(hostile)).toContain('[k](u)');
    expect(imagesAsLinks(hostile)).not.toContain('![k]');
  });

  it('never cuts an emoji in two when it splits a long text', () => {
    const halves = (part: string) => /[\uD800-\uDBFF]$/.test(part) || /^[\uDC00-\uDFFF]/.test(part);
    for (const text of ['😀'.repeat(TEAMS_MESSAGE_CHARS), `x${'😀'.repeat(TEAMS_MESSAGE_CHARS)}`]) {
      const parts = splitTeamsText(text);
      expect(parts.length).toBeGreaterThan(1);
      expect(parts.some(halves)).toBe(false);
      expect(parts.join('')).toBe(text);
    }
  });
});

describe('TeamsChannel delivery', () => {
  it('answers 503 for messages while no handler is set, so Bot Framework sends them again', async () => {
    const api = microsoft();
    const channel = new TeamsChannel({
      appId: APP_ID,
      appPassword: 'secret',
      tenantId: TENANT,
      openIdMetadataUrl: METADATA,
      loginUrl: LOGIN,
      fetch: api.fetch,
    });
    channels.push(channel);
    const body = activity();
    expect((await channel.handleWebhook(request(body))).status).toBe(503);
    const received: ChannelMessage[] = [];
    channel.onMessage(async (msg) => void received.push(msg));
    expect((await channel.handleWebhook(request(body))).status).toBe(202);
    expect(received).toHaveLength(1);
  });

  it('logs a message given back after its request was answered, when the gateway took long', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { channel } = created(microsoft());
    let finish = () => {};
    channel.onMessage(
      (msg) =>
        new Promise<void>((resolve) => {
          finish = () => {
            void channel.redeliver(msg).then(resolve);
          };
        })
    );
    const answered = channel.handleWebhook(request(activity()));
    await vi.advanceTimersByTimeAsync(3100);
    expect((await answered).status).toBe(202);
    finish();
    await waitFor(() => warn.mock.calls.length > 0);
    expect(String(warn.mock.calls[0][0])).toMatch(/dropped unanswered after its request/);
  });

  it('refuses http service URLs unless the metadata URL is a test one, and tenants that disagree', async () => {
    const api = microsoft();
    const real = new TeamsChannel({
      appId: APP_ID,
      appPassword: 'secret',
      tenantId: TENANT,
      loginUrl: LOGIN,
      fetch: api.fetch,
    });
    channels.push(real);
    const received: ChannelMessage[] = [];
    real.onMessage(async (msg) => void received.push(msg));
    const plain = 'http://smba.test/emea/';
    expect(
      (
        await real.handleWebhook(
          request(activity({ serviceUrl: plain }), token({ serviceurl: plain }))
        )
      ).status
    ).toBe(403);
    await real.handleWebhook(
      request(activity({ channelData: { tenant: { id: 'tenant-other' } } }))
    );
    const open = created(api, { tenants: '*' });
    await open.channel.handleWebhook(
      request(activity({ channelData: { tenant: { id: 'tenant-other' } } }))
    );
    await real.handleWebhook(request(activity()));
    expect(received).toHaveLength(1);
    expect(open.received).toEqual([]);
  });

  it('maps audio and video files so speech reaches speech to text', async () => {
    const { channel, received } = created(microsoft());
    await channel.handleWebhook(
      request(
        activity({
          text: '',
          attachments: [
            {
              contentType: 'application/vnd.microsoft.teams.file.download.info',
              name: 'memo.m4a',
              content: { downloadUrl: 'https://files.test/memo.m4a', fileType: 'm4a' },
            },
            {
              contentType: 'application/vnd.microsoft.teams.file.download.info',
              name: 'clip.mp4',
              content: { downloadUrl: 'https://files.test/clip.mp4', fileType: 'mp4' },
            },
          ],
        })
      )
    );
    expect(received[0].attachments?.map((file) => [file.type, file.mimeType])).toEqual([
      ['audio', 'audio/mp4'],
      ['video', 'video/mp4'],
    ]);
  });

  it('lets an Action.Execute press in flight finish when it stops', async () => {
    const port = await freePort();
    const { channel } = created(microsoft(), { webhook: { port } });
    let pressed = false;
    channel.onAction(async () => {
      pressed = true;
      await new Promise(() => {
        return;
      });
    });
    await channel.start();
    const answer = fetch(`http://127.0.0.1:${port}/api/messages`, {
      method: 'POST',
      headers: { authorization: `Bearer ${token()}`, 'content-type': 'application/json' },
      body: JSON.stringify(
        activity({
          type: 'invoke',
          name: 'adaptiveCard/action',
          value: { action: { verb: 'cogitator', data: { cogitator: 'x' } } },
        })
      ),
    });
    await waitFor(() => pressed);
    await channel.stop();
    const response = await answer;
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ statusCode: 200 });
  });
});

describe('TeamsChannel button presses', () => {
  const approve = [[{ text: 'Approve', data: 'cogitator:approve' }]];
  const press = (cardId: string, extra: Record<string, unknown> = {}) =>
    activity({
      type: 'invoke',
      name: 'adaptiveCard/action',
      text: undefined,
      replyToId: cardId,
      value: { action: { verb: 'cogitator', data: { cogitator: 'cogitator:approve' } } },
      ...extra,
    });

  it('answers a press with the card as the press left it', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const { channel } = created(microsoft());
    const cardId = await channel.sendText('a:personal-alice', 'Run it?', { buttons: approve });
    channel.onAction(async (action) => {
      await channel.answerAction(action.id);
      const edited = channel.editButtons('a:personal-alice', cardId, [
        [{ text: 'Approved', disabled: true, style: 'success' }],
      ]);
      await vi.advanceTimersByTimeAsync(TEAMS_MIN_EDIT_INTERVAL);
      await edited;
    });
    const response = await channel.handleWebhook(request(press(cardId)));
    const body = JSON.parse(response.body) as { type: string; value: unknown };
    expect(body.type).toBe('application/vnd.microsoft.card.adaptive');
    expect(JSON.stringify(body.value)).toContain('Approved');
    expect(JSON.stringify(body.value)).not.toContain('Action.Execute');
  });

  it('answers a press sent again, or by someone it does not answer, in the shape Teams wants', async () => {
    const { channel } = created(microsoft());
    const body = press('card-1');
    await channel.handleWebhook(request(body));
    const again = await channel.handleWebhook(request(body));
    expect(again.contentType).toBe('application/json');
    expect(JSON.parse(again.body)).toMatchObject({
      statusCode: 200,
      type: 'application/vnd.microsoft.activity.message',
    });
    const stranger = await channel.handleWebhook(
      request(press('card-1', { channelData: { tenant: { id: 'tenant-other' } } }))
    );
    expect(JSON.parse(stranger.body)).toMatchObject({
      statusCode: 400,
      type: 'application/vnd.microsoft.error',
    });
  });

  it('gives presses in groups and channels their group, and keeps alerts out of threads', async () => {
    const api = microsoft();
    const { channel, actions } = created(api);
    await channel.handleWebhook(
      request(
        activity({
          conversation: channelThread('1700000000009'),
          channelData: { tenant: { id: TENANT }, team: { id: '19:team@thread.tacv2' } },
          text: undefined,
          replyToId: 'card-2',
          value: { cogitator: 'cogitator:approve' },
        })
      )
    );
    await waitFor(() => actions.length === 1);
    expect(actions[0].groupId).toBe('19:team@thread.tacv2');
    await channel.answerAction(actions[0].id, { text: 'This request expired', alert: true });
    expect(api.connector()).toEqual([]);
  });
});

describe('TeamsChannel file consent', () => {
  it('answers an accept it cannot act on and a decline, and refuses empty files', async () => {
    const api = microsoft();
    const { channel } = created(api);
    const consent = (action: 'accept' | 'decline', uploadId: string) =>
      activity({
        type: 'invoke',
        name: 'fileConsent/invoke',
        text: undefined,
        value: {
          type: 'fileUpload',
          action,
          context: { uploadId },
          uploadInfo: {
            name: 'a.txt',
            uploadUrl: 'https://onedrive.test/u',
            contentUrl: 'https://onedrive.test/a.txt',
            uniqueId: 'u1',
          },
        },
      });
    await channel.handleWebhook(request(consent('accept', 'from-before-a-restart')));
    await waitFor(() => api.connector().length === 1);
    expect(api.connector()[0].body?.text).toMatch(/no longer available/);
    await channel.handleWebhook(request(activity()));
    await channel.sendFile('a:personal-alice', {
      type: 'file',
      buffer: Buffer.from('hi'),
      mimeType: 'text/plain',
      filename: 'a.txt',
    });
    const card = api.connector().at(-1)?.body?.attachments as
      Array<{ content: { declineContext: { uploadId: string } } }> | undefined;
    const uploadId = card?.[0].content.declineContext.uploadId ?? '';
    await channel.handleWebhook(request(consent('decline', uploadId)));
    await waitFor(() => api.connector().at(-1)?.body?.text === 'The file was not sent.');
    await expect(
      channel.sendFile('a:personal-alice', {
        type: 'file',
        buffer: new Uint8Array(0),
        mimeType: 'text/plain',
      })
    ).rejects.toThrow(/empty/);
  });
});

describe('ConversationPacer order', () => {
  it('lets a new message go at once while edits wait for their share', async () => {
    vi.useFakeTimers();
    const pacer = new ConversationPacer([{ limit: 4, window: 2000 }], () => Date.now());
    for (let i = 0; i < 3; i++) await pacer.acquire('c', 'background');
    let edited = false;
    const edit = pacer.acquire('c', 'background').then(() => (edited = true));
    let sent = false;
    const send = pacer.acquire('c', 'send').then(() => (sent = true));
    await vi.advanceTimersByTimeAsync(0);
    expect(sent).toBe(true);
    expect(edited).toBe(false);
    await vi.advanceTimersByTimeAsync(2000);
    await Promise.all([edit, send]);
    expect(edited).toBe(true);
  });

  it('keeps the order of waiting requests through a block', async () => {
    vi.useFakeTimers();
    const pacer = new ConversationPacer([{ limit: 1, window: 100 }], () => Date.now());
    const order: string[] = [];
    await pacer.acquire('k');
    const a = pacer.acquire('k').then(() => order.push('A'));
    const b = pacer.acquire('k').then(() => order.push('B'));
    pacer.block('k', 150);
    await vi.advanceTimersByTimeAsync(1000);
    await Promise.all([a, b]);
    expect(order).toEqual(['A', 'B']);
  });

  it('ends a wait when its signal aborts', async () => {
    vi.useFakeTimers();
    const pacer = new ConversationPacer([{ limit: 1, window: 60_000 }], () => Date.now());
    await pacer.acquire('k');
    const halt = new AbortController();
    const waiting = pacer.acquire('k', 'send', halt.signal);
    halt.abort(new Error('stopped'));
    await expect(waiting).rejects.toThrow('stopped');
    expect(vi.getTimerCount()).toBe(0);
  });
});

describe('TeamsChannel stopping and stale state', () => {
  it('aborts waiting requests and refuses new ones once stopped', async () => {
    const api = microsoft([
      (call) =>
        sameOrigin(call.url, SERVICE)
          ? Response.json({}, { status: 429, headers: { 'retry-after': '60' } })
          : undefined,
    ]);
    const { channel } = created(api, { retry: { retries: 3, baseDelay: 1, maxDelay: 60_000 } });
    const sending = channel.sendText('a:x', 'hi').catch((error: unknown) => error);
    await waitFor(() => api.connector().length === 1);
    await channel.stop();
    expect(await sending).toBeInstanceOf(Error);
    await expect(channel.sendText('a:x', 'after')).rejects.toThrow(/stopped/);
    await channel.sendTyping('a:x');
    expect(api.connector()).toHaveLength(1);
  });

  it('does not try a typing indicator again', async () => {
    const api = microsoft([
      (call) => (sameOrigin(call.url, SERVICE) ? new Response('', { status: 502 }) : undefined),
    ]);
    const { channel } = created(api);
    await expect(channel.sendTyping('a:x')).rejects.toMatchObject({ status: 502 });
    expect(api.connector()).toHaveLength(1);
  });

  it('answers a press with no card when a pending change removes the buttons', async () => {
    let release = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const api = microsoft([
      (call) => (call.method === 'PUT' ? gate.then(() => Response.json({})) : undefined),
    ]);
    const { channel } = created(api);
    const cardId = await channel.sendText('a:personal-alice', 'Run it?', {
      buttons: [[{ text: 'Approve', data: 'cogitator:approve' }]],
    });
    channel.onAction(async (action) => {
      await channel.answerAction(action.id);
      void channel.editButtons('a:personal-alice', cardId, null);
    });
    const response = await channel.handleWebhook(
      request(
        activity({
          type: 'invoke',
          name: 'adaptiveCard/action',
          text: undefined,
          replyToId: cardId,
          value: { action: { verb: 'cogitator', data: { cogitator: 'cogitator:approve' } } },
        })
      )
    );
    release();
    const body = JSON.parse(response.body) as { type: string; value: unknown };
    expect(body.type).toBe('application/vnd.microsoft.activity.message');
    expect(JSON.stringify(body.value)).not.toContain('Approve');
  });

  it('loads the keys for a new signing key once a failed load stops backing off', async () => {
    let failing = false;
    const api = microsoft([
      (call) => (failing && call.url === JWKS ? new Response('down', { status: 500 }) : undefined),
    ]);
    let now = Date.now();
    const check = new TeamsTokenVerifier({
      appId: APP_ID,
      metadataUrl: METADATA,
      fetch: api.fetch,
      now: () => now,
    });
    const lasting = { exp: Math.floor(now / 1000) + 3 * 86_400 };
    await check.verify(token(lasting));
    failing = true;
    now += 24 * 60 * 60 * 1000 + 1;
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    await check.verify(token(lasting));
    await waitFor(() => api.keyLoads() === 2);
    await new Promise((resolve) => setTimeout(resolve, 0));
    failing = false;
    api.keys.push(rotated.jwk);
    now += 5000;
    await expect(check.verify(token(lasting, { pair: rotated }))).rejects.toThrow(/unknown key/);
    now += 6000;
    await expect(check.verify(token(lasting, { pair: rotated }))).resolves.toBeDefined();
  });
});
