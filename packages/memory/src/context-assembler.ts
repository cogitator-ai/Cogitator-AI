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
  pinned: { required: true },
  index: { required: true },
  summaries: { required: true },
  facts: { share: 0.15 },
  recall: { share: 0.35 },
  brief: { required: true },
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

/**
 * `text` compared for repeats: case, spacing and the punctuation between words aside, while signs
 * that change what it says, such as a minus, a currency or a percent, stay
 */
function normalized(text: string): string {
  return text
    .toLowerCase()
    .replace(/[.,;:!?"'()[\]{}]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Text short enough that containing it says little: only the same text counts as a duplicate */
const SHORT_TEXT = 24;

/** Whether `kept` says all of `text` already: the same text, or one that holds it whole */
function repeats(text: string, kept: readonly string[]): boolean {
  return kept.some(
    (other) => other === text || (text.length >= SHORT_TEXT && ` ${other} `.includes(` ${text} `))
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
    const shared = Object.values(merged).reduce(
      (sum, partition) => sum + (partition.required ? 0 : (partition.share ?? 0)),
      0
    );
    if (shared > 1) {
      throw new Error(`The shares of the context partitions add up to ${shared}, more than 1`);
    }
    this.partitions = merged;
  }

  /** The budget of `partition` this assembler works with */
  budgetOf(partition: ContextPartition): ContextPartitionBudget {
    return this.partitions[partition];
  }

  async assemble<T>(budget: number, candidates: PartitionCandidates<T>[]): Promise<Assembly<T>> {
    const assembly: Assembly<T> = { kept: {}, dropped: [], tokens: {}, used: 0 };
    const byPartition = new Map(candidates.map((candidate) => [candidate.partition, candidate]));
    const said: string[] = [];
    const isRequired = (partition: ContextPartition) =>
      this.partitions[partition].required === true;

    const filled = new Map<ContextPartition, { blocks: AssemblyBlock<T>[]; cut: boolean }>();
    const fill = async (partition: ContextPartition, room: number): Promise<number> => {
      const given = byPartition.get(partition);
      if (!given) return 0;
      const blocks = given.blocks.filter((block) => {
        const text = block.text === undefined ? '' : normalized(block.text);
        if (text.length === 0 || !repeats(text, said)) return true;
        assembly.dropped.push(this.dropped(partition, block, 'duplicate'));
        return false;
      });
      const fitted = await (given.fit ?? fitInOrder)(blocks, room);
      const tokens = fitted.tokens ?? fitted.kept.reduce((sum, block) => sum + block.tokens, 0);
      for (const block of fitted.kept) {
        if (block.text !== undefined) said.push(normalized(block.text));
      }
      assembly.kept[partition] = fitted.kept;
      assembly.tokens[partition] = tokens;
      assembly.used += tokens;
      for (const { block, reason } of fitted.dropped) {
        assembly.dropped.push(this.dropped(partition, block, reason));
      }
      filled.set(partition, { blocks, cut: fitted.dropped.length > 0 });
      return tokens;
    };

    const refill = async (partition: ContextPartition): Promise<void> => {
      const given = byPartition.get(partition);
      const state = filled.get(partition);
      const left = budget - assembly.used;
      if (!given || !state?.cut || left <= 0) return;
      const previous = assembly.tokens[partition] ?? 0;
      const fitted = await (given.fit ?? fitInOrder)(state.blocks, previous + left);
      const tokens = fitted.tokens ?? fitted.kept.reduce((sum, block) => sum + block.tokens, 0);
      if (tokens <= previous) return;
      const before = new Set(assembly.kept[partition] ?? []);
      for (const block of fitted.kept) {
        if (!before.has(block) && block.text !== undefined) said.push(normalized(block.text));
      }
      assembly.kept[partition] = fitted.kept;
      assembly.tokens[partition] = tokens;
      assembly.used += tokens - previous;
      assembly.dropped = [
        ...assembly.dropped.filter(
          (dropped) => dropped.partition !== partition || dropped.reason === 'duplicate'
        ),
        ...fitted.dropped.map(({ block, reason }) => this.dropped(partition, block, reason)),
      ];
      filled.set(partition, { blocks: state.blocks, cut: fitted.dropped.length > 0 });
    };

    for (const partition of FILL_ORDER) {
      if (!isRequired(partition)) continue;
      const unbounded = partition === 'system' || partition === 'final';
      await fill(partition, unbounded ? Infinity : Math.max(0, budget - assembly.used));
    }

    const open = FILL_ORDER.filter((partition) => !isRequired(partition));
    const grants = this.grants(Math.max(0, budget - assembly.used), open, byPartition);
    let carried = 0;
    for (const partition of open) {
      if (!byPartition.has(partition)) continue;
      const room = Math.min(
        (grants.get(partition) ?? 0) + carried,
        Math.max(0, budget - assembly.used)
      );
      carried = Math.max(0, room - (await fill(partition, room)));
    }
    for (const partition of open) await refill(partition);
    return assembly;
  }

  /**
   * The room of each partition in `open`: its share of `free`, no more than it needs, with what
   * is left over shared again among those that need more, and what shares cannot place going to
   * the hungry ones in the order they are filled
   */
  private grants<T>(
    free: number,
    open: readonly ContextPartition[],
    byPartition: ReadonlyMap<ContextPartition, PartitionCandidates<T>>
  ): Map<ContextPartition, number> {
    const assigned = open.reduce(
      (sum, partition) => sum + (this.partitions[partition].share ?? 0),
      0
    );
    const hungry = new Map<ContextPartition, { share: number; need: number }>();
    for (const partition of open) {
      const candidate = byPartition.get(partition);
      if (!candidate) continue;
      const need =
        candidate.demand ?? candidate.blocks.reduce((sum, block) => sum + block.tokens, 0);
      const share = this.partitions[partition].share ?? Math.max(0, 1 - assigned);
      if (need > 0) hungry.set(partition, { share, need });
    }

    const grants = new Map<ContextPartition, number>();
    const give = (partition: ContextPartition, tokens: number) =>
      grants.set(partition, (grants.get(partition) ?? 0) + tokens);
    let left = free;
    while (left > 0 && hungry.size > 0) {
      const shares = [...hungry.values()].reduce((sum, { share }) => sum + share, 0);
      if (shares <= 0) break;
      let granted = 0;
      for (const [partition, entry] of hungry) {
        const take = Math.min(Math.floor((left * entry.share) / shares), entry.need);
        give(partition, take);
        entry.need -= take;
        granted += take;
        if (entry.need <= 0) hungry.delete(partition);
      }
      left -= granted;
      if (granted === 0) break;
    }
    for (const [partition, entry] of hungry) {
      if (left <= 0) break;
      const take = Math.min(left, entry.need);
      give(partition, take);
      left -= take;
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
