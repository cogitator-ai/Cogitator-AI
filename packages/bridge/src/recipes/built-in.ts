import { isAbsolute, join, relative } from 'node:path';
import type { Workflow } from '@cogitator-ai/types';
import { WorkflowBuilder } from '@cogitator-ai/workflows';
import { z } from 'zod';
import {
  FINDING_SEVERITIES,
  MAX_FINDINGS,
  findingLine,
  findingsCount,
  holdsUp,
  ofTheWork,
  parseFindings,
  severitiesCount,
  type Finding,
  type FindingSeverity,
} from '../findings.js';
import { JobContextSchema } from '../handover.js';
import { oneLine, quoted } from '../letters.js';
import { JobCheckSchema, type BridgeJob, type JobCheck } from '../types.js';
import { debateRecipe } from './debate.js';
import { raceRecipe } from './race.js';
import {
  defineRecipe,
  type Recipe,
  type RecipeJob,
  type RecipeRun,
  type RecipeState,
} from './recipe.js';
import {
  Address,
  FIX_TYPE,
  REVIEW_TYPE,
  TASK_LENGTH,
  WORK_TYPE,
  attempted,
  checkedOf,
  clip,
  endOf,
  freshFor,
  handBack,
  plural,
  type Checked,
} from './steps.js';

/** How many rounds of fixes a review goes through at most when its input names no number. */
export const DEFAULT_REVIEW_ROUNDS = 2;

/**
 * The same for work of the type `fix`: a fix is small, and what a second round finds in it is
 * mostly what the first round of fixes added.
 */
export const FIX_REVIEW_ROUNDS = 1;

/** The lightest finding the author is sent back to fix when the input names no threshold. */
export const DEFAULT_REVIEW_THRESHOLD: FindingSeverity = 'major';

const Severity = z.enum(FINDING_SEVERITIES as [FindingSeverity, ...FindingSeverity[]]);

const ReviewOptions = {
  by: Address.optional(),
  rounds: z.number().int().min(0).max(5).optional(),
  threshold: Severity.optional(),
  focus: z.string().trim().min(1).max(4_000).optional(),
};

/** The work a review is about: a job that was done, where, and by whom. */
interface Work {
  job: number;
  /** The agent that did it, and fixes what the review finds */
  author: string;
  /** The harness of the author, to start a session of when the author is gone */
  harness: string;
  /** The folder the job was done in, where the review and the fixes are done too */
  cwd: string;
  /** The top of the worktree of the job, while its work is still there */
  root?: string;
  /** The commit the worktree of the job was made from */
  base?: string;
  /** What the job was, in the words of whoever handed it over */
  task: string;
  checks: JobCheck[];
  /** What the author reported, when it did */
  report?: string;
}

/** One round: a review, and the fix that answered it when one was asked for. */
interface Round {
  review: number;
  reviewer: string;
  /** Undefined when the review named no findings in a form the bridge reads */
  findings?: Finding[];
  fix?: number;
  fixReport?: string;
}

/**
 * Why no further round follows. `stalled`: a round of fixes left no fewer findings open than
 * there were before it while rounds were left, so another one of the same would not end the
 * review.
 */
type Stopped = 'clean' | 'stalled' | 'unreadable' | 'review-failed' | 'fix-failed' | 'no-work';

interface ReviewState extends RecipeState {
  work?: Work;
  /** Who reviews: the address of the first review, then the name of the agent that took it */
  reviewer?: string;
  rounds: Round[];
  /** What the checks of the job showed last: after the work, then after each fix */
  checked?: Checked;
  stopped?: Stopped;
}

interface ReviewPlan {
  /** How many times the author is sent back at most */
  rounds: number;
  threshold: FindingSeverity;
  focus?: string;
  by?: string;
}

/** The work of a job that is done, as a review needs it. */
async function workOf(run: RecipeRun, job: BridgeJob, report?: string): Promise<Work> {
  const author = await run.agent(job.to);
  const worktree = job.worktree && !job.worktree.end ? job.worktree : undefined;
  const end = job.worktree?.end;
  const below = job.worktree ? relative(job.worktree.path, job.cwd) : '';
  const inside = below.startsWith('..') || isAbsolute(below) ? '' : below;
  const taken = end?.how === 'accepted' && end.into ? join(end.into, inside) : undefined;
  return {
    job: job.number,
    author: job.to,
    harness: author?.harness ?? '',
    cwd: worktree ? job.cwd : (taken ?? (job.worktree ? run.job.cwd : job.cwd)),
    ...(worktree && { root: worktree.path, base: worktree.base }),
    task: await run.taskOf(job),
    checks: job.checks,
    ...(report && { report }),
  };
}

