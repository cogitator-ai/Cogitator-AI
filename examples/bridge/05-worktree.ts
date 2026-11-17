import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BridgeClient, hostBridge, type BridgeAdapter } from '@cogitator-ai/bridge';
import { settingsRights } from '@cogitator-ai/bridge/rights';
import { header } from '../_shared/setup.js';

/**
 * A job in a git worktree of its own. The agent that hands the job over asks for a worktree and
 * names a check. The bridge makes the worktree, starts a session in it, reads what the session
 * changed when it reports, runs the check and hands the report over with the verdict. Then the
 * work is taken into the checkout of whoever handed the job over, staged and not committed.
 *
 * No model is called: the example plays the Claude Code session and the worker itself, in a
 * throwaway repository.
 */
async function main() {
  header('Agent bridge: a worktree of its own, checks, and taking the work');

  const base = process.platform !== 'win32' && existsSync('/tmp') ? '/tmp' : tmpdir();
  const bridgeDir = mkdtempSync(join(base, 'bridge-example-'));
  const project = realpathSync(mkdtempSync(join(base, 'bridge-project-')));
  const git = (...args: string[]) =>
    execFileSync('git', args, { cwd: project, encoding: 'utf8' }).trimEnd();
  git('init', '-q', '-b', 'main');
  git('config', 'user.name', 'Example');
  git('config', 'user.email', 'example@example.com');
  mkdirSync(join(project, '.claude'));
  writeFileSync(
    join(project, '.claude', 'settings.json'),
    JSON.stringify({ permissions: { allow: ['Bash(grep *)'] } })
  );
  writeFileSync(join(project, 'limiter.ts'), 'export const burst = 1;\n');
  writeFileSync(join(project, '.gitignore'), '.cogitator\n');
  git('add', '-A');
  git('commit', '-q', '-m', 'init');
  console.log('The rules of the project allow Bash(grep *): the check below is one\n');

  /** Starts a "session" for a job: the example plays it, so there is nothing to start */
  const started: string[] = [];
  const worker: BridgeAdapter = {
    harness: 'worker',
    delivery: 'example',
    capabilities: { createSession: true, push: false, steer: false, nativeWindow: false },
    createSession: async (request) => {
      started.push(request.cwd);
      return { sessionId: `worker-${started.length}` };
    },
  };
  const host = await hostBridge({
    home: bridgeDir,
    tickMs: 200,
    adapters: [worker],
    rights: settingsRights({ settings: { userDirs: [], managedDirs: [] } }),
  });
  const connect = (harness: string, sessionId: string) =>
    BridgeClient.connect({
      socketPath: host.paths.socket,
      caller: { harness, sessionId, cwd: project },
    });
  const claude = await connect('claude-code', 'example-claude-session');

  try {
    const { job } = await claude.createJob({
      to: 'worker',
      title: 'Raise the burst',
      body: 'Raise the burst limit in limiter.ts to 3.',
      worktree: true,
      checks: [{ name: 'the burst is 3', command: 'grep -q "burst = 3" limiter.ts' }],
    });
    console.log(`1. Claude hands job #${job.number} over, with a worktree and a check`);

    while (started.length === 0) await new Promise((resolve) => setTimeout(resolve, 20));
    const session = await connect('worker', 'worker-1');
    const [task] = await session.inbox();
    console.log(`\n2. The session the bridge started for it reads the job:\n`);
    console.log(indent(task.text));

    writeFileSync(join(started[0], 'limiter.ts'), 'export const burst = 3;\n');
    await session.send({ job: job.number, kind: 'report', body: 'The burst limit is 3 now.' });
    console.log('\n3. It changes the file in its worktree, commits nothing, and reports');

    let report = await claude.inbox();
    while (report.length === 0) {
      await new Promise((resolve) => setTimeout(resolve, 50));
      report = await claude.inbox();
    }
    console.log('\n4. Claude gets the report once the check has run:\n');
    console.log(indent(report[0].text));

    const seen = await claude.diff({ job: job.number });
    console.log(`\n5. The diff of the job:\n`);
    console.log(indent(seen.patch.trimEnd()));

    const taken = await claude.accept({ job: job.number });
    console.log(`\n6. Claude takes the work: ${taken.state}`);
    console.log(`   git status in the checkout: ${git('status', '--porcelain')}`);
    console.log(`   The worktree is gone: ${!existsSync(started[0])}`);
    console.log('   The commit is for Claude to make, with its own message.');

    await session.close();
  } finally {
    await claude.close();
    await host.close();
    rmSync(bridgeDir, { recursive: true, force: true });
    rmSync(project, { recursive: true, force: true });
  }
}

function indent(text: string): string {
  return text
    .split('\n')
    .map((line) => `     ${line}`)
    .join('\n');
}

main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
