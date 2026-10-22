import { afterEach, describe, expect, it, vi } from 'vitest';
import { createHmac } from 'node:crypto';
import { createServer } from 'node:net';
import type { ChannelMessage } from '@cogitator-ai/types';
import { FeedError } from '../feeds/errors';
import {
  GITHUB_COMMENT_LIMIT,
  GitHubChannel,
  type GitHubChannelConfig,
  verifyGitHubSignature,
} from '../channels/github/channel';
import { GitHubClient } from '../channels/github/client';
import { defaultThreadKey } from '../thread-key';

const SECRET = 'webhook-secret';

interface Call {
  method: string;
  path: string;
  body?: Record<string, unknown>;
  authorization?: string;
}

type Route = (call: Call) => Response | undefined;

function github(routes: Route[] = []) {
  const calls: Call[] = [];
  let next = 1000;
  const fetchImpl = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input));
    const headers = new Headers(init?.headers);
    const call: Call = {
      method: init?.method ?? 'GET',
      path: url.pathname,
      ...(typeof init?.body === 'string' && {
        body: JSON.parse(init.body) as Record<string, unknown>,
      }),
      ...(headers.get('authorization') && { authorization: headers.get('authorization') ?? '' }),
    };
    calls.push(call);
    for (const route of routes) {
      const response = route(call);
      if (response) return response;
    }
    if (call.path === '/user') return Response.json({ login: 'mybot', id: 1 });
    if (call.method === 'POST') return Response.json({ id: ++next }, { status: 201 });
    if (call.method === 'DELETE') return new Response(null, { status: 204 });
    return Response.json({ id: 1 });
  });
  return { calls, fetch: fetchImpl as unknown as typeof fetch };
}

const channels: GitHubChannel[] = [];

afterEach(async () => {
  for (const channel of channels.splice(0)) await channel.stop();
  vi.restoreAllMocks();
});

function created(
  api: ReturnType<typeof github>,
  config: Partial<GitHubChannelConfig> & { port?: number } = {}
) {
  const { port, ...rest } = config;
  const channel = new GitHubChannel({
    token: 'ghp_token',
    fetch: api.fetch,
    webhook: { secret: SECRET, ...(port !== undefined && { port }) },
    ...rest,
  });
  channels.push(channel);
  const received: ChannelMessage[] = [];
  channel.onMessage(async (msg) => void received.push(msg));
  return { channel, received };
}

async function started(
  api: ReturnType<typeof github>,
  config: Partial<GitHubChannelConfig> & { port?: number } = {}
) {
  const made = created(api, config);
  await made.channel.start();
  return made;
}

let deliveries = 0;

function signed(event: string, payload: unknown, delivery = `delivery-${++deliveries}`) {
  const rawBody = JSON.stringify(payload);
  return {
    method: 'POST',
    headers: {
      'x-hub-signature-256': `sha256=${createHmac('sha256', SECRET).update(rawBody).digest('hex')}`,
      'x-github-event': event,
      'x-github-delivery': delivery,
      'content-type': 'application/json',
    },
    rawBody,
  };
}

const repository = { full_name: 'acme/widgets', name: 'widgets', owner: { login: 'acme' } };
const person = { login: 'octocat', id: 583231, type: 'User' };

const issueOpened = (body: string, extra: Record<string, unknown> = {}) => ({
  action: 'opened',
  issue: { number: 7, title: 'Crash on start', body, user: person },
  repository,
  sender: person,
  ...extra,
});

const issueComment = (body: string, sender = person, id = 501) => ({
  action: 'created',
  issue: { number: 12, title: 'Add caching', body: null, pull_request: { url: 'x' } },
  comment: { id, body, user: sender },
  repository,
  sender,
});

const reviewComment = (id: number, body: string, inReplyTo?: number) => ({
  action: 'created',
  pull_request: { number: 12, title: 'Add caching', body: 'Speeds it up' },
  comment: {
    id,
    body,
    path: 'src/cache.ts',
    user: person,
    ...(inReplyTo !== undefined && { in_reply_to_id: inReplyTo }),
  },
  repository,
  sender: person,
});

