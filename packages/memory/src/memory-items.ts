/**
 * Memory items over a {@link MemoryItemAdapter}: every rule of what is written, what holds and
 * who sees it, kept once for every storage
 */

import { nanoid } from 'nanoid';
import type {
  Evidence,
  MemoryEntity,
  MemoryItem,
  MemoryEntityFilter,
  MemoryItemAdapter,
  MemoryItemFilter,
  MemoryItemQuery,
  MemoryItemScope,
  MemoryItemTrust,
  MemoryResult,
  NewMemoryItem,
} from '@cogitator-ai/types';

/** Confidence an item needs to become `active` on its own */
export const DEFAULT_ACTIVATION_CONFIDENCE = 0.7;
/** How much an opinion said again gains, and one said otherwise by a weaker source loses */
export const OPINION_GAIN = 0.1;
export const OPINION_LOSS = 0.2;

const LEADING_ARTICLE = /^(?:the|a|an)\s+/;

/** `text` as memory compares names and values: lower case, single spaces, no article in front */
export function normalizeName(text: string): string {
  return text
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[\s_]+/g, ' ')
    .replace(/^[\s"'`.,;:!?()[\]{}-]+|[\s"'`.,;:!?()[\]{}-]+$/g, '')
    .replace(LEADING_ARTICLE, '');
}

/** The slot of `attribute` of the entity `subject` stands for: `<subject>:<attribute>` */
export function slotOf(subject: string, attribute: string): string {
  return `${subject}:${normalizeName(attribute)}`;
}

/**
 * Whether a run of `scope` sees `item`: the same agent, and for the user, the project and the
 * thread either the same one or none, so an item of one user never reaches another
 */
export function visibleIn(item: Pick<MemoryItem, 'scope'>, scope: MemoryItemScope): boolean {
  return (
    item.scope.agentId === scope.agentId &&
    (item.scope.userId === undefined || item.scope.userId === scope.userId) &&
    (item.scope.projectId === undefined || item.scope.projectId === scope.projectId) &&
    (item.scope.threadId === undefined || item.scope.threadId === scope.threadId)
  );
}

/** Whether `item` meets `filter`, for a storage that filters in process */
export function matchesItemFilter(item: MemoryItem, filter: MemoryItemFilter): boolean {
  return (
    item.scope.agentId === filter.agentId &&
    (filter.ids === undefined || filter.ids.includes(item.id)) &&
    (filter.slots === undefined || (item.slot !== undefined && filter.slots.includes(item.slot))) &&
    (filter.entityIds === undefined ||
      (item.entityId !== undefined && filter.entityIds.includes(item.entityId))) &&
    (filter.kinds === undefined || filter.kinds.includes(item.kind)) &&
    (filter.statuses === undefined || filter.statuses.includes(item.status)) &&
    (filter.includeExpired === true || item.expiredAt === undefined)
  );
}

/** Every name of `entity` normalized, as {@link MemoryEntityFilter.names} matches them */
export function entityNames(entity: Pick<MemoryEntity, 'name' | 'aliases'>): string[] {
  return [...new Set([entity.name, ...entity.aliases].map(normalizeName))];
}

/** Whether `entity` meets `filter`, for a storage that filters in process */
export function matchesEntityFilter(entity: MemoryEntity, filter: MemoryEntityFilter): boolean {
  return (
    entity.scope.agentId === filter.agentId &&
    (filter.ids === undefined || filter.ids.includes(entity.id)) &&
    (filter.names === undefined || entityNames(entity).some((name) => filter.names?.includes(name)))
  );
}

/** Oldest recorded first, then by id, the order a {@link MemoryItemAdapter} finds items in */
export function byRecorded(a: MemoryItem, b: MemoryItem): number {
  return (
    a.recordedAt.getTime() - b.recordedAt.getTime() || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)
  );
}

function sameScope(a: MemoryItemScope, b: MemoryItemScope): boolean {
  return (
    a.agentId === b.agentId &&
    a.userId === b.userId &&
    a.projectId === b.projectId &&
    a.threadId === b.threadId
  );
}

