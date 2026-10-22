/**
 * What memory derived from a conversation, followed back to it: when entries are deleted,
 * redacted or cut off by a rewind, everything that stands on them goes with them, in every store
 */

import type {
  CompactionEvent,
  EmbeddingAdapter,
  EntryRedaction,
  Evidence,
  FactAdapter,
  GraphAdapter,
  MemoryAdapter,
  MemoryEntry,
  MemoryFileAdapter,
  MemoryFileVersion,
  MemoryItem,
  MemoryItemAdapter,
  MemoryResult,
} from '@cogitator-ai/types';
import {
  MemoryFileError,
  MemoryFiles,
  REDACTED_CONTENT,
  fileKeyOf,
  sha256Of,
  type MemoryFileAccess,
} from './memory-files';
import { MemoryItems } from './memory-items';
import { FORKS_KEY, MEMORY_USERS_KEY } from './adapters/base';
import { OBSERVATIONS_DIRECTORY } from './memory-observations';
import {
  PLAYBOOK_DRAFT_PATH,
  PLAYBOOK_PATH,
  parsePlaybook,
  playbookFile,
} from './memory-consolidation';

/** What a cascade changed, store by store */
export interface MemoryCascadeReport {
  /** Entries deleted and entries redacted */
  entries: { deleted: string[]; redacted: string[] };
  /** Threads deleted */
  threads: string[];
  /** Threads that lost or had redacted some of their entries */
  threadsChanged: string[];
  /** Compaction entries deleted, their summaries standing on what went */
  summaries: string[];
  /**
   * Memory items: `purged` stood only on what went, `trimmed` lost the quotes of it and keep
   * the rest, `stale` stood only on a branch a rewind cut off
   */
  items: { purged: string[]; trimmed: string[]; stale: string[] };
  /** Entities deleted with the user or thread they belonged to */
  entities: string[];
  /** Facts of a fact store, deleted or trimmed as items are */
  facts: { deleted: string[]; trimmed: string[] };
  /** Nodes and edges of the knowledge graph, deleted or trimmed as items are */
  graph: { nodes: string[]; edges: string[]; trimmed: string[] };
  /** Ids of the memory file versions redacted */
  fileVersions: string[];
  /** Playbook rules taken out, as they stood on a lesson that went */
  playbookRules: number;
}

/** The stores a cascade reaches: the conversation store, and what it can find of the rest */
export interface MemoryCascadeOptions {
  memory: MemoryAdapter;
  /** Memory items, read and changed through {@link MemoryItems} */
  items?: MemoryItemAdapter;
  /** Where memory files are kept, the observations and the playbook among them */
  files?: MemoryFileAdapter;
  graph?: GraphAdapter;
  facts?: FactAdapter;
  /**
   * Where vectors are kept: those of the entries and summaries that go, and of the facts, are
   * deleted from it, whether or not a message index listens to the store
   */
  embeddings?: EmbeddingAdapter;
  now?: () => Date;
}

/** Whose memory a cascade looks through: items, files and the graph are kept by agent */
export interface CascadeAgents {
  /** The memory ids of the agents whose items, files, graph and facts stand on the entries */
  agentIds: readonly string[];
  /**
   * Leave the replies to a user message alone. By default deleting or redacting a user message
   * takes the entries that answer it too (on every branch, up to the next user message), as an
   * answer may say again what the message said.
   */
  keepReplies?: boolean;
}

const CITED = /\[(?:item|lesson):([A-Za-z0-9_-]+)\]/g;

/** Why a cascade redacts a file version, which also tells its paths to go */
const FORGOTTEN = 'its source was forgotten';

function unwrap<T>(result: MemoryResult<T>): T {
  if (!result.success) throw new Error(result.error);
  return result.data;
}

function emptyReport(): MemoryCascadeReport {
  return {
    entries: { deleted: [], redacted: [] },
    threads: [],
    threadsChanged: [],
    summaries: [],
    items: { purged: [], trimmed: [], stale: [] },
    entities: [],
    facts: { deleted: [], trimmed: [] },
    graph: { nodes: [], edges: [], trimmed: [] },
    fileVersions: [],
    playbookRules: 0,
  };
}

