import { asyncBufferFromFile, parquetReadObjects } from 'hyparquet';
import { z } from 'zod';
import { cachedDownload } from '../cache.js';
import type { BenchConversation, BenchTurn } from '../types.js';

const URL =
  'https://huggingface.co/datasets/ai-hyz/MemoryAgentBench/resolve/main/data/Conflict_Resolution-00000-of-00001.parquet';

/** Characters of facts per message the memory gets, about 1000 tokens. */
const CHUNK_CHARS = 4000;

const rowSchema = z.object({
  context: z.string(),
  questions: z.array(z.string()),
  answers: z.array(z.array(z.string())),
  metadata: z.looseObject({ qa_pair_ids: z.array(z.string()) }),
});

/** The note every question carries: later facts replace earlier ones. */
export const CONFLICT_INSTRUCTION =
  'The facts you were given are numbered, and a fact with a larger number is newer: when two ' +
  'facts disagree, the newer one holds. Answer with only the answer, no explanation.';

/** `context` cut into messages at line ends, each at most `size` characters where lines allow. */
export function chunkFacts(context: string, size = CHUNK_CHARS): string[] {
  const chunks: string[] = [];
  let current = '';
  for (const line of context.split('\n')) {
    if (current && current.length + line.length + 1 > size) {
      chunks.push(current);
      current = '';
    }
    current = current ? `${current}\n${line}` : line;
  }
  if (current.trim()) chunks.push(current);
  return chunks;
}

/** One Conflict_Resolution context (a list of facts that later ones override) and its questions. */
export function conflictConversation(row: z.infer<typeof rowSchema>): BenchConversation {
  const firstId = row.metadata.qa_pair_ids[0] ?? 'conflict';
  const id = firstId.replace(/_no\d+$/, '');
  const turns: BenchTurn[] = chunkFacts(row.context).map((chunk) => ({
    role: 'user',
    content: `Memorize these facts:\n${chunk}`,
  }));
  return {
    id,
    dataset: 'mab-conflict',
    turns,
    questions: row.questions.map((question, index) => ({
      id: row.metadata.qa_pair_ids[index] ?? `${id}_no${index}`,
      category: id.includes('_mh_') ? 'multi-hop' : 'single-hop',
      question: `${question}\n\n${CONFLICT_INSTRUCTION}`,
      answer: (row.answers[index] ?? []).join(' | '),
      scoring: { kind: 'substring' as const, answers: row.answers[index] ?? [] },
    })),
  };
}

/**
 * MemoryAgentBench Conflict_Resolution (Hu et al. 2025): eight lists of facts (6K to 262K
 * tokens) where newer facts override older ones, 100 questions each.
 */
export async function loadMemoryAgentBenchConflicts(
  log?: (line: string) => void
): Promise<BenchConversation[]> {
  const path = await cachedDownload(URL, 'mab-conflict-resolution.parquet', log);
  const rows = await parquetReadObjects({ file: await asyncBufferFromFile(path) });
  return z.array(rowSchema).parse(rows).map(conflictConversation);
}
