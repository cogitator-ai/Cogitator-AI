import { escapeHtml, foldable, htmlDocument, htmlTiles } from '../reporters/html-format';
import type {
  PluginEvalCaseResult,
  PluginEvalGrader,
  PluginEvalGraderResult,
  PluginEvalResult,
  PluginEvalRunResult,
} from './types';

const STYLE = `
.verdict { font-size: 15px; margin: 12px 0; }
.banner { border: 1px solid var(--warn); color: var(--warn); border-radius: 8px; padding: 8px 12px; margin: 12px 0; }
.case { border: 1px solid var(--border); border-left: 4px solid var(--border); border-radius: 8px; padding: 12px 16px; margin: 16px 0; }
.case.regressed { border-left-color: var(--fail); }
.case.failed-load { border-left-color: var(--fail); }
.case h2 { margin: 0 0 6px; display: flex; flex-wrap: wrap; gap: 8px; align-items: baseline; }
.case h3 { font-size: 13px; color: var(--muted); margin: 14px 0 6px; }
.bar { position: relative; height: 8px; background: var(--surface); border-radius: 4px; margin: 6px 0 10px; }
.bar span { position: absolute; left: 0; top: 0; bottom: 0; background: var(--pass); border-radius: 4px; }
.bar span.low { background: var(--fail); }
.bar i { position: absolute; top: -3px; bottom: -3px; width: 2px; background: var(--text); }
.run { border-top: 1px solid var(--border); padding: 6px 0; }
.run-head { display: flex; flex-wrap: wrap; gap: 10px; font-variant-numeric: tabular-nums; }
.graders { list-style: none; padding: 0; margin: 4px 0 0; }
.graders li { margin: 2px 0; }
.chip { display: inline-block; border-radius: 10px; padding: 0 8px; font-size: 12px; font-weight: 600; color: #fff; }
.chip.pass { background: var(--pass); }
.chip.fail { background: var(--fail); }
.chip.skip { background: var(--muted); }
.badge { display: inline-block; border: 1px solid var(--border); border-radius: 10px; padding: 0 8px; font-size: 11px; color: var(--muted); }
.notice { color: var(--warn); margin: 2px 0; }
`;

function fixed(value: number, digits = 2): string {
  return value.toFixed(digits);
}

function signed(value: number | undefined, digits = 2): string {
  if (value === undefined) return '-';
  const text = value.toFixed(digits);
  return value > 0 ? `+${text}` : text;
}

function usd(value: number): string {
  return `$${value.toFixed(value < 1 ? 4 : 2)}`;
}

function scoreText(value: number | null | undefined): string {
  return value === null || value === undefined ? '-' : fixed(value);
}

function definitionText(grader: PluginEvalGrader): string {
  switch (grader.type) {
    case 'regex':
      return `/${grader.pattern}/${grader.flags} ${grader.match} in ${typeof grader.target === 'string' ? grader.target : `file ${grader.target.path}`}`;
    case 'tool_used':
      return `${grader.tool}${grader.inputMatch === undefined ? '' : ` /${grader.inputMatch}/`}, ${grader.min} to ${grader.max ?? 'any'} calls`;
    case 'tool_order':
      return `${grader.before.tool} before ${grader.after.tool}`;
    case 'file_exists':
      return `${grader.exists ? 'a created file matches' : 'no created file matches'} ${grader.path}`;
    case 'llm':
      return `${grader.criteria}\n\nfocus: ${typeof grader.focus === 'string' ? grader.focus : `file ${grader.focus.path}`}`;
    case 'baseline':
      return `${grader.criteria}\n\nreference: ${grader.baselineFile}`;
  }
}

function graderItem(result: PluginEvalGraderResult): string {
  const chip = result.skipped
    ? '<span class="chip skip">skipped</span>'
    : `<span class="chip ${result.passed ? 'pass' : 'fail'}">${result.passed ? 'pass' : 'fail'}</span>`;
  const badge = result.scored ? '' : ' <span class="badge">plugin-fired indicator</span>';
  const votes = result.votes
    ? `<ul>${result.votes
        .map(
          (vote) =>
            `<li><b>${escapeHtml(vote.verdict)}</b>${vote.reasoning ? ` ${escapeHtml(vote.reasoning)}` : ''}</li>`
        )
        .join('')}</ul>`
    : '';
  const evidence =
    result.evidence !== undefined
      ? `<details><summary>What the judge saw</summary><pre>${escapeHtml(result.evidence)}</pre></details>`
      : '';
  const body = `<pre>${escapeHtml(result.explanation)}</pre>${votes}${evidence}`;
  const open = !result.passed && !result.skipped ? ' open' : '';
  return `<li>${chip} <code>${escapeHtml(result.name)}</code> <span class="muted">${escapeHtml(result.type)}, weight ${result.weight}</span>${badge}<details${open}><summary>explanation</summary>${body}</details></li>`;
}

function runBlock(run: PluginEvalRunResult): string {
  const head = [
    `<b>Run ${run.index}</b>`,
    `score ${fixed(run.score)}`,
    usd(run.costUsd),
    `${run.durationSeconds.toFixed(1)}s`,
    ...(run.error !== null ? [`<span class="fail">${escapeHtml(run.error)}</span>`] : []),
    ...(run.aborted
      ? [
          `<span class="fail">aborted by ${escapeHtml(`${run.aborted.server}/${run.aborted.tool}`)}: ${escapeHtml(run.aborted.reason)}</span>`,
        ]
      : []),
    ...(run.skippedPaidGraders ? ['<span class="warn">judge graders skipped</span>'] : []),
    ...(run.tempDir ? [`<code>${escapeHtml(run.tempDir)}</code>`] : []),
  ].join(' ');
  const graders =
    run.graders.length > 0
      ? `<ul class="graders">${run.graders.map(graderItem).join('')}</ul>`
      : '<p class="muted">not graded</p>';
  const reply =
    run.lastMessage !== ''
      ? `<details><summary>Final reply</summary>${foldable(run.lastMessage, 200)}</details>`
      : '';
  return `<div class="run"><div class="run-head">${head}</div>${graders}${reply}</div>`;
}

