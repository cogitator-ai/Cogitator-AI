/**
 * Downloads for installs: only over https, never to a loopback, link-local or cloud metadata
 * address, redirects checked one by one, a size limit and a timeout
 */

import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import { CogitatorError, ErrorCode } from '@cogitator-ai/types';

/** Largest download read */
export const MAX_DOWNLOAD_BYTES = 256 * 1024 * 1024;

const MAX_REDIRECTS = 5;
const TIMEOUT_MS = 120_000;

function refuse(message: string): CogitatorError {
  return new CogitatorError({ message, code: ErrorCode.PLUGIN_INSTALL_FAILED });
}

/** The four bytes of an IPv4 address, undefined for anything else */
function ipv4Bytes(text: string): number[] | undefined {
  if (isIP(text) !== 4) return undefined;
  return text.split('.').map(Number);
}

/** The eight 16-bit groups of an IPv6 address (with a dotted IPv4 tail), undefined for anything else */
function ipv6Groups(text: string): number[] | undefined {
  if (isIP(text) !== 6) return undefined;
  let address = text.toLowerCase();
  const zone = address.indexOf('%');
  if (zone !== -1) address = address.slice(0, zone);
  const tail = address.lastIndexOf(':');
  const dotted = ipv4Bytes(address.slice(tail + 1));
  if (dotted) {
    const [a = 0, b = 0, c = 0, d = 0] = dotted;
    address = `${address.slice(0, tail + 1)}${((a << 8) | b).toString(16)}:${((c << 8) | d).toString(16)}`;
  }
  const [head = '', rest] = address.split('::');
  const parse = (part: string) => (part === '' ? [] : part.split(':').map((g) => parseInt(g, 16)));
  const front = parse(head);
  const back = rest === undefined ? [] : parse(rest);
  const groups =
    rest === undefined
      ? front
      : [...front, ...Array<number>(8 - front.length - back.length).fill(0), ...back];
  return groups.length === 8 ? groups : undefined;
}

/** Whether an IPv4 address is this machine, unspecified, link-local, multicast or a metadata service */
function privateIpv4([a = 0, b = 0, c = 0, d = 0]: number[]): boolean {
  return (
    a === 127 ||
    a === 0 ||
    (a === 169 && b === 254) ||
    a >= 224 ||
    (a === 100 && b === 100 && c === 100 && d === 200)
  );
}

/** The IPv4 address an IPv6 address carries: mapped, compatible, NAT64 (64:ff9b::/96) or 6to4 */
function embeddedIpv4(groups: number[]): number[] | undefined {
  const bytes = (high = 0, low = 0) => [high >> 8, high & 0xff, low >> 8, low & 0xff];
  const zeros = (from: number, to: number) => groups.slice(from, to).every((group) => group === 0);
  const mapped = zeros(0, 5) && groups[5] === 0xffff;
  const compatible = zeros(0, 6) && groups[6] !== 0;
  if (mapped || compatible) {
    return bytes(groups[6], groups[7]);
  }
  if (groups[0] === 0x64 && groups[1] === 0xff9b && zeros(2, 6)) return bytes(groups[6], groups[7]);
  if (groups[0] === 0x2002) return bytes(groups[1], groups[2]);
  return undefined;
}

/**
 * Whether `host` names this machine, an unspecified, link-local, unique-local or multicast
 * address, or a cloud metadata service. An IPv6 address is read in full, so an IPv4 address it
 * carries (`[::ffff:7f00:1]`, NAT64, 6to4) is checked as that address
 */
export function isPrivateHost(host: string): boolean {
  const name = host.replace(/^\[|\]$/g, '').toLowerCase();
  if (name === 'localhost' || name.endsWith('.localhost') || name === 'metadata.google.internal') {
    return true;
  }
  const v4 = ipv4Bytes(name);
  if (v4) return privateIpv4(v4);
  const groups = ipv6Groups(name);
  if (!groups) return false;
  const embedded = embeddedIpv4(groups);
  if (embedded) return privateIpv4(embedded);
  const [first = 0] = groups;
  const unspecifiedOrLoopback =
    groups.slice(0, 7).every((group) => group === 0) && (groups[7] ?? 0) <= 1;
  return (
    unspecifiedOrLoopback ||
    (first & 0xfe00) === 0xfc00 ||
    (first & 0xffc0) === 0xfe80 ||
    (first & 0xffc0) === 0xfec0 ||
    (first & 0xff00) === 0xff00
  );
}