function mergedEvidence(a: Evidence[], b: Evidence[]): Evidence[] {
  const key = (piece: Evidence) => `${piece.entryId ?? ''}\u0000${piece.quote}`;
  const seen = new Set(a.map(key));
  return [...a, ...b.filter((piece) => !seen.has(key(piece)))];
}

const time = (date: Date | undefined) => date?.getTime();

function unwrap<T>(result: MemoryResult<T>): T {
  if (!result.success) throw new Error(result.error);
  return result.data;
}

export interface MemoryItemsConfig {
  adapter: MemoryItemAdapter;
  /** Confidence a `user` or `system` item needs to become `active` (default 0.7) */
  activationConfidence?: number;
  /** The clock, for tests */
  now?: () => Date;
}

/**
 * Memory items with their rules, over any {@link MemoryItemAdapter}.
 *
 * Writing only adds. An item said again merges its evidence into the one already there. An
 * `active` item of a slot closes the `active` item of that slot and scope it follows in the
 * world (`validFrom` not earlier), which becomes `superseded` with `validTo` set, so nothing
 * is deleted and a question "as of" an earlier date still finds it. An item that says how
 * things were before the current one (a flashback) is kept as history and closes nothing. Only
 * an `active` item closes another: a `suggested` one waits beside it until {@link activate}.
 *
 * An item becomes `active` on its own when it comes from the application (`system`), or from
 * the user with quotes that hold, at {@link MemoryItemsConfig.activationConfidence} or above.
 * Everything else stays `suggested`, so what a model, a tool or a page wrote cannot plant
 * itself in memory. An opinion said again gains confidence, and one a weaker source contradicts
 * loses some instead of being replaced.
 */
export class MemoryItems {
  private readonly adapter: MemoryItemAdapter;
  private readonly threshold: number;
  private readonly now: () => Date;

  constructor(config: MemoryItemsConfig) {
    this.adapter = config.adapter;
    this.threshold = config.activationConfidence ?? DEFAULT_ACTIVATION_CONFIDENCE;
    this.now = config.now ?? (() => new Date());
  }

  /** The status `item` gets when it does not name one */
  statusFor(
    item: Pick<NewMemoryItem, 'trust' | 'verified' | 'confidence'>
  ): 'active' | 'suggested' {
    const trusted = item.trust === 'system' || (item.trust === 'user' && item.verified === true);
    return trusted && item.confidence >= this.threshold ? 'active' : 'suggested';
  }

  /** Writes `items` in order, see {@link MemoryItems} for the rules, and returns them as kept */
  async write(items: readonly NewMemoryItem[]): Promise<MemoryItem[]> {
    const written: MemoryItem[] = [];
    for (const item of items) written.push(await this.writeOne(item));
    return written;
  }

  private async writeOne(input: NewMemoryItem): Promise<MemoryItem> {
    const recordedAt = input.recordedAt ?? this.now();
    const entity = input.subject
      ? await this.link(input.scope, input.subject, recordedAt)
      : undefined;
    const slot =
      input.slot ??
      (entity && input.attribute !== undefined ? slotOf(entity.id, input.attribute) : undefined);
    const verified = input.verified ?? false;
    const item: MemoryItem = {
      ...input,
      id: `mem_${nanoid(12)}`,
      ...(entity && { entityId: entity.id }),
      ...(slot !== undefined && {
        slot,
        validFrom: input.validFrom ?? input.about?.start ?? input.sessionAt,
      }),
      verified,
      status: input.status ?? this.statusFor({ ...input, verified }),
      recordedAt,
      evidence: input.evidence,
    };

    const same = await this.sameItem(item);
    if (same) return this.merge(same, item);
    return this.writeState(item);
  }

  /** The item already kept that `item` says again: same scope, kind and words, or slot and value */
  private async sameItem(item: MemoryItem): Promise<MemoryItem | undefined> {
    const found = unwrap(
      await this.adapter.findItems({
        agentId: item.scope.agentId,
        kinds: [item.kind],
        statuses: ['active', 'suggested'],
        ...(item.slot !== undefined && { slots: [item.slot] }),
      })
    );
    const content = normalizeName(item.content);
    return found.find(
      (known) =>
        sameScope(known.scope, item.scope) &&
        known.validTo === undefined &&
        (normalizeName(known.content) === content ||
          (item.slot !== undefined &&
            item.value !== undefined &&
            known.value !== undefined &&
            normalizeName(known.value) === normalizeName(item.value)))
    );
  }

