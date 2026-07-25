import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import type { DocumentLoader, RAGDocument } from '@cogitator-ai/types';
import { HTMLLoader } from './html-loader';

const BLOCKED_HOSTNAMES = new Set([
  'localhost',
  '127.0.0.1',
  '::1',
  '[::1]',
  '0.0.0.0',
  '169.254.169.254',
  'metadata.google.internal',
]);

const MAX_REDIRECTS = 5;

function isPrivateIP(ip: string): boolean {
  if (ip.startsWith('10.')) return true;
  if (ip.startsWith('192.168.')) return true;
  if (ip === '0.0.0.0' || ip === '127.0.0.1' || ip === '::1') return true;
  if (ip.startsWith('169.254.')) return true;
  if (ip.startsWith('fc') || ip.startsWith('fd') || ip.startsWith('fe80')) return true;

  const match172 = /^172\.(\d+)\./.exec(ip);
  if (match172) {
    const second = parseInt(match172[1], 10);
    if (second >= 16 && second <= 31) return true;
  }

  return false;
}

async function validateUrl(urlString: string): Promise<URL> {
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

  const hostname = url.hostname.toLowerCase();
  if (BLOCKED_HOSTNAMES.has(hostname)) {
    throw new Error(`WebLoader: access to "${hostname}" is blocked (loopback / metadata endpoint)`);
  }

  if (isIP(hostname) && isPrivateIP(hostname)) {
    throw new Error(`WebLoader: access to private IP "${hostname}" is blocked`);
  }

  if (!isIP(hostname)) {
    try {
      const { address } = await lookup(hostname);
      if (isPrivateIP(address)) {
        throw new Error(`WebLoader: "${hostname}" resolves to private IP ${address} — blocked`);
      }
    } catch (err) {
      if (err instanceof Error && err.message.startsWith('WebLoader:')) throw err;
    }
  }

  return url;
}

export interface WebLoaderOptions {
  selector?: string;
  headers?: Record<string, string>;
  timeoutMs?: number;
  maxResponseBytes?: number;
}

const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_MAX_RESPONSE_BYTES = 50 * 1024 * 1024;

export class WebLoader implements DocumentLoader {
  readonly supportedTypes = ['http', 'https'];
  private readonly htmlLoader: HTMLLoader;
  private readonly headers?: Record<string, string>;
  private readonly timeoutMs: number;
  private readonly maxResponseBytes: number;

  constructor(options?: WebLoaderOptions) {
    this.htmlLoader = new HTMLLoader({ selector: options?.selector });
    this.headers = options?.headers;
    this.timeoutMs = options?.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.maxResponseBytes = options?.maxResponseBytes ?? DEFAULT_MAX_RESPONSE_BYTES;
  }

  async load(source: string): Promise<RAGDocument[]> {
    let currentUrl = source;

    for (let redirectCount = 0; redirectCount <= MAX_REDIRECTS; redirectCount++) {
      await validateUrl(currentUrl);

      const response = await fetch(currentUrl, {
        headers: this.headers ?? {},
        redirect: 'manual',
        signal: AbortSignal.timeout(this.timeoutMs),
      });

      if (response.status >= 300 && response.status < 400) {
        const location = response.headers.get('location');
        if (!location) {
          throw new Error(
            `WebLoader: redirect ${response.status} without Location header from ${currentUrl}`
          );
        }
        currentUrl = new URL(location, currentUrl).href;
        continue;
      }

      if (!response.ok) {
        throw new Error(
          `WebLoader: failed to fetch ${currentUrl}: ${response.status} ${response.statusText}`
        );
      }

      const html = await this.readBodyWithLimit(response, currentUrl);
      const doc = await this.htmlLoader.parseHTML(html, source, 'web');
      return [doc];
    }

    throw new Error(`WebLoader: too many redirects (max ${MAX_REDIRECTS}) for ${source}`);
  }

  private async readBodyWithLimit(response: Response, url: string): Promise<string> {
    const body = response.body;
    if (!body) {
      const text = await response.text();
      if (text.length > this.maxResponseBytes) {
        throw new Error(
          `WebLoader: response from ${url} exceeds ${this.maxResponseBytes} bytes limit`
        );
      }
      return text;
    }

    const reader = body.getReader();
    const chunks: Uint8Array[] = [];
    let totalBytes = 0;

    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;

        totalBytes += value.byteLength;
        if (totalBytes > this.maxResponseBytes) {
          throw new Error(
            `WebLoader: response from ${url} exceeds ${this.maxResponseBytes} bytes limit`
          );
        }
        chunks.push(value);
      }
    } finally {
      reader.releaseLock();
    }

    const merged = new Uint8Array(totalBytes);
    let offset = 0;
    for (const chunk of chunks) {
      merged.set(chunk, offset);
      offset += chunk.byteLength;
    }

    return new TextDecoder('utf-8').decode(merged);
  }
}
