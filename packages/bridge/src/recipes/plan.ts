import { dirname, join, relative } from 'node:path';
import type { Workflow } from '@cogitator-ai/types';
import { WorkflowBuilder } from '@cogitator-ai/workflows';
import { z } from 'zod';
import { JobContextSchema } from '../handover.js';
import { oneLine, quoted } from '../letters.js';
import {
  defineRecipe,
  type Recipe,
  type RecipeJob,
  type RecipeOutcome,
  type RecipeRun,
  type RecipeState,
} from './recipe.js';
import {
  changedSince,
  copyOut,
  keep,
  kept,
  outProblem,
  outRoot,
  runFolder,
  treeOf,
} from './run-folder.js';
import {
  Address,
  ONE_LINE,
  PLAN_TYPE,
  TASK_LENGTH,
  attempted,
  endOf,
  freshFor,
  handBack,
  plural,
} from './steps.js';

/** How many times the merger of a plan is sent back to it when the input names no number. */
export const DEFAULT_PLAN_ROUNDS = 2;

const PLAN_FILE = 'plan.md';
const DECISIONS_FILE = 'decisions.md';
const NOT_AGREED = 'Not agreed between the planners';

const PlanInput = z.strictObject({
  planners: z.array(Address).min(2).max(4),
  rounds: z.number().int().min(0).max(5).optional(),
  out: z.string().trim().min(1).max(4096).regex(ONE_LINE, 'A path is one line').optional(),
  context: JobContextSchema.optional(),
});

type PlanInput = z.infer<typeof PlanInput>;

/** A file the bridge kept of what a planner reported, and the job it was reported in. */
interface Kept {
  job: number;
  path: string;
}

/** One of the agents that plan, by its place among them. */
interface Planner {
  /** Who was asked, as the input named it */
  to: string;
  /** The session that planned for this place last */
  agent?: string;
  draft?: Kept;
  critique?: Kept;
}

/** What a checker said of the joint plan at one check. */
interface Verdict {
  /** The place of the checker among the planners, from 0 */
  seat: number;
  job?: number;
  /** False when its job ended without a report, failed, or was never handed over */
  answered: boolean;
  signed: boolean;
  objections: string[];
}

/** Why no further step follows. */
type Ended = 'signed' | 'rounds' | 'stalled' | 'unanswered' | 'alone';

interface PlanState extends RecipeState {
  planners: Planner[];
  /** Whether the folder is in a repository the bridge can watch, once it looked */
  watched?: boolean;
  /** What was changed in the repository before the first step */
  tree?: string[];
  /** The place of the planner that wrote the joint plan */
  merger?: number;
  plan?: string;
  /** The verdicts of every check, in order */
  checks: Verdict[][];
  jobs: number[];
  /** What did not go as laid out, for the report */
  notes: string[];
  ended?: Ended;
  /** What was missing when the planners did not get to a joint plan */
  alone?: 'drafts' | 'merge' | 'check';
  /** Why the merger gave no answer to the objections */
  unanswered?: string;
}

/**
 * What a checker said of a plan: it signed only when the last line that is a verdict and
 * nothing else, `VERDICT: signed`, says so: the words inside a sentence are no verdict. No such line is no signature, and neither is a verdict of objections. The
 * objections are the lines `OBJECTION: ...` of an answer that did not sign.
 */
export function verdictOf(said: string | undefined): { signed: boolean; objections: string[] } {
  const text = said ?? '';
  const last = [
    ...text.matchAll(
      /^[ \t]*(?:[-*>][ \t]+)*\*{0,2}VERDICT:\*{0,2}[ \t]*(signed|objections)[ \t]*[.!]?\*{0,2}[ \t]*$/gim
    ),
  ].at(-1);
  if (last?.[1]?.toLowerCase() === 'signed') return { signed: true, objections: [] };
  const objections = [...text.matchAll(/^[ \t]*(?:[-*][ \t]+)?\*{0,2}OBJECTION:\*{0,2}(.*)$/gim)]
    .map((found) => oneLine(found[1] ?? ''))
    .filter((objection) => objection !== '');
  return { signed: false, objections };
}

/** How many objections a check left open: a checker that did not sign and named none counts once. */
function openOf(check: readonly Verdict[]): number {
  return check
    .filter((verdict) => !verdict.signed)
    .reduce((count, verdict) => count + Math.max(verdict.objections.length, 1), 0);
}