async function settle() {
  await new Promise((resolve) => setTimeout(resolve, 10));
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

describe('GitHubChannel webhooks', () => {
  it('refuses deliveries that are unsigned or signed with another secret', async () => {
    const { channel, received } = await started(github(), { trigger: 'all' });
    const delivery = signed('issues', issueOpened('body'));
    const forged = {
      ...delivery,
      headers: { ...delivery.headers, 'x-hub-signature-256': `sha256=${'0'.repeat(64)}` },
    };
    expect((await channel.handleWebhook(forged)).status).toBe(401);
    const { 'x-hub-signature-256': _signature, ...unsigned } = delivery.headers;
    expect((await channel.handleWebhook({ ...delivery, headers: unsigned })).status).toBe(401);
    expect((await channel.handleWebhook({ method: 'GET', headers: {} })).status).toBe(405);
    await settle();
    expect(received).toEqual([]);
    expect(verifyGitHubSignature('body', undefined, SECRET)).toBe(false);
    expect(verifyGitHubSignature('body', 'sha1=abc', SECRET)).toBe(false);
  });

  it('reads the signature, event and delivery headers in any letter case', async () => {
    const { channel, received } = await started(github(), { trigger: 'all' });
    const delivery = signed('issues', issueOpened('It crashes'));
    const shouting = Object.fromEntries(
      Object.entries(delivery.headers).map(([name, value]) => [
        name.replace(
          /(^|-)(\w)/g,
          (_, dash: string, letter: string) => dash + letter.toUpperCase()
        ),
        value,
      ])
    );
    expect(shouting['X-Hub-Signature-256']).toBeDefined();
    expect(await channel.handleWebhook({ ...delivery, headers: shouting })).toEqual({
      status: 200,
      body: 'OK',
    });
    await settle();
    expect(received.map((m) => m.text)).toEqual(['Crash on start\n\nIt crashes']);
  });

  it('answers the ping GitHub sends when the webhook is created, and ignores other events', async () => {
    const { channel } = await started(github());
    expect(await channel.handleWebhook(signed('ping', { zen: 'Keep it simple' }))).toEqual({
      status: 200,
      body: 'pong',
    });
    expect(await channel.handleWebhook(signed('star', { action: 'created' }))).toEqual({
      status: 200,
      body: 'Ignored',
    });
    const broken = { ...signed('issues', {}), rawBody: '{' };
    broken.headers['x-hub-signature-256'] =
      `sha256=${createHmac('sha256', SECRET).update('{').digest('hex')}`;
    expect((await channel.handleWebhook(broken)).status).toBe(400);
  });

  it('handles a delivery GitHub sends again only once', async () => {
    const { channel, received } = await started(github(), { trigger: 'all' });
    const first = signed('issue_comment', issueComment('Looks good'), 'same-guid');
    expect((await channel.handleWebhook(first)).body).toBe('OK');
    expect(await channel.handleWebhook(first)).toEqual({ status: 200, body: 'Already received' });
    await settle();
    expect(received).toHaveLength(1);
  });

  it('takes deliveries sent as a form, the payload field holding the JSON', async () => {
    const { channel, received } = await started(github(), { trigger: 'all' });
    const rawBody = new URLSearchParams({
      payload: JSON.stringify(issueComment('Sent as a form')),
    }).toString();
    await channel.handleWebhook({
      method: 'POST',
      headers: {
        'x-hub-signature-256': `sha256=${createHmac('sha256', SECRET).update(rawBody).digest('hex')}`,
        'x-github-event': 'issue_comment',
        'x-github-delivery': 'form-1',
        'content-type': 'application/x-www-form-urlencoded',
      },
      rawBody: Buffer.from(rawBody),
    });
    await settle();
    expect(received.map((m) => m.text)).toEqual(['Sent as a form']);
  });

  it('loads its login once when a delivery comes before start(), and skips its own comments', async () => {
    const api = github();
    const { channel, received } = created(api, { trigger: 'all' });
    await channel.handleWebhook(
      signed('issue_comment', issueComment('my answer', { login: 'MyBot', id: 1, type: 'User' }))
    );
    await channel.handleWebhook(signed('issue_comment', issueComment('a question')));
    await settle();
    expect(received.map((m) => m.text)).toEqual(['a question']);
    expect(api.calls.filter((c) => c.path === '/user')).toHaveLength(1);
    expect(channel.login).toBe('mybot');
  });

  it('runs its own webhook server when given a port, refusing bodies over 1 MB', async () => {
    const port = await freePort();
    const { received } = await started(github(), { port, trigger: 'all' });
    const base = `http://127.0.0.1:${port}/github/webhook`;
    const delivery = signed('issues', issueOpened('over HTTP'));
    const posted = await fetch(base, {
      method: 'POST',
      headers: delivery.headers,
      body: delivery.rawBody,
    });
    expect(posted.status).toBe(200);
    await settle();
    expect(received.map((m) => m.text)).toEqual(['Crash on start\n\nover HTTP']);
    expect((await fetch(`http://127.0.0.1:${port}/elsewhere`)).status).toBe(404);
    const huge = await fetch(base, {
      method: 'POST',
      headers: delivery.headers,
      body: 'x'.repeat(1024 * 1024 + 10),
    });
    expect(huge.status).toBe(413);
    await settle();
    expect(received).toHaveLength(1);
  });

  it('cannot be created without the webhook secret', () => {
    expect(
      () => new GitHubChannel({ token: 't', webhook: { secret: '' }, fetch: github().fetch })
    ).toThrow(/webhook\.secret is required/);
  });
});

describe('GitHubChannel events', () => {
  it('turns every event it answers into a message of its issue or pull request', async () => {
    const { channel, received } = await started(github(), { trigger: 'all' });
    await channel.handleWebhook(signed('issues', issueOpened('Steps: run it')));
    await channel.handleWebhook(signed('issue_comment', issueComment('Why this cache?')));
    await channel.handleWebhook(
      signed('pull_request', {
        action: 'opened',
        number: 13,
        pull_request: { number: 13, title: 'Fix crash', body: null },
        repository,
        sender: person,
      })
    );
    await channel.handleWebhook(
      signed('pull_request_review_comment', reviewComment(900, 'Rename?'))
    );
    await channel.handleWebhook(
      signed('pull_request_review_comment', reviewComment(901, 'Agreed', 900))
    );
    await channel.handleWebhook(
      signed('pull_request_review', {
        action: 'submitted',
        review: { id: 77, body: 'Two nits, then ship it', state: 'approved' },
        pull_request: { number: 12, title: 'Add caching', body: null },
        repository,
        sender: person,
      })
    );
    await settle();
    expect(
      received.map((m) => [m.id, m.channelId, m.text, m.topicId ?? null, m.replyTo ?? null])
    ).toEqual([
      ['issue:7', 'acme/widgets#7', 'Crash on start\n\nSteps: run it', null, null],
      ['comment:501', 'acme/widgets#12', 'Why this cache?', null, null],
      ['issue:13', 'acme/widgets#13', 'Fix crash', null, null],
      ['review_comment:900', 'acme/widgets#12', 'Rename?', '900', null],
      ['review_comment:901', 'acme/widgets#12', 'Agreed', '900', 'review_comment:900'],
      ['review:77', 'acme/widgets#12', 'Two nits, then ship it', null, null],
    ]);
    expect(received[0]).toMatchObject({
      channelType: 'github',
      userId: '583231',
      userName: 'octocat',
      groupId: 'acme/widgets',
    });
  });

  it('keeps an issue and each of its review threads as conversations of their own', async () => {
    const { channel, received } = await started(github(), { trigger: 'all' });
    await channel.handleWebhook(signed('issue_comment', issueComment('On the PR')));
    await channel.handleWebhook(signed('pull_request_review_comment', reviewComment(900, 'A')));
    await channel.handleWebhook(
      signed('pull_request_review_comment', reviewComment(901, 'B', 900))
    );
    await channel.handleWebhook(signed('pull_request_review_comment', reviewComment(950, 'C')));
    await settle();
    expect(received.map((m) => defaultThreadKey(m))).toEqual([
      'github:acme/widgets#12:583231',
      'github:acme/widgets#12:900:583231',
      'github:acme/widgets#12:900:583231',
      'github:acme/widgets#12:950:583231',
    ]);
  });

  it('skips actions it does not answer and reviews without a body', async () => {
    const { channel, received } = await started(github(), { trigger: 'all' });
    await channel.handleWebhook(signed('issues', issueOpened('edited', { action: 'edited' })));
    await channel.handleWebhook(
      signed('issue_comment', { ...issueComment('x'), action: 'deleted' })
    );
    await channel.handleWebhook(
      signed('pull_request_review', {
        action: 'submitted',
        review: { id: 78, body: null, state: 'commented' },
        pull_request: { number: 12, title: 'Add caching' },
        repository,
        sender: person,
      })
    );
    await channel.handleWebhook(signed('issue_comment', { action: 'created', comment: 'bad' }));
    await settle();
    expect(received).toEqual([]);
  });

  it('skips bots and apps unless allowed', async () => {
    const dependabot = { login: 'dependabot[bot]', id: 49699333, type: 'Bot' };
    const strict = await started(github(), { trigger: 'all' });
    await strict.channel.handleWebhook(signed('issue_comment', issueComment('bump', dependabot)));
    await settle();
    expect(strict.received).toEqual([]);

    const open = await started(github(), { trigger: 'all', allowBots: true });
    await open.channel.handleWebhook(signed('issue_comment', issueComment('bump', dependabot)));
    await settle();
    expect(open.received.map((m) => m.userName)).toEqual(['dependabot[bot]']);
  });

  it('answers only mentions by default, outside code and quotes, without the mention', async () => {
    const { channel, received } = await started(github());
    const texts = [
      'no mention here',
      '@mybot can you review this?',
      'cc @MyBot, thoughts?',
      '> @mybot said something\nquoted only',
      'run `@mybot` in code',
      '```\n@mybot inside a fence\n```',
      'ping @mybot-two please',
      'mail me at me@mybot.dev',
    ];
    for (const [index, text] of texts.entries()) {
      await channel.handleWebhook(signed('issue_comment', issueComment(text, person, 600 + index)));
    }
    await settle();
    expect(received.map((m) => m.text)).toEqual(['can you review this?', 'cc @MyBot, thoughts?']);
  });

  it('finds mentions of an app by its slug and skips the app comments by its login', async () => {
    const api = github();
    const { channel, received } = await started(api, { login: 'helper-app[bot]' });
    const app = { login: 'helper-app[bot]', id: 9, type: 'Bot' };
    await channel.handleWebhook(signed('issue_comment', issueComment('@helper-app hi', app)));
    await channel.handleWebhook(signed('issue_comment', issueComment('@helper-app explain')));
    await settle();
    expect(received.map((m) => m.text)).toEqual(['explain']);
    expect(api.calls.some((c) => c.path === '/user')).toBe(false);
  });

  it('answers only in the allowed repositories', async () => {
    const { channel, received } = await started(github(), {
      trigger: 'all',
      repositories: ['Acme/Widgets', 'tools/*'],
    });
    const elsewhere = (name: string) => ({
      ...issueComment(`from ${name}`),
      repository: { full_name: name },
    });
    for (const name of ['acme/widgets', 'acme/secret', 'tools/cli', 'toolsmith/cli']) {
      await channel.handleWebhook(signed('issue_comment', elsewhere(name)));
    }
    await settle();
    expect(received.map((m) => m.text)).toEqual(['from acme/widgets', 'from tools/cli']);
  });

  it('says how to set the login when the token cannot read its user', async () => {
    const api = github([
      (call) =>
        call.path === '/user'
          ? Response.json({ message: 'Resource not accessible by integration' }, { status: 403 })
          : undefined,
    ]);
    const { channel } = created(api);
    const logged = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    await expect(channel.start()).rejects.toThrow(/set `login`/);
    const response = await channel.handleWebhook(signed('issue_comment', issueComment('@mybot')));
    expect(response.status).toBe(503);
    expect(logged).toHaveBeenCalledOnce();
  });
});

describe('GitHubChannel sending', () => {
  it('comments on the issue, or replies in the review thread of a topic', async () => {
    const api = github();
    const { channel } = await started(api);
    expect(await channel.sendText('acme/widgets#12', 'On the PR', { replyTo: 'comment:501' })).toBe(
      'comment:1001'
    );
    expect(await channel.sendText('acme/widgets#12', 'In the thread', { topicId: '900' })).toBe(
      'review_comment:1002'
    );
    expect(
      await channel.sendText('acme/widgets#12', 'Reply to it', { replyTo: 'review_comment:901' })
    ).toBe('review_comment:1003');
    const posts = api.calls.filter((c) => c.method === 'POST');
    expect(posts.map((c) => [c.path, c.body?.body])).toEqual([
      ['/repos/acme/widgets/issues/12/comments', 'On the PR'],
      ['/repos/acme/widgets/pulls/12/comments/900/replies', 'In the thread'],
      ['/repos/acme/widgets/pulls/12/comments/901/replies', 'Reply to it'],
    ]);
    expect(posts[0].authorization).toBe('Bearer ghp_token');
    await expect(channel.sendText('acme/widgets', 'x')).rejects.toThrow(/owner\/repo#number/);
    await expect(channel.sendText('acme/widgets#1', 'x', { topicId: 'abc' })).rejects.toThrow(
      /Unknown topic/
    );
    await expect(channel.sendText('acme/widgets#1', '  ')).rejects.toThrow(/Nothing to send/);
  });

  it('splits text longer than a comment holds into several comments', async () => {
    const api = github();
    const { channel } = await started(api);
    const paragraph = `${'word '.repeat(2000).trim()}\n\n`;
    const text = paragraph.repeat(Math.ceil((GITHUB_COMMENT_LIMIT * 1.5) / paragraph.length));
    const first = await channel.sendText('acme/widgets#7', text);
    const bodies = api.calls.filter((c) => c.method === 'POST').map((c) => String(c.body?.body));
    expect(first).toBe('comment:1001');
    expect(bodies).toHaveLength(2);
    expect(bodies.every((body) => body.length <= GITHUB_COMMENT_LIMIT)).toBe(true);
    expect(bodies.join('').replace(/\s/g, '')).toBe(text.replace(/\s/g, ''));
    expect(channel.maxMessageChars).toBe(GITHUB_COMMENT_LIMIT);
  });

  it('edits and deletes its comments and review comments, but nothing else', async () => {
    const api = github();
    const { channel } = await started(api, { stream: true });
    expect(channel.editable).toBe(true);
    await channel.editText('acme/widgets#12', 'comment:1001', 'better');
    await channel.editText('acme/widgets#12', 'review_comment:1002', 'in thread');
    await channel.deleteMessage('acme/widgets#12', 'comment:1001');
    expect(api.calls.map((c) => [c.method, c.path, c.body?.body ?? null])).toEqual([
      ['GET', '/user', null],
      ['PATCH', '/repos/acme/widgets/issues/comments/1001', 'better'],
      ['PATCH', '/repos/acme/widgets/pulls/comments/1002', 'in thread'],
      ['DELETE', '/repos/acme/widgets/issues/comments/1001', null],
    ]);
    await expect(channel.editText('acme/widgets#12', 'issue:12', 'x')).rejects.toThrow(
      /Only comments can be edited/
    );
    await expect(channel.editText('acme/widgets#12', 'post:1', 'x')).rejects.toThrow(
      /Unknown message id/
    );
    await expect(
      channel.editText('acme/widgets#12', 'comment:1', 'x'.repeat(GITHUB_COMMENT_LIMIT + 1))
    ).rejects.toThrow(/at most/);
    expect(created(github()).channel.editable).toBe(false);
  });

  it('links files with a public url and refuses uploads', async () => {
    const api = github();
    const { channel } = await started(api);
    await channel.sendFile('acme/widgets#7', {
      type: 'image',
      url: 'https://example.com/chart.png',
      mimeType: 'image/png',
      filename: 'chart.png',
      caption: 'The latency chart',
    });
    expect(api.calls.at(-1)?.body?.body).toBe(
      'The latency chart\n\n![chart.png](<https://example.com/chart.png>)'
    );
    await expect(
      channel.sendFile('acme/widgets#7', {
        type: 'file',
        buffer: new Uint8Array([1]),
        mimeType: 'text/plain',
      })
    ).rejects.toThrow(/no API to upload files/);
  });

  it('reacts with the reactions GitHub has, replacing its earlier one', async () => {
    const api = github();
    const { channel } = await started(api);
    await channel.setReaction('acme/widgets#7', 'issue:7', '\u{1F440}');
    await channel.setReaction('acme/widgets#7', 'issue:7', '\u{1F914}');
    await channel.setReaction('acme/widgets#7', 'issue:7', '\u{1F971}');
    await channel.setReaction('acme/widgets#7', 'issue:7', '\u{1F44D}');
    await channel.setReaction('acme/widgets#12', 'review_comment:900', 'rocket');
    await channel.setReaction('acme/widgets#12', 'review:77', '\u{1F44D}');
    expect(api.calls.slice(1).map((c) => [c.method, c.path, c.body?.content ?? null])).toEqual([
      ['POST', '/repos/acme/widgets/issues/7/reactions', 'eyes'],
      ['POST', '/repos/acme/widgets/issues/7/reactions', '+1'],
      ['DELETE', '/repos/acme/widgets/issues/7/reactions/1001', null],
      ['POST', '/repos/acme/widgets/pulls/comments/900/reactions', 'rocket'],
    ]);
    await channel.sendTyping();
  });
});

describe('GitHubClient errors', () => {
  async function failure(response: Response | Error): Promise<FeedError> {
    const client = new GitHubClient({
      token: async () => 'fresh-token',
      apiUrl: 'https://ghe.example.com/api/v3/',
      fetch: (async () => {
        if (response instanceof Error) throw response;
        return response;
      }) as unknown as typeof fetch,
    });
    const error = await client.request('GET', '/repos/a/b').catch((caught: unknown) => caught);
    if (!(error instanceof FeedError)) throw new Error('Expected a FeedError');
    return error;
  }

  it('maps rate limits with when to try again', async () => {
    const now = Date.now();
    const primary = await failure(
      Response.json(
        { message: 'API rate limit exceeded' },
        {
          status: 403,
          headers: {
            'x-ratelimit-remaining': '0',
            'x-ratelimit-reset': String(Math.floor(now / 1000) + 120),
          },
        }
      )
    );
    expect(primary).toMatchObject({ code: 'rate_limited', status: 403, retryable: true });
    expect(primary.retryAfter).toBeGreaterThan(100_000);
    expect(primary.retryAfter).toBeLessThanOrEqual(120_000);

    const secondary = await failure(
      Response.json(
        { message: 'You have exceeded a secondary rate limit' },
        { status: 429, headers: { 'retry-after': '30' } }
      )
    );
    expect(secondary).toMatchObject({ code: 'rate_limited', retryAfter: 30_000 });

    const unnamed = await failure(
      Response.json({ message: 'You have exceeded a secondary rate limit' }, { status: 403 })
    );
    expect(unnamed).toMatchObject({ code: 'rate_limited', retryAfter: 60_000 });
  });

  it('maps auth, missing, invalid and failing requests', async () => {
    expect(
      await failure(Response.json({ message: 'Bad credentials' }, { status: 401 }))
    ).toMatchObject({
      code: 'auth',
      retryable: false,
    });
    expect(
      await failure(Response.json({ message: 'Must have admin rights' }, { status: 403 }))
    ).toMatchObject({ code: 'auth' });
    expect(await failure(Response.json({ message: 'Not Found' }, { status: 404 }))).toMatchObject({
      code: 'not_found',
    });
    expect(await failure(Response.json({ message: 'Gone' }, { status: 410 }))).toMatchObject({
      code: 'not_found',
    });
    const invalid = await failure(
      Response.json(
        {
          message: 'Validation Failed',
          errors: [{ resource: 'IssueComment', code: 'custom', message: 'body is too long' }],
        },
        { status: 422 }
      )
    );
    expect(invalid).toMatchObject({ code: 'invalid_post', feed: 'github' });
    expect(invalid.message).toBe(
      '[github] GET /repos/a/b failed: Validation Failed (body is too long)'
    );
    expect(await failure(new Response('<html>oops</html>', { status: 502 }))).toMatchObject({
      code: 'unavailable',
      retryable: true,
    });
    expect(await failure(new TypeError('fetch failed'))).toMatchObject({ code: 'unavailable' });
  });

  it('calls the API root it is given with a token from the provider', async () => {
    const seen: Array<[string, string | null]> = [];
    const client = new GitHubClient({
      token: () => 'ghs_installation',
      apiUrl: 'https://ghe.example.com/api/v3/',
      fetch: (async (input: string, init?: RequestInit) => {
        seen.push([input, new Headers(init?.headers).get('authorization')]);
        return new Response(null, { status: 204 });
      }) as unknown as typeof fetch,
    });
    expect(await client.request('DELETE', '/repos/a/b/issues/comments/1')).toBeUndefined();
    expect(seen).toEqual([
      ['https://ghe.example.com/api/v3/repos/a/b/issues/comments/1', 'Bearer ghs_installation'],
    ]);
  });
});
