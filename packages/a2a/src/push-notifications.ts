import { randomUUID } from 'node:crypto';
import { lookup as dnsLookup } from 'node:dns';
import { request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { isIP, type LookupFunction } from 'node:net';
import type { A2ATask, PushNotificationConfig, PushNotificationStore } from './types.js';

export class InMemoryPushNotificationStore implements PushNotificationStore {
  private configs = new Map<string, Map<string, PushNotificationConfig>>();

  async create(taskId: string, config: PushNotificationConfig): Promise<PushNotificationConfig> {
    const id = config.id ?? `pnc_${randomUUID()}`;
    const stored: PushNotificationConfig = { ...config, id };
    if (!this.configs.has(taskId)) this.configs.set(taskId, new Map());
    this.configs.get(taskId)!.set(id, stored);
    return stored;
  }

  async get(taskId: string, configId: string): Promise<PushNotificationConfig | null> {
    return this.configs.get(taskId)?.get(configId) ?? null;
  }

  async list(taskId: string): Promise<PushNotificationConfig[]> {
    const taskConfigs = this.configs.get(taskId);
    return taskConfigs ? Array.from(taskConfigs.values()) : [];
  }

  async delete(taskId: string, configId: string): Promise<void> {
    this.configs.get(taskId)?.delete(configId);
  }

  cleanup(taskId: string): void {
    this.configs.delete(taskId);
  }
}

const IPV4_BLOCKED_CIDRS: ReadonlyArray<readonly [string, number]> = [
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
];

const WEBHOOK_TIMEOUT_MS = 10_000;

function describeError(reason: unknown): string {
  if (reason instanceof Error) {
    const code = (reason as NodeJS.ErrnoException).code;
    return reason.message || code || reason.name;
  }
  return String(reason);
}

function ipv4ToNumber(ip: string): number {
  return ip.split('.').reduce((acc, octet) => acc * 256 + Number(octet), 0);
}

function isBlockedIpv4(ip: string): boolean {
  const value = ipv4ToNumber(ip);
  return IPV4_BLOCKED_CIDRS.some(([base, bits]) => {
    const size = 2 ** (32 - bits);
    const start = ipv4ToNumber(base);
    return value >= start && value < start + size;
  });
}

function expandIpv6(ip: string): number[] | null {
  let address = ip.toLowerCase();
  const zoneIndex = address.indexOf('%');
  if (zoneIndex !== -1) address = address.slice(0, zoneIndex);

  const lastColon = address.lastIndexOf(':');
  const tail = address.slice(lastColon + 1);
  if (tail.includes('.')) {
    if (isIP(tail) !== 4) return null;
    const v4 = ipv4ToNumber(tail);
    address = `${address.slice(0, lastColon + 1)}${(v4 >>> 16).toString(16)}:${(v4 & 0xffff).toString(16)}`;
  }

  const halves = address.split('::');
  if (halves.length > 2) return null;
  const head = halves[0] ? halves[0].split(':') : [];
  const rest = halves.length === 2 && halves[1] ? halves[1].split(':') : [];
  const missing = 8 - head.length - rest.length;
  if (missing < 0 || (halves.length === 1 && missing !== 0)) return null;

  const groups = [...head, ...Array<string>(halves.length === 2 ? missing : 0).fill('0'), ...rest];
  const parsed = groups.map((group) => parseInt(group, 16));
  return parsed.length === 8 && parsed.every((g) => Number.isInteger(g) && g >= 0 && g <= 0xffff)
    ? parsed
    : null;
}

function isBlockedIpv6(ip: string): boolean {
  const groups = expandIpv6(ip);
  if (!groups) return true;

  const embeddedV4 = () =>
    `${groups[6] >> 8}.${groups[6] & 0xff}.${groups[7] >> 8}.${groups[7] & 0xff}`;

  if (groups.every((g) => g === 0)) return true;
  if (groups.slice(0, 7).every((g) => g === 0) && groups[7] === 1) return true;
  if (groups.slice(0, 5).every((g) => g === 0) && groups[5] === 0xffff) {
    return isBlockedIpv4(embeddedV4());
  }
  if (groups.slice(0, 6).every((g) => g === 0)) {
    return isBlockedIpv4(embeddedV4());
  }
  if (groups[0] === 0x64 && groups[1] === 0xff9b && groups.slice(2, 6).every((g) => g === 0)) {
    return isBlockedIpv4(embeddedV4());
  }
  if ((groups[0] & 0xfe00) === 0xfc00) return true;
  if ((groups[0] & 0xffc0) === 0xfe80) return true;
  if ((groups[0] & 0xff00) === 0xff00) return true;
  if (groups[0] === 0x2001 && groups[1] === 0x0db8) return true;
  return false;
}

/**
 * Whether an IP address belongs to a loopback, private, link-local, CGNAT,
 * multicast, documentation or otherwise non-public range (IPv4, IPv6 and
 * IPv4-mapped/translated IPv6).
 */
export function isPrivateAddress(address: string): boolean {
  const version = isIP(address);
  if (version === 4) return isBlockedIpv4(address);
  if (version === 6) return isBlockedIpv6(address);
  return true;
}

function isPrivateHostname(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/\.$/, '');
  return (
    host === 'localhost' ||
    host.endsWith('.localhost') ||
    host.endsWith('.local') ||
    host.endsWith('.internal')
  );
}

