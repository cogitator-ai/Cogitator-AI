import { writeFileSync } from 'node:fs';
import type { EvalSuiteResult } from './index';
import { caseLabel, cell, num, trialsPerCase } from './format';

/** Most failures the summary lists before it counts the rest */
export const MARKDOWN_MAX_FAILURES = 25;

/** The failures of the cases: errored cases, then metrics that failed on a case */
function failures(result: EvalSuiteResult): Array<{ label: string; problem: string }> {
  const list: Array<{ label: string; problem: string }> = [];
  result.results.forEach((r, i) => {
    const label = caseLabel(i, r.case.input);
    if (r.error !== undefined) list.push({ label, problem: `error: ${r.error}` });
    for (const score of r.scores) {
      if (score.error !== undefined) {
        list.push({ label, problem: `metric ${score.name} failed: ${score.error}` });
      }
    }
  });
  return list;
}

/**
 * A compact Markdown summary of a suite run for a pull request comment: the totals, the mean of
 * each metric with the cases it covers, the assertions and the failed cases. Every value from the
 * run is escaped, so no answer can break the tables or hide the rest of the comment
 */
export function markdownSummary(result: EvalSuiteResult): string {
  const { stats } = result;
  const passed = result.assertions.filter((a) => a.passed).length;
  const failed = result.assertions.length - passed;
  const trials = trialsPerCase(result);

  const totals = [
    `**${stats.total}** cases${trials > 1 ? ` x **${trials}** trials` : ''}`,
    `**${stats.errors ?? 0}** errored`,
    ...(stats.metricErrors ? [`**${stats.metricErrors}** metric errors`] : []),
    `${stats.duration} ms`,
    `${num(stats.cost)} USD`,
    ...(result.assertions.length > 0
      ? [`assertions: **${passed}** passed, **${failed}** failed`]
      : []),
  ];

  const title = result.name === undefined ? 'Eval results' : `Eval results: ${cell(result.name)}`;
  const lines = [`### ${title}`, '', totals.join(' | '), ''];

  const metrics = Object.values(result.aggregated);
  if (metrics.length > 0) {
    lines.push('| Metric | Mean | Cases |', '| --- | ---: | ---: |');
    for (const m of metrics) {
      lines.push(`| ${cell(m.name)} | ${num(m.mean)} | ${m.count === undefined ? '-' : m.count} |`);
    }
    lines.push('');
  }

  if (result.assertions.length > 0) {
    lines.push('| Assertion | Result | Details |', '| --- | --- | --- |');
    for (const a of result.assertions) {
      lines.push(`| ${cell(a.name)} | ${a.passed ? 'pass' : '**fail**'} | ${cell(a.message)} |`);
    }
    lines.push('');
  }

  const failedCases = failures(result);
  if (failedCases.length > 0) {
    lines.push(
      `**Failed cases** (${failedCases.length})`,
      '',
      '| Case | Problem |',
      '| --- | --- |'
    );
    for (const { label, problem } of failedCases.slice(0, MARKDOWN_MAX_FAILURES)) {
      lines.push(`| ${cell(label)} | ${cell(problem)} |`);
    }
    if (failedCases.length > MARKDOWN_MAX_FAILURES) {
      lines.push('', `and ${failedCases.length - MARKDOWN_MAX_FAILURES} more`);
    }
    lines.push('');
  }

  return lines.join('\n');
}

/** Writes the Markdown summary of a suite run */
export function markdownReport(result: EvalSuiteResult, options: { path: string }): void {
  writeFileSync(options.path, markdownSummary(result), 'utf-8');
}
