import { asyncBufferFromFile, parquetReadObjects } from 'hyparquet';
import { z } from 'zod';
import { cachedDownload } from '../cache.js';
import { parsePythonLiteral } from '../python-literal.js';
import type { BenchConversation, BenchDatasetId, BenchQuestion, BenchTurn } from '../types.js';

export type BeamTier = '100K' | '500K' | '1M';

const DATASET_IDS: Record<BeamTier, BenchDatasetId> = {
  '100K': 'beam-100k',
  '500K': 'beam-500k',
  '1M': 'beam-1m',
};

const turnSchema = z.object({
  id: z
    .union([z.number(), z.bigint()])
    .nullish()
    .transform((id) => (id == null ? id : Number(id))),
  role: z.string(),
  content: z.string(),
  time_anchor: z.string().nullish(),
});

export const beamRowSchema = z.object({
  conversation_id: z.string(),
  chat: z.array(z.array(turnSchema)),
  probing_questions: z.string(),
});

const probeSchema = z.looseObject({
  question: z.string(),
  rubric: z.array(z.string()).min(1),
  answer: z.unknown().optional(),
  ideal_answer: z.unknown().optional(),
  ideal_response: z.unknown().optional(),
  ideal_summary: z.unknown().optional(),
  source_chat_ids: z.unknown().optional().transform(chatIds),
});

/** Every turn id in BEAM's `source_chat_ids`, which comes as a list, or as lists by statement. */
function chatIds(value: unknown): number[] {
  if (typeof value === 'number' && Number.isInteger(value)) return [value];
  if (Array.isArray(value)) return value.flatMap(chatIds);
  if (value !== null && typeof value === 'object') return Object.values(value).flatMap(chatIds);
  return [];
}

const MONTHS = [
  'january',
  'february',
  'march',
  'april',
  'may',
  'june',
  'july',
  'august',
  'september',
  'october',
  'november',
  'december',
];

/** A BEAM time anchor (`March-15-2024`) as a `Date` in UTC, or `undefined`. */
export function parseBeamAnchor(text: string | null | undefined): Date | undefined {
  const match = /^([A-Za-z]+)-(\d{1,2})-(\d{4})$/.exec(text?.trim() ?? '');
  if (!match) return undefined;
  const month = MONTHS.indexOf(match[1].toLowerCase());
  if (month === -1) return undefined;
  return new Date(Date.UTC(Number(match[3]), month, Number(match[2])));
}

/** A BEAM turn's text without the `->-> 1,1` position marker the dataset appends. */
export function stripBeamMarker(content: string): string {
  return content.replace(/\s*->->\s*\d+,\d+\s*$/, '');
}

function referenceAnswer(probe: z.infer<typeof probeSchema>): string {
  for (const value of [
    probe.answer,
    probe.ideal_answer,
    probe.ideal_response,
    probe.ideal_summary,
  ]) {
    if (typeof value === 'string' && value.trim()) return value;
    if (Array.isArray(value)) return value.map(String).join('\n');
  }
  return probe.rubric.join('\n');
}

/** One BEAM row as a conversation with its probing questions. */
export function beamConversation(
  row: z.infer<typeof beamRowSchema>,
  tier: BeamTier
): BenchConversation {
  const turns: BenchTurn[] = [];
  const byId = new Map<number, string>();
  let at: Date | undefined;
  for (const batch of row.chat) {
    for (const turn of batch) {
      if (turn.role !== 'user' && turn.role !== 'assistant') continue;
      at = parseBeamAnchor(turn.time_anchor) ?? at;
      const content = stripBeamMarker(turn.content);
      if (turn.id !== null && turn.id !== undefined) byId.set(turn.id, content);
      turns.push({ role: turn.role, content, ...(at && { at }) });
    }
  }
  const probes = z
    .record(z.string(), z.array(probeSchema))
    .parse(parsePythonLiteral(row.probing_questions));
  const questions: BenchQuestion[] = Object.entries(probes).flatMap(([category, items]) =>
    items.map((probe, index) => {
      const evidence = probe.source_chat_ids.flatMap((id) => {
        const content = byId.get(id);
        return content ? [content] : [];
      });
      return {
        id: `${row.conversation_id}:${category}:${index}`,
        category,
        question: probe.question,
        answer: referenceAnswer(probe),
        scoring: { kind: 'beam-rubric' as const, rubric: probe.rubric },
        ...(evidence.length > 0 && { evidence }),
      };
    })
  );
  return { id: `${tier}:${row.conversation_id}`, dataset: DATASET_IDS[tier], turns, questions };
}

/**
 * BEAM (CC BY-SA 4.0, Tavakoli et al. 2025): long conversations of a tier (100K: 20, 500K: 35,
 * 1M: 35), each with 20 probing questions over ten abilities, scored against rubrics.
 */
export async function loadBeam(
  tier: BeamTier,
  log?: (line: string) => void
): Promise<BenchConversation[]> {
  const path = await cachedDownload(
    `https://huggingface.co/datasets/Mohammadta/BEAM/resolve/main/data/${tier}-00000-of-00001.parquet`,
    `beam-${tier}.parquet`,
    log
  );
  const rows = await parquetReadObjects({
    file: await asyncBufferFromFile(path),
    columns: ['conversation_id', 'chat', 'probing_questions'],
  });
  return z
    .array(beamRowSchema)
    .parse(rows)
    .map((row) => beamConversation(row, tier));
}
