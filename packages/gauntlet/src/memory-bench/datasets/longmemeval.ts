import { readFile } from 'node:fs/promises';
import { z } from 'zod';
import { cachedDownload } from '../cache.js';
import type { BenchConversation, BenchTurn } from '../types.js';

const URL =
  'https://huggingface.co/datasets/xiaowu0162/longmemeval-cleaned/resolve/98d7416c24c778c2fee6e6f3006e7a073259d48f/longmemeval_s_cleaned.json';

const turnSchema = z.object({
  role: z.enum(['user', 'assistant']),
  content: z.string(),
  has_answer: z.boolean().optional(),
});

const recordSchema = z.object({
  question_id: z.string(),
  question_type: z.string(),
  question: z.string(),
  answer: z.union([z.string(), z.number()]),
  question_date: z.string(),
  haystack_dates: z.array(z.string()),
  haystack_sessions: z.array(z.array(turnSchema)),
});

/**
 * A LongMemEval date (`2023/05/20 (Sat) 02:21`) as a `Date` in UTC, or `undefined` for one it
 * cannot read.
 */
export function parseLongMemEvalDate(text: string): Date | undefined {
  const match = /^(\d{4})\/(\d{2})\/(\d{2})(?:\s*\([A-Za-z]+\))?\s*(\d{2}):(\d{2})/.exec(text);
  if (!match) return undefined;
  const [, year, month, day, hour, minute] = match.map(Number);
  return new Date(Date.UTC(year, month - 1, day, hour, minute));
}

/** One LongMemEval record as a conversation with its one question. */
export function longMemEvalConversation(record: z.infer<typeof recordSchema>): BenchConversation {
  const turns: BenchTurn[] = [];
  const evidence: string[] = [];
  record.haystack_sessions.forEach((session, index) => {
    const dateText = record.haystack_dates[index];
    const at = dateText ? parseLongMemEvalDate(dateText) : undefined;
    session.forEach((turn) => {
      if (turn.has_answer) evidence.push(turn.content);
      turns.push({
        role: turn.role,
        content: dateText ? `[${dateText}] ${turn.content}` : turn.content,
        ...(at && { at }),
        ...(turn.has_answer && { evidence: true }),
      });
    });
  });
  const abstention = record.question_id.endsWith('_abs');
  return {
    id: record.question_id,
    dataset: 'longmemeval-s',
    turns,
    questions: [
      {
        id: record.question_id,
        category: abstention ? `${record.question_type} (abstention)` : record.question_type,
        question: record.question,
        answer: String(record.answer),
        askedOn: record.question_date,
        scoring: { kind: 'longmemeval', questionType: record.question_type, abstention },
        ...(evidence.length > 0 && { evidence }),
      },
    ],
  };
}

/**
 * LongMemEval-S (cleaned, MIT, Wu et al. 2024): 500 questions, each with its own history of
 * about 48 sessions and 115K tokens.
 */
export async function loadLongMemEvalS(log?: (line: string) => void): Promise<BenchConversation[]> {
  const path = await cachedDownload(URL, 'longmemeval_s_cleaned.json', log);
  const records = z.array(recordSchema).parse(JSON.parse(await readFile(path, 'utf8')));
  return records.map(longMemEvalConversation);
}