function nameOf(state: PlanState, seat: number): string {
  const planner = state.planners[seat];
  return planner?.agent ?? `planner ${seat + 1} (${planner?.to ?? 'nobody'})`;
}

/** The name of whoever wrote the joint plan. */
function mergerOf(state: PlanState): string {
  return nameOf(state, state.merger ?? 0);
}

function drafted(state: PlanState): number[] {
  return state.planners.flatMap((planner, seat) => (planner.draft ? [seat] : []));
}

function saidOf(outcome: RecipeOutcome): string | undefined {
  return outcome.job.state === 'completed' && outcome.report?.trim() ? outcome.report : undefined;
}

function head(state: PlanState, seat: number): string {
  return `You are planner ${seat + 1} of ${state.planners.length}.`;
}

const HEADINGS = [
  '## Goal: what is true when the work is done',
  '## What is there today: what the code holds already, with the paths and the lines you read yourself',
  '## Design: the parts, the data, the boundaries, what talks to what',
  '## Steps: in order, each with its files, what changes, and how to check it',
  '## Checks: the commands that show the work holds',
  '## Risks: what can go wrong, and what is left out on purpose',
  '## Questions: what only a person can decide',
].join('\n');

function draftText(run: RecipeRun, state: PlanState, seat: number): string {
  return [
    `${head(state, seat)} Several agents plan the same work apart, each without seeing the plans of the others, and then settle on one plan together. Change no file: read what you need in the repository, and write your plan as the report of this job, whole, in Markdown. The bridge keeps it as a file once every planner reported.`,
    `The work to plan:\n${quoted(run.task)}`,
    `Write the plan under these headings, in this order:\n${HEADINGS}`,
    'Plan for whoever builds this without having seen any of it: say what you decided, not what could be decided, and name what you read rather than what you suppose.',
  ].join('\n\n');
}

function plansOf(state: PlanState, seats: readonly number[]): string {
  return seats
    .map(
      (seat) =>
        `- planner ${seat + 1}, ${nameOf(state, seat)}: ${state.planners[seat]?.draft?.path}`
    )
    .join('\n');
}

function critiqueText(run: RecipeRun, state: PlanState, seat: number): string {
  const others = drafted(state).filter((other) => other !== seat);
  return [
    `${head(state, seat)} Every planner wrote a plan of the same work apart. Now read ${others.length === 1 ? 'the plan of the other' : 'the plans of the others'} and check ${others.length === 1 ? 'it' : 'them'} against the code, not against your taste. Change no file: your report is the critique, whole, and the bridge keeps it as a file.`,
    `The work that is planned:\n${quoted(run.task)}`,
    `${others.length === 1 ? 'The plan to read' : 'The plans to read'}:\n${plansOf(state, others)}`,
    [
      'Write numbered points, each of one kind:',
      'take: here the other plan is better than yours, and the joint plan should take it',
      'fault: this is wrong or will not work, with what in the code shows it',
      'gap: this is missing',
      'beside: this is no part of the work that was asked for',
    ].join('\n'),
    'Name the plan and the heading each point is about. Do not rewrite your own plan.',
  ].join('\n\n');
}

function critiquesOf(state: PlanState): string {
  const lines = state.planners.flatMap((planner, seat) =>
    planner.critique
      ? [`- by planner ${seat + 1}, ${nameOf(state, seat)}: ${planner.critique.path}`]
      : []
  );
  return lines.length > 0 ? lines.join('\n') : 'Nobody wrote one.';
}

function mergeText(run: RecipeRun, state: PlanState, seat: number, folder: string): string {
  return [
    `${head(state, seat)} Every planner wrote a plan of the same work apart, and a critique of the plans of the others. Now write the one plan all of you can stand behind. You do not defend your own draft: take what is best, wherever it comes from.`,
    `The work that is planned:\n${quoted(run.task)}`,
    `The plans:\n${plansOf(state, drafted(state))}`,
    `The critiques:\n${critiquesOf(state)}`,
    `Write the joint plan to ${join(folder, PLAN_FILE)}, under the headings the drafts have. Write to ${join(folder, DECISIONS_FILE)} what you did with every point of every critique: taken, or declined and why. Change no other file.`,
    'The others then read both files, and sign the plan or object to it. Report in a few lines once both files are written.',
  ].join('\n\n');
}

