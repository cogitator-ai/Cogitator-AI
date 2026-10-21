/**
 * Memory upkeep between runs: observations of entities and consolidation of memory items
 */

import type { MemoryItemScope } from './memory-items';

/**
 * `memory.observations`: what memory makes of the facts about each entity, kept as a memory
 * file under `/memories/observations/` and written again in the background after a run once the
 * facts it stands on changed. A turn whose input names an entity, or that recalls one of its
 * items, gets its observation next to the facts. Needs a memory adapter that keeps both memory
 * items and memory files.
 */
export interface MemoryObservationsConfig {
  /** Model that writes observations, as `provider/model`, the model the run ended on by default */
  model?: string;
  /** Observations one refresh writes at most (default 3) */
  maxEntities?: number;
  /** Facts that hold now an entity needs for an observation (default 3) */
  minItems?: number;
  /** Instructions added to the observation prompt */
  prompt?: string;
}

/**
 * `memory.consolidation`: a pass over memory in the background, every `everyRuns` runs of a
 * thread and after its compaction, that never holds a run back. It marks as stale the items a
 * model finds to repeat or contradict a newer one, and folds new lessons into the playbook
 * (`/memories/playbook.md`) in at most three edits, each a rule added or one rule rewritten, so
 * the playbook is never written over whole. `Cogitator.consolidateMemory` runs a pass on demand,
 * such as from a worker while the agent is idle.
 */
export interface MemoryConsolidationConfig {
  /** Model of the pass, as `provider/model`, the model the run ended on by default */
  model?: string;
  /** Runs of a thread between two passes (default 20) */
  everyRuns?: number;
  /** Pass after a thread was compacted too (default true) */
  afterCompaction?: boolean;
  /** Items one pass marks as stale at most (default 10), 0 to leave items alone */
  maxChanges?: number;
  /**
   * Subjects one pass asks the model about at most (default 10), the subjects whose newest item
   * is oldest first: the next pass goes on where it stopped
   */
  maxSubjects?: number;
  /**
   * How lessons reach the playbook: `apply` (default) edits it, each edit a new version of the
   * file, `shadow` writes the edited playbook to `/memories/playbook.next.md` for a review that
   * promotes it, `false` leaves the playbook alone
   */
  playbook?: 'apply' | 'shadow' | false;
  /**
   * Show the playbook to every run of the scope it is kept for, as a hint (default true), also
   * with `playbook: false`, which only stops new lessons from reaching it
   */
  showPlaybook?: boolean;
  /** Instructions added to the prompts of the pass */
  prompt?: string;
  /** Called with what a pass changed */
  afterConsolidate?: (report: MemoryConsolidationReport) => void | Promise<void>;
}

/** An item a pass marked as stale, and why */
export interface StaleMark {
  itemId: string;
  /** The item it gave way to */
  keptId: string;
  reason: 'duplicate' | 'contradiction';
}

/** What one pass over memory changed */
export interface MemoryConsolidationReport {
  scope: MemoryItemScope;
  /** Paths of the observations written */
  observations: string[];
  /** Paths of the observations deleted, their entity no longer having enough facts */
  observationsDeleted: string[];
  stale: StaleMark[];
  /** The playbook edits, when lessons were folded in */
  playbook?: { path: string; editCount: number; lessonIds: string[] };
}
