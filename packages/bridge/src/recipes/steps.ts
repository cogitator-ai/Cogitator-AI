import { z } from 'zod';
import { isBridgeError } from '../errors.js';
import type { BridgeJob } from '../types.js';
import type { RecipeJob, RecipeOutcome, RecipeRun } from './recipe.js';

/** How much of what one agent wrote a letter to another quotes. */
const QUOTE_LENGTH = 4_000;

/** Text that stays on one line wherever it is shown: no control character, no line separator. */
export const ONE_LINE = /^[^\p{Cc}\u2028\u2029]*$/u;

/** Who a step is for, as a recipe takes it in its input: an agent's name or a harness word. */
export const Address = z.string().trim().min(1).max(512).regex(ONE_LINE, 'An address is one line');

/** How much of the text of a job a letter of a recipe repeats to another agent. */
export const TASK_LENGTH = 20_000;

/** The start of a text, short enough to quote in a letter. A text that is cut says so. */
export function clip(text: string, length: number = QUOTE_LENGTH): string {
  const trimmed = text.trim();
  return trimmed.length > length ? `${trimmed.slice(0, length)}\n... (cut here)` : trimmed;
}

/**
 * What a step did, or why the bridge refused it. A refusal is an answer a recipe can go on
 * from, such as an address that names nobody: the work of the steps before is not thrown away
 * for it. A run that is stopping is not refused, it stops.
 */
export async function attempted<T>(
  run: RecipeRun,
  work: () => Promise<T>
): Promise<{ done: T } | { refused: string }> {
  try {
    return { done: await work() };
  } catch (error) {
    if (run.signal.aborted || (isBridgeError(error) && error.code === 'not_running')) throw error;
    return { refused: error instanceof Error ? error.message : String(error) };
  }
}

/** How a job ended, in words: `job #4 is failed (reported as failed by codex@app)`. */
export function endOf(job: BridgeJob): string {
  return `job #${job.number} is ${job.state}${job.reason ? ` (${job.reason})` : ''}`;
}

export function plural(count: number, one: string): string {
  return `${count} ${one}${count === 1 ? '' : 's'}`;
}

/** What the checks of a job showed. */
export interface Checked {
  /** Every check ran and passed */
  verified: boolean;
  /** A check ran and did not pass. A check the bridge left out is no failure of the work */
  failed: boolean;
  summary?: string;
}

export function checkedOf(job: BridgeJob): Checked | undefined {
  const verification = job.verification;
  if (!verification) return undefined;
  return {
    verified: verification.verified,
    failed: verification.checks
      ? verification.checks.some((check) => !check.ok && check.skipped === undefined)
      : !verification.verified,
    ...(verification.summary && { summary: verification.summary }),
  };
}

/**
 * An address that gets a session of its own: a harness word means a fresh session of that
 * harness, since a session that is open already may be the one that started the recipe. An
 * agent's name, and a word that names its session after a colon, stay as they are.
 */
export function freshFor(address: string): string {
  return /[@:]/.test(address) ? address : `${address}:new`;
}

/**
 * Hands a job back to an agent that worked on the run before, and to a fresh session of its
 * harness when the agent is gone or would not wake for the letter, such as a Codex thread that
 * is open nowhere while no local daemon runs. The fresh session knows nothing of what the agent
 * did, so it gets `background` too. A step that runs again goes the way it went the first time.
 */
export async function handBack(
  run: RecipeRun,
  step: string,
  agent: { name: string; harness: string },
  job: Omit<RecipeJob, 'to'>,
  background: string
): Promise<RecipeOutcome> {
  const named = (): Promise<RecipeOutcome> => run.handOver(step, { ...job, to: agent.name });
  const fresh = (): Promise<RecipeOutcome> =>
    run.handOver(`${step}.fresh`, {
      ...job,
      to: `${agent.harness}:new`,
      body: background ? `${job.body}\n\n${background}` : job.body,
    });
  if (await run.handedOver(`${step}.fresh`)) return fresh();
  if (await run.handedOver(step)) return named();
  const startable = agent.harness !== '' && (await run.startable()).includes(agent.harness);
  if (startable && !(await run.wakes(agent.name))) return fresh();
  try {
    return await named();
  } catch (error) {
    const gone = isBridgeError(error) && error.code === 'unknown_agent';
    if (!gone || !startable) throw error;
    return fresh();
  }
}
