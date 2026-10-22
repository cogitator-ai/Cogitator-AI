import { writeFileSync } from 'node:fs';
import type { ComparisonResult } from '../eval-comparison';
import type { RunComparison, RunRef } from '../runs/compare';
import type { ComparisonTest } from '../comparison-stats';
import { caseChanges } from '../comparison-stats';
import { cell, num, truncateInput } from './format';
import { prepare, reportPath } from './index';
import type { ReporterOptions } from './index';
import { escapeHtml, htmlDocument, htmlTable, htmlTiles } from './html-format';

/** What `reportComparison()` renders: an `EvalComparison` result or a `compareRuns()` result */
export type ReportableComparison = ComparisonResult | RunComparison;

export type ComparisonReporterType = 'markdown' | 'html' | 'console';

interface ChangeView {
  input: string;
  before: number;
  after: number;
  delta: number;
}

interface MetricView {
  name: string;
  before: number;
  after: number;
  n: number;
  difference: number;
  ci: { low: number; high: number };
  test: ComparisonTest;
  pValue: number;
  adjustedPValue: number;
  significant: boolean;
  winner: string;
  improved: ChangeView[];
  regressed: ChangeView[];
}

/** A comparison of either kind, read the same way */
interface ComparisonView {
  title: string;
  /** The side compared from, `base` or `baseline` */
  before: string;
  /** The side compared to, `head` or `challenger` */
  after: string;
  subtitle?: string;
  winner: string;
  metrics: MetricView[];
  cases?: { matched: number; added: string[]; removed: string[] };
  warnings: string[];
}

/** Most case changes the Markdown summary lists per metric and direction */
const MARKDOWN_MAX_CHANGES = 10;

function isRunComparison(comparison: ReportableComparison): comparison is RunComparison {
  return !('summary' in comparison);
}

function runLabel(ref: RunRef): string {
  return ref.name === undefined ? ref.runId : `${ref.name} (${ref.runId})`;
}

function viewOf(comparison: ReportableComparison): ComparisonView {
  if (isRunComparison(comparison)) {
    return {
      title: 'Run comparison',
      before: 'base',
      after: 'head',
      subtitle: `base ${runLabel(comparison.base)}, head ${runLabel(comparison.head)}`,
      winner: comparison.winner,
      metrics: Object.entries(comparison.metrics).map(([name, m]) => ({
        name,
        before: m.base,
        after: m.head,
        n: m.n,
        difference: m.difference,
        ci: m.ci,
        test: m.test,
        pValue: m.pValue,
        adjustedPValue: m.adjustedPValue,
        significant: m.significant,
        winner: m.winner,
        improved: m.improved.map((c) => ({ ...c, before: c.base, after: c.head })),
        regressed: m.regressed.map((c) => ({ ...c, before: c.base, after: c.head })),
      })),
      cases: {
        matched: comparison.matched,
        added: comparison.added.map((c) => c.input),
        removed: comparison.removed.map((c) => c.input),
      },
      warnings: comparison.warnings,
    };
  }

  const { baseline, challenger, summary } = comparison;
  const pairs = baseline.results.map((r, at) => [r, challenger.results[at]] as const);
  const inputOf = (index: number) => baseline.results[index].case.input;
  return {
    title: 'A/B comparison',
    before: 'baseline',
    after: 'challenger',
    winner: summary.winner,
    metrics: Object.entries(summary.metrics).map(([name, m]) => ({
      name,
      before: m.baseline,
      after: m.challenger,
      n: m.n,
      difference: m.difference,
      ci: m.ci,
      test: m.test,
      pValue: m.pValue,
      adjustedPValue: m.adjustedPValue,
      significant: m.significant,
      winner: m.winner,
      ...caseChanges(pairs, name, inputOf),
    })),
    warnings: [],
  };
}

function signed(n: number): string {
  return n > 0 ? `+${num(n)}` : num(n);
}

function ciText(ci: { low: number; high: number }): string {
  return `[${num(ci.low)}, ${num(ci.high)}]`;
}

function pText(p: number): string {
  return p < 0.0001 ? '<0.0001' : num(p);
}

function changeLines(
  view: ComparisonView,
  kind: 'regressed' | 'improved',
  heading: string
): string[] {
  const rows = view.metrics.flatMap((m) => {
    const changes = m[kind];
    const shown = changes
      .slice(0, MARKDOWN_MAX_CHANGES)
      .map(
        (c) =>
          `| ${cell(m.name)} | ${cell(c.input)} | ${num(c.before)} | ${num(c.after)} | ${signed(c.delta)} |`
      );
    const more =
      changes.length > MARKDOWN_MAX_CHANGES
        ? [`| ${cell(m.name)} | and ${changes.length - MARKDOWN_MAX_CHANGES} more | | | |`]
        : [];
    return [...shown, ...more];
  });
  if (rows.length === 0) return [];
  return [
    `**${heading}**`,
    '',
    `| Metric | Case | ${view.before} | ${view.after} | Change |`,
    '| --- | --- | ---: | ---: | ---: |',
    ...rows,
    '',
  ];
}