function verdictLines(state: PlanState, check: readonly Verdict[], signed = true): string[] {
  return check.flatMap((verdict) => {
    const name = nameOf(state, verdict.seat);
    if (verdict.signed) return signed ? [`- ${name} signed`] : [];
    if (!verdict.answered) return [`- ${name} gave no answer`];
    if (verdict.objections.length === 0) return [`- ${name} did not sign and named no objection`];
    return verdict.objections.map((objection) => `- ${name}: ${objection}`);
  });
}

const HOW_TO_END =
  'End with one line, exactly in this form: VERDICT: signed when you stand behind the plan as it is, VERDICT: objections otherwise. With objections, give each on a line of its own before it, in this form: OBJECTION: <heading> - <what is wrong and why>.';

function checkText(
  run: RecipeRun,
  state: PlanState,
  seat: number,
  at: number,
  folder: string
): string {
  const merger = mergerOf(state);
  const before = state.checks.at(-1)?.find((verdict) => verdict.seat === seat && !verdict.signed);
  return [
    `${head(state, seat)} ${merger} wrote the joint plan from the drafts and the critiques of all. Read it, and what was decided on the critiques, and say whether you stand behind it. Change no file.`,
    `The work that is planned:\n${quoted(run.task)}`,
    `The joint plan: ${state.plan}\nWhat was decided on every point of the critiques: ${join(folder, DECISIONS_FILE)}`,
    ...(at > 1
      ? [
          `This is check ${at}. ${merger} answered the objections of the check before, in the plan or in the decisions.${before ? ` Yours were:\n${verdictLines(state, [before]).join('\n')}` : ''}`,
        ]
      : []),
    'Object only to what would make the plan fail, or mislead whoever builds by it. Taste, wording and what lies beside the work are no objections.',
    HOW_TO_END,
  ].join('\n\n');
}

function reviseText(state: PlanState, at: number, rounds: number, folder: string): string {
  const last = state.checks.at(-1) ?? [];
  return [
    `The others read the joint plan and did not all sign it. For each objection either change ${state.plan}, or decline it in ${join(folder, DECISIONS_FILE)} with your reason. Change no other file.`,
    `Where the checkers stand:\n${verdictLines(state, last).join('\n')}`,
    `This is round ${at} of ${rounds} of answers. They read both files again once you report.`,
  ].join('\n\n');
}

/** What a session that takes the place of one that is gone has to know of its work. */
function background(state: PlanState, seat: number): string {
  const planner = state.planners[seat];
  const wrote = [
    ...(planner?.draft ? [`its plan is in ${planner.draft.path}`] : []),
    ...(planner?.critique ? [`its critique in ${planner.critique.path}`] : []),
  ];
  return wrote.length > 0
    ? `You take the place of a session that planned as planner ${seat + 1} before and is gone: ${wrote.join(', ')}.`
    : '';
}

type Tried = { outcome: RecipeOutcome } | { refused: string };

/** Hands a step to the session of a place, and to a fresh one of its harness when it has none. */
async function turn(
  run: RecipeRun,
  state: PlanState,
  seat: number,
  step: string,
  job: Omit<RecipeJob, 'to'>
): Promise<Tried> {
  const planner = state.planners[seat];
  const known = planner?.agent ? await run.agent(planner.agent) : undefined;
  const behind = background(state, seat);
  const tried = await attempted(run, () =>
    known
      ? handBack(run, step, known, job, behind)
      : run.handOver(step, {
          ...job,
          to: freshFor(planner?.to ?? ''),
          body: planner?.agent && behind ? `${job.body}\n\n${behind}` : job.body,
        })
  );
  return 'refused' in tried ? tried : { outcome: tried.done };
}

function jobOf(run: RecipeRun, what: string, body: string): Omit<RecipeJob, 'to'> {
  return {
    title: `${run.job.title} (plan, ${what})`,
    body,
    type: PLAN_TYPE,
    cwd: run.job.cwd,
    worktree: false,
  };
}

function withJobs(state: PlanState, tried: readonly Tried[]): number[] {
  const added = tried.flatMap((one) => ('outcome' in one ? [one.outcome.job.number] : []));
  return [...new Set([...state.jobs, ...added])].sort((one, other) => one - other);
}

