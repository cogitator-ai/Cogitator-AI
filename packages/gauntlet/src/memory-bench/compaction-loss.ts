import {
  CompactionService,
  compactedHistory,
  countEntryTokens,
  countMessageTokens,
  HISTORY_ENTRY_TYPES,
  InMemoryAdapter,
  type SummarizeFn,
} from '@cogitator-ai/memory';
import type {
  CompactionAtom,
  CompactionAtomKind,
  CompactionConfig,
  CompactionEvent,
  CompactionLevels,
  CompactionNode,
  MemoryEntry,
  Message,
} from '@cogitator-ai/types';
import type { ConsistencyCheck } from './consistency.js';

/** A step of a scripted session: a message, or a tool call with its result. */
type Step =
  | { role: 'user' | 'assistant'; text: string }
  | {
      tool: string;
      args: Record<string, unknown>;
      /** What the assistant says with the call */
      note: string;
      result: string;
      error?: string;
    };

const filler = (i: number): Step => ({
  role: i % 2 === 0 ? 'user' : 'assistant',
  text: `Small talk ${i}: the weather, the traffic downtown and the new bakery on the corner.`,
});

const fillers = (from: number, count: number): Step[] =>
  Array.from({ length: count }, (_, i) => filler(from + i));

/**
 * The scripted session, one list of steps per round, each round followed by a compaction. The
 * control items are planted in the first rounds, closed or claimed closed in later ones, so what
 * an early round summarized has to survive the folds of the later ones.
 */
export const SESSION_ROUNDS: readonly (readonly Step[])[] = [
  [
    { role: 'user', text: 'Hi, we are starting the billing cron rewrite today.' },
    { role: 'assistant', text: 'Great, I will start with the scheduler.' },
    { role: 'user', text: 'My name is Dana and I lead the billing team.' },
    { role: 'assistant', text: 'Nice to meet you, Dana.' },
    {
      role: 'user',
      text: 'We decided to use Postgres instead of MongoDB because we need transactions.',
    },
    { role: 'assistant', text: 'Understood, Postgres it is.' },
    { role: 'user', text: 'Never push directly to main, always open a pull request.' },
    { role: 'assistant', text: 'Got it, pull requests only.' },
    { role: 'user', text: 'Please write the release notes for v2 before Friday.' },
    { role: 'assistant', text: 'Will do.' },
    { role: 'user', text: 'Also fix the login redirect, it loops after sign in.' },
    { role: 'assistant', text: 'I will look into the redirect.' },
    { role: 'user', text: 'And update the API docs for the new endpoints.' },
    {
      tool: 'write_file',
      args: { path: 'src/billing/cron.ts', content: 'export const schedule = "0 3 * * *"' },
      note: 'Writing the new cron module.',
      result: 'wrote 40 lines',
    },
    {
      role: 'assistant',
      text: 'Cron module written.\nTODO: migrate the billing cron to the new scheduler',
    },
    ...fillers(0, 6),
  ],
  [
    ...fillers(6, 4),
    { role: 'user', text: 'The team ships releases on Fridays.' },
    { role: 'assistant', text: 'Noted.' },
    {
      tool: 'edit_file',
      args: { file_path: 'src/auth/redirect.ts', patch: 'guard the callback' },
      note: 'Patching the redirect guard.',
      result: 'patched the redirect guard',
    },
    {
      tool: 'run_tests',
      args: { suite: 'auth' },
      note: 'Running the auth tests.',
      result: '',
      error: '3 tests failed in auth.spec.ts',
    },
    { role: 'assistant', text: 'Should the cron run in UTC or in local time?' },
    { role: 'user', text: 'Let me think about that one.' },
    { role: 'assistant', text: 'I will get to the API docs after the cron work.' },
    { role: 'user', text: 'Fine by me.' },
    ...fillers(10, 6),
  ],
  [
    ...fillers(16, 4),
    { role: 'user', text: 'The API has to stay backwards compatible for old clients.' },
    { role: 'assistant', text: 'Understood.' },
    {
      tool: 'run_tests',
      args: { suite: 'redirect' },
      note: 'Running the redirect tests.',
      result: '12 redirect tests passed',
    },
    { role: 'assistant', text: 'The login redirect is fixed, the redirect tests pass now.' },
    { role: 'user', text: 'Great.' },
    ...fillers(20, 6),
    { role: 'user', text: 'Thanks, that is it for today.' },
    { role: 'assistant', text: 'See you tomorrow.' },
    { role: 'user', text: 'One more thing, remember the release notes.' },
    { role: 'assistant', text: 'They are on my list.' },
  ],
];

