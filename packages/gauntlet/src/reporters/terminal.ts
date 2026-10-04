import type { GauntletEvent, RunReport, StageResult, Usage } from '../runner/types.js';

const tty = process.stdout.isTTY && !process.env.NO_COLOR;
const paint = (code: string) => (text: string) => (tty ? `\x1b[${code}m${text}\x1b[0m` : text);
const green = paint('32');
const red = paint('31');
const yellow = paint('33');
const gray = paint('90');
const bold = paint('1');
const brass = paint('38;5;179');

const STATUS: Record<StageResult['status'], string> = {
  pending: gray('·'),
  running: yellow('▸'),
  passed: green('✓'),
  failed: red('✗'),
  skipped: gray('○'),
  blocked: yellow('⊘'),
};

export function formatUsage(usage: Usage): string {
  const tokens = usage.inputTokens + usage.outputTokens;
  return `${usage.calls} calls · ${tokens.toLocaleString('en-US')} tokens · $${usage.costUsd.toFixed(4)}`;
}

function seconds(ms: number | undefined): string {
  return ms === undefined ? '' : `${(ms / 1000).toFixed(1)}s`;
}

/** Live progress on stdout: stage starts, every check, stage outcomes and a final table. */
export function terminalReporter(verbose: boolean) {
  const titles = new Map<string, string>();

  return (event: GauntletEvent) => {
    switch (event.type) {
      case 'run:start':
        for (const stage of event.report.stages) titles.set(stage.id, stage.title);
        process.stdout.write(
          `${brass(bold('+++ COGITATOR GAUNTLET +++'))}  ${event.report.stages.length} stages on ${event.report.model}\n\n`
        );
        break;
      case 'stage:start':
        process.stdout.write(
          `${STATUS.running} ${bold(titles.get(event.stageId) ?? event.stageId)}\n`
        );
        break;
      case 'stage:check': {
        const mark = event.check.ok ? green('✓') : red('✗');
        const detail = event.check.ok ? '' : `  ${red(event.check.error ?? '')}`;
        process.stdout.write(
          `    ${mark} ${event.check.name} ${gray(seconds(event.check.durationMs))}${detail}\n`
        );
        break;
      }
      case 'stage:log':
        if (verbose) process.stdout.write(`      ${gray(event.line.message)}\n`);
        break;
      case 'stage:end': {
        const { result } = event;
        const title = titles.get(result.id) ?? result.id;
        if (result.status === 'skipped' || result.status === 'blocked') {
          process.stdout.write(
            `${STATUS[result.status]} ${title} ${gray(`- ${result.reason ?? ''}`)}\n`
          );
        } else if (result.status === 'failed') {
          process.stdout.write(
            `  ${red('failed')} ${gray(seconds(result.durationMs))}  ${red(result.reason ?? '')}\n`
          );
        } else {
          process.stdout.write(`  ${green('passed')} ${gray(seconds(result.durationMs))}\n`);
        }
        break;
      }
      case 'run:end':
        process.stdout.write(summary(event.report));
        break;
      case 'stage:usage':
        break;
    }
  };
}

function summary(report: RunReport): string {
  const results = Object.values(report.results);
  const count = (status: StageResult['status']) =>
    results.filter((result) => result.status === status).length;
  const uncovered = Object.entries(report.coverage)
    .filter(([, stages]) => stages.length === 0)
    .map(([name]) => name);
  const lines = [
    '',
    brass(bold('+++ RESULT +++')),
    ...report.stages.map((stage) => {
      const result = report.results[stage.id];
      if (!result) return '';
      const tail = result.reason ? gray(` - ${result.reason}`) : '';
      return `  ${STATUS[result.status]} ${stage.title.padEnd(34)} ${gray(seconds(result.durationMs).padStart(7))}${tail}`;
    }),
    '',
    `  ${green(`${count('passed')} passed`)}  ${red(`${count('failed')} failed`)}  ${gray(`${count('skipped')} skipped`)}  ${yellow(`${count('blocked')} blocked`)}`,
    `  ${formatUsage(report.usage)} · ${seconds((report.finishedAt ?? Date.now()) - report.startedAt)}`,
    uncovered.length ? `  ${red(`Packages no stage exercises: ${uncovered.join(', ')}`)}` : '',
    '',
    report.passed ? green(bold('  GAUNTLET PASSED')) : red(bold('  GAUNTLET FAILED')),
    '',
  ];
  return `${lines.filter((line, index) => line !== '' || index === 0 || lines[index - 1] !== '').join('\n')}\n`;
}
