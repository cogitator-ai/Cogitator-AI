import { createServer as createHttpServer, type Server as HttpServer } from 'node:http';
import { connect, createServer, type Server, type Socket } from 'node:net';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { parseDomainList } from '../os/domains';
import { ProxySession, type ProxyRules } from '../os/proxy';

vi.mock('node:dns/promises', async (original) => {
  const actual = await original<typeof import('node:dns/promises')>();
  return {
    ...actual,
    lookup: async (host: string, options: object) => {
      if (host === 'sneaky.test') return [{ address: '127.0.0.1', family: 4 }];
      if (host === 'metadata.test') return [{ address: '169.254.169.254', family: 4 }];
      return actual.lookup(host, options as { all: true });
    },
  };
});

function rules(allowed: string[], denied: string[] = [], strict = false): ProxyRules {
  return {
    allowed: parseDomainList(allowed, 'allow').patterns,
    denied: parseDomainList(denied, 'deny').patterns,
    strict,
  };
}

/** Sends `request` to the proxy and reads until the connection closes or `until` matches */
function exchange(port: number, request: Buffer | string, until?: RegExp): Promise<string> {
  return new Promise((resolveExchange, reject) => {
    const socket = connect({ host: '127.0.0.1', port });
    let text = '';
    socket.on('data', (chunk) => {
      text += chunk.toString('latin1');
      if (until?.test(text)) {
        socket.destroy();
        resolveExchange(text);
      }
    });
    socket.on('close', () => resolveExchange(text));
    socket.on('error', reject);
    socket.write(request);
  });
}

