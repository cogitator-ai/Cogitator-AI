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
  MemoryFiles,
  REDACTED_CONTENT,
  fileKeyOf,
  sha256Of,
  type MemoryFileAccess,
} from './memory-files';
import { MemoryItems } from './memory-items';
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
  /** Vectors of facts, deleted with them */
  embeddings?: EmbeddingAdapter;
  now?: () => Date;
}

/** Whose memory a cascade looks through: items, files and the graph are kept by agent */
export interface CascadeAgents {
  /** The memory ids of the agents whose items, files, graph and facts stand on the entries */
  agentIds: readonly string[];
}

const CITED = /\[(?:item|lesson):([A-Za-z0-9_-]+)\]/g;

function unwrap<T>(result: MemoryResult<T>): T {
  if (!result.success) throw new Error(result.error);
  return result.data;
}

function emptyReport(): MemoryCascadeReport {
  return {
    entries: { deleted: [], redacted: [] },
    threads: [],
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
    const entries = await this.entriesOf(entryIds);
    if (entries.length === 0) return report;
    const gone = new Set(entries.map((entry) => entry.id));
    await this.dropSummaries(entries, gone, report);
    for (const entry of entries) {
      unwrap(await this.memory.deleteEntry(entry.id));
      report.entries.deleted.push(entry.id);
    }
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
    if (!redact)
      throw new Error(`The ${this.memory.provider} memory adapter cannot redact entries`);
    const report = emptyReport();
    const entries = await this.entriesOf(entryIds);
    if (entries.length === 0) return report;
    const gone = new Set(entries.map((entry) => entry.id));
    await this.dropSummaries(entries, gone, report);
    for (const entry of entries) {
      if (entry.type !== undefined && entry.type !== 'message' && entry.type !== 'tool_result') {
        unwrap(await this.memory.deleteEntry(entry.id));
        report.entries.deleted.push(entry.id);
        continue;
      }
      unwrap(await redact(entry.id, redaction));
      report.entries.redacted.push(entry.id);
    }
    await this.dropDerived(gone, who, report);
    return report;
  }

  /**
   * Deletes the thread with everything that stands on its entries, and the items, entities and
   * memory files kept for the thread alone
   */
  async deleteThread(threadId: string, who: CascadeAgents): Promise<MemoryCascadeReport> {
    const report = emptyReport();
    const thread = unwrap(await this.memory.getThread(threadId));
    if (!thread) return report;
    const entries = unwrap(await this.memory.getEntries({ threadId, types: 'all' }));
    const gone = new Set(entries.map((entry) => entry.id));
    await this.dropDerived(gone, who, report);
    await this.dropScope(who, (scope) => scope.threadId === threadId, report);
    unwrap(await this.memory.deleteThread(threadId));
    report.threads.push(threadId);
    report.entries.deleted.push(...gone);
    return report;
  }

  /**
   * Deletes every thread of `userId` (by its `metadata.userId`) with what stands on them, and
   * every item, entity, memory file, graph node and edge and fact kept for the user
   */
  async deleteUser(userId: string, who: CascadeAgents): Promise<MemoryCascadeReport> {
    const report = emptyReport();
    const threads: string[] = [];
    let cursor: string | undefined;
    do {
      const page = unwrap(
        await this.memory.listThreads({
          metadata: { userId },
          limit: 500,
          ...(cursor !== undefined && { cursor }),
        })
      );
      threads.push(...page.threads.map((thread) => thread.id));
      cursor = page.nextCursor;
    } while (cursor !== undefined);
    for (const threadId of threads) merge(report, await this.deleteThread(threadId, who));
    await this.dropScope(who, (scope) => scope.userId === userId, report);
    await this.dropOwned(who, userId, report);
    return report;
  }

  /**
   * The rewind of `threadId` to `toEntryId` (`MemoryAdapter.rewind`): the entries after it on the
   * active branch stay, on a branch of their own, and the items that stood only on them become
   * `stale` with `staleBecause: { reason: 'rewound' }`
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
    unwrap(await rewind(threadId, toEntryId));
    if (at === -1) return report;
    const cut = new Set(before.slice(at + 1).map((entry) => entry.id));
    if (cut.size === 0 || !this.itemAdapter || !this.items) return report;
    for (const agentId of who.agentIds) {
      const found = unwrap(
        await this.itemAdapter.findItems({ agentId, statuses: ['active', 'suggested'] })
      );
      const cutOff = found.filter((item) => fateOf(item.evidence, cut) === 'gone');
      if (cutOff.length === 0) continue;
      report.items.stale.push(
        ...(await this.items.markStale(
          cutOff.map((item) => item.id),
          { reason: 'rewound', threadId, toEntryId, at: this.now().toISOString() },
          ['active', 'suggested']
        ))
      );
    }
    return report;
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
   * `gone`: covering it on their branch, or quoting it in an atom
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
        if (entry.type !== 'compaction' || gone.has(entry.id)) continue;
        const event = entry.event as CompactionEvent | undefined;
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
        let covers = false;
        let past = event?.firstKeptEntryId === null;
        for (let at = parentOf(entry); at && !covers; at = parentOf(at)) {
          if (past && gone.has(at.id)) covers = true;
          if (at.id === event?.firstKeptEntryId) past = true;
        }
        if (!quoted && !covers) continue;
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
    const purged: string[] = [];
    if (this.itemAdapter && this.items) {
      for (const agentId of who.agentIds) {
        const found = unwrap(await this.itemAdapter.findItems({ agentId, includeExpired: true }));
        const doomed = found.filter((item) => fateOf(item.evidence, gone) === 'gone');
        const trimmed = found.filter((item) => fateOf(item.evidence, gone) === 'trimmed');
        if (doomed.length > 0) {
          await this.items.purge(doomed.map((item) => item.id));
          purged.push(...doomed.map((item) => item.id));
        }
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
    report.items.purged.push(...purged);
    for (const agentId of who.agentIds) {
      await this.dropFacts(agentId, gone, report);
      await this.dropGraph(agentId, gone, report);
    }
    await this.dropFiles(who, gone, new Set(purged), report);
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
      if (doomed.length === 0) continue;
      unwrap(
        await adapter.redactFileVersions(
          doomed.map((version) => version.id),
          {
            content: REDACTED_CONTENT,
            sha256: sha256Of(REDACTED_CONTENT),
            at: this.now(),
            reason: 'its source was forgotten',
          }
        )
      );
      report.fileVersions.push(...doomed.map((version) => version.id));
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
    const purged = new Set<string>();
    if (this.itemAdapter && this.items) {
      for (const agentId of who.agentIds) {
        const found = unwrap(await this.itemAdapter.findItems({ agentId, includeExpired: true }));
        const own = found.filter((item) => belongs(item.scope)).map((item) => item.id);
        if (own.length > 0) {
          await this.items.purge(own);
          for (const id of own) purged.add(id);
          report.items.purged.push(...own);
        }
        const entities = unwrap(await this.itemAdapter.findEntities({ agentId }))
          .filter((entity) => belongs(entity.scope))
          .map((entity) => entity.id);
        if (entities.length > 0) {
          unwrap(await this.itemAdapter.deleteEntities(entities));
          report.entities.push(...entities);
        }
      }
    }
    await this.dropFiles(who, new Set(), purged, report, (version) => belongs(version.scope));
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

function merge(into: MemoryCascadeReport, from: MemoryCascadeReport): void {
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
