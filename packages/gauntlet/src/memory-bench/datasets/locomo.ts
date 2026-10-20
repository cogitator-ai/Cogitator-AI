import { readFile } from 'node:fs/promises';
import { z } from 'zod';
import { cachedDownload } from '../cache.js';
import type { BenchConversation, BenchTurn } from '../types.js';

const URL =
  'https://raw.githubusercontent.com/snap-research/locomo/3eb6f2c585f5e1699204e3c3bdf7adc5c28cb376/data/locomo10.json';

const CATEGORIES: Record<number, string> = {
  1: 'multi-hop',
  2: 'temporal',
  3: 'open-domain',
  4: 'single-hop',
};

const dialogSchema = z.object({ speaker: z.string(), dia_id: z.string(), text: z.string() });

const sampleSchema = z.object({
  sample_id: z.string(),
  conversation: z.record(z.string(), z.unknown()),
  qa: z.array(
    z.object({
      question: z.string(),
      answer: z.union([z.string(), z.number()]).optional(),
      evidence: z.array(z.string()).default([]),
      category: z.number(),
    })
  ),
});

/**
 * One LoCoMo dialogue as a conversation: the first speaker as the user, the second as the
 * assistant, every turn with its session's date, so a turn retrieval finds alone still carries
 * it. Adversarial questions (category 5), which have no answer, are left out.
 */
export function locomoConversation(sample: z.infer<typeof sampleSchema>): BenchConversation {
  const conversation = sample.conversation;
  const speakerA = String(conversation.speaker_a);
  const turns: BenchTurn[] = [];
  const texts = new Map<string, string>();
  for (let session = 1; Array.isArray(conversation[`session_${session}`]); session++) {
    const date = conversation[`session_${session}_date_time`];
    const dialogs = z.array(dialogSchema).parse(conversation[`session_${session}`]);
    for (const dialog of dialogs) {
      const content = `${dialog.speaker}: ${dialog.text}`;
      texts.set(dialog.dia_id, content);
      turns.push({
        role: dialog.speaker === speakerA ? 'user' : 'assistant',
        content: typeof date === 'string' ? `[${date}] ${content}` : content,
      });
    }
  }
  return {
    id: sample.sample_id,
    dataset: 'locomo',
    turns,
    questions: sample.qa
      .filter((qa) => qa.category !== 5 && qa.answer !== undefined)
      .map((qa, index) => ({
        id: `${sample.sample_id}:${index}`,
        category: CATEGORIES[qa.category] ?? `category ${qa.category}`,
        question: qa.question,
        answer: String(qa.answer),
        scoring: { kind: 'token-f1' as const },
        evidence: qa.evidence.flatMap((id) => {
          const text = texts.get(id);
          return text ? [text] : [];
        }),
      })),
  };
}

/**
 * LoCoMo (CC BY-NC 4.0, Maharana et al. 2024): ten long dialogues between two people. Kept as a
 * smoke test only, scored by token F1 against the reference answer.
 */
export async function loadLocomo(log?: (line: string) => void): Promise<BenchConversation[]> {
  const path = await cachedDownload(URL, 'locomo10.json', log);
  return z
    .array(sampleSchema)
    .parse(JSON.parse(await readFile(path, 'utf8')))
    .map(locomoConversation);
}
