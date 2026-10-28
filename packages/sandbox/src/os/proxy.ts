import { lookup } from 'node:dns/promises';
import { createServer, connect, isIPv6, type Server, type Socket } from 'node:net';
import type { SandboxHostDecider, SandboxViolation } from '@cogitator-ai/types';
import {
  canonicalAddress,
  carriedIPv4,
  isAddress,
  localAddressClass,
  ownAddresses,
} from './addresses';
import { firstMatch, normalizeHost, type DomainPattern } from './domains';

/** The lists a proxy checks each host against */
export interface ProxyRules {
  allowed: readonly DomainPattern[];
  denied: readonly DomainPattern[];
  /** Refuse a host no list allows instead of asking the decider */
  strict: boolean;
}

export interface ProxySessionOptions {
  /** The command the connections belong to, for the decider and the violations */
  command: string;
  rules: ProxyRules;
  /**
   * The hosts this command alone lists: when given, a host neither these nor the rules allow is
   * refused without the decider asked
   */
  commandAllowed?: readonly DomainPattern[];
  /** Decides a host no list decides; without one such a host is refused */
  decide?: SandboxHostDecider;
  /** Listen on an ephemeral loopback TCP port, or on a Unix socket at `path` */
  listen: { tcp: true } | { path: string };
  /** Milliseconds a connection to the destination may take (default: 30000) */
  connectTimeout?: number;
}

const MAX_HEAD_BYTES = 64 * 1024;
const DEFAULT_CONNECT_TIMEOUT = 30_000;
const MAX_VIOLATIONS = 200;

type Authorization =
  { ok: true; addresses: string[] } | { ok: false; reason: string; policy: boolean };

/**
 * A proxy for the connections of one sandboxed command, HTTP (`CONNECT`, and plain requests in
 * absolute form) and SOCKS5 on the same listener: the first byte tells them apart. Each host is
 * checked against the lists (a deny wins, then an allow, then the command's own list, then the
 * decider), a host name is resolved once and refused when it leads only to this machine
 * (loopback, link-local, an address of its own interfaces, a cloud metadata endpoint) unless it
 * is `localhost` or the address is allowed by itself, and the address that passed is the one
 * dialed. Refusals are kept as violations of the command
 */
export class ProxySession {
  readonly violations: SandboxViolation[] = [];
  private readonly sockets = new Set<Socket>();
  private readonly decided = new Map<string, Promise<boolean>>();
  private readonly seenViolations = new Set<string>();
  private closed = false;

  private constructor(
    private readonly server: Server,
    private readonly options: ProxySessionOptions
  ) {}

  static async start(options: ProxySessionOptions): Promise<ProxySession> {
    const server = createServer({ pauseOnConnect: false });
    const session = new ProxySession(server, options);
    server.on('connection', (socket) => session.accept(socket));
    await new Promise<void>((resolveListen, reject) => {
      server.once('error', reject);
      const ready = () => {
        server.off('error', reject);
        resolveListen();
      };
      if ('path' in options.listen) server.listen(options.listen.path, ready);
      else server.listen(0, '127.0.0.1', ready);
    });
    return session;
  }

  /** The Unix socket it listens on */
  get socketPath(): string | undefined {
    return 'path' in this.options.listen ? this.options.listen.path : undefined;
  }

  /** The loopback TCP port it listens on */
  get port(): number | undefined {
    const address = this.server.address();
    return typeof address === 'object' && address ? address.port : undefined;
  }