/** What the stub summarizer answers when a line of a chapter holds `trigger`. */
export interface Mention {
  trigger: string;
  kind: CompactionAtomKind;
  status: 'open' | 'closed';
  text: string;
  /** The quote it gives, `trigger` by default: one that is not in the message is a misquote */
  quote?: string;
  /** The message it names, the line's own by default: one out of the chapter is a misquote */
  message?: number;
}

/** What the stub chapter model answers about the session: the planted items, as a model would. */
export const MENTIONS: readonly Mention[] = [
  {
    trigger: 'lead the billing team',
    kind: 'fact',
    status: 'closed',
    text: 'Dana leads the billing team',
    quote: 'I lead the billing team',
  },
  {
    trigger: 'use Postgres instead of MongoDB',
    kind: 'decision',
    status: 'open',
    text: 'Use Postgres instead of MongoDB for transactions',
  },
  {
    trigger: 'Never push directly to main',
    kind: 'constraint',
    status: 'open',
    text: 'Never push directly to main',
  },
  {
    trigger: 'write the release notes for v2',
    kind: 'task',
    status: 'open',
    text: 'Write the release notes for v2',
  },
  {
    trigger: 'fix the login redirect',
    kind: 'task',
    status: 'open',
    text: 'Fix the login redirect',
  },
  {
    trigger: 'update the API docs',
    kind: 'task',
    status: 'open',
    text: 'Update the API docs',
  },
  {
    trigger: 'ships releases on Fridays',
    kind: 'fact',
    status: 'closed',
    text: 'The team ships releases on Fridays',
    quote: 'the team always ships on Friday',
  },
  {
    trigger: 'Should the cron run in UTC or in local time?',
    kind: 'thread',
    status: 'open',
    text: 'Whether the cron runs in UTC or local time',
  },
  {
    trigger: 'get to the API docs',
    kind: 'task',
    status: 'closed',
    text: 'Update the API docs',
    quote: 'The API docs are updated',
  },
  {
    trigger: 'stay backwards compatible',
    kind: 'constraint',
    status: 'open',
    text: 'Keep the API backwards compatible',
    message: 999,
  },
  {
    trigger: 'The login redirect is fixed',
    kind: 'task',
    status: 'closed',
    text: 'Fix the login redirect',
  },
];

/** The claim of done that no message supports: its trigger and the task it claims. */
const UNSUPPORTED_CLAIM = { trigger: 'get to the API docs', task: 'Update the API docs' };

/** Answers that hold no valid array of atoms, each one asked again. */
export const JUNK_ANSWERS = [
  'Sure, here is the summary you asked for.',
  '[{"kind": "task", "text": ',
  '[{"kind":"todo","status":"open","text":"Junk atom from a broken answer"}]',
] as const;

/**
 * A deterministic chapter model. It names an item only the first time it reads it, so a later
 * window that mentions it again (the overlap of two windows, a reminder) leaves it out and only
 * the levels kept from before hold it. Every fourth call starts with a junk answer, which the
 * service has to ask again.
 */
export class StubChapterModel {
  calls = 0;
  junk = 0;
  /** Triggers it answered an atom for */
  readonly said = new Set<string>();

  constructor(private readonly mentions: readonly Mention[] = MENTIONS) {}

  readonly summarize: SummarizeFn = async (messages: Message[]) => {
    this.calls++;
    if (this.calls % 4 === 2) {
      const answer = JUNK_ANSWERS[this.junk % JUNK_ANSWERS.length]!;
      this.junk++;
      return answer;
    }
    const transcript = messages
      .map((message) => (typeof message.content === 'string' ? message.content : ''))
      .join('\n');
    const atoms: unknown[] = [];
    let at = -1;
    for (const line of transcript.split('\n')) {
      const numbered = /^\[(\d+)\] /.exec(line);
      if (numbered) at = Number(numbered[1]);
      for (const mention of this.mentions) {
        if (this.said.has(mention.trigger) || !line.includes(mention.trigger)) continue;
        this.said.add(mention.trigger);
        atoms.push({
          kind: mention.kind,
          status: mention.status,
          text: mention.text,
          evidence: [{ message: mention.message ?? at, quote: mention.quote ?? mention.trigger }],
        });
      }
    }
    return `Here are the atoms of this part:\n${JSON.stringify(atoms)}`;
  };
}

