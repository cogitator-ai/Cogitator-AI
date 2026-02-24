import chalk from 'chalk';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));

export const log = {
  info: (msg: string) => console.log(chalk.blue('ℹ'), msg),
  success: (msg: string) => console.log(chalk.green('✓'), msg),
  warn: (msg: string) => console.log(chalk.yellow('⚠'), msg),
  error: (msg: string) => console.log(chalk.red('✗'), msg),
  step: (msg: string) => console.log(chalk.cyan('→'), msg),
  dim: (msg: string) => console.log(chalk.dim(msg)),
};

export function printBanner() {
  console.log(
    chalk.bold.cyan(`
   ___            _ _        _
  / __\\___   __ _(_) |_ __ _| |_ ___  _ __
 / /  / _ \\ / _\` | | __/ _\` | __/ _ \\| '__|
/ /__| (_) | (_| | | || (_| | || (_) | |
\\____/\\___/ \\__, |_|\\__\\__,_|\\__\\___/|_|
            |___/
`)
  );
  const pkg = JSON.parse(readFileSync(join(__dirname, '../../package.json'), 'utf-8')) as {
    version: string;
  };
  console.log(chalk.dim(`  AI Agent Runtime v${pkg.version}\n`));
}