  /** Stops listening and closes every connection it carries */
  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    for (const socket of this.sockets) socket.destroy();
    this.sockets.clear();
    await new Promise<void>((done) => this.server.close(() => done()));
  }

  private track(socket: Socket): void {
    this.sockets.add(socket);
    socket.on('close', () => this.sockets.delete(socket));
    socket.on('error', () => socket.destroy());
  }

  private accept(client: Socket): void {
    if (this.closed) {
      client.destroy();
      return;
    }
    this.track(client);
    client.once('data', (first: Buffer) => {
      client.pause();
      if (first[0] === 0x05) void this.socks(client, first).catch(() => client.destroy());
      else void this.http(client, first).catch(() => client.destroy());
    });
  }

  private record(host: string, port: number, reason: string): void {
    const target = `${isIPv6(host) ? `[${host}]` : host}:${port}`;
    const key = `${target}\u0000${reason}`;
    if (this.seenViolations.has(key) || this.violations.length >= MAX_VIOLATIONS) return;
    this.seenViolations.add(key);
    this.violations.push({ kind: 'network', operation: 'network-outbound', target, reason });
  }

  /** Whether the lists or the decider let `host` through on `port`, and the address to dial */
  private async authorize(rawHost: string, port: number): Promise<Authorization> {
    const host = normalizeHost(rawHost);
    if (host === '' || /[\s/\\@]/.test(host) || !(port >= 1 && port <= 65535)) {
      return { ok: false, reason: 'not a host and port', policy: true };
    }
    const { rules } = this.options;
    const carriedHost = carriedIPv4(host);
    const denied =
      firstMatch(rules.denied, host, port) ??
      (carriedHost === undefined ? undefined : firstMatch(rules.denied, carriedHost, port));
    if (denied) {
      return {
        ok: false,
        reason: `denied by the deniedDomains entry ${denied.entry}`,
        policy: true,
      };
    }
    const listed =
      firstMatch(rules.allowed, host, port) ??
      (this.options.commandAllowed
        ? firstMatch(this.options.commandAllowed, host, port)
        : undefined);
    if (!listed) {
      const refusal = await this.decideUnlisted(host, port);
      if (refusal) return { ok: false, reason: refusal, policy: true };
    }
    if (isAddress(host)) return { ok: true, addresses: [host] };

    let addresses: Array<{ address: string }>;
    try {
      addresses = await lookup(host, { all: true, verbatim: true });
    } catch {
      return { ok: false, reason: `${host} could not be resolved`, policy: false };
    }
    const own = ownAddresses();
    const localName = host === 'localhost' || host.endsWith('.localhost');
    let refusedAs: string | undefined;
    const passed: string[] = [];
    for (const { address } of addresses) {
      const canonical = canonicalAddress(address) ?? address;
      const carried = carriedIPv4(canonical);
      if (
        firstMatch(rules.denied, canonical, port) ||
        (carried !== undefined && firstMatch(rules.denied, carried, port))
      ) {
        refusedAs ??= 'a deny-listed';
        continue;
      }
      const local = localAddressClass(canonical, own);
      const literallyAllowed = rules.allowed.some(
        (pattern) =>
          pattern.kind === 'address' &&
          pattern.host === canonical &&
          (pattern.port === undefined || pattern.port === port)
      );
      if (localName) {
        if (local === 'loopback' || literallyAllowed) passed.push(canonical);
        else refusedAs ??= 'a non-loopback';
        continue;
      }
      if (local && !literallyAllowed) {
        refusedAs ??= local === "this host's" ? "this host's" : `a ${local}`;
        continue;
      }
      passed.push(canonical);
    }
    if (passed.length > 0) return { ok: true, addresses: [...new Set(passed)] };
    return {
      ok: false,
      reason: `resolved to ${refusedAs ?? 'no'} address`,
      policy: refusedAs !== undefined,
    };
  }

  /** Why a host no list allows is refused, undefined when the decider lets it through */
  private async decideUnlisted(host: string, port: number): Promise<string | undefined> {
    if (this.options.commandAllowed) {
      return 'not on the allow list or the hosts the command listed';
    }
    if (this.options.rules.strict) return 'not on the allow list';
    const decide = this.options.decide;
    if (!decide) return 'not on the allow list, and nothing decides other hosts';
    const key = `${host}:${port}`;
    let pending = this.decided.get(key);
    if (!pending) {
      pending = decide({ host, port, command: this.options.command }).then(
        (allowed) => allowed === true,
        () => false
      );
      this.decided.set(key, pending);
    }
    return (await pending)
      ? undefined
      : 'not on the allow list, and the permission check refused it';
  }

  /** Connects to the first of `addresses` (each one checked already) that answers */
  private async dial(addresses: readonly string[], port: number): Promise<Socket> {
    let failure: unknown;
    for (const address of addresses) {
      try {
        return await this.dialOne(address, port);
      } catch (error) {
        failure = error;
      }
    }
    throw failure instanceof Error ? failure : new Error('no address answered');
  }

  /**
   * Connects to `address`, the socket tracked from the start so a session closed while it
   * connects destroys it, and refused once the session is closed (a decision that came after)
   */
  private dialOne(address: string, port: number): Promise<Socket> {
    if (this.closed) return Promise.reject(new Error('The proxy session is closed'));
    return new Promise((resolveDial, reject) => {
      const upstream = connect({ host: address, port });
      this.track(upstream);
      const fail = (error: Error) => {
        clearTimeout(timeout);
        upstream.destroy();
        reject(error);
      };
      const timeout = setTimeout(
        () => fail(new Error('connect timed out')),
        this.options.connectTimeout ?? DEFAULT_CONNECT_TIMEOUT
      );
      const onError = (error: Error) => fail(error);
      const onClose = () => fail(new Error('The connection closed before it was made'));
      upstream.once('error', onError);
      upstream.once('close', onClose);
      upstream.once('connect', () => {
        clearTimeout(timeout);
        upstream.off('error', onError);
        upstream.off('close', onClose);
        if (this.closed) {
          fail(new Error('The proxy session is closed'));
          return;
        }
        resolveDial(upstream);
      });
    });
  }

  private splice(client: Socket, upstream: Socket, rest: Buffer): void {
    if (rest.length > 0) upstream.write(rest);
    client.pipe(upstream);
    upstream.pipe(client);
    client.on('close', () => upstream.destroy());
    upstream.on('close', () => client.destroy());
    client.resume();
  }

  private async http(client: Socket, first: Buffer): Promise<void> {
    const head = await readHead(client, first);
    if (!head) {
      refuseHttp(client, 400, 'Bad Request', 'The request head could not be read');
      return;
    }
    const [requestLine, ...headerLines] = head.text.split('\r\n');
    const [method, target, version] = requestLine.split(' ');
    if (!method || !target || !version?.startsWith('HTTP/')) {
      refuseHttp(client, 400, 'Bad Request', 'The request line could not be read');
      return;
    }
    if (method.toUpperCase() === 'CONNECT') {
      const parsed = hostPort(target);
      if (!parsed) {
        refuseHttp(client, 400, 'Bad Request', `${target} is not a host and port`);
        return;
      }
      const decision = await this.authorize(parsed.host, parsed.port);
      if (!decision.ok) {
        if (decision.policy) this.record(normalizeHost(parsed.host), parsed.port, decision.reason);
        refuseHttp(
          client,
          decision.policy ? 403 : 502,
          decision.policy ? 'Forbidden' : 'Bad Gateway',
          decision.reason
        );
        return;
      }
      let upstream: Socket;
      try {
        upstream = await this.dial(decision.addresses, parsed.port);
      } catch (error) {
        refuseHttp(client, 502, 'Bad Gateway', errorText(error));
        return;
      }
      client.write('HTTP/1.1 200 Connection Established\r\n\r\n');
      this.splice(client, upstream, head.rest);
      return;
    }
    let url: URL;
    try {
      url = new URL(target);
    } catch {
      refuseHttp(client, 400, 'Bad Request', 'A proxy request names an absolute http:// URL');
      return;
    }
    if (url.protocol !== 'http:') {
      refuseHttp(client, 400, 'Bad Request', `Use CONNECT for ${url.protocol} URLs`);
      return;
    }
    const port = url.port === '' ? 80 : Number(url.port);
    const decision = await this.authorize(url.hostname, port);
    if (!decision.ok) {
      if (decision.policy) this.record(normalizeHost(url.hostname), port, decision.reason);
      refuseHttp(
        client,
        decision.policy ? 403 : 502,
        decision.policy ? 'Forbidden' : 'Bad Gateway',
        decision.reason
      );
      return;
    }
    let upstream: Socket;
    try {
      upstream = await this.dial(decision.addresses, port);
    } catch (error) {
      refuseHttp(client, 502, 'Bad Gateway', errorText(error));
      return;
    }
    const headers = headerLines.filter((line) => {
      const name = line.slice(0, line.indexOf(':')).trim().toLowerCase();
      return (
        name !== '' &&
        !['proxy-connection', 'proxy-authorization', 'connection', 'keep-alive'].includes(name)
      );
    });
    const origin = `${method} ${url.pathname}${url.search} ${version}`;
    upstream.write(`${[origin, ...headers, 'Connection: close'].join('\r\n')}\r\n\r\n`);
    this.splice(client, upstream, head.rest);
  }

  private async socks(client: Socket, first: Buffer): Promise<void> {
    const reader = new ByteReader(client, first);
    const [, methodCount] = await reader.read(2);
    const methods = await reader.read(methodCount);
    if (!methods.includes(0x00)) {
      client.end(Buffer.from([0x05, 0xff]));
      return;
    }
    client.write(Buffer.from([0x05, 0x00]));
    const [version, command, , addressType] = await reader.read(4);
    if (version !== 0x05) {
      client.destroy();
      return;
    }
    let host: string;
    if (addressType === 0x01) {
      host = [...(await reader.read(4))].join('.');
    } else if (addressType === 0x03) {
      const [length] = await reader.read(1);
      host = (await reader.read(length)).toString('latin1');
    } else if (addressType === 0x04) {
      const bytes = await reader.read(16);
      const groups: string[] = [];
      for (let i = 0; i < 16; i += 2) groups.push(bytes.readUInt16BE(i).toString(16));
      host = groups.join(':');
    } else {
      socksReply(client, 0x08);
      return;
    }
    const port = (await reader.read(2)).readUInt16BE(0);
    if (command !== 0x01) {
      this.record(normalizeHost(host), port, 'only SOCKS CONNECT is carried (no UDP, no BIND)');
      socksReply(client, 0x07);
      return;
    }
    const decision = await this.authorize(host, port);
    if (!decision.ok) {
      if (decision.policy) this.record(normalizeHost(host), port, decision.reason);
      socksReply(client, decision.policy ? 0x02 : 0x04);
      return;
    }
    let upstream: Socket;
    try {
      upstream = await this.dial(decision.addresses, port);
    } catch {
      socksReply(client, 0x05);
      return;
    }
    client.write(Buffer.from([0x05, 0x00, 0x00, 0x01, 0, 0, 0, 0, 0, 0]));
    this.splice(client, upstream, reader.rest());
  }
}