/** What the final summary must hold of an item planted in the session. */
interface Planted {
  kind: CompactionAtomKind;
  text: string;
  /** The handoff section it is listed in */
  section: string;
  state: 'open' | 'done';
  /** Whether its evidence holds, so its handoff line carries no `(unverified)` mark */
  verified: boolean;
}

const PLANTED: readonly Planted[] = [
  {
    kind: 'task',
    text: 'Write the release notes for v2',
    section: 'Open tasks',
    state: 'open',
    verified: true,
  },
  {
    kind: 'task',
    text: 'TODO: migrate the billing cron to the new scheduler',
    section: 'Open tasks',
    state: 'open',
    verified: true,
  },
  {
    kind: 'task',
    text: 'Update the API docs',
    section: 'Open tasks',
    state: 'open',
    verified: true,
  },
  {
    kind: 'decision',
    text: 'Use Postgres instead of MongoDB for transactions',
    section: 'Decisions',
    state: 'open',
    verified: true,
  },
  {
    kind: 'constraint',
    text: 'Never push directly to main',
    section: 'Constraints',
    state: 'open',
    verified: true,
  },
  {
    kind: 'constraint',
    text: 'Keep the API backwards compatible',
    section: 'Constraints',
    state: 'open',
    verified: false,
  },
  {
    kind: 'error',
    text: 'run_tests {"suite":"auth"} failed: 3 tests failed in auth.spec.ts',
    section: 'Unresolved errors',
    state: 'open',
    verified: true,
  },
  { kind: 'file', text: 'src/billing/cron.ts', section: 'Files', state: 'open', verified: true },
  { kind: 'file', text: 'src/auth/redirect.ts', section: 'Files', state: 'open', verified: true },
  {
    kind: 'thread',
    text: 'Whether the cron runs in UTC or local time',
    section: 'Open questions',
    state: 'open',
    verified: true,
  },
  { kind: 'task', text: 'Fix the login redirect', section: 'Done', state: 'done', verified: true },
];

/** Atoms that are not control items, checked only for their mark. */
const MARKED: readonly Pick<Planted, 'text' | 'section' | 'verified'>[] = [
  { text: 'Dana leads the billing team', section: 'Facts', verified: true },
  { text: 'The team ships releases on Fridays', section: 'Facts', verified: false },
];

/** A compaction setup the session is run under. */
export interface LossSession {
  name: string;
  config: CompactionConfig;
}

/**
 * The setups: a tail of entries and a tail of tokens, both with chapters small enough that each
 * round makes several and two per arc, so the session folds into arcs and the saga.
 */
export const LOSS_SESSIONS: readonly LossSession[] = [
  {
    name: 'entries',
    config: {
      strategy: 'hierarchical',
      threshold: 0,
      keepRecent: 4,
      chapterTokens: 120,
      chaptersPerArc: 2,
      arcsPerSaga: 2,
    },
  },
  {
    name: 'tokens',
    config: {
      strategy: 'hierarchical',
      threshold: 0,
      keepRecent: 0,
      keepRecentTokens: 80,
      chapterTokens: 200,
      chaptersPerArc: 2,
      arcsPerSaga: 2,
    },
  },
];

async function write(
  memory: InMemoryAdapter,
  threadId: string,
  step: Step,
  callId: string
): Promise<MemoryEntry[]> {
  const add = async (entry: Omit<MemoryEntry, 'id' | 'createdAt' | 'threadId' | 'tokenCount'>) => {
    const added = await memory.addEntry({
      threadId,
      ...entry,
      tokenCount: countMessageTokens(entry.message),
    });
    if (!added.success) throw new Error(added.error);
    return added.data;
  };
  if ('role' in step) return [await add({ message: { role: step.role, content: step.text } })];
  const call = { id: callId, name: step.tool, arguments: step.args };
  const asked = await add({
    message: { role: 'assistant', content: step.note },
    toolCalls: [call],
  });
  const answered = await add({
    message: {
      role: 'tool',
      content: step.error ? `Error: ${step.error}` : step.result,
      toolCallId: callId,
      name: step.tool,
    },
    toolResults: [
      {
        callId,
        name: step.tool,
        result: step.error ? undefined : step.result,
        ...(step.error && { error: step.error }),
      },
    ],
  });
  return [asked, answered];
}

