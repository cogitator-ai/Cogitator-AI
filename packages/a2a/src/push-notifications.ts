import { randomUUID } from 'node:crypto';
import type { PushNotificationConfig, PushNotificationStore, A2AStreamEvent } from './types.js';

export class InMemoryPushNotificationStore implements PushNotificationStore {
  private configs = new Map<string, Map<string, PushNotificationConfig>>();

  async create(taskId: string, config: PushNotificationConfig): Promise<PushNotificationConfig> {
    const id = config.id ?? `pnc_${randomUUID()}`;
    const stored: PushNotificationConfig = { ...config, id, createdAt: new Date().toISOString() };
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

function isPrivateUrl(urlStr: string): boolean {
  let parsed: URL;
  try {
    parsed = new URL(urlStr);
  } catch {
    return true;
  }
  if (!['http:', 'https:'].includes(parsed.protocol)) return true;
  const hostname = parsed.hostname;
  if (hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '::1') return true;
  if (hostname === '[::1]') return true;
  if (hostname.startsWith('169.254.')) return true;
  if (hostname.startsWith('10.')) return true;
  if (hostname.startsWith('192.168.')) return true;
  if (/^172\.(1[6-9]|2\d|3[01])\./.exec(hostname)) return true;
  if (hostname.endsWith('.local') || hostname.endsWith('.internal')) return true;
  return false;
}

export function validateWebhookUrl(url: string): void {
  if (isPrivateUrl(url)) {
    throw new Error(`Webhook URL rejected: private/internal address not allowed: ${url}`);
  }
}

export class PushNotificationSender {
  private store: PushNotificationStore;

  constructor(store: PushNotificationStore) {
    this.store = store;
  }

  async notify(taskId: string, event: A2AStreamEvent): Promise<void> {
    const configs = await this.store.list(taskId);
    const results = await Promise.allSettled(
      configs.map((config) => this.sendWebhook(config, event))
    );
    for (const result of results) {
      if (result.status === 'rejected') {
        process.stderr.write(
          `[a2a] Webhook delivery failed for task ${taskId}: ${result.reason}\n`
        );
      }
    }
  }

  private async sendWebhook(config: PushNotificationConfig, event: A2AStreamEvent): Promise<void> {
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };

    if (config.authenticationInfo) {
      const { scheme, credentials } = config.authenticationInfo;
      if (scheme === 'bearer' && credentials.token) {
        headers.Authorization = `Bearer ${credentials.token}`;
      } else if (scheme === 'apiKey' && credentials.key) {
        headers[credentials.headerName ?? 'X-API-Key'] = credentials.key;
      } else if (scheme === 'basic' && credentials.username && credentials.password) {
        headers.Authorization = `Basic ${Buffer.from(`${credentials.username}:${credentials.password}`).toString('base64')}`;
      }
    }

    const response = await fetch(config.webhookUrl, {
      method: 'POST',
      headers,
      body: JSON.stringify(event),
      signal: AbortSignal.timeout(10000),
    });

    if (!response.ok) {
      throw new Error(`Webhook returned HTTP ${response.status}`);
    }
  }
}
