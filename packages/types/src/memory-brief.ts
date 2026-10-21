/**
 * The pre-turn brief: a quick read of memory before a turn, as a few cards the model may use
 */

/** What a card of a brief tells the model */
export type BriefCardKind = 'constraint' | 'knowledge' | 'consequence' | 'open_thread';

/**
 * One card of a brief: a short note drawn from memory, with the words it stands on, quoted from
 * an earlier turn or a memory item word for word
 */
export interface BriefCard {
  kind: BriefCardKind;
  /** The note, in a sentence */
  text: string;
  /** The words of the source the note stands on, as they are there */
  quote: string;
  /** The source: `turn:<id>` or `item:<id>` */
  source: string;
}

/**
 * `memory.brief`: before the first model call of a run, a cheap model reads what memory finds
 * for the input and writes 0 to 4 cards (a constraint to keep, knowledge to use, a consequence of
 * an earlier choice, a thread left open), each with a quote checked against its source. They go
 * into the turn's memory context as a hint that may be wrong, never into the system message.
 * Any failure or a timeout leaves the turn as it was.
 */
export interface MemoryBriefConfig {
  /** Model that writes the brief, as `provider/model`, the model the run starts on by default */
  model?: string;
  /** Cards at most, from 1 to 4 (default 4) */
  maxCards?: number;
  /** Milliseconds the brief may take before the turn goes on without it (default 4000) */
  timeoutMs?: number;
  /** Tokens the model may answer with (default 600) */
  maxTokens?: number;
  /** Instructions added to the brief prompt */
  prompt?: string;
}
