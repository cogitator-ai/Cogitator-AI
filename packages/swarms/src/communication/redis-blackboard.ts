import { nanoid } from 'nanoid';
import type {
  BlackboardConfig,
  BlackboardSection,
  BlackboardHistoryEntry,
} from '@cogitator-ai/types';
import type { Redis } from 'ioredis';
import {
  BlackboardListeners,
  type BlackboardSectionHandler,
  type BlackboardWriteListener,
  type ObservableBlackboard,
} from './blackboard.js';

export interface RedisBlackboardOptions {
  redis: Redis;
  swarmId: string;
  keyPrefix?: string;
}

interface StoredSection<T = unknown> {
  name: string;
  data: T;
  lastModified: number;
  modifiedBy: string;
  version: number;
}

interface ChangeNotification {
  section: string;
  data?: unknown;
  agentName?: string;
  version?: number;
  timestamp?: number;
  deleted?: boolean;
  _sid?: string;
}

const MAX_HISTORY = 1000;

const ATOMIC_WRITE_SCRIPT = `
local sectionKey = KEYS[1]
local historyKey = KEYS[2]
local channel = KEYS[3]
local sectionJson = ARGV[1]
local notificationJson = ARGV[2]
local historyEntryJson = ARGV[3]
local maxHistory = tonumber(ARGV[4])
local senderId = ARGV[5]

local current = redis.call('GET', sectionKey)
local version = 1
if current then
  version = cjson.decode(current).version + 1
end

local section = cjson.decode(sectionJson)
section.version = version
redis.call('SET', sectionKey, cjson.encode(section))

if historyEntryJson ~= '' then
  local entry = cjson.decode(historyEntryJson)
  entry.version = version
  redis.call('RPUSH', historyKey, cjson.encode(entry))
  redis.call('LTRIM', historyKey, -maxHistory, -1)
end

local notification = cjson.decode(notificationJson)
notification.version = version
notification._sid = senderId
redis.call('PUBLISH', channel, cjson.encode(notification))

return version
`;

function parseStoredSection(raw: string): StoredSection | null {
  try {
    const parsed = JSON.parse(raw) as Partial<StoredSection>;
    if (typeof parsed.name !== 'string' || typeof parsed.version !== 'number') return null;
    return parsed as StoredSection;
  } catch {
    return null;
  }
}

export class RedisBlackboard implements ObservableBlackboard {
  private redis: Redis;
  private subscriber: Redis;
  private swarmId: string;
  private keyPrefix: string;
  private config: BlackboardConfig;
  private listeners = new BlackboardListeners('[RedisBlackboard]');
  private localCache = new Map<string, StoredSection>();
  private historyCache = new Map<string, BlackboardHistoryEntry[]>();
  private readonly instanceId = nanoid(12);
  private initialized = false;

  constructor(config: BlackboardConfig, options: RedisBlackboardOptions) {
    this.config = config;
    this.redis = options.redis;
    this.subscriber = options.redis.duplicate();
    this.swarmId = options.swarmId;
    this.keyPrefix = options.keyPrefix ?? 'swarm';
  }

  private sectionKey(section: string): string {
    return `${this.keyPrefix}:${this.swarmId}:blackboard:${section}`;
  }

  private historyKey(section: string): string {
    return `${this.keyPrefix}:${this.swarmId}:blackboard:${section}:history`;
  }

  private channelKey(): string {
    return `${this.keyPrefix}:${this.swarmId}:blackboard:changes`;
  }

  private readonly handleRemoteChange = (_channel: string, messageJson: string): void => {
    try {
      const parsed = JSON.parse(messageJson) as ChangeNotification;
      if (parsed._sid === this.instanceId) return;

      if (parsed.deleted) {
        const existing = this.localCache.get(parsed.section);
        this.localCache.delete(parsed.section);
        this.historyCache.delete(parsed.section);
        if (existing) {
          this.listeners.notify({
            section: parsed.section,
            data: undefined,
            agentName: parsed.agentName ?? 'system',
            version: existing.version,
            deleted: true,
          });
        }
        return;
      }

      const agentName = parsed.agentName ?? 'unknown';
      const version = parsed.version ?? (this.localCache.get(parsed.section)?.version ?? 0) + 1;
      const timestamp = parsed.timestamp ?? Date.now();

      this.localCache.set(parsed.section, {
        name: parsed.section,
        data: parsed.data,
        lastModified: timestamp,
        modifiedBy: agentName,
        version,
      });

      if (this.config.trackHistory) {
        this.pushHistory(parsed.section, {
          value: parsed.data,
          writtenBy: agentName,
          timestamp,
          version,
        });
      }

      this.listeners.notify({ section: parsed.section, data: parsed.data, agentName, version });
    } catch (error) {
      console.warn('[RedisBlackboard] Failed to parse message:', error);
    }
  };

  async initialize(): Promise<void> {
    if (this.initialized) return;
    this.initialized = true;

    try {
      for (const [name, initialData] of Object.entries(this.config.sections)) {
        const section: StoredSection = {
          name,
          data: initialData,
          lastModified: Date.now(),
          modifiedBy: 'system',
          version: 1,
        };

        const wasSet = await this.redis.set(this.sectionKey(name), JSON.stringify(section), 'NX');

        if (wasSet === 'OK') {
          this.localCache.set(name, section);
          if (this.config.trackHistory) {
            const entry: BlackboardHistoryEntry = {
              value: initialData,
              writtenBy: 'system',
              timestamp: section.lastModified,
              version: 1,
            };
            await this.redis.rpush(this.historyKey(name), JSON.stringify(entry));
            this.historyCache.set(name, [entry]);
          }
          continue;
        }

        const existing = await this.redis.get(this.sectionKey(name));
        const stored = existing ? parseStoredSection(existing) : null;
        this.localCache.set(name, stored ?? section);
      }

      this.subscriber.on('message', this.handleRemoteChange);
      await this.subscriber.subscribe(this.channelKey());
    } catch (error) {
      this.subscriber.off('message', this.handleRemoteChange);
      this.initialized = false;
      throw error;
    }
  }

