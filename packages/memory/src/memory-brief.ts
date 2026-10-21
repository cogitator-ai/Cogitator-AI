/**
 * The pre-turn brief: a cheap model reads what memory found for a turn and writes a few cards,
 * each standing on words it quotes from its source, which are checked before the card is kept
 */

import { z } from 'zod';
import type { BriefCard, BriefCardKind } from '@cogitator-ai/types';
import type { SummarizeFn } from './compaction';
import { inert } from './memory-files';

/** Cards a brief holds at most */
export const MAX_BRIEF_CARDS = 4;

/** Characters of a source the model reads at most */
const SOURCE_CHARS = 1200;

/** Something memory found for the turn, which a card may stand on */
export interface BriefSource {
  /** `turn:<id>` or `item:<id>` */
  ref: string;
  text: string;
  /** When it was said or recorded, `YYYY-MM-DD` */
  date?: string;
}

export const BRIEF_PROMPT = `You read what long-term memory found for the user's next message and write at most {maxCards} short cards that would help answer it well. Each card is one of:
- constraint: something the answer must keep to, such as a rule, a limit or what the user asked never to do
- knowledge: a fact about the user or their work the answer should use
- consequence: what follows from an earlier choice or event for this message
- open_thread: something left open earlier that this message touches

Only write a card a source supports. Quote the words of that source the card stands on, copied exactly, and name the source by its ref. Write no card at all rather than one that does not help. Answer with a JSON array only, such as:
[{"kind": "constraint", "text": "Answer in Portuguese.", "quote": "please always answer me in Portuguese", "source": "turn:ent_abc123"}]`;

const KINDS: readonly BriefCardKind[] = ['constraint', 'knowledge', 'consequence', 'open_thread'];

const cardSchema = z.object({
  kind: z.enum(['constraint', 'knowledge', 'consequence', 'open_thread']),
  text: z.string().trim().min(1).max(400),
  quote: z.string().trim().min(1),
  source: z.string().trim().min(1),
});

export interface MemoryBrieferOptions {
  summarize: SummarizeFn;
  /** Cards at most, from 1 to {@link MAX_BRIEF_CARDS} (default {@link MAX_BRIEF_CARDS}) */
  maxCards?: number;
  /** Tokens the model may answer with (default 600) */
  maxTokens?: number;
  /** Instructions added to {@link BRIEF_PROMPT} */
  prompt?: string;
}

/** Text as quotes are compared: one space between words, no case */
function flat(text: string): string {
  return text.replace(/\s+/g, ' ').trim().toLowerCase();
}

/**
 * The cards of a model's `answer` that stand: of a kind a card may be, naming one of `sources`,
 * whose text holds the quote word for word (spacing and case aside), one card per quote, at most
 * `maxCards`. An answer that holds no JSON array gives no cards.
 */
export function parseBrief(
  answer: string,
  sources: readonly BriefSource[],
  maxCards = MAX_BRIEF_CARDS
): BriefCard[] {
  const start = answer.indexOf('[');
  const end = answer.lastIndexOf(']');
  if (start === -1 || end <= start) return [];
  let raw: unknown;
  try {
    raw = JSON.parse(answer.slice(start, end + 1));
  } catch {
    return [];
  }
  if (!Array.isArray(raw)) return [];
  const bySource = new Map(sources.map((source) => [source.ref, flat(source.text)]));
  const quoted = new Set<string>();
  const cards: BriefCard[] = [];
  for (const value of raw) {
    const parsed = cardSchema.safeParse(value);
    if (!parsed.success || !KINDS.includes(parsed.data.kind)) continue;
    const card = parsed.data;
    const text = bySource.get(card.source);
    const quote = flat(card.quote);
    if (text === undefined || !text.includes(quote) || quoted.has(quote)) continue;
    quoted.add(quote);
    cards.push(card);
    if (cards.length >= maxCards) break;
  }
  return cards;
}

/**
 * The block of a turn's memory context that holds `cards`, marked as a hint that may be wrong,
 * each with its quote and source
 */
export function briefBlock(cards: readonly BriefCard[]): string | undefined {
  if (cards.length === 0) return undefined;
  return inert(
    [
      'A quick read of memory for this turn (a hint that may be wrong, check before relying on it):',
      ...cards.map(
        (card) =>
          `- ${card.kind.replace('_', ' ')}: ${card.text} (${card.source}: "${card.quote.replace(/"/g, "'")}")`
      ),
    ].join('\n')
  );
}

/**
 * Writes the pre-turn brief: hands a model the turn's input and what memory found for it, each
 * source with its ref, and keeps the cards whose quotes hold (see {@link parseBrief})
 */
export class MemoryBriefer {
  private readonly summarize: SummarizeFn;
  private readonly maxCards: number;
  private readonly maxTokens: number;
  private readonly prompt: string;

  constructor(options: MemoryBrieferOptions) {
    const maxCards = options.maxCards ?? MAX_BRIEF_CARDS;
    if (!Number.isInteger(maxCards) || maxCards < 1 || maxCards > MAX_BRIEF_CARDS) {
      throw new Error(`A brief holds from 1 to ${MAX_BRIEF_CARDS} cards, got ${maxCards}`);
    }
    this.summarize = options.summarize;
    this.maxCards = maxCards;
    this.maxTokens = options.maxTokens ?? 600;
    const base = BRIEF_PROMPT.replace('{maxCards}', String(maxCards));
    this.prompt = options.prompt ? `${base}\n\n${options.prompt}` : base;
  }

  /** The cards for a turn that says `input`, none when memory found nothing */
  async brief(input: string, sources: readonly BriefSource[]): Promise<BriefCard[]> {
    if (sources.length === 0 || !input.trim()) return [];
    const listed = sources
      .map(
        (source) =>
          `<source ref="${source.ref}"${source.date ? ` date="${source.date}"` : ''}>\n${source.text.slice(0, SOURCE_CHARS)}\n</source>`
      )
      .join('\n');
    const answer = await this.summarize(
      [
        {
          role: 'user',
          content: `What memory found:\n${listed}\n\nThe user's next message:\n<message>\n${input}\n</message>`,
        },
      ],
      { prompt: this.prompt, maxTokens: this.maxTokens }
    );
    return parseBrief(answer, sources, this.maxCards);
  }
}
