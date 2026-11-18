import type { Workflow } from '@cogitator-ai/types';
import { WorkflowBuilder } from '@cogitator-ai/workflows';
import { z } from 'zod';
import { oneLine, quoted } from '../letters.js';
import { defineRecipe, type Recipe, type RecipeRun, type RecipeState } from './recipe.js';
import {
  Address,
  ONE_LINE,
  TASK_LENGTH,
  attempted,
  clip,
  freshFor,
  handBack,
  plural,
} from './steps.js';

/** How many rounds a debate goes at most when its input names no number. */
export const DEFAULT_DEBATE_ROUNDS = 3;

/** The most turns one debate takes: its debaters times its rounds. */
const MAX_TURNS = 40;

/** How much of what a debater said the others are shown, and the report quotes. */
const SAID_LENGTH = 2_500;

const Role = z.string().trim().min(1).max(60).regex(ONE_LINE, 'A role is one line');

const DebateInput = z
  .strictObject({
    debaters: z
      .array(z.union([Address, z.strictObject({ to: Address, role: Role.optional() })]))
      .min(2)
      .max(6),
    rounds: z.number().int().min(1).max(10).optional(),
    moderator: Address.optional(),
  })
  .refine((input) => input.debaters.length * (input.rounds ?? DEFAULT_DEBATE_ROUNDS) <= MAX_TURNS, {
    message: `A debate takes ${MAX_TURNS} turns at most: fewer debaters, or fewer rounds`,
    path: ['rounds'],
  });

type DebateInput = z.infer<typeof DebateInput>;

/** What a debater said in one round, or why it said nothing. */
interface Turn {
  round: number;
  /** The place of the debater among the debaters, from 0 */
  seat: number;
  job?: number;
  agent?: string;
  /** Undefined when the job ended without a report, failed, or was never handed over */
  said?: string;
  agrees?: boolean;
  /** Why the bridge did not hand the turn over */
  refused?: string;
}

/** Why no further round follows. */
type Ended = 'agreed' | 'rounds' | 'silent';

interface DebateState extends RecipeState {
  turns: Turn[];
  ended?: Ended;
  summed?: { job?: number; by?: string; said?: string; refused?: string };
}

interface Seat {
  to: string;
  role?: string;
}

function seatsOf(input: DebateInput): Seat[] {
  return input.debaters.map((debater) =>
    typeof debater === 'string'
      ? { to: debater }
      : { to: debater.to, ...(debater.role && { role: oneLine(debater.role) }) }
  );
}

/** What a debater is to do, by its role: the rules a debate of the runtime's swarms goes by. */
function stand(role: string | undefined): string {
  const named = role?.toLowerCase();
  if (named === 'advocate') {
    return 'You argue in favor of the position or solution in question: make the strongest case for it.';
  }
  if (named === 'critic') {
    return 'You argue against the position or solution in question: find its weaknesses, its risks and what it overlooks.';
  }
  return `${role ? `Your role is ${role}. ` : ''}Give your own view of the question, with your reasons.`;
}

const HOW_TO_END =
  'End with one line, exactly in this form: STANCE: agree when you now hold the position the others hold and nothing of weight is left in dispute, STANCE: disagree otherwise.';

/** The agent that spoke for a seat last: a seat keeps its place when its session changes. */
function lastOf(state: DebateState, seat: number): string | undefined {
  return state.turns.filter((turn) => turn.seat === seat && turn.agent !== undefined).at(-1)?.agent;
}

function nameOf(state: DebateState, seats: Seat[], turn: Turn): string {
  const known = turn.agent ?? lastOf(state, turn.seat) ?? `debater ${turn.seat + 1}`;
  const role = seats[turn.seat]?.role;
  return role ? `${known} (${role})` : known;
}

function transcript(state: DebateState, seats: Seat[], rounds?: number[]): string {
  return state.turns
    .filter((turn) => !rounds || rounds.includes(turn.round))
    .map(
      (turn) =>
        `${nameOf(state, seats, turn)}, round ${turn.round}:\n${quoted(clip(turn.said ?? 'gave no answer', SAID_LENGTH))}`
    )
    .join('\n');
}

