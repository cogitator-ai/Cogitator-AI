import { appendFileSync } from 'node:fs';
import type { EvalSuiteResult } from './index';
import { caseFlags, caseLabel, trialsPerCase } from './format';

/** Escapes the message of a workflow command */
function escapeData(value: string): string {
  return value.replace(/%/g, '%25').replace(/\r/g, '%0D').replace(/\n/g, '%0A');
}

/** Escapes a workflow command property, where `:` and `,` are separators */
function escapeProperty(value: string): string {
  return escapeData(value).replace(/:/g, '%3A').replace(/,/g, '%2C');
}

function command(kind: 'error' | 'warning', title: string, message: string): string {
  return `::${kind} title=${escapeProperty(title)}::${escapeData(message)}`;
}

/** The workflow commands that annotate the run: failures as errors, metric errors as warnings */
export function githubAnnotations(result: EvalSuiteResult): string[] {
  const lines: string[] = [];

  result.results.forEach((r, i) => {
    const label = caseLabel(i, r.case.input);
    if (r.error !== undefined) {
      lines.push(command('error', `Eval case ${label}`, r.error));
    }
    for (const score of r.scores) {
      if (score.error !== undefined) {
        lines.push(command('warning', `Eval metric ${score.name} on case ${label}`, score.error));
      }
    }
  });

  for (const a of result.assertions) {
    if (!a.passed) lines.push(command('error', `Eval assertion ${a.name}`, a.message));
  }

  return lines;
}

/**
 * A table cell of the step summary: any line break (a lone `\r` too) becomes `<br>` so the row
 * holds, and `<` and `&` are escaped so no tag or comment in an answer hides the rest
 */
function cell(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/\\/g, '\\\\')
    .replace(/\|/g, '\\|')
    .replace(/\r\n|\r|\n/g, '<br>');
}

function num(n: number): string {
  return Number.isInteger(n) ? String(n) : n.toFixed(4);
}

/** The Markdown summary of the run for `$GITHUB_STEP_SUMMARY` */
export function githubSummary(result: EvalSuiteResult): string {
  const { stats } = result;
  const passed = result.assertions.filter((a) => a.passed).length;
  const failed = result.assertions.length - passed;
  const flagged = result.results.filter((r) => caseFlags(r).length > 0).length;

  const trials = trialsPerCase(result);
  const totals = [
    `**${stats.total}** cases${trials > 1 ? ` x **${trials}** trials` : ''}`,
    `**${stats.errors ?? 0}** errored`,
    ...(stats.metricErrors ? [`**${stats.metricErrors}** metric errors`] : []),
    ...(flagged > 0 ? [`**${flagged}** truncated, paused or at the iteration limit`] : []),
    `${stats.duration} ms`,
    `${num(stats.cost)} USD`,
    `assertions: **${passed}** passed, **${failed}** failed`,
  ];

  const lines = ['## Eval results', '', totals.join(' | '), ''];

  const metrics = Object.values(result.aggregated);
  if (metrics.length > 0) {
    lines.push(
      '### Metrics',
      '',
      '| Metric | Mean | P50 | P95 | Cases |',
      '| --- | ---: | ---: | ---: | ---: |'
    );
    for (const m of metrics) {
      const count = m.count === undefined ? '-' : String(m.count);
      lines.push(`| ${cell(m.name)} | ${num(m.mean)} | ${num(m.p50)} | ${num(m.p95)} | ${count} |`);
    }
    lines.push('');
  }

  if (result.assertions.length > 0) {
    lines.push('### Assertions', '', '| Result | Assertion | Details |', '| --- | --- | --- |');
    for (const a of result.assertions) {
      lines.push(`| ${a.passed ? 'pass' : '**fail**'} | ${cell(a.name)} | ${cell(a.message)} |`);
    }
    lines.push('');
  }

  return lines.join('\n') + '\n';
}

/**
 * Prints GitHub Actions annotations to stdout, and appends a Markdown summary to the file in
 * `GITHUB_STEP_SUMMARY` when the variable is set
 */
export function githubReport(result: EvalSuiteResult): void {
  for (const line of githubAnnotations(result)) console.log(line);

  const summaryPath = process.env.GITHUB_STEP_SUMMARY;
  if (summaryPath) appendFileSync(summaryPath, githubSummary(result), 'utf-8');
}
