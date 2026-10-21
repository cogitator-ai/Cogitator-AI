/**
 * Context assembly - shares a token budget among the partitions of a context, so each gets its
 * part and what one leaves unused goes to those that need more
 */

import type {
  ContextPartition,
  ContextPartitionBudget,
  DroppedBlock,
  DroppedReason,
} from '@cogitator-ai/types';

/**
 * Budgets of the partitions when a config sets none: what is required always comes first, the
 * rest share the budget, and `recent` takes whatever the others leave
 */
export const DEFAULT_PARTITIONS: Readonly<Record<ContextPartition, ContextPartitionBudget>> = {
  system: { required: true },
  pinned: { share: 0.1, required: true },
  index: { share: 0.05 },
  summaries: { share: 0.1, required: true },
  facts: { share: 0.1 },
  recall: { share: 0.25 },
  brief: { share: 0.05 },
  recent: {},
  final: { required: true },
};

/** The order partitions are filled in: required first, `recent` last, so it gets what is left */
const FILL_ORDER: readonly ContextPartition[] = [
  'system',
  'final',
  'pinned',
  'summaries',
  'index',
  'brief',
  'facts',
  'recall',
  'recent',
];

/** A piece of a partition with its size */
export interface AssemblyBlock<T> {
  value: T;
  tokens: number;
  /** Text compared with the blocks of other partitions to find what says the same */
  text?: string;
  /** The entry, fact or search result the block came from */
  sourceId?: string;
}

/** What a partition kept of its blocks, and what it left out and why */
export interface FitResult<T> {
  kept: AssemblyBlock<T>[];
  dropped: { block: AssemblyBlock<T>; reason: DroppedReason }[];
  /** Tokens it took, the sum of `kept` unless the fit changed blocks on the way */
  tokens?: number;
}

/** The blocks of one partition, and how they fit a budget when not in order of importance */
export interface PartitionCandidates<T> {
  partition: ContextPartition;
  blocks: AssemblyBlock<T>[];
  /**
   * Fits `blocks` in `budget` tokens. By default blocks are taken in order while they fit, and one
   * that does not is left out while those after it are still tried.
   */
  fit?: (blocks: AssemblyBlock<T>[], budget: number) => FitResult<T> | Promise<FitResult<T>>;
  /** Tokens the partition needs, when its blocks do not say, such as one loaded only once fitted */
  demand?: number;
}

/** What an assembly kept per partition, what it left out, and the tokens it took */
export interface Assembly<T> {
  kept: Partial<Record<ContextPartition, AssemblyBlock<T>[]>>;
  dropped: DroppedBlock[];
  tokens: Partial<Record<ContextPartition, number>>;
  used: number;
}