describe('ProxySession', () => {
  let upstream: HttpServer;
  let upstreamPort: number;
  let echo: Server;
  let echoPort: number;
  let sessions: ProxySession[];

  beforeEach(async () => {
    sessions = [];
    upstream = createHttpServer((req, res) => {
      res.setHeader('connection', 'close');
      res.end(`upstream saw ${req.method} ${req.url} host=${req.headers.host}`);
    });
    await new Promise<void>((done) => upstream.listen(0, '127.0.0.1', done));
    upstreamPort = (upstream.address() as { port: number }).port;
    echo = createServer((socket: Socket) => socket.pipe(socket));
    await new Promise<void>((done) => echo.listen(0, '127.0.0.1', done));
    echoPort = (echo.address() as { port: number }).port;
  });

  afterEach(async () => {
    await Promise.all(sessions.map((session) => session.close()));
    await new Promise<void>((done) => upstream.close(() => done()));
    await new Promise<void>((done) => echo.close(() => done()));
  });

  async function start(options: Partial<Parameters<typeof ProxySession.start>[0]> = {}) {
    const session = await ProxySession.start({
      command: 'curl x',
      rules: rules([`127.0.0.1:${upstreamPort}`, `127.0.0.1:${echoPort}`]),
      listen: { tcp: true },
      ...options,
    });
    sessions.push(session);
    return session;
  }

  it('forwards a plain HTTP request in absolute form to an allowed host', async () => {
    const session = await start();
    const reply = await exchange(
      session.port!,
      `GET http://127.0.0.1:${upstreamPort}/path?q=1 HTTP/1.1\r\nHost: 127.0.0.1:${upstreamPort}\r\nProxy-Connection: keep-alive\r\n\r\n`
    );
    expect(reply).toMatch(/^HTTP\/1\.1 200/);
    expect(reply).toContain('upstream saw GET /path?q=1');
    expect(session.violations).toEqual([]);
  });

  it('tunnels a CONNECT to an allowed host', async () => {
    const session = await start();
    const reply = await exchange(
      session.port!,
      `CONNECT 127.0.0.1:${echoPort} HTTP/1.1\r\nHost: 127.0.0.1:${echoPort}\r\n\r\nping`,
      /ping$/
    );
    expect(reply).toBe('HTTP/1.1 200 Connection Established\r\n\r\nping');
  });

  it('refuses a host no list allows, with a 403 and a violation', async () => {
    const session = await start();
    const reply = await exchange(session.port!, 'CONNECT example.com:443 HTTP/1.1\r\n\r\n');
    expect(reply).toMatch(/^HTTP\/1\.1 403 Forbidden/);
    expect(reply).toContain('X-Proxy-Error: blocked-by-cogitator-sandbox');
    expect(session.violations).toEqual([
      {
        kind: 'network',
        operation: 'network-outbound',
        target: 'example.com:443',
        reason: 'not on the allow list, and nothing decides other hosts',
      },
    ]);
  });

  it('lets a deny win over an allow', async () => {
    const session = await start({
      rules: rules(['*'], [`127.0.0.1:${upstreamPort}`]),
    });
    const reply = await exchange(
      session.port!,
      `GET http://127.0.0.1:${upstreamPort}/ HTTP/1.1\r\nHost: x\r\n\r\n`
    );
    expect(reply).toMatch(/^HTTP\/1\.1 403/);
    expect(session.violations[0].reason).toContain('deniedDomains');
  });

  it('asks the decider about other hosts once per host and port, and follows it', async () => {
    const decide = vi.fn(async ({ port }: { port: number }) => port === echoPort);
    const session = await start({ rules: rules([]), decide });
    const allowed = await exchange(
      session.port!,
      `CONNECT 127.0.0.1:${echoPort} HTTP/1.1\r\n\r\nhi`,
      /hi$/
    );
    expect(allowed).toContain('200 Connection Established');
    await exchange(session.port!, `CONNECT 127.0.0.1:${echoPort} HTTP/1.1\r\n\r\nhi`, /hi$/);
    const refused = await exchange(
      session.port!,
      `CONNECT 127.0.0.1:${upstreamPort} HTTP/1.1\r\n\r\n`
    );
    expect(refused).toMatch(/403/);
    expect(decide).toHaveBeenCalledTimes(2);
    expect(decide).toHaveBeenCalledWith({ host: '127.0.0.1', port: echoPort, command: 'curl x' });
  });

  it('refuses without asking under a strict allowlist or a command list', async () => {
    const decide = vi.fn(async () => true);
    const strict = await start({ rules: rules([], [], true), decide });
    expect(await exchange(strict.port!, 'CONNECT example.com:443 HTTP/1.1\r\n\r\n')).toMatch(/403/);
    const listed = await start({
      rules: rules([]),
      decide,
      commandAllowed: parseDomainList([`127.0.0.1:${echoPort}`], 'allow').patterns,
    });
    expect(
      await exchange(listed.port!, `CONNECT 127.0.0.1:${echoPort} HTTP/1.1\r\n\r\nok`, /ok$/)
    ).toContain('200');
    expect(await exchange(listed.port!, 'CONNECT example.com:443 HTTP/1.1\r\n\r\n')).toMatch(/403/);
    expect(listed.violations[0].reason).toBe(
      'not on the allow list or the hosts the command listed'
    );
    expect(decide).not.toHaveBeenCalled();
  });

  it('refuses an allowed name that resolves only to this machine, but not localhost', async () => {
    const session = await start({
      rules: rules(['sneaky.test', 'metadata.test', 'localhost']),
    });
    expect(await exchange(session.port!, 'CONNECT sneaky.test:443 HTTP/1.1\r\n\r\n')).toMatch(
      /403/
    );
    expect(await exchange(session.port!, 'CONNECT metadata.test:80 HTTP/1.1\r\n\r\n')).toMatch(
      /403/
    );
    expect(session.violations.map((violation) => violation.reason)).toEqual([
      'resolved to a loopback address',
      'resolved to a link-local address',
    ]);
    const local = await exchange(
      session.port!,
      `CONNECT localhost:${echoPort} HTTP/1.1\r\n\r\nyo`,
      /yo$/
    );
    expect(local).toContain('200');
  });

  it('lets a name resolve to a local address that is allowed by itself', async () => {
    const session = await start({ rules: rules(['sneaky.test', `127.0.0.1:${echoPort}`]) });
    expect(
      await exchange(session.port!, `CONNECT sneaky.test:${echoPort} HTTP/1.1\r\n\r\nok`, /ok$/)
    ).toContain('200');
  });

  it('carries SOCKS5 CONNECT by domain and refuses what the lists refuse', async () => {
    const session = await start();
    const socks = (host: string, port: number) => {
      const name = Buffer.from(host);
      const portBytes = Buffer.alloc(2);
      portBytes.writeUInt16BE(port);
      return Buffer.concat([
        Buffer.from([0x05, 0x01, 0x00]),
        Buffer.from([0x05, 0x01, 0x00, 0x03, name.length]),
        name,
        portBytes,
        Buffer.from('data'),
      ]);
    };
    const ok = await exchange(session.port!, socks('127.0.0.1', echoPort), /data$/);
    expect([...Buffer.from(ok, 'latin1').subarray(0, 4)]).toEqual([0x05, 0x00, 0x05, 0x00]);
    const refused = await exchange(session.port!, socks('example.com', 443));
    expect([...Buffer.from(refused, 'latin1').subarray(0, 4)]).toEqual([0x05, 0x00, 0x05, 0x02]);
    expect(session.violations.at(-1)?.target).toBe('example.com:443');
  });

  it('refuses SOCKS UDP and BIND as violations', async () => {
    const session = await start();
    const reply = await exchange(
      session.port!,
      Buffer.from([0x05, 0x01, 0x00, 0x05, 0x03, 0x00, 0x01, 127, 0, 0, 1, 0, 53])
    );
    expect([...Buffer.from(reply, 'latin1').subarray(2, 4)]).toEqual([0x05, 0x07]);
    expect(session.violations[0].reason).toContain('only SOCKS CONNECT');
  });

  it('listens on a unix socket and closes every connection with the session', async () => {
    const { mkdtemp, rm } = await import('node:fs/promises');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');
    const dir = await mkdtemp(join(tmpdir(), 'proxy-sock-'));
    const session = await ProxySession.start({
      command: 'x',
      rules: rules([`127.0.0.1:${echoPort}`]),
      listen: { path: join(dir, 'p.sock') },
    });
    expect(session.socketPath).toBe(join(dir, 'p.sock'));
    const socket = connect({ path: join(dir, 'p.sock') });
    await new Promise<void>((done) => socket.once('connect', () => done()));
    const closed = new Promise<void>((done) => socket.once('close', () => done()));
    socket.resume();
    socket.write(`CONNECT 127.0.0.1:${echoPort} HTTP/1.1\r\n\r\n`);
    await new Promise((done) => setTimeout(done, 50));
    await session.close();
    await closed;
    await rm(dir, { recursive: true, force: true });
  });
});