const normalized = (text: string) => text.toLowerCase().replace(/\s+/g, ' ').trim();

const nodesOf = (levels: CompactionLevels): CompactionNode[] => [
  ...(levels.saga ? [levels.saga] : []),
  ...levels.arcs,
  ...levels.chapters,
];

/** The lines of each `## ` section of a handoff, without their `- ` bullets. */
export function handoffSections(handoff: string): Map<string, string[]> {
  const sections = new Map<string, string[]>();
  let current: string[] | undefined;
  for (const line of handoff.split('\n')) {
    const heading = /^## (.+)$/.exec(line);
    if (heading) {
      current = [];
      sections.set(heading[1]!, current);
    } else if (current && line.startsWith('- ')) {
      current.push(line.slice(2));
    }
  }
  return sections;
}

const lineOf = (item: Pick<Planted, 'text' | 'verified'>) =>
  `${item.text}${item.verified ? '' : ' (unverified)'}`;

/**
 * Checks what hierarchical compaction keeps of a session compacted again and again. A scripted
 * session with planted control items (open tasks, a decision, constraints, a failing tool call,
 * files written through tool calls, an open question) is compacted after each of its three
 * rounds by `CompactionService` with small chapters, two chapters to an arc and two arcs to the
 * saga, under a tail of entries and a tail of tokens. The chapter model is a stub that names an
 * item only the first time it reads it, misquotes some, claims a task done that no message
 * supports and answers junk every fourth call. The final summary, as the next run reads it, must
 * still list every open control item, both in its handoff and in its atoms, show a task closed
 * with evidence as done, keep the task claimed done without evidence open, mark atoms whose
 * quotes do not hold, and be followed by the end of the session verbatim. No model is called.
 */
export async function runCompactionLossSuite(
  sessions: readonly LossSession[] = LOSS_SESSIONS,
  mentions: readonly Mention[] = MENTIONS
): Promise<ConsistencyCheck[]> {
  const checks: ConsistencyCheck[] = [];
  for (const session of sessions) {
    const check = (name: string, passed: boolean, detail: string) =>
      checks.push({ name, strategy: session.name, passed, detail: passed ? 'ok' : detail });
    try {
      await runSession(session, mentions, check);
    } catch (error) {
      check('suite', false, error instanceof Error ? error.message : String(error));
    }
  }
  return checks;
}