/** What becomes of a piece of derived memory when the entries in `gone` go */
type Fate = 'untouched' | 'trimmed' | 'gone';

/** Whether `evidence` stands on entries of `gone`, all of it or a part */
function fateOf(evidence: readonly Evidence[] | undefined, gone: ReadonlySet<string>): Fate {
  if (!evidence || evidence.length === 0) return 'untouched';
  const lost = evidence.filter((piece) => piece.entryId !== undefined && gone.has(piece.entryId));
  if (lost.length === 0) return 'untouched';
  return lost.length === evidence.length ? 'gone' : 'trimmed';
}

const keptOf = (evidence: readonly Evidence[], gone: ReadonlySet<string>) =>
  evidence.filter((piece) => piece.entryId === undefined || !gone.has(piece.entryId));

/** The ids of the items and lessons a memory file names */
function citedIn(content: string | null): Set<string> {
  return new Set(content ? [...content.matchAll(CITED)].map((match) => match[1] ?? '') : []);
}

/**
 * Lineage cascades over memory, see `Cogitator.forget`, `Cogitator.redactEntries` and
 * `Cogitator.rewind`.
 *
 * Deleting or redacting entries takes with them every compaction summary that covers one (the
 * entries before its first kept entry on its branch, or an atom quoting one), so the next
 * compaction writes it again, the memory items, facts and graph nodes and edges that stand only on
 * them (and the quotes of them those that stand on more keep), the vectors of the entries (the
 * store reports the change to its index), the memory file versions written at them, and every
 * version of an observation or a playbook that names an item that went. A playbook in front
 * loses the rules that stood on a lesson that went in a new version. A rewind deletes nothing:
 * the items that stood only on the branch it cut off become `stale`.
 */
export class MemoryCascade {
  private readonly memory: MemoryAdapter;
  private readonly itemAdapter?: MemoryItemAdapter;
  private readonly items?: MemoryItems;
  private readonly fileAdapter?: MemoryFileAdapter;
  private readonly files?: MemoryFiles;
  private readonly graph?: GraphAdapter;
  private readonly facts?: FactAdapter;
  private readonly embeddings?: EmbeddingAdapter;
  private readonly now: () => Date;

  constructor(options: MemoryCascadeOptions) {
    this.memory = options.memory;
    this.now = options.now ?? (() => new Date());
    if (options.items) {
      this.itemAdapter = options.items;
      this.items = new MemoryItems({ adapter: options.items, now: this.now });
    }
    if (options.files) {
      this.fileAdapter = options.files;
      this.files = new MemoryFiles({ adapter: options.files, now: this.now });
    }
    if (options.graph) this.graph = options.graph;
    if (options.facts) this.facts = options.facts;
    if (options.embeddings) this.embeddings = options.embeddings;
  }

  /** Deletes `entryIds` and everything that stands on them, see {@link MemoryCascade} */
  async deleteEntries(
    entryIds: readonly string[],
    who: CascadeAgents
  ): Promise<MemoryCascadeReport> {
    const report = emptyReport();
    const entries = await this.expand(await this.entriesOf(entryIds), who);
    if (entries.length === 0) return report;
    const gone = new Set(entries.map((entry) => entry.id));
    await this.dropSummaries(entries, gone, report);
    await this.dropDerived(gone, who, report);
    for (const entry of [...entries].reverse()) {
      unwrap(await this.memory.deleteEntry(entry.id));
      report.entries.deleted.push(entry.id);
    }
    noteThreads(report, entries);
    await this.dropDerived(gone, who, report);
    return report;
  }