/** Reads exact byte counts from a paused socket, the first chunk given */
class ByteReader {
  private buffer: Buffer;

  constructor(
    private readonly socket: Socket,
    first: Buffer
  ) {
    this.buffer = first;
  }

  async read(count: number): Promise<Buffer> {
    while (this.buffer.length < count) {
      const chunk = await nextChunk(this.socket);
      if (!chunk) throw new Error('The connection closed');
      this.buffer = Buffer.concat([this.buffer, chunk]);
    }
    const out = this.buffer.subarray(0, count);
    this.buffer = this.buffer.subarray(count);
    return out;
  }

  rest(): Buffer {
    return this.buffer;
  }
}

function nextChunk(socket: Socket): Promise<Buffer | undefined> {
  return new Promise((resolveChunk) => {
    const onData = (chunk: Buffer) => {
      cleanup();
      socket.pause();
      resolveChunk(chunk);
    };
    const onEnd = () => {
      cleanup();
      resolveChunk(undefined);
    };
    const cleanup = () => {
      socket.off('data', onData);
      socket.off('end', onEnd);
      socket.off('close', onEnd);
    };
    socket.on('data', onData);
    socket.once('end', onEnd);
    socket.once('close', onEnd);
    socket.resume();
  });
}

/** The head of an HTTP request (up to the blank line) and the bytes after it */
async function readHead(
  socket: Socket,
  first: Buffer
): Promise<{ text: string; rest: Buffer } | undefined> {
  let buffer = first;
  for (;;) {
    const end = buffer.indexOf('\r\n\r\n');
    if (end !== -1) {
      return { text: buffer.subarray(0, end).toString('latin1'), rest: buffer.subarray(end + 4) };
    }
    if (buffer.length > MAX_HEAD_BYTES) return undefined;
    const chunk = await nextChunk(socket);
    if (!chunk) return undefined;
    buffer = Buffer.concat([buffer, chunk]);
  }
}

/** `host:port` of a CONNECT target, an IPv6 host in brackets */
function hostPort(target: string): { host: string; port: number } | undefined {
  const match = /^(?:\[([^\]]+)\]|([^:[\]]+)):(\d{1,5})$/.exec(target);
  if (!match) return undefined;
  return { host: match[1] ?? match[2], port: Number(match[3]) };
}

function refuseHttp(client: Socket, status: number, phrase: string, reason: string): void {
  const body = `${reason}\n`;
  client.end(
    [
      `HTTP/1.1 ${status} ${phrase}`,
      'X-Proxy-Error: blocked-by-cogitator-sandbox',
      'Content-Type: text/plain; charset=utf-8',
      `Content-Length: ${Buffer.byteLength(body)}`,
      'Connection: close',
      '',
      body,
    ].join('\r\n')
  );
}

function socksReply(client: Socket, code: number): void {
  client.end(Buffer.from([0x05, code, 0x00, 0x01, 0, 0, 0, 0, 0, 0]));
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