async function look(run: RecipeRun, state: PlanState): Promise<Partial<PlanState>> {
  if (state.watched !== undefined) return {};
  const tree = await treeOf(run.job.cwd);
  return { watched: tree !== undefined, ...(tree && { tree }) };
}

async function drafts(
  run: RecipeRun,
  input: PlanInput,
  state: PlanState
): Promise<Partial<PlanState>> {
  const folder = runFolder(run.job.cwd, run.job.number);
  const tried = await Promise.all(
    state.planners.map(async (planner, seat): Promise<Tried> => {
      const job = jobOf(run, 'draft', draftText(run, state, seat));
      const done = await attempted(run, () =>
        run.handOver(`draft.${seat + 1}`, {
          ...job,
          to: freshFor(planner.to),
          ...(input.context && { context: input.context }),
        })
      );
      return 'refused' in done ? done : { outcome: done.done };
    })
  );
  const planners: Planner[] = [];
  const notes = [...state.notes];
  for (const [seat, planner] of state.planners.entries()) {
    const one = tried[seat];
    if (!one || 'refused' in one) {
      notes.push(
        `Planner ${seat + 1} (${planner.to}) wrote no draft: ${oneLine(one?.refused ?? 'the bridge refused the job')}`
      );
      planners.push(planner);
      continue;
    }
    const said = saidOf(one.outcome);
    const agent = one.outcome.job.to;
    if (said === undefined) {
      notes.push(`Planner ${seat + 1} (${planner.to}) wrote no draft: ${endOf(one.outcome.job)}`);
      planners.push({ ...planner, agent });
      continue;
    }
    const path = await keep(folder, `draft-${seat + 1}.md`, said);
    planners.push({ ...planner, agent, draft: { job: one.outcome.job.number, path } });
  }
  const enough = planners.filter((planner) => planner.draft).length >= 2;
  return {
    planners,
    notes,
    jobs: withJobs(state, tried),
    ...(!enough && { ended: 'alone' as const, alone: 'drafts' as const }),
  };
}

async function critiques(run: RecipeRun, state: PlanState): Promise<Partial<PlanState>> {
  if (state.ended) return {};
  const folder = runFolder(run.job.cwd, run.job.number);
  const seats = drafted(state);
  const tried = await Promise.all(
    seats.map((seat) =>
      turn(
        run,
        state,
        seat,
        `critique.${seat + 1}`,
        jobOf(run, 'critique', critiqueText(run, state, seat))
      )
    )
  );
  const planners = [...state.planners];
  const notes = [...state.notes];
  for (const [index, seat] of seats.entries()) {
    const one = tried[index];
    const planner = planners[seat];
    if (!one || !planner) continue;
    if ('refused' in one) {
      notes.push(`${nameOf(state, seat)} wrote no critique: ${oneLine(one.refused)}`);
      continue;
    }
    const agent = one.outcome.job.to;
    const said = saidOf(one.outcome);
    if (said === undefined) {
      notes.push(`${agent} wrote no critique: ${endOf(one.outcome.job)}`);
      planners[seat] = { ...planner, agent };
      continue;
    }
    const path = await keep(folder, `critique-${seat + 1}.md`, said);
    planners[seat] = { ...planner, agent, critique: { job: one.outcome.job.number, path } };
  }
  return { planners, notes, jobs: withJobs(state, tried) };
}

async function merge(run: RecipeRun, state: PlanState): Promise<Partial<PlanState>> {
  if (state.ended) return {};
  const folder = runFolder(run.job.cwd, run.job.number);
  const plan = join(folder, PLAN_FILE);
  let now = state;
  for (const seat of drafted(state)) {
    const tried = await turn(
      run,
      now,
      seat,
      `merge.${seat + 1}`,
      jobOf(run, 'merge', mergeText(run, now, seat, folder))
    );
    const jobs = withJobs(now, [tried]);
    if ('refused' in tried) {
      now = {
        ...now,
        jobs,
        notes: [
          ...now.notes,
          `${nameOf(now, seat)} was not asked to merge: ${oneLine(tried.refused)}`,
        ],
      };
      continue;
    }
    const { job } = tried.outcome;
    const planners = now.planners.map((planner, at) =>
      at === seat ? { ...planner, agent: job.to } : planner
    );
    if (job.state === 'completed' && (await kept(plan)) !== undefined) {
      return { planners, jobs, notes: now.notes, merger: seat, plan };
    }
    const why = job.state === 'completed' ? 'left no plan' : `left no plan: ${endOf(job)}`;
    now = {
      ...now,
      planners,
      jobs,
      notes: [...now.notes, `${job.to} was asked to merge in job #${job.number} and ${why}`],
    };
  }
  return {
    planners: now.planners,
    jobs: now.jobs,
    notes: now.notes,
    ended: 'alone',
    alone: 'merge',
  };
}

