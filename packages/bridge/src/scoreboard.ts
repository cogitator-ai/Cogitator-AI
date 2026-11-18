import { checkedOf } from './checks.js';
import { FINDING_SEVERITIES, type FindingSeverity } from './findings.js';
import { formatDuration } from './guards.js';
import { aliasOfHarness } from './registry.js';
import { DEFAULT_JOB_TYPE, type BridgeJob, type JobFailure } from './types.js';

/**
 * How a job turned out, as far as anybody looked: `good` when something confirmed its result,
 * `bad` when something showed it does not hold, `unknown` when it ended and nobody checked.
 */
export type JobOutcome = 'good' | 'bad' | 'unknown';

/** What became of one job: the line of it the scoreboard is made of. */
export interface JobResult {
  job: number;
  /** The agent that carried it out */
  agent: string;
  /** The harness of that agent: what the scoreboard rates */
  harness: string;
  /** The kind of work, `general` for a job that named none */
  type: string;
  project: string;
  state: 'completed' | 'failed';
  outcome: JobOutcome;
  /**
   * What the outcome rests on, in words: `its checks passed`, `a review found 2 major`. Of an
   * `unknown` outcome: why a failure says nothing of the work, empty when nobody checked
   */
  grounds: string[];
  /** Whether its checks confirmed it. Absent when it had none, or none of them ran */
  verified?: boolean;
  /** What the reviews of its work found at each severity. Absent when nobody reviewed it */
  findings?: Record<FindingSeverity, number>;
  /** From the hand-over to the end, in ms */
  durationMs: number;
  /** Letters the two agents exchanged on it */
  letters: number;
  /** How many times it needed the person */
  person: number;
  /** ISO 8601 */
  endedAt: string;
}

function countWords(count: number, word: string): string {
  return `${count} ${word}`;
}

/** The failures that are the doing of the agent that carried the job out. */
const OWN_FAILURES: readonly JobFailure[] = ['reported', 'silent', 'timeout'];

/**
 * What became of a job, for the scoreboard: undefined for a job that is not over, was canceled
 * (which says nothing of the work), still has its checks running, or is a recipe, whose steps are
 * jobs of their own.
 *
 * A job is `bad` when its agent failed it (reported so, went silent, or ran out of the job's
 * time), one of its checks ran and did not pass, or a review of its work found a blocker or a
 * major finding. Otherwise it is `good` when its checks passed, a review found nothing that
 * heavy, or its work was taken out of its worktree. A job that ended with none of that is
 * `unknown`: an agent saying it is done is no evidence, and neither is a failure that was not
 * the agent's doing, such as a session that could not be started.
 */
export function resultOf(job: BridgeJob, harness: string): JobResult | undefined {
  if (job.recipe || job.checking) return undefined;
  if (job.state !== 'completed' && job.state !== 'failed') return undefined;

  const bad: string[] = [];
  const good: string[] = [];
  const failed = job.state === 'failed' ? `it failed${job.reason ? `: ${job.reason}` : ''}` : '';
  const own = job.failure !== undefined && OWN_FAILURES.includes(job.failure);
  if (failed && own) bad.push(failed);

  const checked = checkedOf(job);
  if (checked?.failed) bad.push('a check did not pass');
  else if (checked?.verified) good.push('its checks passed');

  let findings: Record<FindingSeverity, number> | undefined;
  if (job.reviews && job.reviews.length > 0) {
    const counted: Record<FindingSeverity, number> = { blocker: 0, major: 0, minor: 0, nit: 0 };
    for (const review of job.reviews) {
      for (const severity of FINDING_SEVERITIES) counted[severity] += review[severity];
    }
    findings = counted;
    const heavy = (['blocker', 'major'] as const).flatMap((severity) =>
      counted[severity] > 0 ? [countWords(counted[severity], severity)] : []
    );
    if (heavy.length > 0) bad.push(`a review found ${heavy.join(', ')}`);
    else good.push('a review found nothing above minor');
  }

  const end = job.worktree?.end;
  if (end?.commit !== undefined && (end.how === 'accepted' || end.how === 'branch')) {
    good.push('its work was taken');
  }
  const outcome: JobOutcome =
    bad.length > 0 ? 'bad' : good.length > 0 && !failed ? 'good' : 'unknown';
  const grounds =
    outcome === 'bad'
      ? bad
      : outcome === 'good'
        ? good
        : failed
          ? [`${failed}, which was not its agent's doing`]
          : [];

  const endedAt = job.endedAt ?? job.updatedAt;
  return {
    job: job.number,
    agent: job.to,
    harness,
    type: job.type ?? DEFAULT_JOB_TYPE,
    project: job.project,
    state: job.state,
    outcome,
    grounds,
    ...(checked && (checked.failed || checked.verified) && { verified: checked.verified }),
    ...(findings && { findings }),
    durationMs: Math.max(0, Date.parse(endedAt) - Date.parse(job.createdAt)),
    letters: job.lettersUsed,
    person: job.personNeeded ?? 0,
    endedAt,
  };
}