  read<T = unknown>(section: string): T {
    this.assertEnabled();
    const cached = this.localCache.get(section);
    if (!cached) {
      throw new Error(`Blackboard section '${section}' not found`);
    }
    return cached.data as T;
  }

  write<T>(section: string, data: T, agentName: string): void {
    this.assertEnabled();

    const existing = this.localCache.get(section);
    const version = existing ? existing.version + 1 : 1;
    const timestamp = Date.now();

    const newSection: StoredSection<T> = {
      name: section,
      data,
      lastModified: timestamp,
      modifiedBy: agentName,
      version,
    };

    this.localCache.set(section, newSection);

    if (this.config.trackHistory) {
      this.pushHistory(section, { value: data, writtenBy: agentName, timestamp, version });
    }

    const historyEntryJson = this.config.trackHistory
      ? JSON.stringify({ value: data, writtenBy: agentName, timestamp })
      : '';

    void this.redis
      .eval(
        ATOMIC_WRITE_SCRIPT,
        3,
        this.sectionKey(section),
        this.historyKey(section),
        this.channelKey(),
        JSON.stringify(newSection),
        JSON.stringify({ section, data, agentName, timestamp }),
        historyEntryJson,
        String(MAX_HISTORY),
        this.instanceId
      )
      .then((storedVersion: unknown) => {
        if (typeof storedVersion === 'number' && this.localCache.get(section) === newSection) {
          newSection.version = storedVersion;
        }
      })
      .catch((error: unknown) => {
        console.warn('[RedisBlackboard] Write error:', error);
      });

    this.listeners.notify({ section, data, agentName, version });
  }

  append<T>(section: string, item: T, agentName: string): void {
    this.assertEnabled();
    const current = this.localCache.get(section);

    if (!current) {
      this.write(section, [item], agentName);
      return;
    }

    if (!Array.isArray(current.data)) {
      throw new Error(`Section '${section}' is not an array, cannot append`);
    }

    this.write(section, [...current.data, item], agentName);
  }

  has(section: string): boolean {
    return this.localCache.has(section);
  }

  delete(section: string): void {
    const existing = this.localCache.get(section);
    this.localCache.delete(section);
    this.historyCache.delete(section);
    this.removeFromRedis(section);

    if (existing) {
      this.listeners.notify({
        section,
        data: undefined,
        agentName: 'system',
        version: existing.version,
        deleted: true,
      });
    }
  }

  subscribe(section: string, handler: BlackboardSectionHandler): () => void {
    return this.listeners.subscribe(section, handler);
  }

  onWrite(listener: BlackboardWriteListener): () => void {
    return this.listeners.onWrite(listener);
  }

  getSections(): string[] {
    return Array.from(this.localCache.keys());
  }

  getSection<T = unknown>(section: string): BlackboardSection<T> | undefined {
    const cached = this.localCache.get(section);
    if (!cached) return undefined;
    return {
      name: cached.name,
      data: cached.data as T,
      lastModified: cached.lastModified,
      modifiedBy: cached.modifiedBy,
      version: cached.version,
    };
  }

  getHistory(section: string): BlackboardHistoryEntry[] {
    return [...(this.historyCache.get(section) ?? [])];
  }

  clear(): void {
    const sections = Array.from(this.localCache.keys());
    this.localCache.clear();
    this.historyCache.clear();

    for (const section of sections) {
      this.removeFromRedis(section);
    }
  }

  async close(): Promise<void> {
    this.subscriber.off('message', this.handleRemoteChange);
    this.initialized = false;
    if (this.subscriber.status === 'end') return;
    if (this.subscriber.status === 'wait') {
      this.subscriber.disconnect();
      return;
    }
    await this.subscriber.unsubscribe();
    await this.subscriber.quit();
  }

  async syncFromRedis(): Promise<void> {
    const pattern = `${this.keyPrefix}:${this.swarmId}:blackboard:*`;
    let cursor = '0';

    do {
      const [nextCursor, keys] = await this.redis.scan(cursor, 'MATCH', pattern, 'COUNT', 100);
      cursor = nextCursor;

      for (const key of keys) {
        if (key.endsWith(':history')) continue;

        const raw = await this.redis.get(key);
        const stored = raw ? parseStoredSection(raw) : null;
        if (stored && key === this.sectionKey(stored.name)) {
          this.localCache.set(stored.name, stored);
        }
      }
    } while (cursor !== '0');
  }

  private pushHistory(section: string, entry: BlackboardHistoryEntry): void {
    let entries = this.historyCache.get(section);
    if (!entries) {
      entries = [];
      this.historyCache.set(section, entries);
    }
    entries.push(entry);
    if (entries.length > MAX_HISTORY) {
      entries.splice(0, entries.length - MAX_HISTORY);
    }
  }

  private removeFromRedis(section: string): void {
    const notification: ChangeNotification = {
      section,
      deleted: true,
      agentName: 'system',
      timestamp: Date.now(),
      _sid: this.instanceId,
    };

    void this.redis
      .del(this.sectionKey(section), this.historyKey(section))
      .then(() => this.redis.publish(this.channelKey(), JSON.stringify(notification)))
      .catch((error: unknown) => {
        console.warn('[RedisBlackboard] Delete error:', error);
      });
  }

  private assertEnabled(): void {
    if (!this.config.enabled) {
      throw new Error('Blackboard is not enabled');
    }
  }
}