/**
 * A compact Markdown summary of a comparison for a pull request comment: the winner, a table of
 * the metrics with means, difference, interval, p-values and significance, the cases that
 * regressed and improved, and the warnings. Every value is escaped
 */
export function comparisonMarkdown(comparison: ReportableComparison): string {
  const view = viewOf(comparison);
  const lines = [`### ${view.title}`, ''];
  if (view.subtitle) lines.push(cell(view.subtitle), '');

  const totals = [`winner: **${view.winner}**`];
  if (view.cases) {
    totals.push(
      `**${view.cases.matched}** cases matched`,
      `**${view.cases.added.length}** added`,
      `**${view.cases.removed.length}** removed`
    );
  }
  lines.push(totals.join(' | '), '');

  if (view.warnings.length > 0) {
    lines.push('**Warnings**', '', ...view.warnings.map((w) => `- ${cell(w)}`), '');
  }

  if (view.metrics.length > 0) {
    lines.push(
      `| Metric | ${view.before} | ${view.after} | Difference | CI | p | Adjusted p | Significant | Winner |`,
      '| --- | ---: | ---: | ---: | --- | ---: | ---: | --- | --- |'
    );
    for (const m of view.metrics) {
      lines.push(
        `| ${cell(m.name)} | ${num(m.before)} | ${num(m.after)} | ${signed(m.difference)} | ${ciText(m.ci)} | ${pText(m.pValue)} | ${pText(m.adjustedPValue)} | ${m.significant ? '**yes**' : 'no'} | ${m.winner} |`
      );
    }
    lines.push('');
  } else {
    lines.push('No metric to compare.', '');
  }

  lines.push(...changeLines(view, 'regressed', 'Regressions'));
  lines.push(...changeLines(view, 'improved', 'Improvements'));
  return lines.join('\n');
}

function changesTable(view: ComparisonView, kind: 'regressed' | 'improved'): string | undefined {
  const rows = view.metrics.flatMap((m) =>
    m[kind].map((c) => [
      `<code>${escapeHtml(m.name)}</code>`,
      escapeHtml(c.input),
      escapeHtml(num(c.before)),
      escapeHtml(num(c.after)),
      `<span class="${c.delta < 0 ? 'fail' : 'pass'}">${escapeHtml(signed(c.delta))}</span>`,
    ])
  );
  if (rows.length === 0) return undefined;
  return htmlTable(['Metric', 'Case', view.before, view.after, 'Change'], rows, new Set([2, 3, 4]));
}

/**
 * A self-contained HTML page of a comparison: inline CSS for light and dark color schemes, no
 * scripts, no external assets, and every value escaped
 */
export function comparisonHtml(comparison: ReportableComparison): string {
  const view = viewOf(comparison);
  const sections = [`<h1>${escapeHtml(view.title)}</h1>`];
  if (view.subtitle) sections.push(`<p class="sub">${escapeHtml(view.subtitle)}</p>`);

  sections.push(
    htmlTiles([
      [
        'winner',
        `<span class="${view.winner === 'tie' ? 'muted' : 'pass'}">${escapeHtml(view.winner)}</span>`,
      ],
      ...(view.cases
        ? ([
            ['cases matched', escapeHtml(String(view.cases.matched))],
            ['added', escapeHtml(String(view.cases.added.length))],
            ['removed', escapeHtml(String(view.cases.removed.length))],
          ] as const)
        : []),
    ])
  );

  if (view.warnings.length > 0) {
    sections.push(
      '<h2>Warnings</h2>',
      `<ul>${view.warnings.map((w) => `<li class="warn">${escapeHtml(w)}</li>`).join('')}</ul>`
    );
  }

  sections.push(
    '<h2>Metrics</h2>',
    view.metrics.length === 0
      ? '<p class="muted">No metric to compare.</p>'
      : htmlTable(
          [
            'Metric',
            view.before,
            view.after,
            'Cases',
            'Difference',
            'CI',
            'Test',
            'p',
            'Adjusted p',
            'Significant',
            'Winner',
          ],
          view.metrics.map((m) => [
            `<code>${escapeHtml(m.name)}</code>`,
            escapeHtml(num(m.before)),
            escapeHtml(num(m.after)),
            escapeHtml(String(m.n)),
            escapeHtml(signed(m.difference)),
            escapeHtml(ciText(m.ci)),
            escapeHtml(m.test),
            escapeHtml(pText(m.pValue)),
            escapeHtml(pText(m.adjustedPValue)),
            m.significant ? '<span class="pass">yes</span>' : '<span class="muted">no</span>',
            escapeHtml(m.winner),
          ]),
          new Set([1, 2, 3, 4, 7, 8])
        )
  );

  const regressed = changesTable(view, 'regressed');
  if (regressed) sections.push('<h2>Regressions</h2>', regressed);
  const improved = changesTable(view, 'improved');
  if (improved) sections.push('<h2>Improvements</h2>', improved);

  if (view.cases && (view.cases.added.length > 0 || view.cases.removed.length > 0)) {
    const list = (inputs: string[]) =>
      `<ul>${inputs.map((input) => `<li>${escapeHtml(input)}</li>`).join('')}</ul>`;
    if (view.cases.added.length > 0) {
      sections.push(`<h2>Cases only in the ${view.after} run</h2>`, list(view.cases.added));
    }
    if (view.cases.removed.length > 0) {
      sections.push(`<h2>Cases only in the ${view.before} run</h2>`, list(view.cases.removed));
    }
  }

  return htmlDocument(view.title, sections.join('\n'));
}

