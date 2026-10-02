import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { gzipSync } from 'node:zlib';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { WebLoader, isBlockedAddress, createGuardedLookup } from '../loaders/web-loader';

type Handler = (req: http.IncomingMessage, res: http.ServerResponse) => void;

const routes = new Map<string, Handler>();
let server: http.Server;
let base: string;
const received: http.IncomingHttpHeaders[] = [];

beforeAll(async () => {
  server = http.createServer((req, res) => {
    received.push(req.headers);
    const handler = routes.get(req.url ?? '/');
    if (!handler) {
      res.writeHead(404, 'Not Found').end();
      return;
    }
    handler(req, res);
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

  routes.set('/page', (_req, res) => {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end(
      '<html><head><title>Web Page</title><style>.x{color:red}</style></head>' +
        '<body><nav>Menu</nav><article><h1>Heading</h1><p>First paragraph.</p><p>Second</p>' +
        '<script>window.secret = 1</script></article></body></html>'
    );
  });
  routes.set('/redirect', (_req, res) => {
    res.writeHead(302, { location: '/page' }).end();
  });
  routes.set('/loop', (_req, res) => {
    res.writeHead(301, { location: '/loop' }).end();
  });
  routes.set('/plain', (_req, res) => {
    res.writeHead(200, { 'content-type': 'text/plain' });
    res.end('  raw <b>text</b> body  ');
  });
  routes.set('/json', (_req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end('{"a":1}');
  });
  routes.set('/image', (_req, res) => {
    res.writeHead(200, { 'content-type': 'image/png' });
    res.end(Buffer.from([0x89, 0x50]));
  });
  routes.set('/gzip', (_req, res) => {
    res.writeHead(200, { 'content-type': 'text/html', 'content-encoding': 'gzip' });
    res.end(gzipSync('<html><body><p>Compressed body</p></body></html>'));
  });
  routes.set('/latin1', (_req, res) => {
    res.writeHead(200, { 'content-type': 'text/plain; charset=iso-8859-1' });
    res.end(Buffer.from([0x63, 0x61, 0x66, 0xe9]));
  });
  routes.set('/big', (_req, res) => {
    res.writeHead(200, { 'content-type': 'text/plain' });
    res.end('x'.repeat(10_000));
  });
  routes.set('/slow', (_req, res) => {
    setTimeout(() => res.writeHead(200, { 'content-type': 'text/plain' }).end('late'), 500);
  });
});

afterAll(async () => {
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

describe('WebLoader (local server, allowPrivateNetwork)', () => {
  const loader = () => new WebLoader({ allowPrivateNetwork: true });

  it('extracts readable text without scripts/styles and keeps block boundaries', async () => {
    const [doc] = await loader().load(`${base}/page`);
    expect(doc!.sourceType).toBe('web');
    expect(doc!.source).toBe(`${base}/page`);
    expect(doc!.metadata).toMatchObject({
      title: 'Web Page',
      url: `${base}/page`,
      contentType: 'text/html',
    });
    expect(doc!.content).toBe('Menu\n\nHeading\n\nFirst paragraph.\n\nSecond');
    expect(doc!.content).not.toContain('secret');
    expect(doc!.content).not.toContain('color');
  });

  it('applies a custom selector', async () => {
    const [doc] = await new WebLoader({ allowPrivateNetwork: true, selector: 'article' }).load(
      `${base}/page`
    );
    expect(doc!.content).toBe('Heading\n\nFirst paragraph.\n\nSecond');
  });

  it('sends custom headers', async () => {
    received.length = 0;
    await new WebLoader({
      allowPrivateNetwork: true,
      headers: { Authorization: 'Bearer token123' },
    }).load(`${base}/page`);
    expect(received[0]!.authorization).toBe('Bearer token123');
  });

  it('follows redirects and records the final URL', async () => {
    const [doc] = await loader().load(`${base}/redirect`);
    expect(doc!.source).toBe(`${base}/redirect`);
    expect(doc!.metadata?.url).toBe(`${base}/page`);
  });

  it('stops after too many redirects', async () => {
    await expect(loader().load(`${base}/loop`)).rejects.toThrow('too many redirects');
  });

  it('throws with the status code on HTTP errors', async () => {
    await expect(loader().load(`${base}/missing`)).rejects.toThrow('404');
  });

  it('keeps text/plain and JSON responses as raw text', async () => {
    const [plain] = await loader().load(`${base}/plain`);
    expect(plain!.content).toBe('  raw <b>text</b> body  ');
    expect(plain!.metadata?.contentType).toBe('text/plain');

    const [json] = await loader().load(`${base}/json`);
    expect(json!.content).toBe('{"a":1}');
  });

  it('rejects unsupported binary content types', async () => {
    await expect(loader().load(`${base}/image`)).rejects.toThrow('unsupported content type');
  });

  it('decompresses gzip responses', async () => {
    const [doc] = await loader().load(`${base}/gzip`);
    expect(doc!.content).toBe('Compressed body');
  });

  it('decodes the declared charset', async () => {
    const [doc] = await loader().load(`${base}/latin1`);
    expect(doc!.content).toBe('café');
  });

  it('enforces the response size limit', async () => {
    await expect(
      new WebLoader({ allowPrivateNetwork: true, maxResponseBytes: 1000 }).load(`${base}/big`)
    ).rejects.toThrow('exceeds 1000 bytes limit');
  });

  it('times out slow responses', async () => {
    await expect(
      new WebLoader({ allowPrivateNetwork: true, timeoutMs: 100 }).load(`${base}/slow`)
    ).rejects.toThrow('timed out after 100ms');
  });
});

describe('WebLoader SSRF protection (default)', () => {
  it.each([
    'http://127.0.0.1/',
    'http://localhost/',
    'http://foo.localhost/',
    'http://[::1]/',
    'http://[::ffff:127.0.0.1]/',
    'http://0x7f000001/',
    'http://2130706433/',
    'http://10.1.2.3/',
    'http://169.254.169.254/latest/meta-data',
    'http://100.64.0.1/',
    'http://[fd00::1]/',
    'http://metadata.google.internal/',
  ])('blocks %s', async (url) => {
    await expect(new WebLoader().load(url)).rejects.toThrow(/blocked/);
  });

  it('blocks the local test server unless allowPrivateNetwork is set', async () => {
    await expect(new WebLoader().load(`${base}/page`)).rejects.toThrow(/blocked/);
  });

  it('rejects non-http protocols', async () => {
    await expect(new WebLoader().load('file:///etc/passwd')).rejects.toThrow(
      'unsupported protocol'
    );
    await expect(new WebLoader().load('not a url')).rejects.toThrow('invalid URL');
  });
});

describe('isBlockedAddress', () => {
  it.each([
    ['127.0.0.1', true],
    ['127.255.0.9', true],
    ['0.0.0.0', true],
    ['10.0.0.1', true],
    ['172.16.0.1', true],
    ['172.31.255.255', true],
    ['172.32.0.1', false],
    ['192.168.1.1', true],
    ['100.64.0.1', true],
    ['169.254.169.254', true],
    ['224.0.0.1', true],
    ['8.8.8.8', false],
    ['93.184.216.34', false],
    ['::1', true],
    ['::', true],
    ['fe80::1', true],
    ['fd12:3456::1', true],
    ['::ffff:127.0.0.1', true],
    ['::ffff:7f00:1', true],
    ['64:ff9b::a00:1', true],
    ['::ffff:8.8.8.8', false],
    ['2606:4700:4700::1111', false],
    ['[::1]', true],
    ['example.com', false],
  ])('%s -> %s', (address, expected) => {
    expect(isBlockedAddress(address)).toBe(expected);
  });
});

describe('createGuardedLookup', () => {
  function run(
    addresses: Array<{ address: string; family: number }>,
    options: { all?: boolean; family?: number } = {}
  ) {
    const lookup = createGuardedLookup((_host, cb) => cb(null, addresses));
    return new Promise<{ err: Error | null; address: unknown; family?: number }>((resolve) => {
      lookup('host.test', options, (err, address, family) => resolve({ err, address, family }));
    });
  }

  it('rejects hostnames resolving to any private address (DNS rebinding safe)', async () => {
    const { err } = await run([
      { address: '93.184.216.34', family: 4 },
      { address: '10.0.0.5', family: 4 },
    ]);
    expect(err?.message).toContain('resolves to private IP 10.0.0.5');
  });

  it('returns public addresses in single and all modes', async () => {
    const single = await run([{ address: '93.184.216.34', family: 4 }]);
    expect(single).toEqual({ err: null, address: '93.184.216.34', family: 4 });

    const all = await run(
      [
        { address: '93.184.216.34', family: 4 },
        { address: '2606:2800:220:1::1', family: 6 },
      ],
      { all: true }
    );
    expect(all.err).toBeNull();
    expect(all.address).toHaveLength(2);
  });

  it('honours the requested address family', async () => {
    const v6 = await run(
      [
        { address: '93.184.216.34', family: 4 },
        { address: '2606:2800:220:1::1', family: 6 },
      ],
      { family: 6 }
    );
    expect(v6.address).toBe('2606:2800:220:1::1');
  });

  it('propagates resolver errors', async () => {
    const lookup = createGuardedLookup((_host, cb) =>
      cb(Object.assign(new Error('ENOTFOUND'), { code: 'ENOTFOUND' }), [])
    );
    const err = await new Promise<Error | null>((resolve) =>
      lookup('nope.test', {}, (e) => resolve(e))
    );
    expect(err?.message).toBe('ENOTFOUND');
  });
});
