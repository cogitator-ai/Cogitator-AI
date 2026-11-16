import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  BridgeClient,
  callerFromEnv,
  hostBridge,
  isBridgeError,
  type PermissionAsk,
  type PersonRoute,
} from '@cogitator-ai/bridge';
import { settingsRights } from '@cogitator-ai/bridge/rights';
import { header } from '../_shared/setup.js';

/**
 * Leave for a call. An agent that carries a job out asks leave for three commands, and the
 * bridge decides whose answer each takes by the rules of the agent that handed the job over:
 * the permission settings of the project, the ones Claude Code obeys there.
 *
 * No model is called: the example plays the Claude Code session, the Codex thread and the
 * person itself. In real use the request comes from an agent the bridge hosts (its tool call
 * needed approval), and the person answers with `cogitator bridge allow` or in Telegram.
 */
async function main() {
  header('Agent bridge: leave for a call, and the person');

  const base = process.platform !== 'win32' && existsSync('/tmp') ? '/tmp' : tmpdir();
  const bridgeDir = mkdtempSync(join(base, 'bridge-example-'));
  const project = realpathSync(mkdtempSync(join(base, 'bridge-project-')));
  mkdirSync(join(project, '.git'));
  mkdirSync(join(project, '.claude'));
  writeFileSync(
    join(project, '.claude', 'settings.json'),
    JSON.stringify({ permissions: { allow: ['Bash(pnpm test *)'], deny: ['Bash(rm *)'] } })
  );
  console.log('The rules of the project: allow Bash(pnpm test *), deny Bash(rm *)\n');

  /** How this bridge reaches the person: it prints. `inboxRoute` and `channelRoute` are the real ones */
  const person: PersonRoute = {
    ask: ({ letter, job }) => {
      console.log(
        `     [to the person] ${letter.from} asks leave on job #${job.number}: ${letter.body}`
      );
    },
    settle: ({ letter }) => {
      console.log(`     [to the person] ${letter.id} waits no more`);
    },
  };
  const host = await hostBridge({
    home: bridgeDir,
    tickMs: 1_000,
    rights: settingsRights({ settings: { userDirs: [], managedDirs: [] } }),
    person,
  });

  const connect = (env: NodeJS.ProcessEnv) =>
    BridgeClient.connect({ socketPath: host.paths.socket, caller: callerFromEnv(env, project) });
  const claude = await connect({ CLAUDE_CODE_SESSION_ID: 'example-claude-session' });
  const codex = await connect({ CODEX_THREAD_ID: 'example-codex-thread' });
  const you = await BridgeClient.connect({ socketPath: host.paths.socket });

  const { job } = await claude.createJob({ to: 'codex', body: 'Ship the fix for the limiter' });
  await codex.inbox();

  const leaveFor = (command: string) => {
    const ask: PermissionAsk = { tool: 'Bash', access: 'command', command, cwd: project };
    return codex.send({ job: job.number, kind: 'permission', body: `Run: ${command}`, ask });
  };
  const verdictOf = async (letter: string) => {
    const decision = await codex.verdict({ letter, timeoutMs: 5_000 });
    return decision.state === 'decided'
      ? `${decision.verdict} by ${decision.by}: ${decision.reason}`
      : 'still waiting';
  };

  console.log("1. pnpm test --run: the rules allow it, so it is Claude's to decide");
  const tests = await leaveFor('pnpm test --run');
  const [shown] = await claude.inbox();
  console.log(`   Claude sees: ${shown.text.split('\n').at(-1)}`);
  await claude.send({ job: job.number, kind: 'answer', body: 'Go on', verdict: 'allow' });
  console.log(`   Codex gets:  ${await verdictOf(tests.letter.id)}`);

  console.log('\n2. rm -rf dist: the rules forbid it, nobody is asked');
  const removal = await leaveFor('rm -rf dist');
  console.log(`   Codex gets:  ${await verdictOf(removal.letter.id)}`);

  console.log('\n3. git push origin main: no rule, so only the person can allow it');
  const push = await leaveFor('git push origin main');
  try {
    await claude.send({ job: job.number, kind: 'answer', body: 'Fine', verdict: 'allow' });
  } catch (error) {
    if (!isBridgeError(error)) throw error;
    console.log(`   Claude tries to allow it: ${error.code}`);
  }
  const waiting = await you.forPerson();
  console.log(
    `   cogitator bridge asks shows ${waiting.length} letter, job #${waiting[0].job.number}`
  );
  await you.personAnswer({
    letter: push.letter.id,
    verdict: 'allow',
    body: 'The branch is reviewed',
  });
  console.log(`   Codex gets:  ${await verdictOf(push.letter.id)}`);

  console.log(`\nJob #${job.number} is ${(await claude.job(job.number)).state} again`);

  await Promise.all([claude.close(), codex.close(), you.close()]);
  await host.close();
  rmSync(bridgeDir, { recursive: true, force: true });
  rmSync(project, { recursive: true, force: true });
}

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