const GREEN = '\x1b[32m';
const RED = '\x1b[31m';
const YELLOW = '\x1b[33m';
const BOLD = '\x1b[1m';
const DIM = '\x1b[2m';
const RESET = '\x1b[0m';

function pad(text: string, width: number): string {
  return text.length >= width ? `${text} ` : text + ' '.repeat(width - text.length);
}

function printConsole(comparison: ReportableComparison): void {
  const view = viewOf(comparison);
  console.log(
    `\n${BOLD}${view.title}${RESET}${view.subtitle ? ` ${DIM}${view.subtitle}${RESET}` : ''}`
  );
  const cases = view.cases
    ? ` | ${view.cases.matched} cases matched, ${view.cases.added.length} added, ${view.cases.removed.length} removed`
    : '';
  console.log(`Winner: ${BOLD}${view.winner}${RESET}${cases}`);

  for (const warning of view.warnings) console.log(`${YELLOW}warning${RESET} ${warning}`);

  if (view.metrics.length > 0) {
    const width = Math.max(14, ...view.metrics.map((m) => m.name.length + 2));
    const header =
      pad('Metric', width) +
      pad(view.before, 12) +
      pad(view.after, 12) +
      pad('Diff', 10) +
      pad('CI', 22) +
      pad('p', 10) +
      pad('Adj. p', 10) +
      'Winner';
    console.log(`\n${BOLD}${header}${RESET}`);
    console.log(DIM + '─'.repeat(header.length) + RESET);
    for (const m of view.metrics) {
      const color = !m.significant ? '' : m.winner === view.after ? GREEN : RED;
      console.log(
        pad(m.name, width) +
          pad(num(m.before), 12) +
          pad(num(m.after), 12) +
          pad(signed(m.difference), 10) +
          pad(ciText(m.ci), 22) +
          pad(pText(m.pValue), 10) +
          pad(pText(m.adjustedPValue), 10) +
          `${color}${m.winner}${m.significant ? ' *' : ''}${color ? RESET : ''}`
      );
    }
  }

  for (const [kind, heading, color] of [
    ['regressed', 'Regressions', RED],
    ['improved', 'Improvements', GREEN],
  ] as const) {
    const changes = view.metrics.flatMap((m) => m[kind].map((c) => ({ metric: m.name, ...c })));
    if (changes.length === 0) continue;
    console.log(`\n${BOLD}${heading}${RESET}`);
    for (const c of changes) {
      console.log(
        `  ${color}${signed(c.delta)}${RESET} ${c.metric} ${DIM}${num(c.before)} -> ${num(c.after)}${RESET} ${truncateInput(c.input)}`
      );
    }
  }
}

/**
 * Renders an `EvalComparison` result or a `compareRuns()` result: `console` prints it, `markdown`
 * writes a compact summary for a pull request comment to `<path>.md`, and `html` a
 * self-contained page to `<path>.html`. The default path is `eval-comparison`
 */
export function reportComparison(
  comparison: ReportableComparison,
  type: ComparisonReporterType | ComparisonReporterType[],
  options?: ReporterOptions
): void {
  const types = Array.isArray(type) ? type : [type];
  for (const t of types) {
    switch (t) {
      case 'console':
        printConsole(comparison);
        break;
      case 'markdown':
        writeFileSync(
          prepare(reportPath(options?.path, 'md', 'eval-comparison')),
          comparisonMarkdown(comparison),
          'utf-8'
        );
        break;
      case 'html':
        writeFileSync(
          prepare(reportPath(options?.path, 'html', 'eval-comparison')),
          comparisonHtml(comparison),
          'utf-8'
        );
        break;
    }
  }
}