/** Throws when `url`'s host, or an address its name resolves to, is private, see {@link isPrivateHost} */
async function checkResolved(url: URL, what: string): Promise<void> {
  if (isPrivateHost(url.hostname)) {
    throw refuse(`${what} may not point at a loopback, link-local or metadata host: ${url.href}`);
  }
  if (isIP(url.hostname.replace(/^\[|\]$/g, '')) !== 0) return;
  let addresses: { address: string }[];
  try {
    addresses = await lookup(url.hostname, { all: true });
  } catch {
    return;
  }
  if (addresses.some((entry) => isPrivateHost(entry.address))) {
    throw refuse(`${what}: ${url.hostname} resolves to a loopback, link-local or metadata address`);
  }
}

/** Whether `host` is this machine: what a local registry or a test listens on */
export function isLoopbackHost(host: string): boolean {
  const name = host.replace(/^\[|\]$/g, '').toLowerCase();
  if (name === 'localhost') return true;
  const v4 = ipv4Bytes(name);
  if (v4) return v4[0] === 127;
  const groups = ipv6Groups(name);
  if (!groups) return false;
  const embedded = embeddedIpv4(groups);
  if (embedded) return embedded[0] === 127;
  return groups.slice(0, 7).every((group) => group === 0) && groups[7] === 1;
}

/** Checks that `url` is an https URL to a public host, throwing why not */
export function checkDownloadUrl(url: string, what: string): URL {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw refuse(`${what}: ${url} is not a URL`);
  }
  if (parsed.protocol !== 'https:') throw refuse(`${what} must use https: ${url}`);
  if (isPrivateHost(parsed.hostname)) {
    throw refuse(`${what} may not point at a loopback, link-local or metadata host: ${url}`);
  }
  return parsed;
}

/**
 * The body of `url`, read up to `maxBytes`: each redirect is checked like the URL itself. `headers`
 * (a marketplace's `Authorization`, say) go only to the origin of `url`: a redirect to another
 * origin is followed without them, so a token never reaches a host it was not meant for.
 * `fetchFn` replaces the platform's fetch, for a host that routes downloads its own way
 */
export async function download(
  url: string,
  what: string,
  options: {
    headers?: Readonly<Record<string, string>>;
    maxBytes?: number;
    fetchFn?: typeof fetch;
    signal?: AbortSignal;
  } = {}
): Promise<Buffer> {
  const fetchFn = options.fetchFn ?? fetch;
  const maxBytes = options.maxBytes ?? MAX_DOWNLOAD_BYTES;
  let current = checkDownloadUrl(url, what);
  const origin = current.origin;
  const signal = AbortSignal.any([
    AbortSignal.timeout(TIMEOUT_MS),
    ...(options.signal ? [options.signal] : []),
  ]);
  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    if (!options.fetchFn) await checkResolved(current, what);
    const response = await fetchFn(current, {
      redirect: 'manual',
      signal,
      ...(options.headers && current.origin === origin && { headers: { ...options.headers } }),
    });
    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.get('location');
      if (!location) throw refuse(`${what}: ${current.href} redirects nowhere`);
      current = checkDownloadUrl(new URL(location, current).href, what);
      continue;
    }
    if (!response.ok) throw refuse(`${what}: ${current.href} answered HTTP ${response.status}`);
    const length = Number(response.headers.get('content-length') ?? '0');
    if (length > maxBytes) throw refuse(`${what} is larger than ${maxBytes} bytes`);
    if (!response.body) return Buffer.alloc(0);
    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let size = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > maxBytes) {
        await reader.cancel();
        throw refuse(`${what} is larger than ${maxBytes} bytes`);
      }
      chunks.push(value);
    }
    return Buffer.concat(chunks);
  }
  throw refuse(`${what}: more than ${MAX_REDIRECTS} redirects`);
}
