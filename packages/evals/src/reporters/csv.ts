import { writeFileSync } from 'node:fs';
import type { EvalSuiteResult } from './index';
import { CASE_FLAGS } from './format';

function escapeField(value: string): string {
  if (/[",\r\n]/.test(value)) {
    return `"${value.replace(/"/g, '""')}"`;
  }
  return value;
}

export function csvReport(result: EvalSuiteResult, options: { path: string }): void {
  const metricNames = new Set<string>();
  for (const r of result.results) {
    for (const s of r.scores) {
      metricNames.add(s.name);
    }
  }
  const metrics = [...metricNames];
  const flags = CASE_FLAGS.filter((flag) => result.results.some((r) => r[flag] === true));

  const headers = ['input', 'expected', 'output', 'duration', ...flags, ...metrics];
  const lines: string[] = [headers.join(',')];

  for (const r of result.results) {
    const scoreMap = new Map(r.scores.map((s) => [s.name, s.score]));
    const row = [
      escapeField(r.case.input),
      escapeField(r.case.expected ?? ''),
      escapeField(r.output),
      String(r.duration),
      ...flags.map((flag) => (r[flag] === true ? 'true' : '')),
      ...metrics.map((m) => String(scoreMap.get(m) ?? '')),
    ];
    lines.push(row.join(','));
  }

  writeFileSync(options.path, lines.join('\n') + '\n', 'utf-8');
}