  /**
   * Redacts `entryIds` in place (`MemoryAdapter.redactEntry`) and takes away everything that
   * stands on what they said, see {@link MemoryCascade}
   */
  async redactEntries(
    entryIds: readonly string[],
    redaction: EntryRedaction,
    who: CascadeAgents
  ): Promise<MemoryCascadeReport> {
    const redact = this.memory.redactEntry?.bind(this.memory);
    if (!redact) {
      throw new Error(`The ${this.memory.provider} memory adapter cannot redact entries`);
    }
    const report = emptyReport();
    const entries = await this.expand(await this.entriesOf(entryIds), who);
    if (entries.length === 0) return report;
    const gone = new Set(entries.map((entry) => entry.id));
    await this.dropSummaries(entries, gone, report);
    await this.dropDerived(gone, who, report);
    for (const entry of entries) {
      if (entry.type !== undefined && entry.type !== 'message' && entry.type !== 'tool_result') {
        unwrap(await this.memory.deleteEntry(entry.id));
        report.entries.deleted.push(entry.id);
        continue;
      }
      unwrap(await redact(entry.id, redaction));
      report.entries.redacted.push(entry.id);
    }
    noteThreads(report, entries);
    await this.dropDerived(gone, who, report);
    return report;
  }

  /**
   * Deletes the thread with everything that stands on its entries, the copies of them in threads
   * forked from it, and the items, entities and memory files kept for the thread alone
   */
  async deleteThread(threadId: string, who: CascadeAgents): Promise<MemoryCascadeReport> {
    const report = emptyReport();
    const thread = unwrap(await this.memory.getThread(threadId));
    if (!thread) return report;
    const entries = unwrap(await this.memory.getEntries({ threadId, types: 'all' }));
    const copies = (await this.withCopies(entries)).filter((entry) => entry.threadId !== threadId);
    if (copies.length > 0) {
      merge(
        report,
        await this.deleteEntries(
          copies.map((entry) => entry.id),
          who
        )
      );
    }
    const gone = new Set(entries.map((entry) => entry.id));
    await this.dropDerived(gone, who, report);
    await this.dropScope(who, (scope) => scope.threadId === threadId, report);
    unwrap(await this.memory.deleteThread(threadId));
    report.threads.push(threadId);
    report.entries.deleted.push(...gone);
    return report;
  }

  /**
   * Deletes every thread of `userId` (by its `metadata.userId`) with what stands on them, the
   * messages the user wrote in threads of others (those that list the user in
   * `metadata.memoryUserIds`) with their replies, and every item, entity, memory file, graph node
   * and edge and fact kept for the user. A thread of the user is deleted whole, the messages
   * others wrote in it too.
   */
  async deleteUser(userId: string, who: CascadeAgents): Promise<MemoryCascadeReport> {
    const report = emptyReport();
    const own: string[] = [];
    const visited: string[] = [];
    let cursor: string | undefined;
    do {
      const page = unwrap(
        await this.memory.listThreads({ limit: 500, ...(cursor !== undefined && { cursor }) })
      );
      for (const thread of page.threads) {
        if (thread.metadata.userId === userId) own.push(thread.id);
        else if (listed(thread.metadata[MEMORY_USERS_KEY]).includes(userId)) {
          visited.push(thread.id);
        }
      }
      cursor = page.nextCursor;
    } while (cursor !== undefined);
    for (const threadId of visited) {
      const written = unwrap(await this.memory.getEntries({ threadId }))
        .filter((entry) => entry.message.role === 'user' && entry.metadata?.userId === userId)
        .map((entry) => entry.id);
      if (written.length > 0) merge(report, await this.deleteEntries(written, who));
    }
    for (const threadId of own) merge(report, await this.deleteThread(threadId, who));
    await this.dropScope(who, (scope) => scope.userId === userId, report);
    await this.dropOwned(who, userId, report);
    return report;
  }