/** One line for a result: `good (its checks passed, a review found nothing above minor)`. */
export function resultLine(result: Pick<JobResult, 'outcome' | 'grounds'>): string {
  if (result.grounds.length === 0) return 'unknown (it ended, and nobody checked it)';
  return `${result.outcome} (${result.grounds.join(', ')})`;
}

/**
 * A result as one line of a list: the job, who carried it out, its type, how it turned out and
 * what it took. `#4  codex@demo  code  good (its checks passed)  4 min, 3 letters`.
 */
export function resultRow(result: JobResult): string {
  const took = [
    formatDuration(result.durationMs),
    `${result.letters} ${result.letters === 1 ? 'letter' : 'letters'}`,
    ...(result.person > 0
      ? [`needed the person ${result.person === 1 ? 'once' : `${result.person} times`}`]
      : []),
  ];
  return `#${result.job}  ${result.agent}  ${result.type}  ${resultLine(result)}  ${took.join(', ')}`;
}

/** How the jobs of one harness went. */
export interface Standing {
  harness: string;
  /** Jobs that ended, checked or not */
  jobs: number;
  /** Jobs with a known outcome: the ones the rate is counted over */
  scored: number;
  good: number;
  /** Jobs that ended with nobody checking them */
  unknown: number;
  /** Whether `scored` is enough to rate the harness by */
  enough: boolean;
  /** `good / scored`. Absent with no scored job */
  rate?: number;
  /** The lower end of the interval the true rate lies in */
  low?: number;
  /** The upper end of it */
  high?: number;
  /** The median time of its jobs, in ms */
  medianMs?: number;
  /** Letters per job, on average */
  letters?: number;
  /** How many times a job needed the person, on average */
  person?: number;
}

export interface StandingsOptions {
  /** How many scored jobs a harness needs to be rated */
  minJobs: number;
  /** The confidence of the interval, 0.95 by default */
  confidence?: number;
  /** Harnesses to list even with no job at all, in the order ties go by */
  harnesses?: readonly string[];
}

/**
 * How each harness did over the results given: its rate of jobs that held among those somebody
 * checked, with the Wilson interval of that rate, which keeps its width when every job went the
 * same way. They are ordered by the lower end of their interval: what each is good for at
 * least, so three out of three does not outrank forty out of forty-two. Where that is the same,
 * the higher upper end goes first: a harness nobody checked yet may still be anything, and comes
 * before one that is known to do badly. `enough` says whether a harness has the jobs to be
 * rated, and changes nothing in the order.
 */