function caseBlock(result: PluginEvalCaseResult, threshold: number): string {
  const { aggregates } = result;
  const regressed = aggregates.delta !== undefined && aggregates.delta < 0;
  const classes = ['case', regressed ? 'regressed' : '', result.error ? 'failed-load' : '']
    .filter((name) => name !== '')
    .join(' ');
  const score = aggregates.score ?? 0;
  const status = aggregates.passed
    ? '<span class="pass">pass</span>'
    : '<span class="fail">fail</span>';
  const delta =
    aggregates.delta === undefined ? '' : `<span>delta ${signed(aggregates.delta)}</span>`;
  const without =
    aggregates.withoutScore === undefined
      ? ''
      : `<span class="muted">without ${scoreText(aggregates.withoutScore)}</span>`;
  const bar = `<div class="bar"><span class="${score < threshold ? 'low' : ''}" style="width:${(score * 100).toFixed(1)}%"></span><i style="left:${(threshold * 100).toFixed(1)}%"></i></div>`;
  const notices = result.notices
    .map((notice) => `<p class="notice">${escapeHtml(notice)}</p>`)
    .join('');
  const error = result.error ? `<p class="fail">${escapeHtml(result.error)}</p>` : '';
  const withRuns = result.arms.with.map(runBlock).join('');
  const withoutRuns = result.arms.without.map(runBlock).join('');
  const graders = result.graders
    .map(
      (grader) =>
        `<li><code>${escapeHtml(grader.name)}</code> <span class="muted">${escapeHtml(grader.type)}</span><pre>${escapeHtml(definitionText(grader))}</pre></li>`
    )
    .join('');
  return [
    `<section class="${classes}">`,
    `<h2>${escapeHtml(result.name)} ${status} <span>score ${scoreText(aggregates.score)}</span>${without}${delta}<span class="muted">${usd(aggregates.costUsd)}</span></h2>`,
    bar,
    notices,
    error,
    withRuns === '' ? '' : `<h3>${result.singleArm ? 'Runs' : 'With plugin'}</h3>${withRuns}`,
    withoutRuns === '' ? '' : `<h3>Baseline, without the plugin</h3>${withoutRuns}`,
    result.prompt === ''
      ? ''
      : `<details><summary>Prompt</summary><pre>${escapeHtml(result.prompt)}</pre></details>`,
    graders === '' ? '' : `<details><summary>Graders</summary><ul>${graders}</ul></details>`,
    '</section>',
  ].join('\n');
}

function verdictLine(result: PluginEvalResult): string {
  const compared = result.cases.filter((c) => c.aggregates.delta !== undefined);
  if (compared.length === 0 || result.aggregates.meanDelta === undefined) return '';
  const improved = compared.filter((c) => (c.aggregates.delta ?? 0) > 0).length;
  const regressed = compared.filter((c) => (c.aggregates.delta ?? 0) < 0).length;
  const flat = compared.length - improved - regressed;
  const points = signed(result.aggregates.meanDelta * 100, 1);
  return `<p class="verdict">Plugin effect: <b>${points} pts</b> vs baseline, improved ${improved}, flat ${flat}, regressed ${regressed} of ${compared.length} case${compared.length === 1 ? '' : 's'}</p>`;
}

/** The result document as a self-contained HTML page: no scripts, no external requests */
export function pluginEvalHtml(result: PluginEvalResult): string {
  const { aggregates } = result;
  const tiles = htmlTiles([
    ['Suite score', fixed(aggregates.overallScore)],
    ['Ablation delta', signed(aggregates.meanDelta)],
    ['Baseline score', scoreText(aggregates.baselineScore)],
    [
      `Cases at ${fixed(result.config.threshold)} or more`,
      `${aggregates.casesPassed} / ${aggregates.casesTotal}`,
    ],
    ['Perfect runs', `${Math.round(aggregates.perfectRuns * 100)}%`],
    ['Cost', usd(result.costUsd)],
    ['Duration', `${Math.round(result.durationSeconds)}s`],
  ]);
  const banner = result.partial
    ? `<p class="banner">Partial run (${escapeHtml(result.partialReason ?? 'unknown')}): leave it out of trend charts</p>`
    : '';
  const warnings = result.warnings
    .map((warning) => `<p class="notice">${escapeHtml(warning)}</p>`)
    .join('');
  const body = [
    `<h1>Plugin evals: ${escapeHtml(result.plugin.name)}</h1>`,
    `<p class="sub">${escapeHtml(result.evalDir)} &middot; ${escapeHtml(result.startedAt)} &middot; Cogitator ${escapeHtml(result.cogitatorVersion)}${result.config.model ? ` &middot; model ${escapeHtml(result.config.model)}` : ''}</p>`,
    verdictLine(result),
    banner,
    warnings,
    tiles,
    ...result.cases.map((c) => caseBlock(c, result.config.threshold)),
  ].join('\n');
  return htmlDocument(`Plugin evals: ${result.plugin.name}`, body, STYLE);
}
