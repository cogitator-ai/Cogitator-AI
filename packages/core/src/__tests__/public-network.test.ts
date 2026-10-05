import http, { type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { gzipSync } from 'node:zlib';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createHttpRequestTool } from '../tools/http';
import { createTranscribeAudioTool } from '../tools/audio-transcribe';
import { createWebScrapeTool } from '../tools/web-scrape';
import { RobotsPolicy } from '../web/robots';
import {
  assertPublicHost,
  assertPublicUrl,
  DEFAULT_USER_AGENT,
  createGuardedLookup,
  createPublicFetch,
  fetchPublic,
  isPrivateAddress,
  PrivateNetworkError,
  type Resolver,
} from '../utils/public-network';

type Handler = (req: IncomingMessage, res: ServerResponse, body: string) => void;

async function listen(handler: Handler): Promise<{ server: http.Server; port: number }> {
  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => handler(req, res, Buffer.concat(chunks).toString()));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return { server, port: (server.address() as AddressInfo).port };
}

/** Resolves every name to the loopback test server, as a public name pointed inward would. */
const toLoopback: Resolver = (_hostname, callback) => {
  callback(null, [{ address: '127.0.0.1', family: 4 }]);
};

/** Treats the test server's loopback address as public and everything else private as private. */
const loopbackIsPublic = (address: string) => address !== '127.0.0.1' && isPrivateAddress(address);

const ctx = { agentId: 'a', runId: 'r', signal: new AbortController().signal };

describe('isPrivateAddress', () => {
  it.each([
    '127.0.0.1',
    '10.1.2.3',
    '172.20.0.1',
    '192.168.1.1',
    '169.254.169.254',
    '100.64.0.1',
    '0.0.0.0',
    '::1',
    '[::1]',
    'fe80::1',
    'fc00::1',
    '::ffff:127.0.0.1',
    '::ffff:7f00:1',
    '64:ff9b::a9fe:a9fe',
    '192.0.2.10',
    '203.0.113.7',
    '2001:db8::1',
  ])('counts %s as private', (address) => {
    expect(isPrivateAddress(address)).toBe(true);
  });

  it.each(['8.8.8.8', '1.1.1.1', '2606:4700::1111', 'example.com'])(
    'counts %s as public',
    (address) => {
      expect(isPrivateAddress(address)).toBe(false);
    }
  );
});

describe('assertPublicUrl', () => {
  it.each([
    'http://localhost:3000/admin',
    'http://api.localhost/',
    'http://LOCALHOST./',
    'http://[::1]/',
    'http://169.254.169.254/latest/meta-data/',
    'http://metadata.google.internal/computeMetadata/v1/',
    'http://10.0.0.5:8080/',
    'http://printer.local/',
    'http://db.internal:5432/',
  ])('refuses %s', (url) => {
    expect(() => assertPublicUrl(url)).toThrow(PrivateNetworkError);
  });

  it('refuses anything but http and https', () => {
    expect(() => assertPublicUrl('file:///etc/passwd')).toThrow(TypeError);
    expect(() => assertPublicUrl('gopher://example.com/')).toThrow(TypeError);
  });

  it('lets a public URL through', () => {
    expect(assertPublicUrl('https://example.com/page?q=1').href).toBe(
      'https://example.com/page?q=1'
    );
  });
});

describe('createGuardedLookup', () => {
  const lookupWith = (addresses: { address: string; family: number }[]) =>
    new Promise<{ error: Error | null; address: unknown }>((resolve) => {
      createGuardedLookup((_hostname, callback) => callback(null, addresses))(
        'example.com',
        {},
        (error, address) => resolve({ error, address })
      );
    });

  it('refuses a name with any private address among its public ones', async () => {
    const { error } = await lookupWith([
      { address: '93.184.215.14', family: 4 },
      { address: '10.0.0.1', family: 4 },
    ]);
    expect(error).toBeInstanceOf(PrivateNetworkError);
    expect(error?.message).toContain('10.0.0.1');
  });

  it('answers with the first address of a public name', async () => {
    const { error, address } = await lookupWith([{ address: '93.184.215.14', family: 4 }]);
    expect(error).toBeNull();
    expect(address).toBe('93.184.215.14');
  });
});

describe('assertPublicHost', () => {
  it('refuses a name that resolves to a private address before any request is made', async () => {
    await expect(assertPublicHost('http://public.test/', { resolver: toLoopback })).rejects.toThrow(
      PrivateNetworkError
    );
    await expect(assertPublicHost('http://10.0.0.1/')).rejects.toThrow(PrivateNetworkError);
  });

  it('lets a name with only public addresses through', async () => {
    const resolver: Resolver = (_hostname, callback) =>
      callback(null, [{ address: '93.184.215.14', family: 4 }]);
    expect((await assertPublicHost('https://example.com/a', { resolver })).href).toBe(
      'https://example.com/a'
    );
  });
});

