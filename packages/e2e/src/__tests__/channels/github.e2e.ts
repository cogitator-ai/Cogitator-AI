import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { createHmac } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { Agent, Cogitator } from '@cogitator-ai/core';
import { Gateway, githubChannel, type GitHubChannel } from '@cogitator-ai/channels';
import { MockLLMBackend } from '@cogitator-ai/test-utils';
import { getTestModel, ollamaSkipReason } from '../../helpers/setup';

/**
 * The GitHub channel in a real Gateway with a Cogitator agent: signed webhook
 * deliveries go to the channel's own webhook server, and its answers go to a
 * GitHub REST API played by a local server, which records what the bot posts.
 */
const SECRET = 'e2e-webhook-secret';
const BOT = 'cogi-bot';

interface Posted {
  method: string;
  path: string;
  body: Record<string, unknown>;
}

class FakeGitHub {
  readonly posted: Posted[] = [];
  private server?: Server;
  private nextId = 5000;

  async start(): Promise<string> {
    this.server = createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on('data', (chunk: Buffer) => chunks.push(chunk));
      req.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf-8');
        const body = text ? (JSON.parse(text) as Record<string, unknown>) : {};
        const path = req.url ?? '/';
        const method = req.method ?? 'GET';
        const json = (status: number, value: unknown) =>
          res.writeHead(status, { 'content-type': 'application/json' }).end(JSON.stringify(value));
        if (req.headers.authorization !== 'Bearer ghp_e2e') {
          json(401, { message: 'Bad credentials' });
          return;
        }
        if (method === 'GET' && path === '/user') {
          json(200, { login: BOT, id: 1, type: 'User' });
          return;
        }
        this.posted.push({ method, path, body });
        if (method === 'POST') json(201, { id: ++this.nextId });
        else if (method === 'PATCH') json(200, { id: Number(path.split('/').pop()) });
        else res.writeHead(204).end();
      });
    });
    await new Promise<void>((resolve) => this.server!.listen(0, '127.0.0.1', resolve));
    return `http://127.0.0.1:${(this.server!.address() as AddressInfo).port}`;
  }

  comments(): Posted[] {
    return this.posted.filter(
      (call) => call.method === 'POST' && !call.path.endsWith('/reactions')
    );
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

let delivery = 0;

async function deliver(port: number, event: string, payload: unknown): Promise<Response> {
  const body = JSON.stringify(payload);
  return fetch(`http://127.0.0.1:${port}/github/webhook`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-github-event': event,
      'x-github-delivery': `e2e-${++delivery}`,
      'x-hub-signature-256': `sha256=${createHmac('sha256', SECRET).update(body).digest('hex')}`,
    },
    body,
  });
}