export async function standingsOf(
  results: readonly JobResult[],
  options: StandingsOptions
): Promise<Standing[]> {
  const { wilsonCI, median, mean } = await import('@cogitator-ai/evals');
  const order = [...(options.harnesses ?? [])];
  const byHarness = new Map<string, JobResult[]>(order.map((harness) => [harness, []]));
  for (const result of results) {
    const known = byHarness.get(result.harness);
    if (known) known.push(result);
    else {
      byHarness.set(result.harness, [result]);
      order.push(result.harness);
    }
  }
  const standings = [...byHarness].map(([harness, own]): Standing => {
    const scored = own.filter((result) => result.outcome !== 'unknown');
    const good = scored.filter((result) => result.outcome === 'good').length;
    const interval =
      scored.length > 0
        ? wilsonCI(good, scored.length, { confidence: options.confidence ?? 0.95 })
        : undefined;
    return {
      harness,
      jobs: own.length,
      scored: scored.length,
      good,
      unknown: own.length - scored.length,
      enough: scored.length >= options.minJobs,
      ...(interval && { rate: interval.rate, low: interval.low, high: interval.high }),
      ...(own.length > 0 && {
        medianMs: median(own.map((result) => result.durationMs)),
        letters: mean(own.map((result) => result.letters)),
        person: mean(own.map((result) => result.person)),
      }),
    };
  });
  const place = (standing: Standing): number => order.indexOf(standing.harness);
  return standings.sort(
    (a, b) =>
      (b.low ?? 0) - (a.low ?? 0) ||
      (b.high ?? 1) - (a.high ?? 1) ||
      b.scored - a.scored ||
      place(a) - place(b)
  );
}

/** A share as a person reads it: `86%`. */
export function percent(share: number): string {
  return `${Math.round(share * 100)}%`;
}

/** A standing in a few words: `12 of 14 held (86%, 60-96%)`, or how far it is from being rated. */
export function standingWords(standing: Standing, minJobs: number): string {
  if (standing.scored === 0) {
    return standing.jobs === 0 ? 'no job yet' : `${standing.jobs} done, none of them checked`;
  }
  const rate = `${standing.good} of ${standing.scored} held`;
  if (!standing.enough) return `${rate}, not enough to tell (${minJobs} checked jobs are)`;
  return `${rate} (${percent(standing.rate ?? 0)}, ${percent(standing.low ?? 0)}-${percent(standing.high ?? 0)})`;
}

/** A harness as `auto` may take it: how it did, and whether a job can go to it now. */
export interface Candidate extends Standing {
  /** Whether a job can go to it right now */
  available: boolean;
  /** Why not, when it cannot */
  unavailable?: string;
  /** A harness of last resort: it takes a job only when no other can */
  lastResort?: true;
}

/**
 * What the choice of an agent rests on: the jobs of the type asked for (`type`), the jobs of
 * every type when those are too few to tell (`all`), a trial while a harness has done fewer jobs
 * than the scoreboard needs of each to compare them (`trial`), or nothing but the order the
 * bridge knows its harnesses in (`order`).
 */
export type SuggestionBasis = 'type' | 'all' | 'trial' | 'order';

/** Who the bridge would give a job to, and why. */
export interface Suggestion {
  /** The type of job asked about, absent when the question was about any job */
  type?: string;
  basis: SuggestionBasis;
  /** Every harness the bridge knows of, the one it would take first */
  candidates: Candidate[];
  /** The harness `auto` takes now. Absent when no job can go to any */
  best?: string;
  /** Why that one, in words an agent can pass on */
  reason: string;
  /** How many checked jobs a harness needs to be rated */
  minJobs: number;
  /** How far back the results go, in ms */
  windowMs: number;
}

export interface SuggestOptions {
  type?: string;
  minJobs: number;
  windowMs: number;
  /** The harnesses a job can go to, in the order the bridge takes them when it cannot tell */
  harnesses: readonly string[];
  /** Why a job cannot go to a harness right now, undefined when it can */
  unavailable: (harness: string) => string | undefined;
  /**
   * The harnesses of last resort among `harnesses`: listed after every other and never the best
   * while another takes jobs. Whoever places a job tries them once the others could not take it
   */
  lastResort?: readonly string[];
}