async function check(
  run: RecipeRun,
  state: PlanState,
  at: number,
  rounds: number
): Promise<Partial<PlanState>> {
  if (state.ended || state.merger === undefined) return {};
  const folder = runFolder(run.job.cwd, run.job.number);
  const seats = drafted(state).filter((seat) => seat !== state.merger);
  const tried = await Promise.all(
    seats.map((seat) =>
      turn(
        run,
        state,
        seat,
        `check-${at}.${seat + 1}`,
        jobOf(run, `check ${at}`, checkText(run, state, seat, at, folder))
      )
    )
  );
  const planners = [...state.planners];
  const notes = [...state.notes];
  const verdicts = seats.map((seat, index): Verdict => {
    const one = tried[index];
    if (!one || 'refused' in one) {
      notes.push(
        `${nameOf(state, seat)} was not asked at check ${at}: ${oneLine(one?.refused ?? 'the bridge refused the job')}`
      );
      return { seat, answered: false, signed: false, objections: [] };
    }
    const planner = planners[seat];
    if (planner) planners[seat] = { ...planner, agent: one.outcome.job.to };
    const said = saidOf(one.outcome);
    return {
      seat,
      job: one.outcome.job.number,
      answered: said !== undefined,
      ...verdictOf(said),
    };
  });
  const jobs = withJobs(state, tried);
  if (at === 1 && !verdicts.some((verdict) => verdict.answered)) {
    return { planners, notes, jobs, ended: 'alone', alone: 'check' };
  }
  const before = state.checks.at(-1);
  const ended: Ended | undefined = verdicts.every((verdict) => verdict.signed)
    ? 'signed'
    : at > rounds
      ? 'rounds'
      : before && openOf(verdicts) >= openOf(before)
        ? 'stalled'
        : undefined;
  return { planners, notes, jobs, checks: [...state.checks, verdicts], ...(ended && { ended }) };
}

async function revise(
  run: RecipeRun,
  state: PlanState,
  at: number,
  rounds: number
): Promise<Partial<PlanState>> {
  if (state.ended || state.merger === undefined || !state.plan) return {};
  const folder = runFolder(run.job.cwd, run.job.number);
  const tried = await turn(
    run,
    state,
    state.merger,
    `revise-${at}`,
    jobOf(run, `answers ${at}`, reviseText(state, at, rounds, folder))
  );
  const jobs = withJobs(state, [tried]);
  if ('refused' in tried) {
    return { jobs, ended: 'unanswered', unanswered: oneLine(tried.refused) };
  }
  const { job } = tried.outcome;
  const planners = state.planners.map((planner, seat) =>
    seat === state.merger ? { ...planner, agent: job.to } : planner
  );
  if (job.state !== 'completed') {
    return { planners, jobs, ended: 'unanswered', unanswered: endOf(job) };
  }
  if ((await kept(state.plan)) === undefined) {
    return { planners, jobs, ended: 'unanswered', unanswered: `${state.plan} is gone` };
  }
  return { planners, jobs };
}

function alone(state: PlanState): string[] {
  const seats = drafted(state);
  const why =
    state.alone === 'drafts'
      ? `${seats.length} of ${plural(state.planners.length, 'agent')} wrote a draft, and a plan of one is no joint plan`
      : state.alone === 'merge'
        ? 'nobody merged the drafts'
        : `${mergerOf(state)} merged the drafts into ${state.plan}, and nobody checked the plan`;
  const wrote = seats.flatMap((seat) => {
    const planner = state.planners[seat];
    return [
      ...(planner?.draft ? [`- ${nameOf(state, seat)}: ${planner.draft.path}`] : []),
      ...(planner?.critique ? [`- ${nameOf(state, seat)}: ${planner.critique.path}`] : []),
    ];
  });
  return [
    `No joint plan was written: ${why}.`,
    ...(wrote.length > 0 ? ['What was written:', ...wrote] : []),
  ];
}

