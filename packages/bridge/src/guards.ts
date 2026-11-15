import { BridgeError } from './errors.js';
import {
  BridgeLimitsSchema,
  type BridgeJobRecord,
  type BridgeLimits,
  type JobBudget,
  type LetterKind,
} from './types.js';

/** Limits given in part, the rest taken from the defaults. */
export interface BridgeLimitsInput extends Partial<Omit<BridgeLimits, 'budget' | 'maxBudget'>> {
  budget?: Partial<JobBudget>;
  maxBudget?: Partial<JobBudget>;
}

/**
 * The limits a dispatcher runs with: what was given, the defaults for the rest.
 *
 * @throws BridgeError `invalid_input` for a limit that is not a whole number in its range, or a
 * default budget over the most a job may ask for
 */
export function resolveLimits(defaults: BridgeLimits, input: BridgeLimitsInput = {}): BridgeLimits {
  const { budget, maxBudget, ...rest } = input;
  const parsed = BridgeLimitsSchema.safeParse({
    ...defaults,
    ...rest,
    budget: { ...defaults.budget, ...budget },
    maxBudget: { ...defaults.maxBudget, ...maxBudget },
  });
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    throw new BridgeError(
      'invalid_input',
      `The bridge limit ${issue.path.join('.') || '(unknown key)'} is not valid: ${issue.message}`
    );
  }
  const limits = parsed.data;
  for (const key of ['letters', 'durationMs', 'replyTimeoutMs'] as const) {
    if (limits.budget[key] > limits.maxBudget[key]) {
      throw new BridgeError(
        'invalid_input',
        `The default budget (${key}: ${limits.budget[key]}) is over the most a job may ask for (${limits.maxBudget[key]})`
      );
    }
  }
  return limits;
}

/**
 * The depth of a job handed over from inside a job of depth `parentDepth`: one more, and 1 for a
 * job that is part of no other.
 *
 * @throws BridgeError `depth_exceeded` when that is deeper than jobs may nest
 */
export function nextDepth(parentDepth: number | undefined, limits: BridgeLimits): number {
  const depth = 1 + (parentDepth ?? 0);
  if (depth > limits.maxDepth) {
    throw new BridgeError(
      'depth_exceeded',
      `Jobs nest ${limits.maxDepth} deep at most, and this one would be at depth ${depth}. Do the work yourself or report back to the agent that gave you the job`,
      { depth, maxDepth: limits.maxDepth }
    );
  }
  return depth;
}

/**
 * The budget of a job: what was asked for, the defaults for the rest.
 *
 * @throws BridgeError `invalid_input` when it asks for more than a job may have
 */
export function resolveBudget(
  requested: Partial<JobBudget> | undefined,
  limits: BridgeLimits
): JobBudget {
  const budget: JobBudget = { ...limits.budget, ...requested };
  for (const key of ['letters', 'durationMs', 'replyTimeoutMs'] as const) {
    const value = budget[key];
    if (!Number.isInteger(value) || value <= 0) {
      throw new BridgeError('invalid_input', `The budget's ${key} must be a positive whole number`);
    }
    if (value > limits.maxBudget[key]) {
      throw new BridgeError(
        'invalid_input',
        `The budget's ${key} (${value}) is over the most a job may ask for (${limits.maxBudget[key]})`,
        { key, value, max: limits.maxBudget[key] }
      );
    }
  }
  return budget;
}

/**
 * What a job has run out of, if anything, when one more letter is about to be sent at `now`. The
 * report that ends the job is never held back by the count of letters: refusing it would throw
 * away finished work.
 */
export function exhaustedBudget(
  job: Pick<BridgeJobRecord, 'budget' | 'lettersUsed' | 'deadlineAt'>,
  now: number,
  kind?: LetterKind
): 'letters' | 'time' | undefined {
  if (now >= Date.parse(job.deadlineAt)) return 'time';
  if (kind !== 'report' && job.lettersUsed >= job.budget.letters) return 'letters';
  return undefined;
}

/** How long to wait before the next delivery attempt after `attempts` failed ones. */
export function deliveryBackoff(attempts: number, limits: BridgeLimits): number {
  const delay = limits.deliveryBackoffMs * 2 ** Math.max(0, attempts - 1);
  return Math.min(delay, limits.deliveryBackoffMaxMs);
}

export function formatDuration(ms: number): string {
  const minutes = Math.round(ms / 60_000);
  if (minutes < 1) return `${Math.max(1, Math.round(ms / 1000))}s`;
  if (minutes < 120) return `${minutes} min`;
  return `${Math.round(minutes / 60)} h`;
}
