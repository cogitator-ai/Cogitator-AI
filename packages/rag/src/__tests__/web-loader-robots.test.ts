import http from 'node:http';
import type { AddressInfo } from 'node:net';
import type { RobotsChecker } from '@cogitator-ai/types';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { RobotsDisallowedError, WebLoader } from '../loaders/web-loader';

let server: http.Server;
let base: string;
const requested: string[] = [];

beforeAll(async () => {
  server = http.createServer((req, res) => {
    requested.push(req.url ?? '');
    if (req.url === '/open') {
      res.writeHead(200, { 'content-type': 'text/plain' }).end('open page');
    } else if (req.url === '/to-private') {
      res.writeHead(302, { location: '/private/page' }).end();
    } else {
      res.writeHead(200, { 'content-type': 'text/plain' }).end('private page');
    }
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

const noPrivate: RobotsChecker = {
  allows: (url) => Promise.resolve(!new URL(url).pathname.startsWith('/private')),
};

describe('WebLoader with a robots checker', () => {
  const loader = new WebLoader({ allowPrivateNetwork: true, robots: noPrivate });

  it('loads a page the site allows', async () => {
    const [doc] = await loader.load(`${base}/open`);
    expect(doc?.content).toBe('open page');
  });

  it('refuses a disallowed page without requesting it', async () => {
    requested.length = 0;
    await expect(loader.load(`${base}/private/page`)).rejects.toBeInstanceOf(RobotsDisallowedError);
    expect(requested).toEqual([]);
  });

  it('refuses a redirect into a disallowed page', async () => {
    requested.length = 0;
    await expect(loader.load(`${base}/to-private`)).rejects.toThrow(
      /robots\.txt does not allow fetching .*\/private\/page/
    );
    expect(requested).toEqual(['/to-private']);
  });
});