function open(count: number): string {
  return `${plural(count, 'objection')} ${count === 1 ? 'is' : 'are'} open`;
}

function how(state: PlanState, rounds: number): string {
  const merger = mergerOf(state);
  const last = state.checks.at(-1) ?? [];
  const at = state.checks.length;
  if (state.ended === 'signed') {
    const signers = last.map((verdict) => nameOf(state, verdict.seat));
    const who =
      signers.length < 3
        ? signers.join(' and ')
        : `${signers.slice(0, -1).join(', ')} and ${signers.at(-1)}`;
    return `: ${merger} wrote it from the drafts and the critiques of all, and ${who} signed it at ${at === 1 ? 'the first check' : `check ${at}`}.`;
  }
  if (state.ended === 'stalled') {
    const before = openOf(state.checks.at(-2) ?? []);
    const left = rounds - (at - 1);
    return `, and it is not agreed: the last round of answers brought it no closer, with ${plural(before, 'objection')} open before it and ${openOf(last)} after. The bridge stopped here with ${plural(left, 'round')} left: one more of the same would not end it.`;
  }
  if (state.ended === 'unanswered') {
    return `, and it is not agreed: ${merger} did not answer the objections of the last check (${state.unanswered ?? 'no answer'}).`;
  }
  return `, and it is not agreed: ${open(openOf(last))}, and no round of answers is left.`;
}

/** Puts what is still open under a heading of its own at the end of the plan, once. */
async function markOpen(state: PlanState, plan: string, decisions: string): Promise<void> {
  const text = await kept(plan);
  if (text === undefined || new RegExp(`^## ${NOT_AGREED}[ \\t]*$`, 'm').test(text)) return;
  const merger = mergerOf(state);
  const section = [
    `## ${NOT_AGREED}`,
    `${merger} wrote this plan from the drafts and the critiques of all. When the planning ended, this was still open:`,
    verdictLines(state, state.checks.at(-1) ?? [], false).join('\n'),
    `What ${merger} decided on every point is in ${decisions}.`,
  ].join('\n\n');
  await keep(dirname(plan), PLAN_FILE, `${text.trimEnd()}\n\n${section}\n`);
}

async function summary(
  run: RecipeRun,
  input: PlanInput,
  state: PlanState,
  rounds: number
): Promise<Partial<PlanState>> {
  const cwd = run.job.cwd;
  const folder = runFolder(cwd, run.job.number);
  const jobs = state.jobs.map((job) => `#${job}`).join(', ');
  const every = jobs ? [`Every step is a job of its own: ${jobs}.`] : [];
  if (state.ended === 'alone' || !state.plan) {
    return {
      report: [...alone(state), ...state.notes, ...every].join('\n'),
      failed: true,
    };
  }
  const decisions = join(folder, DECISIONS_FILE);
  const agreed = state.ended === 'signed';
  const lines = [
    `The joint plan of ${plural(drafted(state).length, 'agent')} is in ${state.plan}${how(state, rounds)}`,
  ];
  if (!agreed) {
    lines.push(
      'Where the checkers stand:',
      ...verdictLines(state, state.checks.at(-1) ?? []),
      `The plan says so under a heading of its own, "${NOT_AGREED}".`
    );
    await markOpen(state, state.plan, decisions);
  }
  lines.push(
    (await kept(decisions)) === undefined
      ? `${mergerOf(state)} left no ${DECISIONS_FILE}: what it did with the critiques is not written down.`
      : `What ${mergerOf(state)} decided on every point of the critiques is in ${decisions}.`
  );
  let final = state.plan;
  let copied: string | undefined;
  if (input.out) {
    try {
      copied = await copyOut(state.plan, cwd, input.out);
      final = copied;
      lines.push(`A copy is in ${copied}.`);
    } catch (error) {
      lines.push(
        `No copy was made: ${oneLine(error instanceof Error ? error.message : String(error))}`
      );
    }
  }
  lines.push(...state.notes);
  if (state.watched) {
    const except = copied ? [relative(await outRoot(cwd), copied)] : [];
    const changed = changedSince(state.tree ?? [], (await treeOf(cwd)) ?? [], except);
    if (changed.length > 0) {
      lines.push(
        'Changed in the repository while the plan was written, by whom the bridge cannot tell:',
        ...changed.map((line) => `- ${line}`)
      );
    }
  } else {
    lines.push(
      `${cwd} is in no git repository, so the bridge could not see whether anything else was changed.`
    );
  }
  lines.push(
    `Everything the planners wrote is in ${folder}: the drafts, the critiques, the decisions.`,
    ...every,
    `To have it built, hand it to an agent with the commands of its Checks section as checks: cogitator bridge build codex "Carry out the plan in ${final}" --check "<a command of the plan>"`
  );
  return { report: lines.join('\n') };
}

