import { writeFileSync } from 'node:fs';
import type { EvalSuiteResult } from './index';

export function jsonReport(result: EvalSuiteResult, options: { path: string }): void {
  writeFileSync(options.path, JSON.stringify(result, null, 2), 'utf-8');
}