function normalized(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Text short enough that containing it says little: only the same text counts as a duplicate */
const SHORT_TEXT = 24;

function repeats(text: string, kept: readonly string[]): boolean {
  return kept.some(
    (other) =>
      other === text ||
      (text.length >= SHORT_TEXT && other.includes(text)) ||
      (other.length >= SHORT_TEXT && text.includes(other))
  );
}

/** Takes blocks in order while they fit, leaving out one that does not and trying the next */
export function fitInOrder<T>(blocks: AssemblyBlock<T>[], budget: number): FitResult<T> {
  const result: FitResult<T> = { kept: [], dropped: [] };
  let used = 0;
  for (const block of blocks) {
    if (used + block.tokens <= budget) {
      result.kept.push(block);
      used += block.tokens;
    } else {
      result.dropped.push({ block, reason: block.tokens > budget ? 'oversized' : 'budget' });
    }
  }
  return result;
}

/**
 * Shares a context budget among partitions (see `ContextPartition`). Required partitions get
 * room first. The others get their `share` of the budget, and what a partition does not need
 * goes to those that need more than their share, in proportion to their shares, so no part of
 * the budget sits unused while another partition is cut. Blocks of a partition that say what a
 * block of a more lasting partition says already are left out as duplicates.
 */
export class ContextAssembler {
  private readonly partitions: Record<ContextPartition, ContextPartitionBudget>;

  constructor(partitions: Partial<Record<ContextPartition, ContextPartitionBudget>> = {}) {
    const merged = { ...DEFAULT_PARTITIONS };
    for (const [name, budget] of Object.entries(partitions) as [
      ContextPartition,
      ContextPartitionBudget,
    ][]) {
      if (budget.share !== undefined && !(budget.share >= 0 && budget.share <= 1)) {
        throw new Error(`Context partition ${name} needs a share from 0 to 1, got ${budget.share}`);
      }
      merged[name] = { ...merged[name], ...budget };
    }
    this.partitions = merged;
  }

  /** The budget of `partition` this assembler works with */
  budgetOf(partition: ContextPartition): ContextPartitionBudget {
    return this.partitions[partition];
  }

  async assemble<T>(budget: number, candidates: PartitionCandidates<T>[]): Promise<Assembly<T>> {
    const assembly: Assembly<T> = { kept: {}, dropped: [], tokens: {}, used: 0 };
    const given = new Map(candidates.map((candidate) => [candidate.partition, candidate]));
    const byPartition = new Map<ContextPartition, PartitionCandidates<T>>();
    const seen: string[] = [];
    for (const partition of FILL_ORDER) {
      const candidate = given.get(partition);
      if (!candidate) continue;
      const blocks = candidate.blocks.filter((block) => {
        if (block.text === undefined) return true;
        const text = normalized(block.text);
        if (text.length > 0 && repeats(text, seen)) {
          assembly.dropped.push(this.dropped(partition, block, 'duplicate'));
          return false;
        }
        seen.push(text);
        return true;
      });
      byPartition.set(partition, { ...candidate, blocks });
    }

    const grants = this.grants(budget, byPartition);
    let carried = 0;
    for (const partition of FILL_ORDER) {
      const candidate = byPartition.get(partition);
      if (!candidate) continue;
      const required = this.partitions[partition].required === true;
      const room = required
        ? partition === 'system'
          ? Infinity
          : Math.max(0, budget - assembly.used)
        : Math.min((grants.get(partition) ?? 0) + carried, Math.max(0, budget - assembly.used));
      const fitted = await (candidate.fit ?? fitInOrder)(candidate.blocks, room);
      const tokens = fitted.tokens ?? fitted.kept.reduce((sum, block) => sum + block.tokens, 0);
      assembly.kept[partition] = fitted.kept;
      assembly.tokens[partition] = tokens;
      assembly.used += tokens;
      for (const { block, reason } of fitted.dropped) {
        assembly.dropped.push(this.dropped(partition, block, reason));
      }
      if (!required) carried = Math.max(0, room - tokens);
    }
    return assembly;
  }

  /**
   * The room of each partition that is not required: its share of what the required ones leave,
   * no more than it needs, with what is left over shared again among those that need more
   */
  private grants<T>(
    budget: number,
    byPartition: ReadonlyMap<ContextPartition, PartitionCandidates<T>>
  ): Map<ContextPartition, number> {
    const demand = (candidate: PartitionCandidates<T>) =>
      candidate.demand ?? candidate.blocks.reduce((sum, block) => sum + block.tokens, 0);
    let free = budget;
    const open = new Map<ContextPartition, { share: number; need: number }>();
    const assigned = Object.values(this.partitions).reduce(
      (sum, partition) => sum + (partition.required ? 0 : (partition.share ?? 0)),
      0
    );
    for (const [partition, candidate] of byPartition) {
      const config = this.partitions[partition];
      if (config.required) {
        if (partition !== 'system') free -= demand(candidate);
        continue;
      }
      const share = config.share ?? Math.max(0, 1 - assigned);
      open.set(partition, { share, need: demand(candidate) });
    }
    free = Math.max(0, free);

    const grants = new Map<ContextPartition, number>();
    let left = free;
    while (left > 0 && open.size > 0) {
      const shares = [...open.values()].reduce((sum, { share }) => sum + share, 0);
      if (shares <= 0) break;
      let granted = 0;
      for (const [partition, entry] of open) {
        const offer = Math.floor((left * entry.share) / shares);
        const take = Math.min(offer, entry.need);
        grants.set(partition, (grants.get(partition) ?? 0) + take);
        entry.need -= take;
        granted += take;
        if (entry.need <= 0) open.delete(partition);
      }
      left -= granted;
      if (granted === 0) break;
    }
    return grants;
  }

  private dropped<T>(
    partition: ContextPartition,
    block: AssemblyBlock<T>,
    reason: DroppedReason
  ): DroppedBlock {
    return {
      partition,
      reason,
      tokens: block.tokens,
      ...(block.sourceId !== undefined && { sourceId: block.sourceId }),
    };
  }
}