  /**
   * The rewind of `threadId` to `toEntryId` (`MemoryAdapter.rewind`): the entries after it on the
   * active branch stay, on a branch of their own, and the items that stood only on them become
   * `stale` with `staleBecause: { reason: 'rewound' }`. They are marked before the thread moves,
   * and as they were again when the store refuses the rewind, such as for an entry another
   * checkout took off the active branch meanwhile. A thread that stands at `toEntryId` already is
   * left as it is.
   */
  async rewind(
    threadId: string,
    toEntryId: string,
    who: CascadeAgents
  ): Promise<MemoryCascadeReport> {
    const rewind = this.memory.rewind?.bind(this.memory);
    const getPath = this.memory.getPath?.bind(this.memory);
    if (!rewind || !getPath) {
      throw new Error(`The ${this.memory.provider} memory adapter has no branches to rewind`);
    }
    const report = emptyReport();
    const before = unwrap(await getPath({ threadId, types: 'all' }));
    const at = before.findIndex((entry) => entry.id === toEntryId);
    const cut = new Set(at === -1 ? [] : before.slice(at + 1).map((entry) => entry.id));
    if (cut.size === 0 || !this.itemAdapter || !this.items) {
      unwrap(await rewind(threadId, toEntryId));
      return report;
    }
    const marked: MemoryItem[] = [];
    for (const agentId of who.agentIds) {
      const found = unwrap(
        await this.itemAdapter.findItems({ agentId, statuses: ['active', 'suggested'] })
      );
      const cutOff = found.filter((item) => fateOf(item.evidence, cut) === 'gone');
      if (cutOff.length === 0) continue;
      const stale = new Set(
        await this.items.markStale(
          cutOff.map((item) => item.id),
          { reason: 'rewound', threadId, toEntryId, at: this.now().toISOString() },
          ['active', 'suggested']
        )
      );
      marked.push(...cutOff.filter((item) => stale.has(item.id)));
    }
    const moved = await rewind(threadId, toEntryId);
    if (!moved.success) {
      for (const item of marked) unwrap(await this.itemAdapter.putItem(item));
      throw new Error(moved.error);
    }
    report.items.stale.push(...marked.map((item) => item.id));
    return report;
  }

  /** `entries` with their replies and the copies of all of them in forks, and their replies */
  private async expand(
    entries: readonly MemoryEntry[],
    who: CascadeAgents
  ): Promise<MemoryEntry[]> {
    return this.withReplies(await this.withCopies(await this.withReplies(entries, who)), who);
  }

  /**
   * `entries` with their copies in the threads forked from theirs (`metadata.forks`), and the
   * copies of those in their forks in turn
   */
  private async withCopies(entries: readonly MemoryEntry[]): Promise<MemoryEntry[]> {
    const all = new Map(entries.map((entry) => [entry.id, entry]));
    const queue = [...new Set(entries.map((entry) => entry.threadId))];
    const seen = new Set(queue);
    for (let threadId = queue.pop(); threadId !== undefined; threadId = queue.pop()) {
      const thread = unwrap(await this.memory.getThread(threadId));
      for (const forkId of listed(thread?.metadata[FORKS_KEY])) {
        if (seen.has(forkId)) continue;
        seen.add(forkId);
        const fork = await this.memory.getEntries({ threadId: forkId, types: 'all' });
        if (!fork.success) continue;
        let found = false;
        for (const entry of fork.data) {
          const origin = entry.metadata?.forkOf;
          if (typeof origin !== 'string' || !all.has(origin) || all.has(entry.id)) continue;
          all.set(entry.id, entry);
          found = true;
        }
        if (found) queue.push(forkId);
      }
    }
    return [...all.values()];
  }

  /**
   * `entries` with, unless `who.keepReplies`, the entries that answer each user message among
   * them: its descendants on every branch up to the next user message, events such as a model
   * change or an approval among them, a compaction passed over and left to the summary check
   */
  private async withReplies(
    entries: readonly MemoryEntry[],
    who: CascadeAgents
  ): Promise<MemoryEntry[]> {
    const asked = entries.filter((entry) => entry.message.role === 'user');
    if (who.keepReplies || asked.length === 0) return [...entries];
    const all = new Map(entries.map((entry) => [entry.id, entry]));
    for (const threadId of new Set(asked.map((entry) => entry.threadId))) {
      const children = await this.childrenOf(threadId);
      const queue = asked.filter((entry) => entry.threadId === threadId).map((entry) => entry.id);
      const seen = new Set(queue);
      for (let id = queue.pop(); id !== undefined; id = queue.pop()) {
        for (const child of children.get(id) ?? []) {
          if (seen.has(child.id)) continue;
          seen.add(child.id);
          const conversation =
            child.type === undefined || child.type === 'message' || child.type === 'tool_result';
          if (conversation && child.message.role === 'user') continue;
          if (child.type !== 'compaction') all.set(child.id, child);
          queue.push(child.id);
        }
      }
    }
    return [...all.values()];
  }

