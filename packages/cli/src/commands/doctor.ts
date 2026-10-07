import { Command } from 'commander';
import chalk from 'chalk';
import { loadProjectEnv, runDoctor, type DoctorCheck } from '../utils/doctor.js';

const ICONS: Record<DoctorCheck['status'], string> = {
  pass: chalk.green('✓'),
  warn: chalk.yellow('!'),
  fail: chalk.red('✗'),
};

export function formatChecks(checks: readonly DoctorCheck[]): string {
  const width = Math.max(...checks.map((check) => check.label.length));
  const lines = checks.map((check) => {
    const line = `  ${ICONS[check.status]} ${check.label.padEnd(width)}  ${check.detail}`;
    return check.fix ? `${line}\n  ${' '.repeat(width + 4)}${chalk.dim(`→ ${check.fix}`)}` : line;
  });
  const failed = checks.filter((check) => check.status === 'fail').length;
  const warned = checks.filter((check) => check.status === 'warn').length;
  const summary =
    failed > 0
      ? chalk.red(`${failed} problem${failed === 1 ? '' : 's'} to fix`)
      : warned > 0
        ? chalk.yellow(`Ready, with ${warned} warning${warned === 1 ? '' : 's'}`)
        : chalk.green('Everything is ready');
  return ['', ...lines, '', `  ${summary}`, ''].join('\n');
}

export const doctorCommand = new Command('doctor')
  .description('Check that a project can run: Node, packages, config, keys, models and services')
  .option('--json', 'print the checks as JSON')
  .option('--offline', 'skip checks that call the model provider or connect to services')
  .action(async (options: { json?: boolean; offline?: boolean }) => {
    const projectDir = process.cwd();
    loadProjectEnv(projectDir);
    const checks = await runDoctor({
      projectDir,
      env: process.env,
      nodeVersion: process.version,
      probe: !options.offline,
    });
    const ok = checks.every((check) => check.status !== 'fail');
    if (options.json) {
      console.log(JSON.stringify({ ok, checks }, null, 2));
    } else {
      console.log(formatChecks(checks));
    }
    process.exitCode = ok ? 0 : 1;
  });