  private async merge(known: MemoryItem, item: MemoryItem): Promise<MemoryItem> {
    const gained =
      known.kind === 'opinion' ? Math.min(1, known.confidence + OPINION_GAIN) : known.confidence;
    const verified = known.verified || item.verified;
    const merged: MemoryItem = {
      ...known,
      evidence: mergedEvidence(known.evidence, item.evidence),
      verified,
      confidence: Math.max(gained, item.confidence),
    };
    const status =
      known.status === 'suggested' && this.statusFor(merged) === 'active' ? 'active' : known.status;
    if (status === 'active' && known.status === 'suggested') {
      return this.writeState({ ...merged, status }, known.id);
    }
    return unwrap(await this.adapter.putItem({ ...merged, status }));
  }

  /**
   * Writes `item` and, when it is an `active` item of a slot, closes what it follows. A
   * `suggested` opinion only weakens the `active` opinions of its slot that come from a more
   * trusted source. `replacing` names the stored item it is, one that became `active` and now
   * supersedes in turn.
   */
  private async writeState(item: MemoryItem, replacing?: string): Promise<MemoryItem> {
    if (item.slot === undefined) return unwrap(await this.adapter.putItem(item));
    const current = unwrap(
      await this.adapter.findItems({
        agentId: item.scope.agentId,
        slots: [item.slot],
        statuses: ['active'],
      })
    ).filter(
      (known) =>
        known.id !== (replacing ?? item.id) &&
        sameScope(known.scope, item.scope) &&
        known.validTo === undefined
    );
    if (item.status !== 'active') {
      if (item.kind === 'opinion') {
        for (const known of current) {
          if (known.kind !== 'opinion' || rank(known.trust) <= rank(item.trust)) continue;
          unwrap(
            await this.adapter.putItem({
              ...known,
              confidence: Math.max(0, known.confidence - OPINION_LOSS),
            })
          );
        }
      }
      return unwrap(await this.adapter.putItem(item));
    }
    const from = time(item.validFrom) ?? 0;
    const follows = current.filter((known) => (time(known.validFrom) ?? 0) <= from);
    const later = current.filter((known) => (time(known.validFrom) ?? 0) > from);

    const earliestLater = later
      .map((known) => known.validFrom)
      .filter((date): date is Date => date !== undefined)
      .sort((a, b) => a.getTime() - b.getTime())[0];
    const kept: MemoryItem = {
      ...item,
      ...(follows.length > 0 && {
        supersedes: [...(item.supersedes ?? []), ...follows.map((known) => known.id)],
      }),
      ...(earliestLater && { validTo: earliestLater }),
    };
    const written = unwrap(await this.adapter.putItem(kept));
    for (const known of follows) {
      await this.adapter.putItem({
        ...known,
        status: 'superseded',
        validTo: item.validFrom ?? item.recordedAt,
        supersededBy: written.id,
      });
    }
    return written;
  }

  /** The entity `name` stands for in `scope`, made when there is none yet */
  async link(
    scope: MemoryItemScope,
    name: string,
    seenAt: Date = this.now(),
    type?: string
  ): Promise<MemoryEntity> {
    const normalized = normalizeName(name);
    const found = unwrap(
      await this.adapter.findEntities({ agentId: scope.agentId, names: [normalized] })
    ).find((entity) => sameScope(entity.scope, scope));
    if (found) {
      const aliases = [found.name, ...found.aliases].some(
        (known) => normalizeName(known) === normalized
      )
        ? found.aliases
        : [...found.aliases, name.trim()];
      return unwrap(
        await this.adapter.putEntity({
          ...found,
          aliases,
          lastSeenAt: seenAt > found.lastSeenAt ? seenAt : found.lastSeenAt,
          ...(type && !found.type && { type }),
        })
      );
    }
    return unwrap(
      await this.adapter.putEntity({
        id: `ent_${nanoid(12)}`,
        scope,
        name: name.trim(),
        aliases: [],
        ...(type && { type }),
        firstSeenAt: seenAt,
        lastSeenAt: seenAt,
      })
    );
  }