function turnText(
  run: RecipeRun,
  state: DebateState,
  seats: Seat[],
  seat: number,
  round: number,
  rounds: number
): string {
  const head = `You are debater ${seat + 1} of ${seats.length} in a debate of agents on a question. ${stand(seats[seat]?.role)} Change no file: read what you need, and argue.`;
  if (round === 1) {
    return [
      head,
      `The question:\n${quoted(run.task)}`,
      `This is round 1 of ${rounds} at most. Nobody has spoken yet: the others answer the same question now, and from the next round on everybody sees what the others said.`,
      HOW_TO_END,
    ].join('\n\n');
  }
  return [
    head,
    `Continue the debate on:\n${quoted(run.task)}`,
    `This is round ${round} of ${rounds} at most. What was said before:\n${transcript(state, seats)}`,
    'Answer the strongest points of the others, and move where they convinced you.',
    HOW_TO_END,
  ].join('\n\n');
}

/**
 * The seats that took part: those that answered in some round. Agreement is theirs to reach
 * together, so one that argued before and is silent now has not agreed.
 */
function tookPart(turns: readonly Turn[]): number[] {
  return [...new Set(turns.filter((turn) => turn.said !== undefined).map((turn) => turn.seat))];
}

function stanceOf(said: string | undefined): boolean | undefined {
  const last = [
    ...(said ?? '').matchAll(/^[ \t]*\*{0,2}STANCE:\*{0,2}[ \t]*(agree|disagree)\b/gim),
  ].at(-1);
  return last ? last[1].toLowerCase() === 'agree' : undefined;
}

async function round(
  run: RecipeRun,
  state: DebateState,
  seats: Seat[],
  at: number,
  rounds: number
): Promise<Partial<DebateState>> {
  if (state.ended) return {};
  const turns = await Promise.all(
    seats.map(async (seat, index): Promise<Turn> => {
      const job = {
        title: `${run.job.title} (debate, round ${at})`,
        body: turnText(run, state, seats, index, at, rounds),
      };
      const before = lastOf(state, index);
      const known = before ? await run.agent(before) : undefined;
      const step = `round-${at}.${index + 1}`;
      const tried = await attempted(run, () =>
        known
          ? handBack(run, step, known, job, '')
          : run.handOver(step, { ...job, to: freshFor(seat.to) })
      );
      if ('refused' in tried) return { round: at, seat: index, refused: tried.refused };
      const outcome = tried.done;
      const said = outcome.job.state === 'completed' ? outcome.report : undefined;
      const agrees = stanceOf(said);
      return {
        round: at,
        seat: index,
        job: outcome.job.number,
        agent: outcome.job.to,
        ...(said && { said }),
        ...(agrees !== undefined && { agrees }),
      };
    })
  );
  const spoke = turns.filter((turn) => turn.said !== undefined);
  const all = [...state.turns, ...turns];
  const agreed = tookPart(all).every(
    (seat) => turns.find((turn) => turn.seat === seat)?.agrees === true
  );
  const ended: Ended | undefined =
    spoke.length < 2
      ? 'silent'
      : at > 1 && agreed
        ? 'agreed'
        : at === rounds
          ? 'rounds'
          : undefined;
  return { turns: all, ...(ended && { ended }) };
}

async function sumUp(
  run: RecipeRun,
  input: DebateInput,
  state: DebateState,
  seats: Seat[]
): Promise<Partial<DebateState>> {
  const spoken = state.turns.some((turn) => turn.said !== undefined);
  if (!input.moderator || !spoken) return {};
  const to = freshFor(input.moderator);
  const tried = await attempted(run, () =>
    run.handOver('moderator', {
      to,
      title: `${run.job.title} (debate, summing up)`,
      body: [
        `Sum up a debate of ${seats.length} agents. Change no file.`,
        `The question:\n${quoted(run.task)}`,
        `What was said:\n${transcript(state, seats)}`,
        'Write a balanced summary of the positions, where the debaters agree and where they still disagree, the strongest arguments of each side, and what you recommend.',
      ].join('\n\n'),
    })
  );
  if ('refused' in tried) return { summed: { refused: tried.refused } };
  const { job, report } = tried.done;
  return {
    summed: {
      job: job.number,
      by: job.to,
      ...(job.state === 'completed' && report && { said: report }),
    },
  };
}