async function waitFor(check: () => boolean, timeoutMs = 60_000): Promise<void> {
  const started = Date.now();
  while (!check()) {
    if (Date.now() - started > timeoutMs) throw new Error('Timed out waiting for the bot');
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

const repository = { full_name: 'acme/widgets' };
const octocat = { login: 'octocat', id: 583231, type: 'User' };

const issueComment = (number: number, id: number, body: string, sender = octocat) => ({
  action: 'created',
  issue: { number, title: 'Cache misses on cold start', body: null },
  comment: { id, body },
  repository,
  sender,
});

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
  describe.skipIf(target.skip)(`GitHub channel through a Gateway (${target.label})`, () => {
    const scripted = target.model.startsWith('mock/');
    const github = new FakeGitHub();
    let apiUrl: string;
    let backend: MockLLMBackend;
    let cogitator: Cogitator;
    let gateway: Gateway | undefined;
    let port: number;

    beforeAll(async () => {
      apiUrl = await github.start();
      backend = new MockLLMBackend();
      cogitator = new Cogitator({
        llm: { ...(scripted && { backends: { mock: backend } }), retry: false },
        memory: { adapter: 'memory' },
      });
    });

    afterEach(async () => {
      await gateway?.stop();
      gateway = undefined;
      github.posted.length = 0;
    });

    afterAll(async () => {
      await cogitator.close();
      await github.stop();
    });

    async function serve(options: { stream?: boolean } = {}): Promise<GitHubChannel> {
      port = await freePort();
      const channel = githubChannel({
        token: async () => 'ghp_e2e',
        apiUrl,
        webhook: { secret: SECRET, port },
        ...(options.stream && { stream: true }),
      });
      const agent = new Agent({
        name: 'github-e2e',
        model: target.model,
        instructions: 'You help maintainers on GitHub. Answer in one short sentence.',
      });
      const memory = await cogitator.getMemory();
      gateway = new Gateway({
        agent,
        cogitator,
        channels: [channel],
        ...(memory && { memory }),
        reactions: { enabled: true, debounceMs: 0 },
        ...(options.stream && { stream: { flushInterval: 50, minChunkSize: 1 } }),
      });
      await gateway.start();
      return channel;
    }

    it('answers a mention in an issue comment with a comment on the issue', async () => {
      backend.setResponse({ content: 'Warm the cache in the start hook.' });
      await serve();
      const answered = await deliver(port, 'issue_comment', {
        ...issueComment(42, 900, `@${BOT} why do we miss the cache on a cold start?`),
      });
      expect(answered.status).toBe(200);
      await waitFor(() => github.comments().length === 1);
      const [reply] = github.comments();
      expect(reply.path).toBe('/repos/acme/widgets/issues/42/comments');
      expect(String(reply.body.body).trim().length).toBeGreaterThan(0);
      if (scripted) {
        expect(reply.body.body).toBe('Warm the cache in the start hook.');
        const prompt = JSON.stringify(backend.getLastCall()?.messages);
        expect(prompt).toContain('why do we miss the cache on a cold start?');
        expect(prompt).not.toContain(`@${BOT}`);
      }
      await waitFor(() =>
        github.posted.some(
          (call) => call.path === '/repos/acme/widgets/issues/comments/900/reactions'
        )
      );
    });

    it('stays quiet without a mention and for its own comments', async () => {
      backend.setResponse({ content: 'Should not be sent.' });
      await serve();
      await deliver(port, 'issue_comment', issueComment(42, 901, 'Just a note for the team.'));
      await deliver(
        port,
        'issue_comment',
        issueComment(42, 902, `@${BOT} talking to myself`, { login: BOT, id: 1, type: 'User' })
      );
      await deliver(port, 'issues', {
        action: 'edited',
        issue: { number: 42, title: `@${BOT} edited`, body: null },
        repository,
        sender: octocat,
      });
      await new Promise((resolve) => setTimeout(resolve, 500));
      expect(github.comments()).toEqual([]);
    });

    it('answers a review comment in its review thread', async () => {
      backend.setResponse({ content: 'A map keeps the lookups constant time.' });
      await serve();
      await deliver(port, 'pull_request_review_comment', {
        action: 'created',
        pull_request: { number: 77, title: 'Add a lookup map', body: 'Faster lookups' },
        comment: { id: 3100, in_reply_to_id: 3000, body: `@${BOT} why a map here?` },
        repository,
        sender: octocat,
      });
      await waitFor(() => github.comments().length === 1);
      expect(github.comments()[0].path).toBe('/repos/acme/widgets/pulls/77/comments/3000/replies');
    });

    it.skipIf(!scripted)('streams into a comment it edits when streaming is on', async () => {
      backend.setStreamChunks([
        { content: 'Bump the ' },
        { content: 'timeout ', delay: 120 },
        { content: 'to 30 seconds.', delay: 120 },
      ]);
      await serve({ stream: true });
      await deliver(port, 'issues', {
        action: 'opened',
        issue: { number: 43, title: 'Flaky deploys', body: `@${BOT} what should we change?` },
        repository,
        sender: octocat,
      });
      await waitFor(() =>
        github.posted.some((call) => call.body.body === 'Bump the timeout to 30 seconds.')
      );
      const comments = github.comments();
      expect(comments).toHaveLength(1);
      expect(comments[0].path).toBe('/repos/acme/widgets/issues/43/comments');
      const edits = github.posted.filter((call) => call.method === 'PATCH');
      expect(edits.length).toBeGreaterThan(0);
      expect(edits.at(-1)?.path).toMatch(/^\/repos\/acme\/widgets\/issues\/comments\/\d+$/);
    });
  });
}
