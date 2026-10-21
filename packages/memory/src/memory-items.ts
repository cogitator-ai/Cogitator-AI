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

/** The last time an item was recorded, per storage and agent, in this process */
const recorded = new WeakMap<MemoryItemAdapter, Map<string, number>>();

/** Writes in progress, per storage and agent, which the next write of the same agent waits for */
const writing = new WeakMap<MemoryItemAdapter, Map<string, Promise<void>>>();

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

/** How narrow a scope is: a thread's items over a user's, a user's over the agent's */
function narrowness(item: MemoryItem): number {
  return (
    (item.scope.threadId !== undefined ? 4 : 0) +
    (item.scope.projectId !== undefined ? 2 : 0) +
    (item.scope.userId !== undefined ? 1 : 0)
  );
}

/** Whether state `a` of a slot wins over `b`: it started later, or together in a narrower scope */
function laterState(a: MemoryItem, b: MemoryItem): boolean {
  const since = (a.validFrom?.getTime() ?? 0) - (b.validFrom?.getTime() ?? 0);
  return since !== 0 ? since > 0 : narrowness(a) > narrowness(b);
}

/**
 * `items` with one item per slot: the one that started to hold last, of the narrowest scope when
 * two started together, since a run sees a slot's states of its thread, its user and the agent
 * at once
 */
export function onePerSlot(items: readonly MemoryItem[]): MemoryItem[] {
  const bySlot = new Map<string, MemoryItem>();
  const kept: MemoryItem[] = [];
  for (const item of items) {
    if (item.slot === undefined) {
      kept.push(item);
      continue;
    }
    const known = bySlot.get(item.slot);
    if (!known || laterState(item, known)) bySlot.set(item.slot, item);
  }
  return [...kept, ...bySlot.values()];
}

/** The fields of a scope that narrow its agent, which `visibleTo` and `scope` filters compare */
const SCOPE_FIELDS = ['userId', 'projectId', 'threadId'] as const;

/**
 * Whether `item` meets `filter`, for a storage that filters in process. An item memory lets go
 * at a time after `now` (milliseconds, the clock by default) is still found.
 */