/**
 * Whether whoever started the recipe may have the work of a job reviewed: the agent that did the
 * job, the one that handed it over, and the one that started the recipe the job was a step of.
 */
async function mayHaveReviewed(run: RecipeRun, job: BridgeJob): Promise<boolean> {
  const caller = run.job.from;
  if (job.to === caller) return true;
  const conductors = (await run.agent(run.conductor))?.harness;
  for (let at: BridgeJob | undefined = job; at;) {
    if (at.from === caller) return true;
    const byRecipe = (await run.agent(at.from))?.harness === conductors;
    if (!byRecipe || at.parent === undefined) return false;
    at = await run.lookAt(at.parent);
  }
  return false;
}

/**
 * Who reviews when the input names nobody: a fresh session of another harness than the
 * author's, which reads the work with other eyes, and of the author's own when the bridge can
 * start no other. A harness word in the input gets a fresh session too: a session that is open
 * already may be the one that asked for the review.
 */
async function reviewerFor(run: RecipeRun, plan: ReviewPlan, work: Work): Promise<string> {
  if (plan.by) return freshFor(plan.by);
  const startable = await run.startable();
  const other = startable.find((harness) => harness !== work.harness);
  const harness = other ?? (startable.includes(work.harness) ? work.harness : undefined);
  if (!harness) {
    throw new Error(
      'The bridge can start no session to review the work. Name the reviewer in the input of the recipe: by'
    );
  }
  return `${harness}:new`;
}

function whereText(work: Work): string {
  return work.base
    ? `The work is in ${work.root ?? work.cwd}, a git worktree made from commit ${work.base.slice(0, 10)}: \`git diff ${work.base.slice(0, 10)}\` there shows what the job changed, committed or not, and \`git status\` the files it added.${work.root && work.root !== work.cwd ? ` The job was done in ${work.cwd}.` : ''}`
    : `The work is in ${work.cwd}, where the job was done: \`git status\` and \`git diff\` there show what is not committed yet.`;
}

const WHAT_COUNTS = [
  'Judge the work against the job. A finding is something the work gets wrong, leaves undone of what the job asks, or broke.',
  'What you notice beside that is worth naming too, but mark it as beside the job: a fault that was there before the job in code it had no need to change, or a case the job does not ask for. It does not hold the work up and is not sent back to its author.',
].join('\n');

const HOW_TO_REPORT = [
  'Report what you found as findings, each with its severity: blocker (must not go in as it is), major (should be fixed first), minor (worth fixing), nit (a matter of taste).',
  'Name them in the findings of your report when your report takes them, with beside set on those beside the job. Otherwise write one line for each, in exactly this form:',
  '[severity] path/to/file:line - what is wrong, and what would be right',
  'with [beside severity] in the brackets for one beside the job, as in [beside major], and the single line [none] when you found nothing. Report only what you checked in the code yourself.',
].join('\n');

/** The findings that hold the work up: about the work, and at or above the threshold. */
function openOf(findings: readonly Finding[] | undefined, plan: ReviewPlan): Finding[] {
  return (findings ?? []).filter((finding) => holdsUp(finding, plan.threshold));
}

