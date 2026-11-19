import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  BridgeClient,
  callerFromEnv,
  hostBridge,
  type BridgeAdapter,
  type RenderedLetter,
} from '@cogitator-ai/bridge';
import { recipeAdapter } from '@cogitator-ai/bridge/recipes';
import { header } from '../_shared/setup.js';

/**
 * A plan through the bridge: one call has two agents plan the same work apart, read the plan of
 * each other, and settle on one plan. The first merges, the other signs the plan or objects to
 * it. The bridge hands every step over itself and keeps what the planners write as files, and
 * one report comes back.
 *
 * No model is called: the example plays the Claude Code session that asks and both planners.
 */
async function main() {
  header('Agent bridge: a plan of two agents');

  const base = process.platform !== 'win32' && existsSync('/tmp') ? '/tmp' : tmpdir();
  const bridgeDir = mkdtempSync(join(base, 'bridge-example-'));
  const project = realpathSync(mkdtempSync(join(base, 'bridge-project-')));
  mkdirSync(join(project, '.git'));

  const tasks: { agent: string; session: string; letter: RenderedLetter }[] = [];
  const mail: RenderedLetter[] = [];
  let sessions = 0;
  const starts = (harness: string): BridgeAdapter => ({
    harness,
    delivery: 'example',
    capabilities: { createSession: true, push: true, steer: false, nativeWindow: false },
    createSession: async (request) => {
      const session = `${harness}-${(sessions += 1)}`;
      tasks.push({ agent: request.agentName, session, letter: request.firstLetter });
      return { sessionId: session, deliveredFirstLetter: true };
    },
    deliver: async ({ agent, letter }) => {
      if (letter.kind === 'task')
        tasks.push({ agent: agent.name, session: agent.sessionId, letter });
      else mail.push(letter);
    },
  });

  const host = await hostBridge({
    home: bridgeDir,
    tickMs: 200,
    adapters: [starts('claude-code'), starts('codex'), recipeAdapter({ pollMs: 50 })],
  });
  const claude = await BridgeClient.connect({
    socketPath: host.paths.socket,
    caller: callerFromEnv({ CLAUDE_CODE_SESSION_ID: 'example-claude-session' }, project),
  });
  const clients: BridgeClient[] = [];
  const say = async (task: (typeof tasks)[number], body: string): Promise<void> => {
    const harness = task.session.startsWith('codex') ? 'codex' : 'claude-code';
    const client = await BridgeClient.connect({
      socketPath: host.paths.socket,
      caller: { harness, sessionId: task.session, cwd: project, project },
    });
    clients.push(client);
    await client.send({ job: task.letter.job, kind: 'report', body });
  };
  const turn = async (job: number): Promise<(typeof tasks)[number]> => {
    for (;;) {
      const found = tasks.find((task) => task.letter.job === job);
      if (found) return found;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
  };

  const folder = join(project, '.cogitator', 'plans', 'job-1');

  try {
    const { job } = await claude.createJob({
      to: 'recipe',
      title: 'A rate limiter for the gateway',
      body: 'Plan a rate limiter for the gateway: where it lives, what it counts, how it is tested.',
      recipe: {
        name: 'plan',
        input: { planners: ['codex', 'claude'], rounds: 2, out: 'docs/limiter-plan.md' },
      },
    });
    console.log(`1. Claude starts the plan as job #${job.number}, and its turn ends\n`);

    const first = await turn(2);
    const second = await turn(3);
    console.log(
      `2. ${first.agent} and ${second.agent} each write a plan, neither sees the other's`
    );
    await say(first, '## Goal\nA token bucket per route, kept in the gateway process.');
    console.log(`   One plan is in. On disk so far: ${existsSync(folder) ? 'a draft' : 'nothing'}`);
    await say(second, '## Goal\nA sliding window per client, kept in Redis.');

    const critique = await turn(4);
    const other = await turn(5);
    console.log('\n3. Both plans are files now, and each planner reads the other one:\n');
    const lines = critique.letter.text.split('\n');
    const at = lines.indexOf('The plan to read:');
    console.log(indent(lines.slice(at, at + 2).join('\n')));
    await say(critique, '1. take: Redis survives a restart of the gateway, my bucket does not');
    await say(other, '1. fault: per client alone lets one route starve the others');

    const merge = await turn(6);
    console.log(`\n4. ${merge.agent} merges both plans and both critiques into one`);
    writeFileSync(
      join(folder, 'plan.md'),
      '## Goal\nA sliding window per client and per route, kept in Redis.\n'
    );
    writeFileSync(join(folder, 'decisions.md'), '1. taken: Redis\n2. taken: per route too\n');
    await say(merge, 'Both files are written');

    const check = await turn(7);
    console.log(`5. ${check.agent} reads the joint plan, and objects`);
    await say(
      check,
      'OBJECTION: Checks - nothing shows the limit holds across two gateways\nVERDICT: objections'
    );

    const revise = await turn(8);
    console.log(`6. ${revise.agent} answers the objection in the plan`);
    writeFileSync(
      join(folder, 'plan.md'),
      '## Goal\nA sliding window per client and per route, kept in Redis.\n\n## Checks\nA test runs two gateways against one Redis.\n'
    );
    await say(revise, 'Taken: a test with two gateways');

    const again = await turn(9);
    console.log(`7. ${again.agent} reads it again, and signs`);
    await say(again, 'It holds now.\nVERDICT: signed');

    for (;;) {
      const report = mail.find((letter) => letter.job === job.number && letter.kind === 'report');
      if (report) {
        console.log('\n8. One report comes back to Claude:\n');
        console.log(indent(report.text));
        console.log('\n9. The plan, where Claude asked for a copy:\n');
        console.log(indent(readFileSync(join(project, 'docs', 'limiter-plan.md'), 'utf8')));
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
  } finally {
    await Promise.all([claude.close(), ...clients.map((client) => client.close())]);
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
