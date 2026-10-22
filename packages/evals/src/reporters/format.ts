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
