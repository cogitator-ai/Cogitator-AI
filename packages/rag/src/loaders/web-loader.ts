import { lookup as dnsLookup, type LookupAddress, type LookupOptions } from 'node:dns';
import http, { type IncomingMessage } from 'node:http';
import https from 'node:https';
import { BlockList, isIP } from 'node:net';
import type { Readable } from 'node:stream';
import { createBrotliDecompress, createGunzip, createInflate } from 'node:zlib';
import type { DocumentLoader, RAGDocument, RobotsChecker } from '@cogitator-ai/types';
import { nanoid } from 'nanoid';
import { HTMLLoader } from './html-loader.js';

const MAX_REDIRECTS = 5;
const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_MAX_RESPONSE_BYTES = 50 * 1024 * 1024;

const BLOCKED_HOSTNAMES = new Set(['localhost', 'metadata.google.internal', 'metadata']);

const PRIVATE_RANGES = new BlockList();
for (const [network, prefix] of [
  ['0.0.0.0', 8],
  ['10.0.0.0', 8],
  ['100.64.0.0', 10],
  ['127.0.0.0', 8],
  ['169.254.0.0', 16],
  ['172.16.0.0', 12],
  ['192.0.0.0', 24],
  ['192.168.0.0', 16],
  ['198.18.0.0', 15],
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
] as const) {
  PRIVATE_RANGES.addSubnet(network, prefix, 'ipv6');
}