  /** Items `query.scope` sees, see {@link MemoryItemQuery}, oldest recorded first */
  async query(query: MemoryItemQuery): Promise<MemoryItem[]> {
    const now = this.now().getTime();
    const asOf = time(query.asOf) ?? now;
    const knownAt = time(query.knownAt) ?? now;
    const past = query.includeClosed || query.asOf !== undefined || query.knownAt !== undefined;
    const found = unwrap(
      await this.adapter.findItems({
        agentId: query.scope.agentId,
        statuses: query.statuses ?? (past ? ['active', 'superseded'] : ['active']),
        includeExpired: query.knownAt !== undefined,
        ...(query.kinds && { kinds: query.kinds }),
        ...(query.slots && { slots: query.slots }),
        ...(query.entityIds && { entityIds: query.entityIds }),
      })
    );
    const words = query.text ? normalizeName(query.text).split(' ').filter(Boolean) : [];
    const matching = found.filter((item) => {
      if (!visibleIn(item, query.scope)) return false;
      if (item.recordedAt.getTime() > knownAt) return false;
      if (item.expiredAt && item.expiredAt.getTime() <= knownAt) return false;
      if (!query.includeClosed && item.slot !== undefined) {
        if ((time(item.validFrom) ?? 0) > asOf) return false;
        if (item.validTo && item.validTo.getTime() <= asOf) return false;
      }
      const text = normalizeName(`${item.content} ${item.value ?? ''}`);
      return words.every((word) => text.includes(word));
    });
    return query.limit === undefined ? matching : matching.slice(-query.limit);
  }

  /** Every item of `slot` `scope` sees, current and closed, by when they started to hold */
  async history(scope: MemoryItemScope, slot: string): Promise<MemoryItem[]> {
    const items = await this.query({
      scope,
      slots: [slot],
      includeClosed: true,
      statuses: ['active', 'superseded'],
    });
    return items.sort((a, b) => (time(a.validFrom) ?? 0) - (time(b.validFrom) ?? 0));
  }

  /** Makes a `suggested` item `active`, such as one the user confirmed, closing what it follows */
  async activate(itemId: string): Promise<MemoryItem> {
    const item = unwrap(await this.adapter.getItem(itemId));
    if (!item) throw new Error(`No memory item ${itemId}`);
    if (item.status === 'active') return item;
    return this.writeState({ ...item, status: 'active' }, item.id);
  }

  /** Marks items as no longer trusted to hold: kept and found by `statuses: ['stale']` */
  async markStale(itemIds: readonly string[]): Promise<void> {
    await this.update(itemIds, (item) => ({ ...item, status: 'stale' }));
  }

  /** Lets items go: they are kept, but no longer found unless asked for as of an earlier date */
  async expire(itemIds: readonly string[], at: Date = this.now()): Promise<void> {
    await this.update(itemIds, (item) => (item.expiredAt ? item : { ...item, expiredAt: at }));
  }

  /** Deletes items for good, such as everything a user asked to be forgotten */
  async purge(itemIds: readonly string[]): Promise<void> {
    if (itemIds.length > 0) unwrap(await this.adapter.deleteItems([...itemIds]));
  }

  async get(itemId: string): Promise<MemoryItem | null> {
    return unwrap(await this.adapter.getItem(itemId));
  }

  private async update(
    itemIds: readonly string[],
    change: (item: MemoryItem) => MemoryItem
  ): Promise<void> {
    for (const itemId of itemIds) {
      const item = unwrap(await this.adapter.getItem(itemId));
      if (item) unwrap(await this.adapter.putItem(change(item)));
    }
  }
}

const TRUST_RANK: Record<MemoryItemTrust, number> = {
  web: 0,
  tool: 1,
  model: 2,
  user: 3,
  system: 4,
};

function rank(trust: MemoryItemTrust): number {
  return TRUST_RANK[trust];
}