  /** The entries of `threadId` by the entry they follow */
  private async childrenOf(threadId: string): Promise<Map<string, MemoryEntry[]>> {
    const children = new Map<string, MemoryEntry[]>();
    for (const entry of unwrap(await this.memory.getEntries({ threadId, types: 'all' }))) {
      if (!entry.parentId) continue;
      children.set(entry.parentId, [...(children.get(entry.parentId) ?? []), entry]);
    }
    return children;
  }

  private async entriesOf(entryIds: readonly string[]): Promise<MemoryEntry[]> {
    const entries: MemoryEntry[] = [];
    for (const entryId of new Set(entryIds)) {
      const entry = unwrap(await this.memory.getEntry(entryId));
      if (entry) entries.push(entry);
    }
    return entries;
  }

  /**
   * Deletes the compaction entries of the threads of `entries` whose summary stands on one of
   * `gone`: covering it on their branch (the entries before its first kept one, else from its
   * last left out one back, else, when neither is found, every entry before it), or quoting it in
   * an atom
   */
  private async dropSummaries(
    entries: readonly MemoryEntry[],
    gone: ReadonlySet<string>,
    report: MemoryCascadeReport
  ): Promise<void> {
    for (const threadId of new Set(entries.map((entry) => entry.threadId))) {
      const all = unwrap(await this.memory.getEntries({ threadId, types: 'all' }));
      const byId = new Map(all.map((entry) => [entry.id, entry]));
      const parentOf = (entry: MemoryEntry) =>
        entry.parentId === undefined || entry.parentId === null
          ? undefined
          : byId.get(entry.parentId);
      for (const entry of all) {
        const legacy = entry.metadata?.compactionSummary === true;
        if ((entry.type !== 'compaction' && !legacy) || gone.has(entry.id)) continue;
        const event = (legacy ? { levels: entry.metadata?.compactionLevels } : entry.event) as
          CompactionEvent | undefined;
        const quoted = [
          ...(event?.levels?.saga ? [event.levels.saga] : []),
          ...(event?.levels?.arcs ?? []),
          ...(event?.levels?.chapters ?? []),
        ].some(
          (node) =>
            gone.has(node.from) ||
            gone.has(node.to) ||
            node.atoms.some((atom) => fateOf(atom.evidence, gone) !== 'untouched')
        );
        const ancestors: MemoryEntry[] = [];
        for (let at = parentOf(entry); at; at = parentOf(at)) ancestors.push(at);
        const kept = ancestors.findIndex((at) => at.id === event?.firstKeptEntryId);
        const last = ancestors.findIndex((at) => at.id === event?.lastCompactedEntryId);
        const from = kept !== -1 ? kept + 1 : last !== -1 ? last : 0;
        const covers = !legacy && ancestors.slice(from).some((at) => gone.has(at.id));
        if (!quoted && !covers) continue;
        if (this.embeddings) unwrap(await this.embeddings.deleteBySource(entry.id));
        unwrap(await this.memory.deleteEntry(entry.id));
        report.summaries.push(entry.id);
      }
    }
  }

