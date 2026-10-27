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

/** Whether `host` names this machine, a link-local address or a cloud metadata service */
export function isPrivateHost(host: string): boolean {
  const name = host.replace(/^\[|\]$/g, '').toLowerCase();
  if (name === 'localhost' || name.endsWith('.localhost') || name === 'metadata.google.internal') {
    return true;
  }
  const version = isIP(name);
  if (version === 4) {
    const [a = 0, b = 0] = name.split('.').map(Number);
    return a === 127 || a === 0 || (a === 169 && b === 254) || name === '100.100.100.200';
  }
  if (version === 6) {
    return (
      name === '::1' ||
      name === '::' ||
      /^fe[89ab][0-9a-f]:/.test(name) ||
      name.startsWith('::ffff:127.') ||
      name.startsWith('::ffff:169.254.') ||
      name === 'fd00:ec2::254'
    );
  }
  return false;
}

/** Throws when a name of `url`'s host resolves to a private address, see {@link isPrivateHost} */
async function checkResolved(url: URL, what: string): Promise<void> {
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
  return name === 'localhost' || name === '::1' || name.startsWith('127.');
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
