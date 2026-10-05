import { lookup as dnsLookup, type LookupAddress, type LookupOptions } from 'node:dns';
import http, { type IncomingMessage } from 'node:http';
import https from 'node:https';
import { BlockList, isIP } from 'node:net';
import { Readable } from 'node:stream';
import { createBrotliDecompress, createGunzip, createInflate } from 'node:zlib';

/** The User-Agent requests carry unless the caller sets one. */
export const DEFAULT_USER_AGENT =
  'Mozilla/5.0 (compatible; CogitatorBot/1.0; +https://github.com/cogitator-ai/Cogitator-AI)';

/** What a tool fetches with: the global `fetch` or anything shaped like it. */
export type FetchFunction = (input: string | URL, init?: RequestInit) => Promise<Response>;

/** A request was refused because it would reach a loopback, private or link-local address. */
export class PrivateNetworkError extends Error {
  constructor(
    readonly target: string,
    reason: string
  ) {
    super(`Refused to reach ${target}: ${reason}`);
    this.name = 'PrivateNetworkError';
  }
}

const BLOCKED_HOSTNAMES = new Set(['localhost', 'metadata', 'metadata.google.internal']);
/** Names for the local machine, the local network (mDNS) and a cloud's internal network. */
const PRIVATE_SUFFIXES = ['.localhost', '.local', '.internal'];

const PRIVATE_RANGES = new BlockList();
for (const [network, prefix] of [
  ['0.0.0.0', 8],
  ['10.0.0.0', 8],
  ['100.64.0.0', 10],
  ['127.0.0.0', 8],
  ['169.254.0.0', 16],
  ['172.16.0.0', 12],
  ['192.0.0.0', 24],
  ['192.0.2.0', 24],
  ['192.168.0.0', 16],
  ['198.18.0.0', 15],
  ['198.51.100.0', 24],
  ['203.0.113.0', 24],
  ['224.0.0.0', 4],
  ['240.0.0.0', 4],
] as const) {
  PRIVATE_RANGES.addSubnet(network, prefix, 'ipv4');
}
for (const [network, prefix] of [
  ['::', 128],
  ['::1', 128],
  ['fc00::', 7],
  ['fe80::', 10],
  ['ff00::', 8],
  ['2001:db8::', 32],
] as const) {
  PRIVATE_RANGES.addSubnet(network, prefix, 'ipv6');
}