async function runSession(
  session: LossSession,
  mentions: readonly Mention[],
  check: (name: string, passed: boolean, detail: string) => void
): Promise<void> {
  const memory = new InMemoryAdapter({ provider: 'memory' });
  await memory.connect();
  const threadId = `loss:${session.name}`;
  const created = await memory.createThread('compaction-loss', {}, threadId);
  if (!created.success) throw new Error(created.error);
  const model = new StubChapterModel(mentions);
  const service = new CompactionService({ adapter: memory, summarize: model.summarize });

  const written: MemoryEntry[] = [];
  const published: number[] = [];
  for (const [round, steps] of SESSION_ROUNDS.entries()) {
    for (const [index, step] of steps.entries()) {
      written.push(...(await write(memory, threadId, step, `call-${round}-${index}`)));
    }
    const result = await service.compact(threadId, session.config);
    published.push(result.summaryTokens);
  }

  const path = await memory.getPath({
    threadId,
    types: HISTORY_ENTRY_TYPES,
    includeToolCalls: true,
  });
  if (!path.success) throw new Error(path.error);
  const compactions = path.data.filter((entry) => entry.type === 'compaction');
  const [summary, ...tail] = compactedHistory(path.data);
  if (summary?.type !== 'compaction') throw new Error('The session holds no summary');
  const levels = (summary.event as Partial<CompactionEvent> | undefined)?.levels;
  if (!levels) throw new Error('The summary holds no levels');
  const handoff = String(summary.message.content);
  const sections = handoffSections(handoff);
  const atoms = nodesOf(levels).flatMap((node) => node.atoms);
  const atomsOf = (item: Pick<Planted, 'kind' | 'text'>): CompactionAtom[] =>
    atoms.filter(
      (atom) => atom.kind === item.kind && normalized(atom.text) === normalized(item.text)
    );
  const listed = (section: string, line: string) => sections.get(section)?.includes(line) ?? false;

  check(
    `rounds: ${SESSION_ROUNDS.length} compactions published, folded into arcs and the saga`,
    published.every((tokens) => tokens > 0) &&
      compactions.length === SESSION_ROUNDS.length &&
      levels.saga !== undefined &&
      levels.arcs.length > 0,
    `${published.filter((tokens) => tokens > 0).length} summaries published, ` +
      `${compactions.length} on the branch, saga ${levels.saga ? 'present' : 'missing'}, ` +
      `${levels.arcs.length} arcs`
  );

  const open = PLANTED.filter((item) => item.state === 'open');
  const missingLines = open.filter((item) => !listed(item.section, lineOf(item)));
  check(
    'open items: every planted open control item is in the handoff',
    missingLines.length === 0,
    `missing: ${missingLines.map((item) => `${item.section} / ${lineOf(item)}`).join(', ')}`
  );
  const lostAtoms = open.filter((item) => {
    const found = atomsOf(item);
    const closed = found.some((atom) => atom.status === 'closed' && atom.verified);
    return closed || !found.some((atom) => atom.status === 'open');
  });
  check(
    'open items: every planted open control item is an open atom of the levels',
    lostAtoms.length === 0,
    `lost or closed: ${lostAtoms.map((item) => `${item.kind} "${item.text}"`).join(', ')}`
  );

  const done = PLANTED.filter((item) => item.state === 'done');
  const notDone = done.filter(
    (item) =>
      !listed('Done', lineOf(item)) ||
      listed('Open tasks', lineOf(item)) ||
      !atomsOf(item).some((atom) => atom.status === 'closed' && atom.verified)
  );
  check(
    'done: an item closed with evidence that holds shows as done, not open',
    notDone.length === 0,
    `not done: ${notDone.map((item) => item.text).join(', ')}`
  );

  const claim = UNSUPPORTED_CLAIM;
  const claimed = model.said.has(claim.trigger);
  const keptOpen =
    listed('Open tasks', claim.task) &&
    !(sections.get('Done') ?? []).some((line) => line.startsWith(claim.task));
  check(
    'unsupported close: a task claimed done without evidence stays open',
    claimed && keptOpen,
    claimed
      ? `"${claim.task}" is not listed as an open task, or is listed as done`
      : 'the stub never made the unsupported claim'
  );

  const marks = [...PLANTED, ...MARKED];
  const wrongMarks = marks.filter((item) => {
    const lines = sections.get(item.section) ?? [];
    return (
      !lines.includes(lineOf(item)) || lines.includes(lineOf({ ...item, verified: !item.verified }))
    );
  });
  const unverified = marks.filter((item) => !item.verified).length;
  check(
    'unverified: atoms whose quotes do not hold are marked, grounded ones are not',
    unverified > 0 && wrongMarks.length === 0,
    wrongMarks.length > 0
      ? `wrong or missing mark: ${wrongMarks.map((item) => lineOf(item)).join(', ')}`
      : 'no unverified atom was planted'
  );

  const suffix = written.slice(written.length - tail.length);
  const verbatim =
    tail.length > 0 &&
    tail.every((entry, at) => {
      const original = suffix[at];
      return (
        entry.id === original?.id &&
        entry.message.role === original.message.role &&
        entry.message.content === original.message.content &&
        JSON.stringify(entry.toolCalls ?? []) === JSON.stringify(original.toolCalls ?? []) &&
        JSON.stringify(entry.toolResults ?? []) === JSON.stringify(original.toolResults ?? [])
      );
    });
  const tailTokens = tail.reduce((sum, entry) => sum + countEntryTokens(entry), 0);
  const sized =
    session.config.keepRecentTokens !== undefined
      ? tail[0]?.message.role === 'user' && tailTokens <= session.config.keepRecentTokens
      : tail.length === session.config.keepRecent;
  check(
    'tail: the kept tail is the end of the session, verbatim and of the size asked',
    verbatim && sized,
    verbatim
      ? `${tail.length} entries, ${tailTokens} tokens, starting with ${tail[0]?.message.role}`
      : `the ${tail.length} entries after the summary are not the last ones written, as written`
  );

  const junkPublished =
    JUNK_ANSWERS.some((answer) => handoff.includes(answer)) || handoff.includes('Junk atom');
  check(
    'retry: junk answers were asked again and never published',
    model.junk > 0 && !junkPublished,
    model.junk === 0 ? 'the stub never answered junk' : 'a junk answer reached the summary'
  );
}