/**
 * Chooses who a job should go to from what earlier jobs showed.
 *
 * While a harness a job can go to has finished fewer jobs than the scoreboard needs of each, the
 * one that has done the fewest takes the job: otherwise the first harness in the order would get
 * every job, and the others would never be known. After that, with a type, the jobs of that
 * type decide when at least one harness a job can go to has enough of them checked, otherwise
 * the jobs of every type do, and when those are too few as well the order of the bridge decides
 * and the suggestion says that the scoreboard cannot tell. Among the harnesses the one with the
 * highest lower end of its interval is taken, and the reason says when the intervals overlap,
 * so the difference is not established.
 */
export async function suggestFrom(
  results: readonly JobResult[],
  options: SuggestOptions
): Promise<Suggestion> {
  const { type, minJobs, harnesses } = options;
  const last = new Set(options.lastResort ?? []);
  const place = (harness: string): number => {
    const index = harnesses.indexOf(harness);
    return index === -1 ? harnesses.length : index;
  };
  const rank = async (basis: SuggestionBasis): Promise<Candidate[]> => {
    const own = basis === 'type' ? results.filter((result) => result.type === type) : results;
    const standings = await standingsOf(own, { minJobs, harnesses });
    const ordered =
      basis === 'order' || basis === 'trial'
        ? [...standings].sort((a, b) => place(a.harness) - place(b.harness))
        : standings;
    const candidates = ordered.map((standing): Candidate => {
      const why = harnesses.includes(standing.harness)
        ? options.unavailable(standing.harness)
        : 'the bridge has no way to start a session of it';
      return {
        ...standing,
        available: why === undefined,
        ...(why !== undefined && { unavailable: why }),
        ...(last.has(standing.harness) && { lastResort: true as const }),
      };
    });
    return [
      ...candidates.filter((candidate) => !candidate.lastResort),
      ...candidates.filter((candidate) => candidate.lastResort),
    ];
  };
  const openOf = (candidates: Candidate[]): Candidate[] => {
    const open = candidates.filter((candidate) => candidate.available);
    const usual = open.filter((candidate) => !candidate.lastResort);
    return usual.length > 0 ? usual : open;
  };
  const rated = (candidates: Candidate[]): boolean =>
    openOf(candidates).some((candidate) => candidate.enough);

  let basis: SuggestionBasis = 'trial';
  let candidates = await rank(basis);
  let best: Candidate | undefined;
  const untried = openOf(candidates).filter((candidate) => candidate.jobs < minJobs);
  if (untried.length > 0 && openOf(candidates).length > 1) {
    best = untried.reduce((least, candidate) => (candidate.jobs < least.jobs ? candidate : least));
  } else {
    basis = type === undefined ? 'all' : 'type';
    candidates = await rank(basis);
    if (basis === 'type' && !rated(candidates)) {
      basis = 'all';
      candidates = await rank(basis);
    }
    if (!rated(candidates)) {
      basis = 'order';
      candidates = await rank(basis);
    }
    best = openOf(candidates)[0];
  }

  return {
    ...(type !== undefined && { type }),
    basis,
    candidates,
    ...(best && { best: best.harness }),
    reason: reasonOf({ type, basis, best, open: openOf(candidates), candidates, minJobs }),
    minJobs,
    windowMs: options.windowMs,
  };
}

