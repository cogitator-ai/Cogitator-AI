import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs';
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
 * A debate through the bridge: one call puts a question to two agents, who answer each other
 * round by round until they agree, and a third sums it up. The bridge hands every turn over
 * itself, and one report comes back.
 *
 * No model is called: the example plays the Claude Code session that asks, the advocate, the
 * critic and the moderator.
 */
async function main() {
  header('Agent bridge: a debate of agents');

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

  const next = async (agent: string, after: number): Promise<(typeof tasks)[number]> => {
    for (;;) {
      const found = tasks.find((task) => task.agent === agent && task.letter.job > after);
      if (found) return found;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
  };

  try {
    const { job } = await claude.createJob({
      to: 'recipe',
      title: 'Where the limiter lives',
      body: 'Should the rate limiter live in the gateway or in each service?',
      recipe: {
        name: 'debate',
        input: {
          debaters: [
            { to: 'codex', role: 'advocate' },
            { to: 'claude', role: 'critic' },
          ],
          rounds: 3,
          moderator: 'codex',
        },
      },
    });
    console.log(`1. Claude starts the debate as job #${job.number}, and its turn ends\n`);

    const advocate = await turn(2);
    const critic = await turn(3);
    console.log(`2. Round 1: ${advocate.agent} argues for, ${critic.agent} against, each alone`);
    await say(advocate, 'In the gateway: one place, one policy for every route.\nSTANCE: disagree');
    await say(critic, 'In the gateway it becomes a bottleneck for all.\nSTANCE: disagree');

    const again = await next(advocate.agent, 3);
    const back = await next(critic.agent, 3);
    console.log('3. Round 2: each sees what the other said, and answers it:\n');
    console.log(indent(again.letter.text.split('\n').slice(6, 13).join('\n')));
    await say(
      again,
      'In the gateway, with a limit per route: no shared bottleneck.\nSTANCE: agree'
    );
    await say(back, 'A limit per route answers my point.\nSTANCE: agree');

    const moderator = await turn(6);
    console.log(`\n4. Both agree, so the debate ends, and ${moderator.agent} sums it up`);
    await say(moderator, 'Both end at the gateway, with a limit per route. Do that.');

    for (;;) {
      const report = mail.find((letter) => letter.job === job.number && letter.kind === 'report');
      if (report) {
        console.log('\n5. One report comes back to Claude:\n');
        console.log(indent(report.text));
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