function isPrivateUrl(urlStr: string): boolean {
  let parsed: URL;
  try {
    parsed = new URL(urlStr);
  } catch {
    return true;
  }
  if (!['http:', 'https:'].includes(parsed.protocol)) return true;
  const hostname = parsed.hostname.replace(/^\[|\]$/g, '');
  if (!hostname) return true;
  if (isIP(hostname)) return isPrivateAddress(hostname);
  return isPrivateHostname(hostname);
}

export function validateWebhookUrl(url: string): void {
  if (isPrivateUrl(url)) {
    throw new Error(`Webhook URL rejected: private/internal address not allowed: ${url}`);
  }
}

/**
 * DNS lookup that refuses to connect to private addresses. Used as the socket
 * lookup for webhook requests so the check applies to the address actually
 * connected to (no DNS-rebinding window between validation and connect).
 */
const publicOnlyLookup: LookupFunction = (hostname, options, callback) => {
  dnsLookup(hostname, { ...options, all: true }, (err, addresses) => {
    if (err) {
      callback(err, '');
      return;
    }
    const blocked = addresses.find((entry) => isPrivateAddress(entry.address));
    if (blocked || addresses.length === 0) {
      const error: NodeJS.ErrnoException = new Error(
        `Webhook host ${hostname} resolves to a private/internal address${blocked ? ` (${blocked.address})` : ''}`
      );
      error.code = 'ERR_A2A_PRIVATE_ADDRESS';
      callback(error, '');
      return;
    }
    if (options.all) {
      callback(null, addresses);
    } else {
      callback(null, addresses[0].address, addresses[0].family);
    }
  });
};

function postJson(
  url: URL,
  headers: Record<string, string>,
  body: string,
  lookup: LookupFunction | undefined
): Promise<number> {
  const request = url.protocol === 'https:' ? httpsRequest : httpRequest;
  return new Promise((resolve, reject) => {
    const req = request(
      url,
      {
        method: 'POST',
        headers: { ...headers, 'Content-Length': String(Buffer.byteLength(body)) },
        lookup,
        timeout: WEBHOOK_TIMEOUT_MS,
      },
      (res) => {
        res.resume();
        res.on('end', () => resolve(res.statusCode ?? 0));
        res.on('error', reject);
      }
    );
    const deadline = setTimeout(
      () => req.destroy(new Error(`Webhook timed out after ${WEBHOOK_TIMEOUT_MS}ms`)),
      WEBHOOK_TIMEOUT_MS
    );
    req.on('close', () => clearTimeout(deadline));
    req.on('timeout', () => req.destroy(new Error('Webhook socket timed out')));
    req.on('error', reject);
    req.end(body);
  });
}

/** Header carrying the config's `token` on every webhook call (A2A v0.3, section 9.5). */
export const NOTIFICATION_TOKEN_HEADER = 'X-A2A-Notification-Token';

/**
 * The `Authorization` header for a webhook from the config's `authentication`: the credentials
 * under the first scheme the server knows (`Bearer`, or `Basic` with base64 `user:password`).
 */
function authorizationHeader(config: PushNotificationConfig): string | undefined {
  const auth = config.authentication;
  if (!auth?.credentials) return undefined;
  for (const scheme of auth.schemes) {
    const normalized = scheme.toLowerCase();
    if (normalized === 'bearer') return `Bearer ${auth.credentials}`;
    if (normalized === 'basic') return `Basic ${auth.credentials}`;
  }
  return undefined;
}

export class PushNotificationSender {
  private store: PushNotificationStore;
  private allowPrivateUrls: boolean;

  constructor(store: PushNotificationStore, allowPrivateUrls = false) {
    this.store = store;
    this.allowPrivateUrls = allowPrivateUrls;
  }

  /** POST the task, as the client sees it, to every webhook registered for it. */
  async notify(task: A2ATask): Promise<void> {
    const configs = await this.store.list(task.id);
    const results = await Promise.allSettled(
      configs.map((config) => this.sendWebhook(config, task))
    );
    for (const result of results) {
      if (result.status === 'rejected') {
        process.stderr.write(
          `[a2a] Webhook delivery failed for task ${task.id}: ${describeError(result.reason)}\n`
        );
      }
    }
  }

  private async sendWebhook(config: PushNotificationConfig, task: A2ATask): Promise<void> {
    if (!this.allowPrivateUrls) {
      validateWebhookUrl(config.url);
    }

    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    if (config.token) headers[NOTIFICATION_TOKEN_HEADER] = config.token;
    const authorization = authorizationHeader(config);
    if (authorization) headers.Authorization = authorization;

    const status = await postJson(
      new URL(config.url),
      headers,
      JSON.stringify(task),
      this.allowPrivateUrls ? undefined : publicOnlyLookup
    );

    if (status < 200 || status >= 300) {
      throw new Error(`Webhook returned HTTP ${status}`);
    }
  }
}