describe('createPublicFetch', () => {
  let main: { server: http.Server; port: number };
  let other: { server: http.Server; port: number };
  const seen: { path: string; method: string; authorization?: string; body: string }[] = [];

  beforeAll(async () => {
    other = await listen((req, res) => {
      seen.push({
        path: `other${req.url}`,
        method: req.method ?? '',
        authorization: req.headers.authorization,
        body: '',
      });
      res.end('other');
    });
    main = await listen((req, res, body) => {
      seen.push({
        path: req.url ?? '',
        method: req.method ?? '',
        authorization: req.headers.authorization,
        body,
      });
      switch (req.url) {
        case '/echo':
          res.setHeader('content-type', 'application/json');
          res.end(JSON.stringify({ method: req.method, body, header: req.headers['x-test'] }));
          return;
        case '/headers':
          res.setHeader('content-type', 'application/json');
          res.end(
            JSON.stringify({ userAgent: req.headers['user-agent'], accept: req.headers.accept })
          );
          return;
        case '/gzip':
          res.setHeader('content-encoding', 'gzip');
          res.end(gzipSync('unzipped'));
          return;
        case '/see-other':
          res.writeHead(303, { location: '/echo' }).end();
          return;
        case '/to-metadata':
          res.writeHead(302, { location: 'http://169.254.169.254/latest/meta-data/' }).end();
          return;
        case '/to-localhost':
          res.writeHead(302, { location: `http://localhost:${main.port}/echo` }).end();
          return;
        case '/to-other':
          res.writeHead(307, { location: `http://public.test:${other.port}/landing` }).end();
          return;
        case '/empty':
          res.writeHead(204).end();
          return;
        case '/slow':
          setTimeout(() => res.end('late'), 2000);
          return;
        default:
          res.end('ok');
      }
    });
  });

  afterAll(() => {
    main.server.close();
    other.server.close();
  });

  it('refuses a private address written in the URL', async () => {
    await expect(fetchPublic(`http://127.0.0.1:${main.port}/echo`)).rejects.toThrow(
      PrivateNetworkError
    );
  });

  it('refuses a public-looking name that resolves to a private address when it connects', async () => {
    const guarded = createPublicFetch({ resolver: toLoopback });
    await expect(guarded(`http://public.test:${main.port}/echo`)).rejects.toThrow(
      /resolves to the private address 127\.0\.0\.1/
    );
  });

  it('refuses a redirect into the private network instead of following it', async () => {
    const guarded = createPublicFetch({ resolver: toLoopback, isBlocked: loopbackIsPublic });
    await expect(guarded(`http://public.test:${main.port}/to-metadata`)).rejects.toThrow(
      PrivateNetworkError
    );
    await expect(guarded(`http://public.test:${main.port}/to-localhost`)).rejects.toThrow(
      PrivateNetworkError
    );
  });

  it('sends the method, headers and body and reads the answer', async () => {
    const guarded = createPublicFetch({ resolver: toLoopback, isBlocked: loopbackIsPublic });
    const response = await guarded(`http://public.test:${main.port}/echo`, {
      method: 'POST',
      headers: { 'x-test': 'yes' },
      body: 'hello',
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ method: 'POST', body: 'hello', header: 'yes' });
  });

  it('sends a User-Agent and Accept unless the caller sets its own', async () => {
    const open = createPublicFetch({ allowPrivateNetwork: true });
    expect(await (await open(`http://127.0.0.1:${main.port}/headers`)).json()).toEqual({
      userAgent: DEFAULT_USER_AGENT,
      accept: '*/*',
    });
    const custom = await open(`http://127.0.0.1:${main.port}/headers`, {
      headers: { 'User-Agent': 'MyAgent/2.0', Accept: 'application/json' },
    });
    expect(await custom.json()).toEqual({ userAgent: 'MyAgent/2.0', accept: 'application/json' });
  });

  it('decompresses gzip and turns a 303 into a GET', async () => {
    const open = createPublicFetch({ allowPrivateNetwork: true });
    expect(await (await open(`http://127.0.0.1:${main.port}/gzip`)).text()).toBe('unzipped');
    const response = await open(`http://127.0.0.1:${main.port}/see-other`, {
      method: 'POST',
      body: 'form',
    });
    expect(await response.json()).toEqual({ method: 'GET', body: '' });
  });

  it('hands back a redirect as it is with redirect: manual', async () => {
    const open = createPublicFetch({ allowPrivateNetwork: true });
    const response = await open(`http://127.0.0.1:${main.port}/to-metadata`, {
      redirect: 'manual',
    });
    expect(response.status).toBe(302);
    expect(response.headers.get('location')).toBe('http://169.254.169.254/latest/meta-data/');
  });

  it('drops the credentials when a redirect leaves the origin', async () => {
    const guarded = createPublicFetch({ resolver: toLoopback, isBlocked: loopbackIsPublic });
    seen.length = 0;
    const response = await guarded(`http://public.test:${main.port}/to-other`, {
      headers: { authorization: 'Bearer secret' },
    });
    expect(await response.text()).toBe('other');
    expect(seen.map((entry) => [entry.path, entry.authorization])).toEqual([
      ['/to-other', 'Bearer secret'],
      ['other/landing', undefined],
    ]);
  });

  it('answers HEAD and 204 without a body', async () => {
    const open = createPublicFetch({ allowPrivateNetwork: true });
    expect((await open(`http://127.0.0.1:${main.port}/empty`)).status).toBe(204);
    const head = await open(`http://127.0.0.1:${main.port}/echo`, { method: 'HEAD' });
    expect(head.body).toBeNull();
  });

  it('stops a request when its signal aborts', async () => {
    const open = createPublicFetch({ allowPrivateNetwork: true });
    await expect(
      open(`http://127.0.0.1:${main.port}/slow`, { signal: AbortSignal.timeout(50) })
    ).rejects.toMatchObject({ name: expect.stringMatching(/AbortError|TimeoutError/) as unknown });
  });
});