export function matchesItemFilter(
  item: MemoryItem,
  filter: MemoryItemFilter,
  now: number = Date.now()
): boolean {
  const { visibleTo, scope } = filter;
  return (
    item.scope.agentId === filter.agentId &&
    (filter.ids === undefined || filter.ids.includes(item.id)) &&
    (filter.slots === undefined || (item.slot !== undefined && filter.slots.includes(item.slot))) &&
    (filter.entityIds === undefined ||
      (item.entityId !== undefined && filter.entityIds.includes(item.entityId))) &&
    (filter.kinds === undefined || filter.kinds.includes(item.kind)) &&
    (filter.statuses === undefined || filter.statuses.includes(item.status)) &&
    (visibleTo === undefined ||
      SCOPE_FIELDS.every(
        (field) => item.scope[field] === undefined || item.scope[field] === visibleTo[field]
      )) &&
    (scope === undefined || SCOPE_FIELDS.every((field) => item.scope[field] === scope[field])) &&
    (filter.includeExpired === true ||
      item.expiredAt === undefined ||
      item.expiredAt.getTime() > now)
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

/**
 * Whether two values of a slot are the same value: the same text up to spaces at the ends and
 * between words. Case and signs count, so `-5` is not `5` and a corrected spelling is a change.
 */
export function sameValue(a: string, b: string): boolean {
  const plain = (value: string) => value.normalize('NFKC').replace(/\s+/g, ' ').trim();
  return plain(a) === plain(b);
}

/** The order states of a slot follow each other in: when each started to hold, then recorded */
function byStart(a: MemoryItem, b: MemoryItem): number {
  return (time(a.validFrom) ?? 0) - (time(b.validFrom) ?? 0) || byRecorded(a, b);
}

/**
 * When each state among `items` stops holding: when the next state of its slot and exact scope
 * starts, among the `active` and `superseded` ones (those let go keep their place). A state with
 * no state after it is not in the map.
 */
function timelineEnds(items: readonly MemoryItem[]): Map<string, number> {
  const slots = new Map<string, MemoryItem[]>();
  for (const item of items) {
    if (item.slot === undefined || (item.status !== 'active' && item.status !== 'superseded')) {
      continue;
    }
    const key = [item.slot, item.scope.userId, item.scope.projectId, item.scope.threadId].join(
      '\u0000'
    );
    slots.set(key, [...(slots.get(key) ?? []), item]);
  }
  const ends = new Map<string, number>();
  for (const states of slots.values()) {
    states.sort(byStart);
    for (const [at, item] of states.entries()) {
      const next = states[at + 1];
      if (next) ends.set(item.id, time(next.validFrom) ?? next.recordedAt.getTime());
    }
  }
  return ends;
}

/** Whether `a` and `b` are laid out the same in the timeline of their slot */
function sameState(a: MemoryItem, b: MemoryItem): boolean {
  return (
    a.status === b.status &&
    time(a.validTo) === time(b.validTo) &&
    a.supersededBy === b.supersededBy &&
    (a.supersedes ?? []).join('\u0000') === (b.supersedes ?? []).join('\u0000')
  );
}

/** First seen first, then by id */
function byFirstSeen(a: MemoryEntity, b: MemoryEntity): number {
  return (
    a.firstSeenAt.getTime() - b.firstSeenAt.getTime() || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)
  );
}

/** Passes a settle makes at most, each after another writer changed the slot meanwhile */
const SETTLE_PASSES = 5;

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
 * Writing only adds. An item said again merges its evidence into the one already there. The
 * `active` items of a slot and scope form its timeline: by when each started to hold, each is
 * closed (`superseded`, `validTo`) when the next one starts, the last one open, so nothing is
 * deleted, a question "as of" an earlier date finds what held then, and an item that tells how
 * things were before (a flashback) takes its place in the past without closing the present. A
 * `suggested` item stays out of the timeline until {@link activate}.
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

  /**
   * Writes `items` in order, see {@link MemoryItems} for the rules, and returns them as kept.
   * Writes of one agent's memory in this process go one after another, so two of the same slot
   * never both stay current and one name never becomes two entities.
   */
  async write(items: readonly NewMemoryItem[]): Promise<MemoryItem[]> {
    const written: MemoryItem[] = [];
    for (const item of items) {
      written.push(await this.exclusive(item.scope.agentId, () => this.writeOne(item)));
    }
    return written;
  }

  /**
   * Now, or a millisecond after the last item of `agentId` this process recorded when the clock
   * has not moved on, so items written one after another never tie in time and the later one
   * stays later in its slot
   */
  private nextRecordedAt(agentId: string): Date {
    let agents = recorded.get(this.adapter);
    if (!agents) {
      agents = new Map();
      recorded.set(this.adapter, agents);
    }
    const at = Math.max(this.now().getTime(), (agents.get(agentId) ?? -Infinity) + 1);
    agents.set(agentId, at);
    return new Date(at);
  }

  /** Runs `work` after every write of `agentId`'s memory before it in this process */
  private async exclusive<T>(agentId: string, work: () => Promise<T>): Promise<T> {
    let agents = writing.get(this.adapter);
    if (!agents) {
      agents = new Map();
      writing.set(this.adapter, agents);
    }
    const before = agents.get(agentId) ?? Promise.resolve();
    const run = before.then(work, work);
    const settled = run.then(
      () => undefined,
      () => undefined
    );
    agents.set(agentId, settled);
    try {
      return await run;
    } finally {
      if (agents.get(agentId) === settled) agents.delete(agentId);
    }
  }

  private async writeOne(input: NewMemoryItem): Promise<MemoryItem> {
    const recordedAt = input.recordedAt ?? this.nextRecordedAt(input.scope.agentId);
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
    const written = unwrap(await this.adapter.putItem(item));
    if (written.slot === undefined) return written;
    if (written.status === 'active') return this.settled(written);
    if (written.kind === 'opinion') await this.weaken(written);
    return written;
  }

  /**
   * The item already kept that `item` says again: of the same scope and kind, open and not let
   * go, with the same words or, in a slot, the same value. In a slot it is only one no other
   * value followed since, so saying a value again after it changed is a new state, not the old
   * one brought back with its old date.
   */
  private async sameItem(item: MemoryItem): Promise<MemoryItem | undefined> {
    const found = unwrap(
      await this.adapter.findItems({
        agentId: item.scope.agentId,
        scope: item.scope,
        ...(item.slot !== undefined ? { slots: [item.slot] } : { kinds: [item.kind] }),
      })
    ).filter((known) => sameScope(known.scope, item.scope));
    const content = normalizeName(item.content);
    const candidates = [...found]
      .reverse()
      .filter(
        (known) =>
          known.kind === item.kind &&
          (known.status === 'active' || known.status === 'suggested') &&
          known.validTo === undefined &&
          known.expiredAt === undefined &&
          (normalizeName(known.content) === content ||
            (item.slot !== undefined &&
              item.value !== undefined &&
              known.value !== undefined &&
              sameValue(known.value, item.value)))
      );
    if (item.slot === undefined) return candidates[0];
    return candidates.find((candidate) => {
      const since = time(candidate.validFrom) ?? 0;
      return !found.some(
        (known) =>
          known.id !== candidate.id &&
          (known.status === 'active' || known.status === 'superseded') &&
          (time(known.validFrom) ?? 0) > since
      );
    });
  }

  /**
   * `item` merged into `known`, the item it says again: the evidence of both, and the trust that
   * comes with the better source of the two (the more trusted one, then the one whose quotes
   * hold), so a quote of one source never vouches for the trust of another and the application's
   * own word is never taken down to a model's. An opinion said
   * again with quotes that hold gains confidence.
   */
  private async merge(known: MemoryItem, item: MemoryItem): Promise<MemoryItem> {
    const itemBetter =
      rank(item.trust) - rank(known.trust) || Number(item.verified) - Number(known.verified);
    const source = itemBetter > 0 ? item : known;
    const confidence =
      known.kind === 'opinion' && item.verified
        ? Math.min(1, Math.max(known.confidence, source.confidence) + OPINION_GAIN)
        : Math.max(known.confidence, source.confidence);
    const merged: MemoryItem = {
      ...known,
      evidence: mergedEvidence(known.evidence, item.evidence),
      trust: source.trust,
      verified: source.verified,
      confidence,
    };
    const status =
      known.status === 'suggested' && this.statusFor(merged) === 'active' ? 'active' : known.status;
    const written = unwrap(await this.adapter.putItem({ ...merged, status }));
    return written.slot !== undefined && status === 'active' ? this.settled(written) : written;
  }

  /** Takes confidence from the open opinions of `item`'s slot a more trusted source holds */
  private async weaken(item: MemoryItem): Promise<void> {
    if (item.slot === undefined) return;
    const held = unwrap(
      await this.adapter.findItems({
        agentId: item.scope.agentId,
        scope: item.scope,
        slots: [item.slot],
        statuses: ['active'],
      })
    ).filter(
      (known) =>
        known.kind === 'opinion' &&
        sameScope(known.scope, item.scope) &&
        known.validTo === undefined &&
        rank(known.trust) > rank(item.trust)
    );
    for (const known of held) {
      unwrap(
        await this.adapter.putItem({
          ...known,
          confidence: Math.max(0, known.confidence - OPINION_LOSS),
        })
      );
    }
  }

  /** `item` as stored once its slot is settled */
  private async settled(item: MemoryItem): Promise<MemoryItem> {
    if (item.slot !== undefined) await this.settle(item.slot, item.scope);
    return unwrap(await this.adapter.getItem(item.id)) ?? item;
  }

  /**
   * Lays the states of `slot` in `scope` out in time: its `active` and `superseded` items memory
   * keeps, by when they started to hold (then when they were recorded, then by id), each closed
   * when the next one starts and `superseded` by it, the last one `active` and open. The layout
   * depends only on the items, so writers that raced, a write after an older one (a flashback
   * told late) and a close that failed half way all end in the same timeline once any of them
   * settles it. A pass that changed something reads again, in case another writer changed the
   * slot meanwhile. An item memory let go keeps its place in the timeline, so forgetting the
   * latest state does not bring the one before it back.
   */
  private async settle(slot: string, scope: MemoryItemScope): Promise<void> {
    for (let pass = 0; pass < SETTLE_PASSES; pass++) {
      const states = unwrap(
        await this.adapter.findItems({
          agentId: scope.agentId,
          scope,
          slots: [slot],
          statuses: ['active', 'superseded'],
          includeExpired: true,
        })
      )
        .filter((item) => sameScope(item.scope, scope))
        .sort(byStart);
      let changed = false;
      for (const [at, item] of states.entries()) {
        const next = states[at + 1];
        const previous = states[at - 1];
        const { validTo: _validTo, supersededBy: _supersededBy, ...open } = item;
        const supersedes =
          previous && !(item.supersedes ?? []).includes(previous.id)
            ? [...(item.supersedes ?? []), previous.id]
            : item.supersedes;
        const laid: MemoryItem = next
          ? {
              ...open,
              ...(supersedes && { supersedes }),
              status: 'superseded',
              validTo: next.validFrom ?? next.recordedAt,
              supersededBy: next.id,
            }
          : { ...open, ...(supersedes && { supersedes }), status: 'active' };
        if (sameState(item, laid)) continue;
        unwrap(await this.adapter.putItem(laid));
        changed = true;
      }
      if (!changed) return;
    }
  }

  /**
   * The entity `name` stands for in `scope`: one `scope` sees (its own, or a broader one such as
   * the user's for a thread), made in `scope` when there is none yet, so a slot of an entity is
   * the same slot in a thread and in the user's memory. When writers raced and
   * made two for one name, every one of them settles on the first made (then by id), and a
   * writer that made another one deletes it before anything stands on it.
   */
  async link(
    scope: MemoryItemScope,
    name: string,
    seenAt: Date = this.now(),
    type?: string
  ): Promise<MemoryEntity> {
    const normalized = normalizeName(name);
    const named = async () =>
      unwrap(await this.adapter.findEntities({ agentId: scope.agentId, names: [normalized] }))
        .filter((entity) => visibleIn(entity, scope))
        .sort(byFirstSeen)[0];
    const found = await named();
    if (found) {
      if (seenAt <= found.lastSeenAt && (!type || found.type)) return found;
      return unwrap(
        await this.adapter.putEntity({
          ...found,
          lastSeenAt: seenAt > found.lastSeenAt ? seenAt : found.lastSeenAt,
          ...(type && !found.type && { type }),
        })
      );
    }
    const made = unwrap(
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
    const first = await named();
    if (!first || first.id === made.id) return made;
    unwrap(await this.adapter.deleteEntities([made.id]));
    return first;
  }

  /**
   * Items `query.scope` sees, see {@link MemoryItemQuery}, oldest recorded first. Which state of
   * a slot holds is worked out from the states memory knew at `knownAt`, laid out in time as
   * {@link settle} lays them out, so a state that a later one is set to close in the future still
   * holds until then, and a correction recorded after `knownAt` does not change what memory knew
   * then.
   */
  async query(query: MemoryItemQuery): Promise<MemoryItem[]> {
    const now = this.now().getTime();
    const knownAt = time(query.knownAt) ?? now;
    const asOf = time(query.asOf) ?? knownAt;
    const found = unwrap(
      await this.adapter.findItems({
        agentId: query.scope.agentId,
        visibleTo: query.scope,
        statuses: query.statuses ?? ['active', 'superseded'],
        includeExpired: true,
        ...(query.kinds && { kinds: query.kinds }),
        ...(query.slots && { slots: query.slots }),
        ...(query.entityIds && { entityIds: query.entityIds }),
      })
    ).filter(
      (item) =>
        visibleIn(item, query.scope) &&
        (query.knownAt === undefined || item.recordedAt.getTime() <= knownAt)
    );
    const ends = timelineEnds(found);
    const words = query.text ? normalizeName(query.text).split(' ').filter(Boolean) : [];
    const matching = found.filter((item) => {
      if (item.expiredAt && item.expiredAt.getTime() <= knownAt) return false;
      if (!query.includeClosed && item.slot !== undefined) {
        if ((time(item.validFrom) ?? 0) > asOf) return false;
        const end = ends.get(item.id);
        if (end !== undefined && end <= asOf) return false;
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
    const found = unwrap(await this.adapter.getItem(itemId));
    if (!found) throw new Error(`No memory item ${itemId}`);
    return this.exclusive(found.scope.agentId, async () => {
      const item = unwrap(await this.adapter.getItem(itemId));
      if (!item) throw new Error(`No memory item ${itemId}`);
      if (item.status === 'active') return item;
      const active = unwrap(await this.adapter.putItem({ ...item, status: 'active' }));
      return this.settled(active);
    });
  }

  /** Marks items as no longer trusted to hold: kept and found by `statuses: ['stale']` */
  async markStale(itemIds: readonly string[]): Promise<void> {
    await this.update(itemIds, (item) => ({ ...item, status: 'stale' }));
  }

  /**
   * Lets items go: they are kept, but no longer found unless asked for as known at an earlier
   * date. A state let go keeps its place in time, so the one before it stays closed.
   */
  async expire(itemIds: readonly string[], at: Date = this.now()): Promise<void> {
    await this.update(itemIds, (item) => (item.expiredAt ? item : { ...item, expiredAt: at }));
  }

  /** Deletes items for good, such as everything a user asked to be forgotten */
  async purge(itemIds: readonly string[]): Promise<void> {
    for (const [agentId, ids] of await this.idsByAgent(itemIds)) {
      await this.exclusive(agentId, async () => unwrap(await this.adapter.deleteItems(ids)));
    }
  }

  /**
   * Counts `itemIds` as gone to a model once more, at `at`: what a run sent in its context, once
   * the run finished or paused for approval, so an item read but never sent does not count
   */
  async noteRetrieved(itemIds: readonly string[], at: Date = this.now()): Promise<void> {
    const ids = [...new Set(itemIds)];
    if (ids.length === 0) return;
    if (this.adapter.countRetrieved) {
      unwrap(await this.adapter.countRetrieved(ids, at));
      return;
    }
    await this.update(ids, (item) => ({
      ...item,
      timesRetrieved: (item.timesRetrieved ?? 0) + 1,
      lastRetrievedAt: at,
    }));
  }

  async get(itemId: string): Promise<MemoryItem | null> {
    return unwrap(await this.adapter.getItem(itemId));
  }

  /**
   * Changes the items under the lock of their agent, each read again under it in one call, so a
   * change never writes back an older state of an item, nor one purged meanwhile
   */
  private async update(
    itemIds: readonly string[],
    change: (item: MemoryItem) => MemoryItem
  ): Promise<void> {
    for (const [agentId, ids] of await this.idsByAgent(itemIds)) {
      await this.exclusive(agentId, async () => {
        const items = unwrap(await this.adapter.findItems({ agentId, ids, includeExpired: true }));
        for (const item of items) unwrap(await this.adapter.putItem(change(item)));
      });
    }
  }

  /** The distinct ids of the items that exist among `itemIds`, by the agent they belong to */
  private async idsByAgent(itemIds: readonly string[]): Promise<Map<string, string[]>> {
    const items = await Promise.all(
      [...new Set(itemIds)].map(async (itemId) => unwrap(await this.adapter.getItem(itemId)))
    );
    const byAgent = new Map<string, string[]>();
    for (const item of items) {
      if (!item) continue;
      const ids = byAgent.get(item.scope.agentId);
      if (ids) ids.push(item.id);
      else byAgent.set(item.scope.agentId, [item.id]);
    }
    return byAgent;
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

/** Whether `adapter` stores memory items, as every built-in memory adapter does */
export function isMemoryItemAdapter<T extends object>(
  adapter: T
): adapter is T & MemoryItemAdapter {
  const candidate = adapter as Partial<MemoryItemAdapter>;
  return (
    typeof candidate.putItem === 'function' &&
    typeof candidate.getItem === 'function' &&
    typeof candidate.findItems === 'function' &&
    typeof candidate.deleteItems === 'function' &&
    typeof candidate.putEntity === 'function' &&
    typeof candidate.findEntities === 'function' &&
    typeof candidate.deleteEntities === 'function'
  );
}
