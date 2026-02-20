import type { EvalSuiteResult } from './index';

const GREEN = '\x1b[32m';
const RED = '\x1b[31m';
const BOLD = '\x1b[1m';
const DIM = '\x1b[2m';
const RESET = '\x1b[0m';

function pad(str: string, len: number): string {
  return str.length >= len ? str : str + ' '.repeat(len - str.length);
}

function fmt(n: number): string {
  return Number.isInteger(n) ? String(n) : n.toFixed(4);
}

export function consoleReport(result: EvalSuiteResult): void {
  const metrics = Object.values(result.aggregated);

  if (metrics.length > 0) {
    const cols = { metric: 14, mean: 10, median: 10, p95: 10, min: 10, max: 10 };
    const header =
      pad('Metric', cols.metric) +
      pad('Mean', cols.mean) +
      pad('Median', cols.median) +
      pad('P95', cols.p95) +
      pad('Min', cols.min) +
      pad('Max', cols.max);

    console.log(`\n${BOLD}${header}${RESET}`);
    console.log(DIM + '─'.repeat(header.length) + RESET);

    for (const m of metrics) {
      const row =
        pad(m.name, cols.metric) +
        pad(fmt(m.mean), cols.mean) +
        pad(fmt(m.median), cols.median) +
        pad(fmt(m.p95), cols.p95) +
        pad(fmt(m.min), cols.min) +
        pad(fmt(m.max), cols.max);
      console.log(row);
    }
  }

  if (result.assertions.length > 0) {
    console.log(`\n${BOLD}Assertions${RESET}`);
    for (const a of result.assertions) {
      const icon = a.passed ? `${GREEN}✓${RESET}` : `${RED}✗${RESET}`;
      const color = a.passed ? GREEN : RED;
      console.log(`  ${icon} ${color}${a.name}${RESET} ${DIM}${a.message}${RESET}`);
    }
  }

  const passed = result.assertions.filter((a) => a.passed).length;
  const failed = result.assertions.filter((a) => !a.passed).length;

  console.log(
    `\n${BOLD}Summary${RESET}: ${result.stats.total} cases | ${result.stats.duration}ms | $${result.stats.cost} | ${GREEN}${passed} passed${RESET} ${failed > 0 ? `${RED}${failed} failed${RESET}` : ''}`
  );
}
