import { header, section } from '../_shared/setup.js';
import { WorkspaceError } from '@cogitator-ai/core';
import {
  DaytonaWorkspace,
  E2BWorkspace,
  VercelSandboxWorkspace,
  type RemoteShellWorkspace,
} from '@cogitator-ai/sandbox';

type Provider = 'e2b' | 'daytona' | 'vercel';

/** The provider to use: REMOTE_WORKSPACE when set, else the first one with credentials. */
function chooseProvider(): Provider | undefined {
  const asked = process.env.REMOTE_WORKSPACE;
  if (asked === 'e2b' || asked === 'daytona' || asked === 'vercel') return asked;
  if (process.env.E2B_API_KEY) return 'e2b';
  if (process.env.DAYTONA_API_KEY) return 'daytona';
  if (
    process.env.VERCEL_OIDC_TOKEN ||
    (process.env.VERCEL_TOKEN && process.env.VERCEL_TEAM_ID && process.env.VERCEL_PROJECT_ID)
  ) {
    return 'vercel';
  }
  return undefined;
}

function createWorkspace(provider: Provider): RemoteShellWorkspace {
  const common = { root: 'project', timeout: 60_000 };
  switch (provider) {
    case 'e2b':
      return new E2BWorkspace({ ...common, lifetime: 10 * 60_000 });
    case 'daytona':
      return new DaytonaWorkspace({ ...common, autoStopInterval: 15 });
    case 'vercel':
      return new VercelSandboxWorkspace({
        ...common,
        image: 'vercel/sandbox/node:24',
        lifetime: 10 * 60_000,
      });
  }
}

async function main() {
  header('07 - Remote Workspace: files and commands in a cloud sandbox');

  const provider = chooseProvider();
  if (!provider) {
    console.log('  No sandbox provider is configured, so there is nothing to run.');
    console.log('  Set one of these and install its SDK next to @cogitator-ai/sandbox:');
    console.log('    E2B_API_KEY                                    (pnpm add e2b)');
    console.log('    DAYTONA_API_KEY                                (pnpm add @daytona/sdk)');
    console.log('    VERCEL_OIDC_TOKEN, or VERCEL_TOKEN + VERCEL_TEAM_ID + VERCEL_PROJECT_ID');
    console.log('                                                   (pnpm add @vercel/sandbox)');
    console.log('  REMOTE_WORKSPACE=e2b|daytona|vercel picks one when several are set.\n');
    return;
  }

  const workspace = createWorkspace(provider);
  try {
    section(`1. Start a ${provider} sandbox`);
    await workspace.start();
    console.log(`  sandbox: ${workspace.sandboxId}`);
    console.log(`  root:    ${workspace.root}`);

    section('2. Files and commands');
    await workspace.write('src/greet.sh', 'echo "hello from $(uname -s)"\n');
    const run = await workspace.exec('sh src/greet.sh && ls src', {
      onStdout: (chunk) => process.stdout.write(`  > ${chunk}`),
    });
    console.log(`  exit code ${run.exitCode} in ${run.durationMs} ms`);
    const files = await workspace.list('.', { recursive: true });
    console.log(`  files: ${files.map((entry) => entry.path).join(', ')}`);

    section('3. The root holds, even against a symlink a command made');
    await workspace.exec('ln -sf /etc escape');
    try {
      await workspace.read('escape/passwd');
    } catch (error) {
      if (WorkspaceError.is(error, 'OUTSIDE_ROOT')) console.log(`  refused: ${error.message}`);
    }
    await workspace.remove('escape');

    section('4. A timeout kills the whole process group');
    const slow = await workspace.exec('sleep 60 & sleep 61', { timeout: 2_000 });
    console.log(`  timed out: ${slow.timedOut}, exit code ${slow.exitCode}`);

    section('5. Snapshot and restore');
    const snapshot = await workspace.snapshot({ label: 'before the mess' });
    await workspace.exec('rm -r src && echo junk > junk.txt');
    console.log(
      `  after the mess: ${(await workspace.list()).map((entry) => entry.name).join(', ')}`
    );
    await workspace.restore(snapshot.id);
    console.log(
      `  restored:       ${(await workspace.list()).map((entry) => entry.name).join(', ')}`
    );
    await workspace.deleteSnapshot(snapshot.id);
  } finally {
    await workspace.dispose();
    console.log('\n  The sandbox is released.');
  }
}

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
