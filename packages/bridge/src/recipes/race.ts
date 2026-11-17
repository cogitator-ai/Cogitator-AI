import type { Workflow } from '@cogitator-ai/types';
import { WorkflowBuilder } from '@cogitator-ai/workflows';
import { z } from 'zod';
import { JobContextSchema } from '../handover.js';
import { oneLine, quoted } from '../letters.js';
import { JobCheckSchema, type JobState } from '../types.js';
import { defineRecipe, type Recipe, type RecipeRun, type RecipeState } from './recipe.js';
import {
  Address,
  TASK_LENGTH,
  attempted,
  checkedOf,
  clip,
  freshFor,
  plural,
  type Checked,
} from './steps.js';

/** One attempt of a race: the job an agent got, and how it ended. */
interface Attempt {
  /** Who was asked, as the input named it */
  to: string;
  job?: number;
  agent?: string;
  state?: JobState;
  /** Why the attempt did not start, or why its job failed */
  reason?: string;
  /** Where its work lies, and the commit it started from */
  worktree?: string;
  base?: string;
  checked?: Checked;
  changes?: { files: number; insertions: number; deletions: number };
  report?: string;
}

/** What the judge said, or why nobody judged. */
interface Judged {
  job?: number;
  by?: string;
  report?: string;
  take?: number | 'none';
  /** Why the bridge did not hand the comparison over */
  refused?: string;
}

interface RaceState extends RecipeState {
  attempts: Attempt[];
  judged?: Judged;
}

const RaceInput = z.strictObject({
  to: z.array(Address).min(2).max(6),
  checks: z.array(JobCheckSchema).max(50).optional(),
  context: JobContextSchema.optional(),
  judge: Address.optional(),
});

type RaceInput = z.infer<typeof RaceInput>;

function checksOf(attempt: Attempt): string {
  if (!attempt.checked) return 'no checks';
  if (attempt.checked.verified) return 'checks passed';
  return attempt.checked.failed ? 'checks not passed' : 'checks not verified';
}

function changesOf(attempt: Attempt): string {
  const changes = attempt.changes;
  if (!changes) return '';
  return `, ${plural(changes.files, 'file')} +${changes.insertions} -${changes.deletions}`;
}

function attemptLine(attempt: Attempt, take?: number | 'none'): string {
  if (attempt.job === undefined) {
    return `- ${attempt.to}: not started: ${oneLine(attempt.reason ?? 'the bridge refused the job')}`;
  }
  const how =
    attempt.state === 'completed'
      ? `completed, ${checksOf(attempt)}${changesOf(attempt)}`
      : `${attempt.state ?? 'not finished'}${attempt.reason ? ` (${oneLine(attempt.reason)})` : ''}`;
  const picked = take === attempt.job ? ', the pick of the judge' : '';
  return `- job #${attempt.job} by ${attempt.agent ?? attempt.to}: ${how}${picked}`;
}

/** The attempts that finished, those whose checks hold first. */
function finished(state: RaceState): Attempt[] {
  const rank = (attempt: Attempt): number =>
    attempt.checked?.verified ? 0 : attempt.checked?.failed ? 2 : 1;
  return state.attempts
    .filter((attempt) => attempt.state === 'completed')
    .sort((a, b) => rank(a) - rank(b));
}

async function attempt(run: RecipeRun, input: RaceInput, to: string, at: number): Promise<Attempt> {
  const note = `This is attempt ${at} of ${input.to.length} at the same job: ${input.to.length} agents do it at the same time, each in a git worktree of its own. Do not look for the work of the others: whoever started the race compares the results and takes one.`;
  const tried = await attempted(run, () =>
    run.handOver(`attempt-${at}`, {
      to,
      title: `${run.job.title} (attempt ${at})`,
      body: `${run.task}\n\n${note}`,
      worktree: true,
      ...(input.checks && { checks: input.checks }),
      ...(input.context && { context: input.context }),
    })
  );
  if ('refused' in tried) return { to, reason: tried.refused };
  const { job, report } = tried.done;
  const checked = checkedOf(job);
  return {
    to,
    job: job.number,
    agent: job.to,
    state: job.state,
    ...(job.reason && { reason: job.reason }),
    ...(job.worktree && !job.worktree.end && { worktree: job.worktree.path }),
    ...(job.worktree && { base: job.worktree.base }),
    ...(checked && { checked }),
    ...(job.changes && {
      changes: {
        files: job.changes.files,
        insertions: job.changes.insertions,
        deletions: job.changes.deletions,
      },
    }),
    ...(report && { report }),
  };
}