function reasonOf(given: {
  type: string | undefined;
  basis: SuggestionBasis;
  best: Candidate | undefined;
  open: Candidate[];
  candidates: Candidate[];
  minJobs: number;
}): string {
  const { type, basis, best, open, candidates, minJobs } = given;
  if (!best) {
    const why = candidates
      .filter((candidate) => candidate.unavailable !== undefined)
      .map((candidate) => `${aliasOfHarness(candidate.harness)}: ${candidate.unavailable}`);
    return why.length > 0
      ? `No job can go to any agent right now. ${why.join('. ')}`
      : 'The bridge knows no agent it can start a session of';
  }
  const name = aliasOfHarness(best.harness);
  const kind = type === undefined ? 'jobs' : `${type} jobs`;
  if (basis === 'trial') {
    const done = best.jobs === 0 ? 'none' : `${best.jobs}`;
    return (
      `Not enough data to tell the agents apart: the scoreboard wants ${minJobs} finished jobs of each agent before it compares them, and ${name} has ${done}. ` +
      `It takes this one`
    );
  }
  if (basis === 'order') {
    return (
      `Not enough data to tell the agents apart: none has ${minJobs} checked ${type === undefined ? 'jobs' : 'jobs of any type'} yet. ` +
      `${name} comes first in the order of the bridge`
    );
  }
  const over = basis === 'type' ? kind : 'jobs of every type';
  const lead =
    basis === 'all' && type !== undefined
      ? `Not enough ${kind} to tell the agents apart, so this goes by jobs of every type. `
      : '';
  const rivals = open.filter((candidate) => candidate !== best && candidate.scored > 0);
  const others = rivals.map(
    (candidate) => `${aliasOfHarness(candidate.harness)} ${standingWords(candidate, minJobs)}`
  );
  if (!best.enough) {
    return (
      `${lead}${name} has too few checked ${over} to be rated (${standingWords(best, minJobs)}), and takes this one all the same: ` +
      `no agent that is rated is known to do better. ${others.join(', ')}`
    );
  }
  const own = `${name}: ${standingWords(best, minJobs)} over ${over}`;
  if (rivals.length === 0) return `${lead}${own}. No other agent has a checked job to compare`;
  const apart = rivals.every((candidate) => (best.low ?? 0) > (candidate.high ?? 1));
  return (
    `${lead}${own}. Against ${others.join(', ')}. ` +
    (apart
      ? 'The intervals do not overlap: the difference holds'
      : 'The intervals overlap: the difference is not established, this is the better guess')
  );
}

/** A stretch of time for a heading: `60 days`, `6 hours`. */
function windowWords(ms: number): string {
  const days = ms / 86_400_000;
  if (days >= 1) return `${Math.round(days)} ${Math.round(days) === 1 ? 'day' : 'days'}`;
  const hours = Math.max(1, Math.round(ms / 3_600_000));
  return `${hours} ${hours === 1 ? 'hour' : 'hours'}`;
}

function average(value: number): string {
  return value.toFixed(1).replace(/\.0$/, '');
}

/**
 * A suggestion as lines to read: what it goes by, every harness with how its jobs went, and the
 * reason for the one `auto` takes. Harnesses go by the word a job is addressed to them with.
 */
export function suggestionLines(suggestion: Suggestion): string[] {
  const { candidates, minJobs } = suggestion;
  const over =
    suggestion.basis === 'type' && suggestion.type !== undefined
      ? `${suggestion.type} jobs`
      : 'jobs of every type';
  const names = candidates.map((candidate) => aliasOfHarness(candidate.harness));
  const width = Math.max(0, ...names.map((name) => name.length));
  const lines = candidates.map((candidate, index) => {
    const parts = [standingWords(candidate, minJobs)];
    if (candidate.medianMs !== undefined && candidate.jobs > 0) {
      parts.push(
        `median ${formatDuration(candidate.medianMs)}, ${average(candidate.letters ?? 0)} letters and ${average(candidate.person ?? 0)} calls for the person a job`
      );
    }
    if (candidate.unknown > 0 && candidate.scored > 0) {
      parts.push(`${candidate.unknown} more nobody checked`);
    }
    if (candidate.unavailable !== undefined) {
      parts.push(`takes no job now: ${candidate.unavailable}`);
    } else if (candidate.lastResort && candidate.harness !== suggestion.best) {
      parts.push('takes a job only when no other agent can');
    }
    const mark = candidate.harness === suggestion.best ? '  <- auto takes this one' : '';
    return `  ${names[index].padEnd(width)}  ${parts.join('. ')}${mark}`;
  });
  return [
    `How ${over} of the last ${windowWords(suggestion.windowMs)} went:`,
    ...(lines.length > 0 ? lines : ['  no agent the bridge can start a session of']),
    suggestion.reason,
  ];
}