function summary(state: DebateState, seats: Seat[]): Partial<DebateState> {
  const last = Math.max(0, ...state.turns.map((turn) => turn.round));
  const closing = state.turns.filter((turn) => turn.round === last && turn.said !== undefined);
  const agreeing = closing.filter((turn) => turn.agrees === true).length;
  const part = tookPart(state.turns).length;
  const how =
    state.ended === 'agreed'
      ? part < seats.length
        ? `the ${part} that took part hold the same position now`
        : 'all of them hold the same position now'
      : state.ended === 'silent'
        ? 'fewer than two of them answered'
        : `the rounds ran out, and ${agreeing} of ${closing.length} said they agree at the end`;
  const lines = [
    `The debate of ${plural(seats.length, 'agent')} ended after ${plural(last, 'round')}: ${how}.`,
  ];
  for (const turn of state.turns) {
    if (turn.refused) {
      lines.push(
        `${nameOf(state, seats, turn)} did not get its turn of round ${turn.round}: ${oneLine(turn.refused)}`
      );
    }
  }
  if (state.summed?.said) {
    lines.push(`${state.summed.by} sums it up:`, quoted(clip(state.summed.said, 4 * SAID_LENGTH)));
  } else {
    if (state.summed) {
      lines.push(
        state.summed.refused
          ? `Nobody summed it up: ${oneLine(state.summed.refused)}`
          : `${state.summed.by} was asked to sum it up in job #${state.summed.job} and reported nothing.`
      );
    }
    if (last > 0) lines.push('The positions at the end:', transcript(state, seats, [last]));
  }
  const jobs = state.turns.flatMap((turn) => (turn.job === undefined ? [] : [`#${turn.job}`]));
  if (jobs.length > 0) {
    lines.push(`Every turn is a job of its own, with all that was said: ${jobs.join(', ')}.`);
  }
  return { report: lines.join('\n'), ...(state.ended === 'silent' && { failed: true }) };
}

function debateWorkflow(input: DebateInput, run: RecipeRun): Workflow<DebateState> {
  if (run.task.length > TASK_LENGTH) {
    throw new Error(
      `the question of a debate takes ${TASK_LENGTH} characters at most, and this one has ${run.task.length}. Every debater reads it whole in every round: put the details in a file and name it`
    );
  }
  const seats = seatsOf(input);
  const rounds = input.rounds ?? DEFAULT_DEBATE_ROUNDS;
  const builder = new WorkflowBuilder<DebateState>('bridge-debate').initialState({ turns: [] });
  let last: string | undefined;
  const step = (
    name: string,
    work: (state: DebateState) => Promise<Partial<DebateState>>
  ): void => {
    builder.addNode(
      name,
      async ({ state }) => ({ state: await work(state) }),
      last === undefined ? undefined : { after: [last] }
    );
    last = name;
  };
  for (let at = 1; at <= rounds; at += 1) {
    step(`round-${at}`, (state) => round(run, state, seats, at, rounds));
  }
  step('moderator', (state) => sumUp(run, input, state, seats));
  step('report', async (state) => summary(state, seats));
  return builder.build();
}

/**
 * `debate`: a question to several agents, by the rules a debate of the runtime's swarms goes by.
 * In the first round each answers the question alone. From the second on each sees what the
 * others said in the rounds before and answers them, and ends its turn by saying whether it
 * agrees now. The debate ends when all that took part agree in the same round, or the rounds run
 * out: a debater that argued before and gives no answer now has not agreed. A `moderator` then
 * sums it up: the positions, what is agreed and what is not, the strongest arguments, a
 * recommendation. Without one the report carries the positions of the last round.
 *
 * Input: `debaters`, two to six agents or harness words, each as a word or as `{ to, role }`:
 * an `advocate` argues for, a `critic` against, any other role is told to the agent as it is.
 * `rounds`, 3 by default. `moderator`, nobody by default. Debaters times rounds is 40 at most.
 *
 * A turn the bridge refuses to hand over, and a moderator it cannot reach, are said in the
 * report, which still carries what the others said.
 */
export const debateRecipe: Recipe = defineRecipe({
  name: 'debate',
  summary:
    'A question to several agents, who answer each other round by round until they agree or the rounds run out',
  input: DebateInput,
  workflow: debateWorkflow,
});