describe('the network tools', () => {
  let site: { server: http.Server; port: number };
  const hits: string[] = [];

  beforeAll(async () => {
    site = await listen((req, res) => {
      hits.push(req.url ?? '');
      if (req.url === '/audio.mp3') {
        res.setHeader('content-type', 'audio/mpeg');
        res.end('fake audio');
        return;
      }
      res.setHeader('content-type', 'text/html');
      res.end('<html><head><title>Admin</title></head><body><p>Internal</p></body></html>');
    });
  });

  afterAll(() => {
    site.server.close();
  });

  it('web_scrape refuses a private host unless allowed', async () => {
    const url = `http://127.0.0.1:${site.port}/`;
    const refused = await createWebScrapeTool().execute({ url }, ctx);
    expect(refused).toMatchObject({
      error: expect.stringContaining('Refused to reach') as unknown,
    });

    const allowed = await createWebScrapeTool({ allowPrivateNetwork: true }).execute({ url }, ctx);
    expect(allowed).toMatchObject({
      title: 'Admin',
      content: expect.stringContaining('Internal') as unknown,
    });
  });

  it('web_scrape checks a private host before its robots.txt is read', async () => {
    const robots = { allows: vi.fn(() => Promise.resolve(true)) };
    for (const url of [`http://127.0.0.1:${site.port}/`, `http://localhost:${site.port}/`]) {
      const refused = await createWebScrapeTool({ robots }).execute({ url }, ctx);
      expect(refused).toMatchObject({
        error: expect.stringContaining('Refused to reach') as unknown,
      });
    }
    expect(robots.allows).not.toHaveBeenCalled();
  });

  it('a robots policy reading through fetchPublic stays off private hosts', async () => {
    hits.length = 0;
    const policy = new RobotsPolicy({ userAgent: 'TestBot/1.0', fetch: fetchPublic });
    expect(await policy.allows(`http://127.0.0.1:${site.port}/page`)).toBe(false);
    expect(hits).toEqual([]);
  });

  it('http_request refuses a private host unless allowed', async () => {
    const url = `http://127.0.0.1:${site.port}/`;
    const refused = await createHttpRequestTool().execute({ url }, ctx);
    expect(refused).toMatchObject({
      error: expect.stringContaining('Refused to reach') as unknown,
    });

    const allowed = await createHttpRequestTool({ allowPrivateNetwork: true }).execute(
      { url },
      ctx
    );
    expect(allowed).toMatchObject({ status: 200 });
  });

  it('the transcription tool refuses an audio URL on a private host', async () => {
    const tool = createTranscribeAudioTool({ apiKey: 'test-key' });
    await expect(
      tool.execute({ audio: `http://127.0.0.1:${site.port}/audio.mp3` }, ctx)
    ).rejects.toThrow(PrivateNetworkError);
  });
});
