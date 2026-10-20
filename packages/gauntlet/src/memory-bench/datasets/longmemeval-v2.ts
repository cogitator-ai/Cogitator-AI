import { createReadStream } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { createInterface } from 'node:readline';
import { z } from 'zod';
import { cachedDownload } from '../cache.js';
import type { BenchConversation, BenchQuestion, BenchTurn } from '../types.js';

const BASE = 'https://huggingface.co/datasets/xiaowu0162/longmemeval-v2/resolve/main';

/** Characters of a page's accessibility tree the memory keeps: the trees run to megabytes. */
export const TREE_CHARS = 4000;

const questionSchema = z.object({
  id: z.string(),
  domain: z.string(),
  question_type: z.string(),
  question: z.string(),
  image: z.string().nullable(),
  answer: z.union([z.string(), z.number()]),
  eval_function: z.string(),
});

const stateSchema = z.object({
  state_index: z.number(),
  url: z.string().nullish(),
  action: z.string().nullish(),
  thought: z.string().nullish(),
  accessibility_tree: z.string().nullish(),
});

const trajectorySchema = z.object({
  id: z.string(),
  environment: z.string(),
  goal: z.string(),
  outcome: z.string(),
  start_url: z.string().nullish(),
  states: z.array(stateSchema),
});

export type LmeV2Question = z.infer<typeof questionSchema>;
export type LmeV2Trajectory = z.infer<typeof trajectorySchema>;

/** A trajectory as turns: the task, then each step the agent took and the page it saw. */
export function trajectoryTurns(trajectory: LmeV2Trajectory): BenchTurn[] {
  const turns: BenchTurn[] = [
    {
      role: 'user',
      content: `Task in ${trajectory.environment} (${trajectory.outcome}): ${trajectory.goal}${
        trajectory.start_url ? `\nStart page: ${trajectory.start_url}` : ''
      }`,
    },
  ];
  for (const state of trajectory.states) {
    const tree = state.accessibility_tree?.trim();
    if (tree) {
      const page = tree.length > TREE_CHARS ? `${tree.slice(0, TREE_CHARS)}\n[...]` : tree;
      turns.push({ role: 'user', content: `Page ${state.url ?? ''}:\n${page}` });
    }
    const parts = [
      state.thought?.trim() && `Thought: ${state.thought.trim()}`,
      state.action?.trim() && `Action: ${state.action.trim()}`,
    ].filter((part): part is string => Boolean(part));
    if (parts.length > 0) {
      turns.push({ role: 'assistant', content: `Step ${state.state_index}: ${parts.join('\n')}` });
    }
  }
  return turns;
}

/**
 * The questions grouped by the haystack they share (within a domain, LME-V2-Small gives every
 * question the same 100 trajectories), each group a conversation of those trajectories in order.
 * Questions with a screenshot are left out: the runtime's memory holds text.
 */
export function lmeV2Conversations(
  questions: LmeV2Question[],
  haystacks: Record<string, string[]>,
  trajectories: Map<string, LmeV2Trajectory>
): BenchConversation[] {
  const groups = new Map<string, { ids: string[]; questions: BenchQuestion[] }>();
  for (const question of questions) {
    if (question.image) continue;
    const ids = haystacks[question.id];
    if (!ids) continue;
    const key = ids.join(',');
    const group = groups.get(key) ?? { ids, questions: [] };
    group.questions.push({
      id: question.id,
      category: question.question_type,
      question: question.question,
      answer: String(question.answer),
      scoring: { kind: 'lme-v2', evalFunction: question.eval_function },
    });
    groups.set(key, group);
  }
  return [...groups.values()].map((group, index) => ({
    id: `${questions.find((q) => q.id === group.questions[0]?.id)?.domain ?? 'haystack'}-${index}`,
    dataset: 'lme-v2-small' as const,
    turns: group.ids.flatMap((id) => {
      const trajectory = trajectories.get(id);
      return trajectory ? trajectoryTurns(trajectory) : [];
    }),
    questions: group.questions,
  }));
}

/**
 * LongMemEval-V2 Small (Apache-2.0, Wu et al. 2026): 451 questions about web and enterprise
 * environments, each with a haystack of 100 agent trajectories. Reads only the trajectories the
 * haystacks name out of the 1.2 GB `trajectories.jsonl`.
 */
export async function loadLongMemEvalV2Small(
  log?: (line: string) => void
): Promise<BenchConversation[]> {
  const [questionsPath, haystackPath, trajectoriesPath] = await Promise.all([
    cachedDownload(`${BASE}/questions.jsonl`, 'lme-v2-questions.jsonl', log),
    cachedDownload(`${BASE}/haystacks/lme_v2_small.json`, 'lme-v2-small-haystacks.json', log),
    cachedDownload(`${BASE}/trajectories.jsonl`, 'lme-v2-trajectories.jsonl', log),
  ]);
  const questions = (await readFile(questionsPath, 'utf8'))
    .split('\n')
    .filter((line) => line.trim())
    .map((line) => questionSchema.parse(JSON.parse(line)));
  const haystacks = z
    .record(z.string(), z.array(z.string()))
    .parse(JSON.parse(await readFile(haystackPath, 'utf8')));
  const needed = new Set(Object.values(haystacks).flat());
  const trajectories = new Map<string, LmeV2Trajectory>();
  const lines = createInterface({ input: createReadStream(trajectoriesPath), crlfDelay: Infinity });
  for await (const line of lines) {
    if (!line.trim()) continue;
    const id = /"id"\s*:\s*"([^"]+)"/.exec(line)?.[1];
    if (!id || !needed.has(id)) continue;
    trajectories.set(id, trajectorySchema.parse(JSON.parse(line)));
  }
  return lmeV2Conversations(questions, haystacks, trajectories);
}
