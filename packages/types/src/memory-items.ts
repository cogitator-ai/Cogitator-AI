/**
 * Memory items: what a conversation established, kept apart from the conversation itself
 */

import type { Evidence, MemoryResult } from './memory';

/** What a memory item records */
export type MemoryItemKind = 'fact' | 'event' | 'preference' | 'instruction' | 'opinion' | 'lesson';

/**
 * Where a memory item stands: `suggested` until it is grounded well enough to be used, `active`
 * while it holds, `stale` once it is no longer trusted to hold, `superseded` once a newer item of
 * its slot took its place
 */
export type MemoryItemStatus = 'suggested' | 'active' | 'stale' | 'superseded';

/**
 * Who a memory item comes from, which decides how far it is trusted: `user` (the person, in
 * their own message), `system` (the application's code), `model` (the model's own words),
 * `tool` (a tool's result) and `web` (a page a tool fetched). Only `user` and `system` items
 * become `active` on their own, the rest stay `suggested`, so text a model or a page wrote cannot
 * plant itself in memory.
 */
export type MemoryItemTrust = 'user' | 'system' | 'model' | 'tool' | 'web';

/** How precise a date of a memory item is */
export type TimePrecision = 'instant' | 'day' | 'week' | 'month' | 'year' | 'approximate';

/** The time a memory item is about, as said and as an interval */
export interface MemoryItemTime {
  /** The words that said it, such as `last Friday` */
  text?: string;
  /** Where the interval starts and ends, absent when the words could not be resolved */
  start?: Date;
  end?: Date;
  precision: TimePrecision;
}

/**
 * Who a memory item belongs to. `agentId` is always set, and every other field narrows it: an
 * item with a `userId` is seen only by runs for that user, one with a `threadId` only in that
 * thread. An item without one is seen across it.
 */
export interface MemoryItemScope {
  agentId: string;
  userId?: string;
  projectId?: string;
  threadId?: string;
}

/**
 * One thing a conversation established, kept with where it comes from and when it held.
 *
 * Its times are bitemporal: `validFrom` and `validTo` say when it held in the world,
 * `recordedAt` and `expiredAt` when memory took it in and let it go. A newer item of the same
 * `slot` closes it (`validTo`, `superseded`) instead of deleting it, so a question "as of" a
 * date still finds what held then.
 */
export interface MemoryItem {
  id: string;
  kind: MemoryItemKind;
  /** The item as one coherent statement */
  content: string;
  /** The entity it is about, as said */
  subject?: string;
  /** The entity of the entity index `subject` was linked to */
  entityId?: string;
  /** What about the subject it records, such as `home city` */
  attribute?: string;
  /** The value it gives the attribute */
  value?: string;
  /**
   * The key of the state it records, `<subject>:<attribute>` normalized: a newer item of the
   * same slot supersedes it
   */
  slot?: string;
  status: MemoryItemStatus;
  trust: MemoryItemTrust;
  /** How sure memory is of it, from 0 to 1 */
  confidence: number;
  scope: MemoryItemScope;
  /** Quotes of the entries it stands on */
  evidence: Evidence[];
  /** Whether every quote was found in its entry */
  verified: boolean;
  /** When it was said */
  saidAt: Date;
  /** The date of the session it was said in, which relative dates are resolved against */
  sessionAt: Date;
  /** The time it is about, when it names one */
  about?: MemoryItemTime;
  /** When it started to hold in the world, for an item of a slot */
  validFrom?: Date;
  /** When it stopped holding in the world, for an item of a slot a newer one closed */
  validTo?: Date;
  /** When memory took it in */
  recordedAt: Date;
  /** When memory let it go: an expired item is kept, but no longer found */
  expiredAt?: Date;
  /** The items of its slot it closed */
  supersedes?: string[];
  /** The item of its slot that closed it */
  supersededBy?: string;
  metadata?: Record<string, unknown>;
}

/** A memory item to write: memory gives it its id, status and record time */
export type NewMemoryItem = Omit<
  MemoryItem,
  'id' | 'status' | 'recordedAt' | 'supersedes' | 'supersededBy' | 'expiredAt' | 'verified'
