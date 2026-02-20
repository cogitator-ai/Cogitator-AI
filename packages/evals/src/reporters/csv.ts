import { writeFileSync } from 'node:fs';
import type { EvalSuiteResult } from './index';

function escapeField(value: string): string {
  if (value.includes(',') || value.includes('"') || value.includes('\n')) {
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

  const headers = ['input', 'expected', 'output', 'duration', ...metrics];
  const lines: string[] = [headers.join(',')];

  for (const r of result.results) {
    const scoreMap = new Map(r.scores.map((s) => [s.name, s.score]));
    const row = [
      escapeField(r.case.input),
      escapeField(r.case.expected ?? ''),
      escapeField(r.output),
      String(r.duration),
      ...metrics.map((m) => String(scoreMap.get(m) ?? '')),
    ];
    lines.push(row.join(','));
  }

  writeFileSync(options.path, lines.join('\n') + '\n', 'utf-8');
}
