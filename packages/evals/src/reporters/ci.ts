import type { EvalSuiteResult } from './index';

const GREEN = '\x1b[32m';
const RED = '\x1b[31m';
const RESET = '\x1b[0m';

export function ciReport(result: EvalSuiteResult): void {
  const passed = result.assertions.filter((a) => a.passed).length;
  const failed = result.assertions.filter((a) => !a.passed).length;

  console.log(
    `Eval: ${result.stats.total} cases | ${result.stats.duration}ms | $${result.stats.cost}`
  );

  for (const a of result.assertions) {
    if (a.passed) {
      console.log(`  ${GREEN}PASS${RESET} ${a.name}`);
    } else {
      console.log(`  ${RED}FAIL${RESET} ${a.name}: ${a.message}`);
    }
  }

  console.log(`Result: ${passed} passed, ${failed} failed`);

  if (failed > 0) {
    process.exit(1);
  }
}