function embeddedIPv4(ipv6: string): string | null {
  const lower = ipv6.toLowerCase();
  const prefixes = ['::ffff:', '64:ff9b::', '::'];
  for (const prefix of prefixes) {
    if (!lower.startsWith(prefix)) continue;
    const rest = lower.slice(prefix.length);
    if (isIP(rest) === 4) return rest;
    const hex = /^([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(rest);
    if (hex) {
      const high = parseInt(hex[1]!, 16);
      const low = parseInt(hex[2]!, 16);
      return [high >> 8, high & 0xff, low >> 8, low & 0xff].join('.');
    }
  }
  return null;
}

/**
 * Whether an IP address points to a loopback, private, link-local, CGNAT, multicast or
 * otherwise non-public network (including IPv4-mapped / NAT64 IPv6 forms).
 */
export function isBlockedAddress(address: string): boolean {
  const ip = address.replace(/^\[|\]$/g, '');
  const family = isIP(ip);
  if (family === 4) return PRIVATE_RANGES.check(ip, 'ipv4');
  if (family === 6) {
    const v4 = embeddedIPv4(ip);
    if (v4) return PRIVATE_RANGES.check(v4, 'ipv4');
    return PRIVATE_RANGES.check(ip, 'ipv6');
  }
  return false;
}

type LookupCallback = (
  err: NodeJS.ErrnoException | null,
  address: string | LookupAddress[],
  family?: number
) => void;

type Resolver = (
  hostname: string,
  callback: (err: NodeJS.ErrnoException | null, addresses: LookupAddress[]) => void
) => void;

const systemResolver: Resolver = (hostname, callback) => {
  dnsLookup(hostname, { all: true, verbatim: true }, callback);
};

/**
 * DNS lookup for `http.request` that rejects private addresses at connect time,
 * which also defeats DNS-rebinding between validation and connection.
 */
export function createGuardedLookup(resolver: Resolver = systemResolver) {
  return (hostname: string, options: LookupOptions, callback: LookupCallback): void => {
    resolver(hostname, (err, addresses) => {
      if (err) {
        callback(err, []);
        return;
      }
      const candidates = addresses.filter(
        (entry) => !options.family || entry.family === options.family
      );
      const blocked = candidates.find((entry) => isBlockedAddress(entry.address));
      if (blocked) {
        callback(
          Object.assign(
            new Error(
              `WebLoader: "${hostname}" resolves to private IP ${blocked.address} — blocked`
            ),
            { code: 'EBLOCKED' }
          ),
          []
        );
        return;
      }
      if (candidates.length === 0) {
        callback(
          Object.assign(new Error(`WebLoader: no addresses found for "${hostname}"`), {
            code: 'ENOTFOUND',
          }),
          []
        );
        return;
      }
      if (options.all) {
        callback(null, candidates);
      } else {
        callback(null, candidates[0]!.address, candidates[0]!.family);
      }
    });
  };
}

function parseUrl(urlString: string, allowPrivateNetwork: boolean): URL {
  let url: URL;
  try {
    url = new URL(urlString);
  } catch {
    throw new Error(`WebLoader: invalid URL: ${urlString}`);
  }

  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error(
      `WebLoader: unsupported protocol "${url.protocol}" — only http and https are allowed`
    );
  }

  if (allowPrivateNetwork) return url;

  const hostname = url.hostname
    .toLowerCase()
    .replace(/^\[|\]$/g, '')
    .replace(/\.$/, '');
  if (BLOCKED_HOSTNAMES.has(hostname) || hostname.endsWith('.localhost')) {
    throw new Error(`WebLoader: access to "${hostname}" is blocked (loopback / metadata endpoint)`);
  }
  if (isIP(hostname) && isBlockedAddress(hostname)) {
    throw new Error(`WebLoader: access to private IP "${hostname}" is blocked`);
  }

  return url;
}

function decodeBody(body: Buffer, contentType: string): string {
  const charset = /charset\s*=\s*"?([\w.:-]+)"?/i.exec(contentType)?.[1];
  if (charset) {
    try {
      return new TextDecoder(charset).decode(body);
    } catch {
      return new TextDecoder('utf-8').decode(body);
    }
  }
  return new TextDecoder('utf-8').decode(body);
}

function decompress(response: IncomingMessage): Readable {
  const encoding = (response.headers['content-encoding'] ?? '').toLowerCase().trim();
  switch (encoding) {
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

export interface WebLoaderOptions {
  selector?: string;
  headers?: Record<string, string>;
  timeoutMs?: number;
  maxResponseBytes?: number;
  /**
   * Allow fetching loopback / private-network hosts (e.g. an intranet wiki).
   * Disabled by default to prevent SSRF when URLs come from untrusted input.
   */
  allowPrivateNetwork?: boolean;
  /**
   * Checks every URL against its site's robots.txt before fetching it, redirect targets
   * included, e.g. `new RobotsPolicy({ userAgent })` from `@cogitator-ai/core`. A URL the site
   * disallows fails the load with `RobotsDisallowedError`
   */
  robots?: RobotsChecker;
}

/** The site's robots.txt does not allow fetching this URL. */
export class RobotsDisallowedError extends Error {
  constructor(readonly url: string) {
    super(`WebLoader: robots.txt does not allow fetching ${url}`);
    this.name = 'RobotsDisallowedError';
  }
}

interface FetchedPage {
  url: string;
  contentType: string;
  body: string;
}

/**
 * Loads a web page over http(s). HTML is converted to text (scripts and styles removed);
 * plain-text and JSON responses are kept as-is. Redirects are followed (max 5) and every
 * hop — including DNS resolution at connect time — is checked against private networks.
 */
export class WebLoader implements DocumentLoader {
  readonly supportedTypes = ['http', 'https'];
  private readonly htmlLoader: HTMLLoader;
  private readonly headers?: Record<string, string>;
  private readonly timeoutMs: number;
  private readonly maxResponseBytes: number;
  private readonly allowPrivateNetwork: boolean;
  private readonly robots?: RobotsChecker;
  private readonly lookup = createGuardedLookup();

  constructor(options?: WebLoaderOptions) {
    this.htmlLoader = new HTMLLoader({ selector: options?.selector });
    this.headers = options?.headers;
    this.timeoutMs = options?.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.maxResponseBytes = options?.maxResponseBytes ?? DEFAULT_MAX_RESPONSE_BYTES;
    this.allowPrivateNetwork = options?.allowPrivateNetwork ?? false;
    this.robots = options?.robots;
  }

  async load(source: string): Promise<RAGDocument[]> {
    const page = await this.fetchPage(source);
    const mime = page.contentType.split(';')[0]!.trim().toLowerCase();

    if (mime === '' || mime.includes('html') || mime.endsWith('/xml') || mime.endsWith('+xml')) {
      const doc = await this.htmlLoader.parseHTML(page.body, source, 'web');
      return [
        { ...doc, metadata: { ...doc.metadata, url: page.url, contentType: mime || 'text/html' } },
      ];
    }

    if (mime.startsWith('text/') || mime === 'application/json' || mime.endsWith('+json')) {
      return [
        {
          id: nanoid(),
          content: page.body,
          source,
          sourceType: 'web',
          metadata: { url: page.url, contentType: mime },
        },
      ];
    }

    throw new Error(`WebLoader: unsupported content type "${mime}" from ${page.url}`);
  }

  private async fetchPage(source: string): Promise<FetchedPage> {
    let current = parseUrl(source, this.allowPrivateNetwork);

    for (let redirects = 0; redirects <= MAX_REDIRECTS; redirects++) {
      if (this.robots && !(await this.robots.allows(current.href))) {
        throw new RobotsDisallowedError(current.href);
      }
      const response = await this.request(current);
      const status = response.statusCode ?? 0;

      if (status >= 300 && status < 400) {
        response.resume();
        const location = response.headers.location;
        if (!location) {
          throw new Error(
            `WebLoader: redirect ${status} without Location header from ${current.href}`
          );
        }
        current = parseUrl(new URL(location, current).href, this.allowPrivateNetwork);
        continue;
      }

      if (status < 200 || status >= 300) {
        response.resume();
        throw new Error(
          `WebLoader: failed to fetch ${current.href}: ${status} ${response.statusMessage ?? ''}`.trim()
        );
      }

      const contentType = response.headers['content-type'] ?? '';
      const body = await this.readBody(response, current.href);
      return { url: current.href, contentType, body: decodeBody(body, contentType) };
    }

    throw new Error(`WebLoader: too many redirects (max ${MAX_REDIRECTS}) for ${source}`);
  }

  private request(url: URL): Promise<IncomingMessage> {
    const transport = url.protocol === 'https:' ? https : http;
    return new Promise<IncomingMessage>((resolve, reject) => {
      const req = transport.get(url, {
        headers: {
          'user-agent': 'cogitator-rag-webloader',
          accept: 'text/html,application/xhtml+xml,text/plain;q=0.9,*/*;q=0.5',
          'accept-encoding': 'gzip, deflate, br',
          ...this.headers,
        },
        signal: AbortSignal.timeout(this.timeoutMs),
        ...(!this.allowPrivateNetwork && { lookup: this.lookup }),
      });
      req.once('response', resolve);
      req.once('error', (err: Error & { code?: string }) => {
        if (err.message.startsWith('WebLoader:')) {
          reject(err);
        } else if (err.name === 'AbortError' || err.code === 'ABORT_ERR') {
          reject(
            new Error(`WebLoader: request to ${url.href} timed out after ${this.timeoutMs}ms`)
          );
        } else {
          reject(new Error(`WebLoader: request to ${url.href} failed: ${err.message}`));
        }
      });
    });
  }

  private readBody(response: IncomingMessage, url: string): Promise<Buffer> {
    const stream = decompress(response);
    return new Promise<Buffer>((resolve, reject) => {
      const chunks: Buffer[] = [];
      let total = 0;
      stream.on('data', (chunk: Buffer) => {
        total += chunk.length;
        if (total > this.maxResponseBytes) {
          response.destroy();
          stream.destroy();
          reject(
            new Error(
              `WebLoader: response from ${url} exceeds ${this.maxResponseBytes} bytes limit`
            )
          );
          return;
        }
        chunks.push(chunk);
      });
      stream.once('end', () => resolve(Buffer.concat(chunks)));
      stream.once('error', (err: Error) => {
        reject(new Error(`WebLoader: failed to read response from ${url}: ${err.message}`));
      });
      response.once('error', (err: Error) => {
        reject(new Error(`WebLoader: failed to read response from ${url}: ${err.message}`));
      });
    });
  }
}