/** What the reviews of a run noticed beside the job, each once, in the order it came up. */
function besideOf(rounds: readonly Round[]): Finding[] {
  const seen = new Set<string>();
  return rounds
    .flatMap((round) => round.findings ?? [])
    .filter((finding) => {
      if (ofTheWork(finding)) return false;
      const key = findingLine(finding);
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
}

function reviewText(work: Work, plan: ReviewPlan, state: ReviewState, round: number): string {
  const before = state.rounds.at(-1);
  const parts = [
    `Review the work of job #${work.job}, done by ${work.author}. Change no file: read, run what you need to check, and report.`,
    `The job was:\n${quoted(clip(work.task, TASK_LENGTH))}`,
    whereText(work),
  ];
  parts.push(WHAT_COUNTS);
  if (plan.focus) parts.push(`Look at this above all:\n${quoted(plan.focus)}`);
  if (round > 1 && before) {
    const asked = openOf(before.findings, plan);
    parts.push(
      [
        `This is round ${round}. ${work.author} was sent back to fix what the round before found:`,
        ...(asked.length > 0 ? asked.map(findingLine) : ['the checks of the job, which failed']),
        ...(before.fixReport ? [`and reported:\n${quoted(clip(before.fixReport))}`] : []),
        'Check that each is fixed, and that the fixes broke nothing. What the fixes added is part of the work.',
      ].join('\n')
    );
  }
  parts.push(HOW_TO_REPORT);
  return parts.join('\n\n');
}

function fixText(work: Work, plan: ReviewPlan, state: ReviewState): string {
  const findings = state.rounds.at(-1)?.findings ?? [];
  const must = openOf(findings, plan);
  const may = findings.filter((finding) => ofTheWork(finding) && !holdsUp(finding, plan.threshold));
  const beside = findings.length - must.length - may.length;
  const parts = [
    `Fix what the review of your work on job #${work.job} found. You work where you did the job: ${work.cwd}.`,
  ];
  if (must.length > 0) parts.push(['To fix:', ...must.map(findingLine)].join('\n'));
  if (state.checked?.failed) {
    parts.push(
      `The checks of the job do not pass${state.checked.summary ? `: ${oneLine(state.checked.summary)}` : ''}. Make them pass.`
    );
  }
  if (may.length > 0) {
    parts.push(
      ['Found too, fix what is quick and safe to fix:', ...may.map(findingLine)].join('\n')
    );
  }
  parts.push(
    'Fix each one, or say in your report why it is no problem. Leave alone what the findings do not touch.'
  );
  if (beside > 0) {
    parts.push(
      `The review noticed ${beside} more beside the job. ${beside === 1 ? 'It is' : 'They are'} no part of this job and not yours to fix here.`
    );
  }
  return parts.join('\n\n');
}

function needsFix(state: ReviewState, plan: ReviewPlan): boolean {
  return openOf(state.rounds.at(-1)?.findings, plan).length > 0 || state.checked?.failed === true;
}

async function review(
  run: RecipeRun,
  plan: ReviewPlan,
  state: ReviewState,
  round: number
): Promise<Partial<ReviewState>> {
  const work = state.work;
  if (!work || state.stopped) return {};
  const before = state.rounds.at(-1);
  const job: Omit<RecipeJob, 'to'> = {
    title: `Review of job #${work.job}${round > 1 ? `, round ${round}` : ''}`,
    cwd: work.cwd,
    body: reviewText(work, plan, state, round),
    type: REVIEW_TYPE,
    reviewOf: before?.fix ?? work.job,
  };
  const reviewer = before ? await run.agent(before.reviewer) : undefined;
  const outcome =
    before && reviewer
      ? await handBack(
          run,
          `review-${round}`,
          reviewer,
          job,
          'You did not see the rounds before: read the work as it is now.'
        )
      : await run.handOver(`review-${round}`, {
          ...job,
          to: state.reviewer ?? (await reviewerFor(run, plan, work)),
        });
  if (outcome.job.state !== 'completed') {
    return {
      rounds: [...state.rounds, { review: outcome.job.number, reviewer: outcome.job.to }],
      stopped: 'review-failed',
    };
  }
  const findings =
    outcome.job.findings ?? (outcome.report ? parseFindings(outcome.report) : undefined);
  const rounds = [
    ...state.rounds,
    { review: outcome.job.number, reviewer: outcome.job.to, ...(findings && { findings }) },
  ];
  if (!findings) return { rounds, stopped: 'unreadable', report: outcome.report };
  const next: ReviewState = { ...state, rounds };
  if (!needsFix(next, plan)) return { rounds, findings, stopped: 'clean' };
  const were = openOf(before?.findings, plan).length;
  const stalled = round <= plan.rounds && were > 0 && openOf(findings, plan).length >= were;
  return { rounds, findings, ...(stalled && { stopped: 'stalled' as const }) };
}

async function fix(
  run: RecipeRun,
  plan: ReviewPlan,
  state: ReviewState,
  round: number
): Promise<Partial<ReviewState>> {
  const work = state.work;
  const last = state.rounds.at(-1);
  if (!work || !last || state.stopped) return {};
  const outcome = await handBack(
    run,
    `fix-${round}`,
    { name: work.author, harness: work.harness },
    {
      title: `Fixes after the review of job #${work.job}${round > 1 ? `, round ${round}` : ''}`,
      cwd: work.cwd,
      checks: work.checks,
      body: fixText(work, plan, state),
      type: FIX_TYPE,
    },
    `You did not do that job yourself. It was:\n${quoted(clip(work.task, TASK_LENGTH))}\n\n${whereText(work)}`
  );
  const rounds = [
    ...state.rounds.slice(0, -1),
    {
      ...last,
      fix: outcome.job.number,
      ...(outcome.report && { fixReport: outcome.report }),
    },
  ];
  if (outcome.job.state !== 'completed') return { rounds, stopped: 'fix-failed' };
  const checked = checkedOf(outcome.job);
  return { rounds, ...(checked && { checked }) };
}

/** What the recipe tells whoever started it: how the review ended, round by round. */
function summary(state: ReviewState, plan: ReviewPlan): Partial<ReviewState> {
  const work = state.work;
  if (!work) return state.report ? {} : { failed: true, report: 'The recipe found no work' };
  const last = state.rounds.at(-1);
  const fixes = state.rounds.filter((round) => round.fix !== undefined).length;
  const open = openOf(last?.findings, plan);
  const beside = besideOf(state.rounds);
  const after = fixes > 0 ? ` after ${plural(fixes, 'round')} of fixes` : '';
  const lines: string[] = [];
  if (!last) {
    lines.push(`The work of job #${work.job} by ${work.author} was not reviewed.`);
  } else if (state.stopped === 'clean') {
    lines.push(
      `The work of job #${work.job} by ${work.author} passed the review of ${last.reviewer}${after}: nothing at or above ${plan.threshold} is open.`
    );
  } else if (state.stopped === 'review-failed') {
    lines.push(
      `The review of job #${work.job} did not finish: job #${last.review} of ${last.reviewer} ended without a report of what it found.`
    );
  } else if (state.stopped === 'unreadable') {
    lines.push(
      `${last.reviewer} reviewed job #${work.job} and named its findings in no form the bridge reads, so nothing was sent back to be fixed. Its report:`,
      quoted(clip(state.report ?? ''))
    );
  } else if (state.stopped === 'fix-failed') {
    lines.push(
      `The review of job #${work.job} is not clean: ${work.author} did not finish the fixes of job #${last.fix ?? last.review}. ${severitiesCount(open)} at or above ${plan.threshold} were open before them.`
    );
  } else if (state.stopped === 'stalled') {
    const were = openOf(state.rounds.at(-2)?.findings, plan);
    const left = plan.rounds - fixes;
    lines.push(
      `The review of job #${work.job} is not clean${after}, and the last round brought it no closer: ${severitiesCount(were)} at or above ${plan.threshold} ${were.length === 1 ? 'was' : 'were'} open before it, ${severitiesCount(open)} after. The bridge stopped here with ${plural(left, 'round')} left: one more of the same would not end it.`
    );
  } else {
    const left = [
      ...(open.length > 0
        ? [
            `${severitiesCount(open)} at or above ${plan.threshold} ${open.length === 1 ? 'is' : 'are'} still open`,
          ]
        : []),
      ...(state.checked?.failed ? ['the checks do not pass'] : []),
    ];
    lines.push(`The review of job #${work.job} is not clean${after}: ${left.join(', and ')}.`);
  }
  if (beside.length > 0) {
    lines.push(
      `Beside the job the review noticed ${severitiesCount(beside)}. ${beside.length === 1 ? 'It is' : 'They are'} no part of this work and ${beside.length === 1 ? 'was' : 'were'} not sent back: decide on ${beside.length === 1 ? 'it' : 'them'} apart from it.`,
      ...beside.map(findingLine)
    );
  }
  if (state.checked) {
    lines.push(
      `Checks: ${state.checked.verified ? 'passed' : state.checked.failed ? 'not passed' : 'not verified, the bridge did not run all of them'}${state.checked.summary ? `. ${oneLine(state.checked.summary)}` : ''}`
    );
  }
  for (const [at, round] of state.rounds.entries()) {
    const found = round.findings ? findingsCount(round.findings) : 'no findings the bridge reads';
    const fixed = round.fix === undefined ? '' : `, fixes in job #${round.fix}`;
    lines.push(
      `Round ${at + 1}: review in job #${round.review} by ${round.reviewer}, ${found}${fixed}.`
    );
  }
  lines.push(
    work.base
      ? `The work is in the worktree of job #${work.job}, with the fixes: look at it with diff, take it with accept, drop it with reject, each for job ${work.job}.`
      : `The work is in ${work.cwd}, with the fixes.`
  );
  if (work.report) lines.push(`${work.author} reported on the job:\n${quoted(clip(work.report))}`);
  return {
    report: lines.join('\n'),
    ...(state.stopped === 'review-failed' && { failed: true }),
    ...(last?.findings && { findings: handedOn(state.rounds, last.findings) }),
  };
}

/**
 * The findings a recipe hands on with its report: those of the last review, then what the
 * reviews before it noticed beside the job, as many as one report takes. The text of the report
 * names all of them.
 */
function handedOn(rounds: readonly Round[], last: readonly Finding[]): Finding[] {
  const kept = new Set(last.map(findingLine));
  const earlier = besideOf(rounds.slice(0, -1)).filter(
    (finding) => !kept.has(findingLine(finding))
  );
  return [...last, ...earlier].slice(0, MAX_FINDINGS);
}

function planOf(
  input: {
    by?: string;
    rounds?: number;
    threshold?: FindingSeverity;
    focus?: string;
  },
  type: string | undefined
): ReviewPlan {
  return {
    rounds: input.rounds ?? (type === FIX_TYPE ? FIX_REVIEW_ROUNDS : DEFAULT_REVIEW_ROUNDS),
    threshold: input.threshold ?? DEFAULT_REVIEW_THRESHOLD,
    ...(input.focus && { focus: input.focus }),
    ...(input.by && { by: input.by }),
  };
}

/**
 * The steps of a review, after the one that finds the work: a review, then for every round a fix
 * by the author and a review of it, then the report. Each step looks at the state first and does
 * nothing once the review is clean or cannot go on, so the steps run in one line and a run that
 * was restarted passes over those it finished.
 */
function reviewWorkflow(
  name: string,
  run: RecipeRun,
  plan: ReviewPlan,
  find: (state: ReviewState) => Promise<Partial<ReviewState>>
): Workflow<ReviewState> {
  const builder = new WorkflowBuilder<ReviewState>(name).initialState({ rounds: [] });
  let last: string | undefined;
  const step = (
    stepName: string,
    work: (state: ReviewState) => Promise<Partial<ReviewState>>
  ): void => {
    builder.addNode(
      stepName,
      async ({ state }) => ({ state: await work(state) }),
      last === undefined ? undefined : { after: [last] }
    );
    last = stepName;
  };
  step('work', find);
  step('review-1', (state) => review(run, plan, state, 1));
  for (let round = 1; round <= plan.rounds; round += 1) {
    step(`fix-${round}`, (state) => fix(run, plan, state, round));
    step(`review-${round + 1}`, (state) => review(run, plan, state, round + 1));
  }
  step('report', async (state) => summary(state, plan));
  return builder.build();
}

/**
 * `review`: an agent of another harness reads the work of a job that is done and names what it
 * found, the author fixes what weighs enough, and the reviewer looks again, for as many rounds
 * as the input allows and for as long as each round leaves fewer findings open than the one
 * before. The reviewer judges the work against the job: what it notices beside the job is named
 * in the report of the recipe, and neither holds the work up nor is sent back. The job of the
 * recipe ends with how the review ended and what is still open.
 *
 * Input: `job`, the job whose work is reviewed, one the caller handed over or carried out.
 * `by`, who reviews: an agent, or a harness word for a fresh session, another harness than the
 * author's by default. `rounds`, how many times the author is sent back at most, 2 by default
 * and 1 when the work is of the type `fix`, 0 for a review that sends nothing back. `threshold`, the lightest finding worth sending back,
 * `major` by default. `focus`, what to look at above all.
 */
export const reviewRecipe: Recipe = defineRecipe({
  name: 'review',
  summary:
    'An agent of another harness reviews the work of a job, the author fixes what was found, the reviewer checks again',
  input: z.strictObject({ job: z.number().int().positive(), ...ReviewOptions }),
  async workflow(input, run) {
    const reviewed = await attempted(run, () => run.lookAt(input.job));
    const plan = planOf(input, 'done' in reviewed ? reviewed.done.type : undefined);
    return reviewWorkflow('bridge-review', run, plan, async () => {
      const job = await run.lookAt(input.job);
      if (!(await mayHaveReviewed(run, job))) {
        return {
          failed: true,
          stopped: 'no-work',
          report: `Job #${job.number} is between ${job.from} and ${job.to}: only they, and whoever started the recipe it is a step of, have it reviewed.`,
        };
      }
      const none = (report: string): Partial<ReviewState> => ({
        failed: true,
        stopped: 'no-work',
        report,
      });
      if (job.recipe) {
        return none(
          `Job #${job.number} is a recipe and holds no work itself: have the job reviewed that its report names as holding the work.`
        );
      }
      if (job.state !== 'completed' || job.checking) {
        return none(
          `There is no finished work to review: ${endOf(job)}${job.checking ? ', and its checks still run' : ''}.`
        );
      }
      const end = job.worktree?.end;
      if (end && end.how !== 'accepted') {
        return none(
          `The work of job #${job.number} is not there to review: it was ${end.how === 'branch' ? 'left as a branch' : end.how === 'rejected' ? 'dropped' : 'put away by the bridge'}.`
        );
      }
      const work = await workOf(run, job);
      const checked = checkedOf(job);
      return {
        work,
        reviewer: await reviewerFor(run, plan, work),
        ...(checked && { checked }),
      };
    });
  },
});

/**
 * `build`: do, check, review, fix, check. The text of the recipe's job is handed to an agent as
 * a job in a git worktree of its own, with the checks of the input. Its work is reviewed as by
 * `review`, and the author is sent back until the review is clean and the checks pass, the
 * rounds run out, or a round leaves no fewer findings open than the one before. The work stays in the worktree of the first job: whoever started the recipe
 * takes it with `accept`.
 *
 * Input: `to`, who does the work. `checks`, the commands that show the result holds, run by the
 * bridge on every report. `worktree`, false to work in the caller's folder. `context`, what the
 * caller knows and the agent does not, as `delegate` takes it. And `by`, `rounds`, `threshold`
 * and `focus` of the review.
 */
export const buildRecipe: Recipe = defineRecipe({
  name: 'build',
  summary:
    'An agent does the job in a worktree of its own, the bridge runs the checks, another agent reviews, the author fixes, until it is clean',
  input: z.strictObject({
    to: Address,
    checks: z.array(JobCheckSchema).max(50).optional(),
    worktree: z.boolean().optional(),
    context: JobContextSchema.optional(),
    ...ReviewOptions,
  }),
  workflow(input, run) {
    const plan = planOf(input, run.job.type);
    return reviewWorkflow('bridge-build', run, plan, async () => {
      const outcome = await run.handOver('work', {
        to: input.to,
        title: run.job.title,
        body: run.task,
        type: run.job.type ?? WORK_TYPE,
        ...(input.worktree !== false && { worktree: true }),
        ...(input.checks && { checks: input.checks }),
        ...(input.context && { context: input.context }),
      });
      if (outcome.job.state !== 'completed') {
        return {
          failed: true,
          stopped: 'no-work',
          report: [
            `The work was not done: ${endOf(outcome.job)}.`,
            ...(outcome.report ? [quoted(clip(outcome.report))] : []),
          ].join('\n'),
        };
      }
      const work = await workOf(run, outcome.job, outcome.report);
      const checked = checkedOf(outcome.job);
      return {
        work,
        reviewer: await reviewerFor(run, plan, work),
        ...(checked && { checked }),
      };
    });
  },
});

/** The recipes the conductor of the bridge knows unless its host names others. */
export const BUILT_IN_RECIPES: readonly Recipe[] = [
  reviewRecipe,
  buildRecipe,
  raceRecipe,
  debateRecipe,
];