> & {
  /** Overrides the status memory would give it, such as `active` for an item the user confirmed */
  status?: MemoryItemStatus;
  /** Whether its quotes hold, when the caller checked them already */
  verified?: boolean;
  /** When memory takes it in, now by default */
  recordedAt?: Date;
};

/** An entity memory items are about, with every name it was called */
export interface MemoryEntity {
  id: string;
  scope: MemoryItemScope;
  name: string;
  aliases: string[];
  /** What it is, such as `person` or `place` */
  type?: string;
  firstSeenAt: Date;
  lastSeenAt: Date;
}

/** Which items a {@link MemoryItemAdapter} finds: all of the given conditions hold */
export interface MemoryItemFilter {
  agentId: string;
  ids?: string[];
  slots?: string[];
  entityIds?: string[];
  kinds?: MemoryItemKind[];
  statuses?: MemoryItemStatus[];
  /** Include items memory let go (`expiredAt` set), left out by default */
  includeExpired?: boolean;
}

/** Which entities a {@link MemoryItemAdapter} finds */
export interface MemoryEntityFilter {
  agentId: string;
  ids?: string[];
  /** Entities one of whose names or aliases, normalized, is among these */
  names?: string[];
}

/**
 * Storage for memory items and the entity index. A built-in adapter implements it, and
 * `MemoryItems` keeps every rule (supersession, activation, scopes, time) on top of it, so the
 * storage only stores. Found items come oldest recorded first.
 */
export interface MemoryItemAdapter {
  /** Writes `item`, replacing the item with its id */
  putItem(item: MemoryItem): Promise<MemoryResult<MemoryItem>>;
  getItem(itemId: string): Promise<MemoryResult<MemoryItem | null>>;
  findItems(filter: MemoryItemFilter): Promise<MemoryResult<MemoryItem[]>>;
  /** Deletes the items for good */
  deleteItems(itemIds: string[]): Promise<MemoryResult<void>>;
  /** Writes `entity`, replacing the entity with its id */
  putEntity(entity: MemoryEntity): Promise<MemoryResult<MemoryEntity>>;
  findEntities(filter: MemoryEntityFilter): Promise<MemoryResult<MemoryEntity[]>>;
  deleteEntities(entityIds: string[]): Promise<MemoryResult<void>>;
}

/**
 * `memory.extraction`: memory items taken from a run's conversation after the run. One model call
 * reads each window of the entries new since the last extraction, every item it names is checked
 * against the quotes it gives, and items are only added.
 */
export interface MemoryExtractionConfig {
  /** Model that extracts, as `provider/model`, the model the run ended on by default */
  model?: string;
  /** Instructions added to the extraction prompt */
  prompt?: string;
  /** Tokens of conversation one call reads (default 4000) */
  windowTokens?: number;
  /** Confidence a `user` item with quotes that hold needs to become `active` (default 0.7) */
  activationConfidence?: number;
  /**
   * Who the items belong to: `user` (default) the run's user, agent-wide for a run without one,
   * `agent` everyone the agent talks to, `thread` the thread alone
   */
  scope?: 'user' | 'agent' | 'thread';
  /**
   * IANA time zone relative dates are resolved in when the thread names none
   * (`metadata.timeZone`), UTC by default
   */
  timeZone?: string;
  /** Called with the items an extraction wrote */
  afterExtract?: (items: MemoryItem[]) => void | Promise<void>;
}

/** What `MemoryItems.query` finds */
export interface MemoryItemQuery {
  scope: MemoryItemScope;
  kinds?: MemoryItemKind[];
  /** `active` by default */
  statuses?: MemoryItemStatus[];
  slots?: string[];
  entityIds?: string[];
  /**
   * The moment in the world the answer is for: of the items of a slot, those that held then
   * (`validFrom` not after it, `validTo` after it), whatever their status says now. Now by
   * default, so a superseded item is left out.
   */
  asOf?: Date;
  /**
   * The moment of memory the answer is for: items memory had then (`recordedAt` not after it,
   * `expiredAt` after it). Now by default, so an item memory let go is left out.
   */
  knownAt?: Date;
  /** Keep items that no longer hold, for a history of a slot */
  includeClosed?: boolean;
  /** Words every found item holds, matched without case */
  text?: string;
  limit?: number;
}