  /** Takes away what stands on `gone` in the item, fact, graph and file stores */
  private async dropDerived(
    gone: ReadonlySet<string>,
    who: CascadeAgents,
    report: MemoryCascadeReport
  ): Promise<void> {
    if (gone.size === 0) return;
    if (this.embeddings) {
      for (const entryId of gone) unwrap(await this.embeddings.deleteBySource(entryId));
    }
    const doomed = new Map<string, MemoryItem[]>();
    if (this.itemAdapter && this.items) {
      for (const agentId of who.agentIds) {
        const found = unwrap(await this.itemAdapter.findItems({ agentId, includeExpired: true }));
        doomed.set(
          agentId,
          found.filter((item) => fateOf(item.evidence, gone) === 'gone')
        );
        const trimmed = found.filter((item) => fateOf(item.evidence, gone) === 'trimmed');
        if (trimmed.length > 0) {
          report.items.trimmed.push(
            ...(await this.items.reviseEvidence(
              trimmed.map((item) => item.id),
              (piece) => piece.entryId === undefined || !gone.has(piece.entryId)
            ))
          );
        }
      }
    }
    const purged = [...doomed.values()].flat();
    await this.dropFiles(who, gone, new Set(purged.map((item) => item.id)), report);
    for (const agentId of who.agentIds) {
      await this.dropFacts(agentId, gone, report);
      await this.dropGraph(agentId, gone, report);
    }
    await this.purgeItems(purged, report);
  }

  /**
   * Purges `items` (after what names them went, so a cascade made again still finds it), and
   * deletes the entities no item is about any more
   */
  private async purgeItems(
    items: readonly MemoryItem[],
    report: MemoryCascadeReport
  ): Promise<void> {
    if (!this.items || !this.itemAdapter || items.length === 0) return;
    await this.items.purge(items.map((item) => item.id));
    report.items.purged.push(...items.map((item) => item.id));
    const byAgent = new Map<string, Set<string>>();
    for (const item of items) {
      if (item.entityId === undefined) continue;
      const entities = byAgent.get(item.scope.agentId) ?? new Set<string>();
      entities.add(item.entityId);
      byAgent.set(item.scope.agentId, entities);
    }
    for (const [agentId, entities] of byAgent) {
      const left = unwrap(
        await this.itemAdapter.findItems({
          agentId,
          entityIds: [...entities],
          includeExpired: true,
        })
      );
      const kept = new Set(left.flatMap((item) => (item.entityId ? [item.entityId] : [])));
      const orphans = [...entities].filter((id) => !kept.has(id));
      if (orphans.length === 0) continue;
      unwrap(await this.itemAdapter.deleteEntities(orphans));
      report.entities.push(...orphans);
    }
  }

  private async dropFacts(
    agentId: string,
    gone: ReadonlySet<string>,
    report: MemoryCascadeReport,
    owned?: (metadata: Record<string, unknown> | undefined) => boolean
  ): Promise<void> {
    if (!this.facts) return;
    for (const fact of unwrap(await this.facts.getFacts(agentId))) {
      const fate = owned?.(fact.metadata) ? 'gone' : fateOf(fact.evidence, gone);
      if (fate === 'untouched') continue;
      if (fate === 'gone') {
        unwrap(await this.facts.deleteFact(fact.id));
        if (this.embeddings) unwrap(await this.embeddings.deleteBySource(fact.id));
        report.facts.deleted.push(fact.id);
      } else {
        unwrap(
          await this.facts.updateFact(fact.id, { evidence: keptOf(fact.evidence ?? [], gone) })
        );
        report.facts.trimmed.push(fact.id);
      }
    }
  }

  private async dropGraph(
    agentId: string,
    gone: ReadonlySet<string>,
    report: MemoryCascadeReport,
    owned?: (metadata: Record<string, unknown> | undefined) => boolean
  ): Promise<void> {
    const graph = this.graph;
    if (!graph) return;
    for (const edge of unwrap(await graph.queryEdges({ agentId }))) {
      const fate = owned?.(edge.metadata) ? 'gone' : fateOf(edge.evidence, gone);
      if (fate === 'gone') {
        unwrap(await graph.deleteEdge(edge.id));
        report.graph.edges.push(edge.id);
      } else if (fate === 'trimmed') {
        unwrap(await graph.updateEdge(edge.id, { evidence: keptOf(edge.evidence ?? [], gone) }));
        report.graph.trimmed.push(edge.id);
      }
    }
    for (const node of unwrap(await graph.queryNodes({ agentId }))) {
      const fate = owned?.(node.metadata) ? 'gone' : fateOf(node.evidence, gone);
      if (fate === 'gone') {
        unwrap(await graph.deleteNode(node.id));
        report.graph.nodes.push(node.id);
      } else if (fate === 'trimmed') {
        unwrap(await graph.updateNode(node.id, { evidence: keptOf(node.evidence ?? [], gone) }));
        report.graph.trimmed.push(node.id);
      }
    }
  }

