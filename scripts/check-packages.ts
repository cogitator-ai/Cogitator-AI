import { execFile } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { publint } from 'publint';
import { formatMessage } from 'publint/utils';

/**
 * Lints every public package the way npm will receive it: each one is packed
 * with pnpm (workspace versions and publishConfig applied, as the release
 * publishes it), then checked by publint (package.json against the packed
 * files) and by arethetypeswrong (types and exports for Node 16+ and
 * bundlers). The packages are ESM only, so attw runs with the esm-only
 * profile, which leaves out CommonJS resolution.
 *
 * Usage: tsx scripts/check-packages.ts [package dirs...]
 */

const run = promisify(execFile);
const ROOT = resolve(import.meta.dirname, '..');
const PACKAGES_DIR = join(ROOT, 'packages');
const ATTW = join(ROOT, 'node_modules', '.bin', 'attw');
const CONCURRENCY = 4;

interface PackageJson {
  name?: string;
  private?: boolean;
}

interface PackageReport {
  name: string;
  problems: string[];
  suggestions: string[];
}

interface PackageSelection {
  dirs: string[];
  /** Directories named on the command line that hold no package.json. */
  missing: string[];
}

function selectPackages(): PackageSelection {
  const requested = process.argv.slice(2);
  const candidates =
    requested.length > 0
      ? requested.map((dir) => resolve(process.cwd(), dir))
      : readdirSync(PACKAGES_DIR, { withFileTypes: true })
          .filter((entry) => entry.isDirectory())
          .map((entry) => join(PACKAGES_DIR, entry.name));
  const selection: PackageSelection = { dirs: [], missing: [] };
  for (const dir of candidates) {
    const manifestPath = join(dir, 'package.json');
    if (!existsSync(manifestPath)) {
      if (requested.length > 0) selection.missing.push(dir);
      continue;
    }
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf-8')) as PackageJson;
    if (manifest.private !== true && manifest.name) selection.dirs.push(dir);
  }
  return selection;
}

function outputOf(error: unknown): string {
  const { stdout, stderr, message } = error as Error & { stdout?: string; stderr?: string };
  return [stdout?.trim(), stderr?.trim()].filter(Boolean).join('\n') || message;
}

/**
 * Packs into a directory of its own and takes the one tarball there: lifecycle
 * scripts print to the same stdout, so the output of `pnpm pack` cannot be
 * parsed reliably.
 */
async function pack(packageDir: string, destination: string): Promise<string> {
  const outDir = mkdtempSync(join(destination, 'pack-'));
  await run('pnpm', ['pack', '--pack-destination', outDir], {
    cwd: packageDir,
    maxBuffer: 64 * 1024 * 1024,
  });
  const tarballs = readdirSync(outDir).filter((file) => file.endsWith('.tgz'));
  if (tarballs.length !== 1) {
    throw new Error(`expected one tarball in ${outDir}, found ${tarballs.length}`);
  }
  return join(outDir, tarballs[0]);
}

async function lintWithPublint(tarballPath: string, report: PackageReport): Promise<void> {
  const data = readFileSync(tarballPath);
  const tarball = data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength);
  const { messages, pkg } = await publint({ pack: { tarball }, level: 'suggestion' });
  for (const message of messages) {
    const text = `publint ${message.code}: ${formatMessage(message, pkg, { color: false }) ?? ''}`;
    if (message.type === 'suggestion') report.suggestions.push(text);
    else report.problems.push(text);
  }
}

async function lintWithAttw(tarballPath: string, report: PackageReport): Promise<void> {
  try {
    await run(
      ATTW,
      [tarballPath, '--profile', 'esm-only', '--format', 'ascii', '--no-emoji', '--no-color'],
      { cwd: ROOT, maxBuffer: 16 * 1024 * 1024 }
    );
  } catch (error: unknown) {
    report.problems.push(`arethetypeswrong:\n${outputOf(error)}`);
  }
}

async function checkPackage(packageDir: string, destination: string): Promise<PackageReport> {
  const manifest = JSON.parse(readFileSync(join(packageDir, 'package.json'), 'utf-8')) as {
    name: string;
  };
  const report: PackageReport = { name: manifest.name, problems: [], suggestions: [] };
  let tarballPath: string;
  try {
    tarballPath = await pack(packageDir, destination);
  } catch (error: unknown) {
    report.problems.push(`pnpm pack failed:\n${outputOf(error)}`);
    return report;
  }
  try {
    await lintWithPublint(tarballPath, report);
  } catch (error: unknown) {
    report.problems.push(
      `publint failed: ${error instanceof Error ? error.message : String(error)}`
    );
  }
  await lintWithAttw(tarballPath, report);
  return report;
}

async function main(): Promise<void> {
  const { dirs, missing } = selectPackages();
  if (missing.length > 0) {
    console.error(`No package.json in:\n${missing.map((dir) => `- ${dir}`).join('\n')}`);
    process.exitCode = 1;
    return;
  }
  if (dirs.length === 0) {
    console.error('No public package to check: every package found is private or unnamed');
    process.exitCode = 1;
    return;
  }
  const destination = mkdtempSync(join(tmpdir(), 'cogitator-package-checks-'));
  const reports: PackageReport[] = [];
  try {
    const queue = [...dirs];
    await Promise.all(
      Array.from({ length: Math.min(CONCURRENCY, queue.length) }, async () => {
        for (let dir = queue.shift(); dir !== undefined; dir = queue.shift()) {
          reports.push(await checkPackage(dir, destination));
        }
      })
    );
  } finally {
    rmSync(destination, { recursive: true, force: true });
  }

  reports.sort((a, b) => a.name.localeCompare(b.name));
  for (const report of reports.filter((r) => r.suggestions.length > 0)) {
    console.log(`${report.name} suggestions:`);
    for (const suggestion of report.suggestions) console.log(`  ${suggestion}`);
  }

  const failed = reports.filter((report) => report.problems.length > 0);
  if (failed.length > 0) {
    console.error(`\n${failed.length} of ${reports.length} package(s) are not ready to publish:\n`);
    for (const report of failed) {
      console.error(`- ${report.name}:`);
      for (const problem of report.problems) console.error(problem.replace(/^/gm, '    '));
      console.error('');
    }
    process.exitCode = 1;
    return;
  }

  console.log(`Checked ${reports.length} package(s) with publint and arethetypeswrong`);
}

await main();
