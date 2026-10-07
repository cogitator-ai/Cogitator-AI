/**
 * Fails when the built create-cogitator-app does not match the versions about
 * to be published. The scaffolder bakes its own version and the versions of
 * the @cogitator-ai packages it pins into its build, so a build made before
 * `changeset version` would publish the previous release's numbers.
 *
 * Run after `pnpm build`: npx tsx scripts/check-scaffolder-build.ts
 */
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const root = join(import.meta.dirname, '..');
const cli = join(root, 'packages', 'create-cogitator-app', 'dist', 'index.js');

function manifest(dir: string): { name?: string; version?: string; private?: boolean } {
  return JSON.parse(readFileSync(join(dir, 'package.json'), 'utf-8')) as {
    name?: string;
    version?: string;
    private?: boolean;
  };
}

const workspace = new Map<string, string>();
for (const entry of readdirSync(join(root, 'packages'))) {
  try {
    const pkg = manifest(join(root, 'packages', entry));
    if (pkg.name && pkg.version) workspace.set(pkg.name, pkg.version);
  } catch {
    continue;
  }
}

const problems: string[] = [];
const expectedVersion = workspace.get('create-cogitator-app');
const builtVersion = execFileSync(process.execPath, [cli, '--version'], {
  encoding: 'utf-8',
}).trim();
if (builtVersion !== expectedVersion) {
  problems.push(`the scaffolder reports ${builtVersion}, package.json says ${expectedVersion}`);
}

const scratch = mkdtempSync(join(tmpdir(), 'scaffolder-check-'));
try {
  const plan = JSON.parse(
    execFileSync(
      process.execPath,
      [cli, 'release-check', '--dry-run', '--json', '--no-telemetry'],
      {
        cwd: scratch,
        encoding: 'utf-8',
      }
    )
  ) as { dependencies: Record<string, string>; devDependencies: Record<string, string> };
  for (const [name, range] of Object.entries({ ...plan.dependencies, ...plan.devDependencies })) {
    if (!name.startsWith('@cogitator-ai/')) continue;
    const version = workspace.get(name);
    if (range !== `^${version}`) {
      problems.push(`a new project pins ${name}@${range}, the workspace has ${version}`);
    }
  }
} finally {
  rmSync(scratch, { recursive: true, force: true });
}

if (problems.length > 0) {
  console.error(
    `create-cogitator-app was built with stale versions, rebuild it after \`changeset version\`:\n- ${problems.join('\n- ')}`
  );
  process.exit(1);
}
console.log(`create-cogitator-app ${builtVersion} pins the workspace versions`);
