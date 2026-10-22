/** The run flags a case result can carry, in the order reports list them */
export const CASE_FLAGS = ['truncated', 'iterationLimitReached', 'paused'] as const;
export type CaseFlag = (typeof CASE_FLAGS)[number];

/** The flags set on a case result, in `CASE_FLAGS` order */
export function caseFlags(result: Partial<Record<CaseFlag, boolean>>): CaseFlag[] {
  return CASE_FLAGS.filter((flag) => result[flag] === true);
}

const DEFAULT_LABEL_LENGTH = 60;

/**
 * A one-line label for a case input: whitespace collapsed and cut to `max` characters with an
 * ellipsis, so test names and annotation titles stay readable
 */
export function truncateInput(input: string, max: number = DEFAULT_LABEL_LENGTH): string {
  const line = input.replace(/\s+/g, ' ').trim();
  const chars = [...line];
  if (chars.length <= max) return line;
  return `${chars
    .slice(0, max - 3)
    .join('')
    .trimEnd()}...`;
}

/** The label of the case at `index` (zero based) in a report or test name */
export function caseLabel(index: number, input: string): string {
  const text = truncateInput(input);
  return `[${index + 1}] ${text === '' ? '(empty input)' : text}`;
}

/** How many trials each case ran, 1 for a suite without several trials */
export function trialsPerCase(result: {
  results: ReadonlyArray<{ trials?: readonly unknown[] }>;
}): number {
  return result.results.reduce((most, r) => Math.max(most, r.trials?.length ?? 1), 1);
}

/**
 * A Markdown table cell: any line break (a lone `\r` too) becomes `<br>` so the row holds, and
 * `<` and `&` are escaped so no tag or comment in an answer hides the rest
 */
export function cell(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/\\/g, '\\\\')
    .replace(/\|/g, '\\|')
    .replace(/\r\n|\r|\n/g, '<br>');
}

/** A figure in a report: an integer as it is, any other number to 4 decimals */
export function num(n: number): string {
  return Number.isInteger(n) ? String(n) : n.toFixed(4);
}

/** A case result as `caseProblems` reads it */
export interface ProblemSource {
  error?: string;
  scores: ReadonlyArray<{ name: string; error?: string }>;
  trials?: readonly ProblemSource[];
}

/**
 * What went wrong on a case: its error and each metric that failed on it. With several trials,
 * those of every trial, each prefixed with its trial number
 */
export function caseProblems(result: ProblemSource): string[] {
  const several = result.trials !== undefined && result.trials.length > 1;
  const runs = several ? result.trials! : [result];
  return runs.flatMap((run, at) => {
    const prefix = several ? `trial ${at + 1}: ` : '';
    return [
      ...(run.error !== undefined ? [`${prefix}error: ${run.error}`] : []),
      ...run.scores.flatMap((score) =>
        score.error !== undefined ? [`${prefix}metric ${score.name} failed: ${score.error}`] : []
      ),
    ];
  });
}