function judgeText(run: RecipeRun, done: Attempt[]): string {
  return [
    `Compare ${done.length} attempts at the same job, and say which one you would take. Change no file: read, run what you need to check, and report.`,
    `The job was:\n${quoted(clip(run.task, TASK_LENGTH))}`,
    [
      'The attempts, each in a git worktree of its own:',
      ...done.map(
        (one) =>
          `- job #${one.job} by ${one.agent}: ${checksOf(one)}${changesOf(one)}, in ${one.worktree ?? 'a worktree that is gone'}${one.base ? ` (\`git diff ${one.base.slice(0, 10)}\` there shows what it changed)` : ''}`
      ),
    ].join('\n'),
    'Say of each attempt in a few lines what it does well and what is wrong with it.\nEnd with one line, exactly in this form: TAKE: job <number>\nor TAKE: none when none of them should be taken.',
  ].join('\n\n');
}

function takeOf(report: string | undefined, done: Attempt[]): number | 'none' | undefined {
  const said = [
    ...(report ?? '').matchAll(
      /^[ \t]*\*{0,2}TAKE:\*{0,2}[ \t]*(?:job[ \t]*#?(\d{1,9})|(none))\b/gim
    ),
  ].at(-1);
  if (!said) return undefined;
  if (said[2]) return 'none';
  const job = Number(said[1]);
  return done.some((one) => one.job === job) ? job : undefined;
}

async function judge(
  run: RecipeRun,
  input: RaceInput,
  state: RaceState
): Promise<Partial<RaceState>> {
  const done = finished(state);
  if (!input.judge || done.length < 2) return {};
  const to = freshFor(input.judge);
  const tried = await attempted(run, () =>
    run.handOver('judge', {
      to,
      title: `Compare the attempts at ${run.job.title}`,
      body: judgeText(run, done),
    })
  );
  if ('refused' in tried) return { judged: { refused: tried.refused } };
  const { job, report } = tried.done;
  const take = job.state === 'completed' ? takeOf(report, done) : undefined;
  return {
    judged: {
      job: job.number,
      by: job.to,
      ...(report && { report }),
      ...(take !== undefined && { take }),
    },
  };
}

function summary(state: RaceState): Partial<RaceState> {
  const done = finished(state);
  const judged = state.judged;
  const take = judged?.take;
  const lines = [
    `${plural(state.attempts.length, 'agent')} ${state.attempts.length === 1 ? 'was' : 'were'} asked to do the job, ${done.length} finished it${done.length === 0 ? ': there is nothing to take' : ''}.`,
    ...state.attempts.map((one) => attemptLine(one, take)),
  ];
  if (judged?.refused) {
    lines.push(`Nobody compared them: ${oneLine(judged.refused)}`);
  } else if (judged) {
    lines.push(
      take === undefined
        ? `${judged.by} compared them in job #${judged.job} and named none to take:`
        : take === 'none'
          ? `${judged.by} compared them in job #${judged.job} and would take none:`
          : `${judged.by} compared them in job #${judged.job} and would take job #${take}:`,
      quoted(clip(judged.report ?? 'It reported nothing.'))
    );
  }
  if (done.length > 0) {
    lines.push(
      'Each attempt is in the worktree of its job: look at one with diff, take one with accept, and drop the others with reject.'
    );
  }
  return { report: lines.join('\n'), ...(done.length === 0 && { failed: true }) };
}

function raceWorkflow(input: RaceInput, run: RecipeRun): Workflow<RaceState> {
  return new WorkflowBuilder<RaceState>('bridge-race')
    .initialState({ attempts: [] })
    .addNode('attempts', async () => ({
      state: {
        attempts: await Promise.all(input.to.map((to, at) => attempt(run, input, to, at + 1))),
      },
    }))
    .addNode('judge', async ({ state }) => ({ state: await judge(run, input, state) }), {
      after: ['attempts'],
    })
    .addNode('report', async ({ state }) => ({ state: summary(state) }), { after: ['judge'] })
    .build();
}

/**
 * `race`: the same job to two or more agents at the same time, each in a git worktree of its
 * own. The bridge runs the checks of the input on every attempt, and the report lays the
 * attempts side by side: which finished, what their checks showed, how much each changed. With a
 * `judge` another agent reads them and says which it would take. The recipe takes none itself:
 * whoever started it takes one with `accept` and drops the others with `reject`.
 *
 * Input: `to`, two to six harness words, the same one twice for two sessions of one harness.
 * `checks`, the commands that show a result holds. `context`, what the caller knows and the
 * agents do not. `judge`, who compares the attempts, nobody by default.
 *
 * The bridge keeps only so many worktrees of a project in progress and starts only so many
 * sessions at once: attempts beyond that wait their turn. An attempt the bridge refuses, and a
 * judge it cannot reach, are said in the report, which still lays out the rest.
 */
export const raceRecipe: Recipe = defineRecipe({
  name: 'race',
  summary:
    'The same job to several agents at once, each in a worktree of its own: the checks and, when asked, a judge show which attempt to take',
  input: RaceInput,
  workflow: raceWorkflow,
});
