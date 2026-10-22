import { writeFileSync } from 'node:fs';
import type { EvalSuiteResult, ReportedCase } from './index';
import { caseFlags, num, trialsPerCase } from './format';
import { escapeHtml, foldable, htmlDocument, htmlTable, htmlTiles } from './html-format';

function scoresCell(r: ReportedCase): string {
  if (r.scores.length === 0) return '<span class="muted">-</span>';
  return r.scores
    .map((s) => {
      const failed =
        s.error !== undefined ? ` <span class="fail">${escapeHtml(s.error)}</span>` : '';
      return `<code>${escapeHtml(s.name)}</code> ${escapeHtml(num(s.score))}${failed}`;
    })
    .join('<br>');
}

function statusCell(r: ReportedCase): string {
  const parts: string[] = [];
  if (r.error !== undefined) parts.push(`<span class="fail">error</span> ${foldable(r.error, 80)}`);
  else parts.push('<span class="pass">answered</span>');
  for (const flag of caseFlags(r)) parts.push(`<span class="warn">${escapeHtml(flag)}</span>`);
  if (r.trials && r.trials.length > 1) {
    const answered = r.trials.filter((t) => t.error === undefined).length;
    parts.push(`<span class="muted">${answered} of ${r.trials.length} trials answered</span>`);
  }
  return parts.join('<br>');
}

function outputCell(r: ReportedCase): string {
  if (!r.turns || r.turns.length === 0) return foldable(r.output);
  const conversation = r.turns
    .map(
      (turn) =>
        `user: ${turn.input}\nagent: ${turn.error !== undefined ? `(error) ${turn.error}` : turn.output}`
    )
    .join('\n\n');
  return `<details><summary>${r.turns.length} turns</summary><pre>${escapeHtml(conversation)}</pre></details>`;
}

function runCell(r: ReportedCase): string {
  const parts: string[] = [];
  if (r.traceId !== undefined) parts.push(`<code>${escapeHtml(r.traceId)}</code>`);
  if (r.prompt) {
    const version = r.prompt.version !== undefined ? ` v${r.prompt.version}` : '';
    parts.push(`<span class="muted">${escapeHtml(r.prompt.key + version)}</span>`);
  }
  return parts.length > 0 ? parts.join('<br>') : '<span class="muted">-</span>';
}

/**
 * A self-contained HTML page of a suite run: the totals, the aggregated metrics, the assertions
 * and every case with its scores. Inline CSS for light and dark color schemes, no scripts, no
 * external assets, and every value from the run escaped
 */
export function htmlPage(result: EvalSuiteResult): string {
  const { stats } = result;
  const title = result.name === undefined ? 'Eval results' : `Eval results: ${result.name}`;
  const passed = result.assertions.filter((a) => a.passed).length;
  const failed = result.assertions.length - passed;
  const trials = trialsPerCase(result);

  const sections: string[] = [
    `<h1>${escapeHtml(title)}</h1>`,
    ...(result.runId !== undefined
      ? [`<p class="sub">Run <code>${escapeHtml(result.runId)}</code></p>`]
      : []),
    htmlTiles([
      ['cases', escapeHtml(String(stats.total))],
      ...(trials > 1 ? [['trials per case', escapeHtml(String(trials))] as const] : []),
      ['errored', escapeHtml(String(stats.errors ?? 0))],
      ...(stats.metricErrors
        ? [['metric errors', escapeHtml(String(stats.metricErrors))] as const]
        : []),
      ['duration', `${escapeHtml(String(stats.duration))} ms`],
      ['cost', `${escapeHtml(num(stats.cost))} USD`],
      ...(result.assertions.length > 0
        ? [
            [
              'assertions',
              `<span class="${failed > 0 ? 'fail' : 'pass'}">${passed} / ${result.assertions.length}</span>`,
            ] as const,
          ]
        : []),
    ]),
  ];

  const metrics = Object.values(result.aggregated);
  if (metrics.length > 0) {
    sections.push(
      '<h2>Metrics</h2>',
      htmlTable(
        ['Metric', 'Mean', 'P50', 'P95', 'Min', 'Max', 'Cases'],
        metrics.map((m) => [
          `<code>${escapeHtml(m.name)}</code>`,
          ...[m.mean, m.p50, m.p95, m.min, m.max].map((v) => escapeHtml(num(v))),
          m.count === undefined ? '-' : escapeHtml(String(m.count)),
        ]),
        new Set([1, 2, 3, 4, 5, 6])
      )
    );
  }

  if (result.assertions.length > 0) {
    sections.push(
      '<h2>Assertions</h2>',
      htmlTable(
        ['Result', 'Assertion', 'Details'],
        result.assertions.map((a) => [
          a.passed ? '<span class="pass">pass</span>' : '<span class="fail">fail</span>',
          `<code>${escapeHtml(a.name)}</code>`,
          escapeHtml(a.message),
        ])
      )
    );
  }

  if (result.results.length > 0) {
    const showRun = result.results.some((r) => r.traceId !== undefined || r.prompt !== undefined);
    sections.push(
      '<h2>Cases</h2>',
      htmlTable(
        ['#', 'Input', 'Expected', 'Output', 'Scores', 'Status', ...(showRun ? ['Trace'] : [])],
        result.results.map((r, i) => [
          String(i + 1),
          foldable(r.case.input),
          r.case.expected === undefined
            ? '<span class="muted">-</span>'
            : foldable(r.case.expected),
          outputCell(r),
          scoresCell(r),
          statusCell(r),
          ...(showRun ? [runCell(r)] : []),
        ]),
        new Set([0])
      )
    );
  }

  return htmlDocument(title, sections.join('\n'));
}

/** Writes the HTML page of a suite run */
export function htmlReport(result: EvalSuiteResult, options: { path: string }): void {
  writeFileSync(options.path, htmlPage(result), 'utf-8');
}
