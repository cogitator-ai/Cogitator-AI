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

const ANSWER_RULES =
  'Answer based on your memory of the environment. If you do not know the answer, output exactly ' +
  '\\boxed{UNKNOWN}. Do not guess. Never attempt to guess an answer if you are not sure. If you ' +
  "believe the question's construction/premise is wrong, provide an explanation in \\boxed{} " +
  'explaining why the question is flawed.';

/*
 * The answering rules of each domain, from DOMAIN_SYSTEM_PROMPTS in evaluation/harness.py of
 * https://github.com/xiaowu0162/LongMemEval-V2 (Apache License 2.0).
 */
const DOMAIN_PROTOCOLS: Record<string, string> = {
  web:
    'You are an experienced colleague in a web browsing environment that has a customized ' +
    'magento-based shopping website, a customized magento-based shopping admin cms website, as ' +
    `well as a customized forum website based on reddit/postmill. ${ANSWER_RULES}`,
  enterprise: `You are an experienced colleague working in a customized ServiceNow environment. ${ANSWER_RULES}`,
};
export type LmeV2Trajectory = z.infer<typeof trajectorySchema>;

/**
 * A trajectory as turns of a log the memory holds: one per step, each naming the session's task,
 * what the agent thought and did, and the page it saw. They go in as notes, not as turns of the
 * assistant, so the model reads them as records of earlier work rather than things it said.
 */
export function trajectoryTurns(trajectory: LmeV2Trajectory): BenchTurn[] {
  const session = `[Log of an earlier session in ${trajectory.environment}, task: ${trajectory.goal} (${trajectory.outcome})]`;
  const turns: BenchTurn[] = [
    {
      role: 'user',
      content: `${session}\nStarted at ${trajectory.start_url ?? 'an unknown page'}.`,
    },
  ];
  for (const state of trajectory.states) {
    const tree = state.accessibility_tree?.trim();
    const parts = [
      `Step ${state.state_index} at ${state.url ?? 'an unknown page'}`,
      state.thought?.trim() && `Thought: ${state.thought.trim()}`,
      state.action?.trim() && `Action: ${state.action.trim()}`,
      tree && `Page:\n${tree.length > TREE_CHARS ? `${tree.slice(0, TREE_CHARS)}\n[...]` : tree}`,
    ].filter((part): part is string => Boolean(part));
    turns.push({ role: 'user', content: `${session}\n${parts.join('\n')}` });
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
  return [...groups.values()].map((group, index) => {
    const domain = questions.find((q) => q.id === group.questions[0]?.id)?.domain ?? 'haystack';
    return {
      id: `${domain}-${index}`,
      dataset: 'lme-v2-small' as const,
      ...(DOMAIN_PROTOCOLS[domain] && { protocol: DOMAIN_PROTOCOLS[domain] }),
      turns: group.ids.flatMap((id) => {
        const trajectory = trajectories.get(id);
        return trajectory ? trajectoryTurns(trajectory) : [];
      }),
      questions: group.questions,
    };
  });
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
    const leading = /^\{\s*"id"\s*:\s*"([^"]+)"/.exec(line)?.[1];
    if (leading !== undefined && !needed.has(leading)) continue;
    const trajectory = trajectorySchema.parse(JSON.parse(line));
    if (needed.has(trajectory.id)) trajectories.set(trajectory.id, trajectory);
  }
  return lmeV2Conversations(questions, haystacks, trajectories);
}
