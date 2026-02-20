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
}

export class PushNotificationSender {
  private store: PushNotificationStore;

  constructor(store: PushNotificationStore) {
    this.store = store;
  }

  async notify(taskId: string, event: A2AStreamEvent): Promise<void> {
    const configs = await this.store.list(taskId);
    const promises = configs.map((config) => this.sendWebhook(config, event));
    await Promise.allSettled(promises);
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
        headers.Authorization = `Basic ${btoa(`${credentials.username}:${credentials.password}`)}`;
      }
    }

    try {
      await fetch(config.webhookUrl, {
        method: 'POST',
        headers,
        body: JSON.stringify(event),
        signal: AbortSignal.timeout(10000),
      });
    } catch {}
  }
}