  /**
   * Redacts the file versions written at an entry of `gone`, and every version of an observation
   * or a playbook that names an item of `purged`. A playbook or observation in front that names
   * one is written again first, without the rules or the statements that stood on it.
   */
  private async dropFiles(
    who: CascadeAgents,
    gone: ReadonlySet<string>,
    purged: ReadonlySet<string>,
    report: MemoryCascadeReport,
    owned?: (version: MemoryFileVersion) => boolean
  ): Promise<void> {
    const adapter = this.fileAdapter;
    const files = this.files;
    if (!adapter || !files) return;
    for (const agentId of who.agentIds) {
      const versions = unwrap(await adapter.findFileVersions({ agentId }));
      const derived = (version: MemoryFileVersion) =>
        version.path === PLAYBOOK_PATH ||
        version.path === PLAYBOOK_DRAFT_PATH ||
        version.path.startsWith(`${OBSERVATIONS_DIRECTORY}/`);
      const names = (version: MemoryFileVersion) =>
        derived(version) && [...citedIn(version.content)].some((id) => purged.has(id));
      if (purged.size > 0) {
        report.playbookRules += await this.rewritePlaybooks(versions, purged);
      }
      const doomed = versions.filter(
        (version) =>
          version.content !== null &&
          version.redacted === undefined &&
          (owned?.(version) ||
            (version.place !== undefined && gone.has(version.place.entryId)) ||
            names(version))
      );
      if (doomed.length > 0) {
        unwrap(
          await adapter.redactFileVersions(
            doomed.map((version) => version.id),
            {
              content: REDACTED_CONTENT,
              sha256: sha256Of(REDACTED_CONTENT),
              at: this.now(),
              reason: FORGOTTEN,
            }
          )
        );
        report.fileVersions.push(...doomed.map((version) => version.id));
      }
      await this.dropForgottenPaths(agentId);
    }
  }

  /**
   * Deletes the files of `agentId` whose version in front a cascade redacted and that keep no
   * text in any version, on any branch, so their paths, which may name what was forgotten, leave
   * the listing too. A file another branch still holds text of keeps its path.
   */
  private async dropForgottenPaths(agentId: string): Promise<void> {
    const adapter = this.fileAdapter;
    const files = this.files;
    if (!adapter || !files) return;
    const byKey = new Map<string, MemoryFileVersion[]>();
    for (const version of unwrap(await adapter.findFileVersions({ agentId }))) {
      const key = fileKeyOf(version.scope, version.path);
      byKey.set(key, [...(byKey.get(key) ?? []), version]);
    }
    for (const versions of byKey.values()) {
      const held = versions.filter((version) => version.content !== null);
      const front = [...versions].sort((a, b) => b.sequence - a.sequence)[0];
      if (!front || front.content === null || front.redacted?.reason !== FORGOTTEN) continue;
      if (!held.every((version) => version.redacted !== undefined)) continue;
      const access: MemoryFileAccess = {
        scope: front.scope,
        visibleTo: front.scope,
        author: 'system',
      };
      try {
        await files.delete(access, front.path, front.sha256 ?? undefined);
      } catch (error) {
        if (!(error instanceof MemoryFileError)) throw error;
      }
    }
  }