async function planWorkflow(input: PlanInput, run: RecipeRun): Promise<Workflow<PlanState>> {
  if (run.task.length > TASK_LENGTH) {
    throw new Error(
      `the work to plan takes ${TASK_LENGTH} characters at most, and this one has ${run.task.length}. Every planner reads it whole at every step: put the details in a file and name it`
    );
  }
  const seats = input.planners.map((to) => ({ to }));
  if (input.out) {
    const started = await Promise.all(seats.map((_, seat) => run.handedOver(`draft.${seat + 1}`)));
    const problem = started.some(Boolean) ? undefined : await outProblem(run.job.cwd, input.out);
    if (problem) throw new Error(`the plan cannot be copied to ${input.out}: ${problem}`);
  }
  const rounds = input.rounds ?? DEFAULT_PLAN_ROUNDS;
  const builder = new WorkflowBuilder<PlanState>('bridge-plan').initialState({
    planners: seats,
    checks: [],
    jobs: [],
    notes: [],
  });
  let last: string | undefined;
  const step = (name: string, work: (state: PlanState) => Promise<Partial<PlanState>>): void => {
    builder.addNode(
      name,
      async ({ state }) => ({ state: await work(state) }),
      last === undefined ? undefined : { after: [last] }
    );
    last = name;
  };
  step('look', (state) => look(run, state));
  step('drafts', (state) => drafts(run, input, state));
  step('critiques', (state) => critiques(run, state));
  step('merge', (state) => merge(run, state));
  step('check-1', (state) => check(run, state, 1, rounds));
  for (let at = 1; at <= rounds; at += 1) {
    step(`revise-${at}`, (state) => revise(run, state, at, rounds));
    step(`check-${at + 1}`, (state) => check(run, state, at + 1, rounds));
  }
  step('report', (state) => summary(run, input, state, rounds));
  return builder.build();
}

/**
 * `plan`: two to four agents plan the same work and settle on one plan. Each writes a plan
 * apart, as the report of its job: the bridge keeps the drafts as files only once all of them
 * are in, so nobody plans from the plan of another. Each then reads the plans of the others and
 * reports a critique. The first planner that has a draft merges all of it into one plan and
 * writes down what it did with every point of the critiques. The others sign the plan or
 * object, and the merger answers the objections, for `rounds` rounds at most.
 *
 * It ends when every checker signed at the same check, when the rounds ran out, when a round of
 * answers left no fewer objections open, or when the merger gave no answer. What is still open
 * then is said in the report and under a heading of its own at the end of the plan. With fewer
 * than two drafts, with nobody to merge them, or with nobody to check the merged plan there is
 * no joint plan, and the recipe fails.
 *
 * The files of a run are in `.cogitator/plans/job-<number>` under the folder the recipe was
 * started in: `draft-<n>.md`, `critique-<n>.md`, `plan.md`, `decisions.md`. No planner is to
 * change anything else, and the report names what changed in the repository meanwhile.
 *
 * Input: `planners`, two to four agents or harness words, the first of which merges. `rounds`,
 * 2 by default. `out`, where to copy the plan to, a path from the folder of the run inside its
 * repository, at which nothing is yet. `context`, what the caller knows, as `build` takes it.
 */
export const planRecipe: Recipe = defineRecipe({
  name: 'plan',
  summary:
    'Agents plan the same work apart, read the plans of each other, and settle on one plan they sign or object to',
  input: PlanInput,
  workflow: planWorkflow,
});
