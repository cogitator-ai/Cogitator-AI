/**
 * What a note on the board is: a `fact` an agent or the person wants the others to know, a
 * `lesson` of a job (what worked, what did not), or the `outcome` of a job as the bridge saw it.
 */
export type FactKind = 'fact' | 'lesson' | 'outcome';

export const FACT_KINDS: readonly FactKind[] = ['fact', 'lesson', 'outcome'];

/** Who put a note on the board, and on which occasion. */
export interface FactSource {
  /** The agent that said it, `person` for the person, `bridge` for what the bridge noted itself */
  by: string;
  /** The job it was said on, or is about */
  job?: number;
  /** ISO 8601 */
  at: string;
}

/** One note on the board of a project. */
export interface BoardFact {
  id: string;
  kind: FactKind;
  text: string;
  /** The main checkout of the project it belongs to */
  project: string;
  /** Set on a note for one job only: the two agents of that job see it, nobody else */
  job?: number;
  source: FactSource;
}

export interface NewBoardFact {
  kind: FactKind;
  text: string;
  project: string;
  /** Keep the note to this job */
  job?: number;
  source: FactSource;
}

export interface BoardQuery {
  project: string;
  /**
   * The jobs whose own notes are looked at too. Notes of the whole project always are, a note
   * kept to a job only when its job is named here
   */
  jobs?: readonly number[];
  /** Words to look for: the notes that fit them best come first. The newest first without it */
  text?: string;
  kinds?: readonly FactKind[];
  /** 10 by default */
  limit?: number;
}

/**
 * The shared board of facts: what agents and the person told the bridge to remember, by
 * project. The bridge keeps no notes itself, a host gives it a board, such as `memoryBoard()` of
 * `@cogitator-ai/bridge/memory`, which keeps them with `@cogitator-ai/memory`.
 *
 * A board decides nothing about who may read or forget what: the dispatcher asks it only for
 * what the caller may see.
 */
export interface FactBoard {
  remember(fact: NewBoardFact): Promise<BoardFact>;
  recall(query: BoardQuery): Promise<BoardFact[]>;
  /** The note with this id, or the one whose id starts with it when only one does */
  find(id: string): Promise<BoardFact | undefined>;
  /** Lets a note go: it is found no more. Resolves with whether there was such a note */
  forget(id: string): Promise<boolean>;
  close?(): Promise<void>;
}

/** How many notes one look at the board returns when it names no number. */
export const DEFAULT_RECALL_LIMIT = 10;

/** The most notes one look at the board returns. */
export const MAX_RECALL_LIMIT = 50;

/** The longest note the board takes, in characters. */
export const MAX_FACT_LENGTH = 2_000;

/** One note as a line an agent or a person reads: the text, then who said it and when. */
export function factLine(fact: BoardFact): string {
  const who = fact.source.by === 'person' ? 'the person' : fact.source.by;
  const on = fact.source.job === undefined ? '' : `, job #${fact.source.job}`;
  const kept = fact.job === undefined ? '' : ', kept to that job';
  return `${fact.text} (${fact.kind} from ${who}${on}, ${fact.source.at.slice(0, 10)}${kept})`;
}