  /**
   * Writes again each playbook in front that names a lesson of `purged`, without the rules that
   * stood on it, so redacting its older versions leaves the other rules in place. Returns the
   * rules taken out.
   */
  private async rewritePlaybooks(
    versions: readonly MemoryFileVersion[],
    purged: ReadonlySet<string>
  ): Promise<number> {
    const files = this.files;
    if (!files) return 0;
    const fronts = new Map<string, MemoryFileVersion>();
    for (const version of versions) {
      if (version.path !== PLAYBOOK_PATH) continue;
      const key = fileKeyOf(version.scope, version.path);
      const known = fronts.get(key);
      if (!known || version.sequence > known.sequence) fronts.set(key, version);
    }
    let removed = 0;
    for (const front of fronts.values()) {
      if (front.content === null || front.author === 'model') continue;
      const playbook = parsePlaybook(front.content);
      const rules = playbook.rules.filter((rule) =>
        [...citedIn(rule)].every((id) => !purged.has(id))
      );
      if (rules.length === playbook.rules.length) continue;
      const access: MemoryFileAccess = {
        scope: front.scope,
        visibleTo: front.scope,
        author: 'system',
      };
      await files.put(
        access,
        PLAYBOOK_PATH,
        playbookFile({ ...playbook, rules }),
        front.sha256 ?? sha256Of(front.content)
      );
      removed += playbook.rules.length - rules.length;
    }
    return removed;
  }

  /** Purges the items and deletes the entities and file versions whose scope `belongs` takes */
  private async dropScope(
    who: CascadeAgents,
    belongs: (scope: MemoryItem['scope']) => boolean,
    report: MemoryCascadeReport
  ): Promise<void> {
    const own: MemoryItem[] = [];
    if (this.itemAdapter) {
      for (const agentId of who.agentIds) {
        const found = unwrap(await this.itemAdapter.findItems({ agentId, includeExpired: true }));
        own.push(...found.filter((item) => belongs(item.scope)));
      }
    }
    await this.dropFiles(who, new Set(), new Set(own.map((item) => item.id)), report, (version) =>
      belongs(version.scope)
    );
    await this.purgeItems(own, report);
    if (this.itemAdapter) {
      for (const agentId of who.agentIds) {
        const entities = unwrap(await this.itemAdapter.findEntities({ agentId }))
          .filter((entity) => belongs(entity.scope))
          .map((entity) => entity.id);
        if (entities.length > 0) {
          unwrap(await this.itemAdapter.deleteEntities(entities));
          report.entities.push(...entities.filter((id) => !report.entities.includes(id)));
        }
      }
    }
  }

  /** Deletes the facts, graph nodes and edges whose `metadata.userId` is `userId` */
  private async dropOwned(
    who: CascadeAgents,
    userId: string,
    report: MemoryCascadeReport
  ): Promise<void> {
    const owned = (metadata: Record<string, unknown> | undefined) => metadata?.userId === userId;
    for (const agentId of who.agentIds) {
      await this.dropFacts(agentId, new Set(), report, owned);
      await this.dropGraph(agentId, new Set(), report, owned);
    }
    if (this.embeddings?.deleteByFilter) {
      unwrap(await this.embeddings.deleteByFilter({ metadata: { userId } }));
    }
  }
}

/** The strings of a metadata list */
function listed(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((id): id is string => typeof id === 'string') : [];
}

/** Notes the threads of `entries` as changed */
function noteThreads(report: MemoryCascadeReport, entries: readonly MemoryEntry[]): void {
  for (const threadId of new Set(entries.map((entry) => entry.threadId))) {
    if (!report.threadsChanged.includes(threadId)) report.threadsChanged.push(threadId);
  }
}

function merge(into: MemoryCascadeReport, from: MemoryCascadeReport): void {
  for (const threadId of from.threadsChanged) {
    if (!into.threadsChanged.includes(threadId)) into.threadsChanged.push(threadId);
  }
  into.entries.deleted.push(...from.entries.deleted);
  into.entries.redacted.push(...from.entries.redacted);
  into.threads.push(...from.threads);
  into.summaries.push(...from.summaries);
  into.items.purged.push(...from.items.purged);
  into.items.trimmed.push(...from.items.trimmed);
  into.items.stale.push(...from.items.stale);
  into.entities.push(...from.entities);
  into.facts.deleted.push(...from.facts.deleted);
  into.facts.trimmed.push(...from.facts.trimmed);
  into.graph.nodes.push(...from.graph.nodes);
  into.graph.edges.push(...from.graph.edges);
  into.graph.trimmed.push(...from.graph.trimmed);
  into.fileVersions.push(...from.fileVersions);
  into.playbookRules += from.playbookRules;
}