function embeddedIPv4(ipv6: string): string | null {
  const lower = ipv6.toLowerCase();
  for (const prefix of ['::ffff:', '64:ff9b::', '::']) {
    if (!lower.startsWith(prefix)) continue;
    const rest = lower.slice(prefix.length);
    if (isIP(rest) === 4) return rest;
    const hex = /^([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(rest);
    if (hex) {
      const high = parseInt(hex[1], 16);
      const low = parseInt(hex[2], 16);
      return [high >> 8, high & 0xff, low >> 8, low & 0xff].join('.');
    }
  }
  return null;
}

/**
 * Whether an IP address is loopback, private, link-local, carrier-grade NAT, multicast,
 * documentation or otherwise not on the public internet, IPv4 inside IPv6 (`::ffff:`, NAT64)
 * included.
 * A string that is not an IP address is not private.
 */
export function isPrivateAddress(address: string): boolean {
  const ip = address.replace(/^\[|\]$/g, '');
  const family = isIP(ip);
  if (family === 4) return PRIVATE_RANGES.check(ip, 'ipv4');
  if (family === 6) {
    const v4 = embeddedIPv4(ip);
    return v4 ? PRIVATE_RANGES.check(v4, 'ipv4') : PRIVATE_RANGES.check(ip, 'ipv6');
  }
  return false;
}

function parseHttpUrl(input: string | URL): URL {
  let url: URL;
  try {
    url = new URL(input);
  } catch {
    throw new TypeError(`Invalid URL: ${String(input)}`);
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new TypeError(`Only http and https URLs can be fetched, not ${url.protocol}`);
  }
  return url;
}

/**
 * The URL, when it is http or https and names a public host. A hostname is checked again by
 * the address it resolves to when the request connects, see {@link createGuardedLookup}.
 */
export function assertPublicUrl(input: string | URL): URL {
  const url = parseHttpUrl(input);
  const hostname = url.hostname
    .toLowerCase()
    .replace(/^\[|\]$/g, '')
    .replace(/\.$/, '');
  if (BLOCKED_HOSTNAMES.has(hostname) || PRIVATE_SUFFIXES.some((end) => hostname.endsWith(end))) {
    throw new PrivateNetworkError(url.href, `"${hostname}" is a local, internal or metadata host`);
  }
  if (isIP(hostname) && isPrivateAddress(hostname)) {
    throw new PrivateNetworkError(url.href, `${hostname} is a private address`);
  }
  return url;
}

type LookupCallback = (
  err: NodeJS.ErrnoException | null,
  address: string | LookupAddress[],
  family?: number
) => void;

/** Resolves a hostname to every address it has, as `dns.lookup` with `all` does. */
export type Resolver = (
  hostname: string,
  callback: (err: NodeJS.ErrnoException | null, addresses: LookupAddress[]) => void
) => void;

const systemResolver: Resolver = (hostname, callback) => {
  dnsLookup(hostname, { all: true, verbatim: true }, callback);
};

/**
 * A DNS lookup for `http.request` that refuses a host with any private address. It runs when
 * the request connects, so a name that resolved to a public address when it was checked and
 * to a private one a moment later (DNS rebinding) is still refused.
 */
export function createGuardedLookup(
  resolver: Resolver = systemResolver,
  isBlocked: (address: string) => boolean = isPrivateAddress
) {
  return (hostname: string, options: LookupOptions, callback: LookupCallback): void => {
    resolver(hostname, (err, addresses) => {
      if (err) {
        callback(err, []);
        return;
      }
      const candidates = addresses.filter(
        (entry) => !options.family || entry.family === options.family
      );
      const blocked = candidates.find((entry) => isBlocked(entry.address));
      if (blocked) {
        callback(
          new PrivateNetworkError(
            hostname,
            `it resolves to the private address ${blocked.address}`
          ),
          []
        );
        return;
      }
      const first = candidates[0];
      if (!first) {
        callback(
          Object.assign(new Error(`No addresses found for ${hostname}`), { code: 'ENOTFOUND' }),
          []
        );
        return;
      }
      if (options.all) callback(null, candidates);
      else callback(null, first.address, first.family);
    });
  };
}

/**
 * The URL, when it is http or https and its host and every address the host resolves to are
 * public. For a check before other network I/O about the URL, such as reading its robots.txt:
 * a request made later is checked again when it connects.
 */
export async function assertPublicHost(
  input: string | URL,
  options: Pick<PublicFetchOptions, 'resolver' | 'isBlocked'> = {}
): Promise<URL> {
  const url = assertPublicUrl(input);
  const hostname = url.hostname.replace(/^\[|\]$/g, '');
  if (isIP(hostname)) return url;
  const lookup = createGuardedLookup(options.resolver, options.isBlocked ?? isPrivateAddress);
  await new Promise<void>((resolve, reject) => {
    lookup(hostname, { all: true }, (err) => {
      if (err) reject(err);
      else resolve();
    });
  });
  return url;
}

export interface PublicFetchOptions {
  /** Reach loopback and private hosts too, for a trusted intranet. Default: false */
  allowPrivateNetwork?: boolean;
  /** Redirects followed before giving up. Default: 5 */
  maxRedirects?: number;
  /** Resolves hostnames. Default: the system's DNS */
  resolver?: Resolver;
  /** Which resolved addresses to refuse. Default: {@link isPrivateAddress} */
  isBlocked?: (address: string) => boolean;
}

const REDIRECTS = new Set([301, 302, 303, 307, 308]);
const NULL_BODY = new Set([101, 204, 205, 304]);

async function bodyBytes(body: RequestInit['body']): Promise<Buffer | undefined> {
  if (body === undefined || body === null) return undefined;
  if (typeof body === 'string') return Buffer.from(body);
  if (body instanceof URLSearchParams) return Buffer.from(body.toString());
  if (body instanceof ArrayBuffer) return Buffer.from(body);
  if (ArrayBuffer.isView(body)) return Buffer.from(body.buffer, body.byteOffset, body.byteLength);
  if (body instanceof Blob) return Buffer.from(await body.arrayBuffer());
  throw new TypeError('This fetch sends a string, bytes, a Blob or URLSearchParams as the body');
}

function decoded(response: IncomingMessage): Readable {
  switch ((response.headers['content-encoding'] ?? '').toLowerCase().trim()) {
    case 'gzip':
    case 'x-gzip':
      return response.pipe(createGunzip());
    case 'deflate':
      return response.pipe(createInflate());
    case 'br':
      return response.pipe(createBrotliDecompress());
    default:
      return response;
  }
}

function responseHeaders(response: IncomingMessage): Headers {
  const headers = new Headers();
  const raw = response.rawHeaders;
  for (let i = 0; i + 1 < raw.length; i += 2) headers.append(raw[i], raw[i + 1]);
  return headers;
}

function send(
  url: URL,
  method: string,
  headers: Headers,
  body: Buffer | undefined,
  signal: AbortSignal | undefined,
  lookup: ReturnType<typeof createGuardedLookup> | undefined
): Promise<IncomingMessage> {
  const transport = url.protocol === 'https:' ? https : http;
  return new Promise((resolve, reject) => {
    const request = transport.request(url, {
      method,
      headers: {
        accept: '*/*',
        'accept-encoding': 'gzip, deflate, br',
        'user-agent': DEFAULT_USER_AGENT,
        ...Object.fromEntries(headers),
        ...(body && { 'content-length': String(body.length) }),
      },
      ...(signal && { signal }),
      ...(lookup && { lookup }),
    });
    request.once('response', resolve);
    request.once('error', reject);
    request.end(body);
  });
}

function toResponse(message: IncomingMessage, method: string, signal?: AbortSignal): Response {
  const status = message.statusCode ?? 0;
  const init = {
    status,
    statusText: message.statusMessage ?? '',
    headers: responseHeaders(message),
  };
  if (method === 'HEAD' || NULL_BODY.has(status)) {
    message.resume();
    return new Response(null, init);
  }
  const stream = decoded(message);
  signal?.addEventListener(
    'abort',
    () => stream.destroy(signal.reason instanceof Error ? signal.reason : undefined),
    { once: true }
  );
  return new Response(Readable.toWeb(stream) as ReadableStream<Uint8Array>, init);
}

/**
 * A `fetch` that reaches only the public internet: every URL, redirect targets included, must
 * be http or https on a public host, and every hostname is checked by the address it resolves
 * to when the request connects. Runs on `node:http`, in Node and in Bun alike, and takes the
 * `fetch` options tools use: method, headers, a string, bytes, Blob or URLSearchParams body,
 * `signal` and `redirect`. A refused address throws a {@link PrivateNetworkError}.
 */
export function createPublicFetch(options: PublicFetchOptions = {}): FetchFunction {
  const allowPrivate = options.allowPrivateNetwork ?? false;
  const maxRedirects = options.maxRedirects ?? 5;
  const lookup = allowPrivate
    ? undefined
    : createGuardedLookup(options.resolver, options.isBlocked ?? isPrivateAddress);
  const check = (target: string | URL) =>
    allowPrivate ? parseHttpUrl(target) : assertPublicUrl(target);

  return async (input, init = {}) => {
    let url = check(input);
    let method = (init.method ?? 'GET').toUpperCase();
    let body = await bodyBytes(init.body);
    const headers = new Headers(init.headers);
    const redirect = init.redirect ?? 'follow';
    const signal = init.signal ?? undefined;

    for (let hop = 0; ; hop++) {
      const message = await send(url, method, headers, body, signal, lookup);
      const status = message.statusCode ?? 0;
      const location = message.headers.location;
      if (redirect === 'manual' || !REDIRECTS.has(status) || !location) {
        return toResponse(message, method, signal);
      }
      message.resume();
      if (redirect === 'error')
        throw new TypeError(`Redirected to ${location} with redirect: "error"`);
      if (hop >= maxRedirects) throw new TypeError(`Too many redirects (max ${maxRedirects})`);

      const next = check(new URL(location, url));
      if (status === 303 || ((status === 301 || status === 302) && method === 'POST')) {
        method = method === 'HEAD' ? 'HEAD' : 'GET';
        body = undefined;
        headers.delete('content-type');
      }
      if (next.origin !== url.origin) {
        headers.delete('authorization');
        headers.delete('cookie');
      }
      url = next;
    }
  };
}

/** A {@link createPublicFetch} with the defaults: public hosts only, five redirects. */
export const fetchPublic: FetchFunction = createPublicFetch();
