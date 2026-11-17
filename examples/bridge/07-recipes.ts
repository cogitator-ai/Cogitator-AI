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
import { FileCheckpointStore } from '@cogitator-ai/workflows';
import { header } from '../_shared/setup.js';

/**
 * A recipe of the bridge: do, check, review, fix. One call starts it, the bridge hands the steps
 * to the agents itself, and one report comes back. The reviewer is of another harness than the
 * author, and what it finds goes back to the author until the review is clean.
 *
 * No model is called: the example plays the Claude Code session that starts the recipe, the
 * Codex thread that does the work and the session that reviews it.
 */
async function main() {
  header('Agent bridge: a recipe (do, check, review, fix)');

  const base = process.platform !== 'win32' && existsSync('/tmp') ? '/tmp' : tmpdir();
  const bridgeDir = mkdtempSync(join(base, 'bridge-example-'));
  const project = realpathSync(mkdtempSync(join(base, 'bridge-project-')));
  mkdirSync(join(project, '.git'));

  const started: { agent: string; letter: RenderedLetter }[] = [];
  const mail: RenderedLetter[] = [];
  const starts = (harness: string): BridgeAdapter => ({
    harness,
    delivery: 'example',
    capabilities: { createSession: true, push: true, steer: false, nativeWindow: false },
    createSession: async (request) => {
      started.push({ agent: request.agentName, letter: request.firstLetter });
      return { sessionId: `${harness}-${started.length}`, deliveredFirstLetter: true };
    },
    deliver: async ({ letter }) => {
      mail.push(letter);
    },
  });

  const host = await hostBridge({
    home: bridgeDir,
    tickMs: 200,
    adapters: [
      starts('claude-code'),
      starts('codex'),
      recipeAdapter({
        checkpoints: new FileCheckpointStore(join(bridgeDir, 'recipes')),
        pollMs: 50,
      }),
    ],
  });
  const claude = await BridgeClient.connect({
    socketPath: host.paths.socket,
    caller: callerFromEnv({ CLAUDE_CODE_SESSION_ID: 'example-claude-session' }, project),
  });
  const as = (harness: string, session: number) =>
    BridgeClient.connect({
      socketPath: host.paths.socket,
      caller: { harness, sessionId: `${harness}-${session}`, cwd: project, project },
    });
  const next = async (count: number): Promise<{ agent: string; letter: RenderedLetter }> => {
    while (started.length < count) await new Promise((resolve) => setTimeout(resolve, 20));
    return started[count - 1];
  };
  const mailOf = async (job: number, kind: string): Promise<RenderedLetter> => {
    for (;;) {
      const found = mail.find((letter) => letter.job === job && letter.kind === kind);
      if (found) return found;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
  };

  try {
    const { job } = await claude.createJob({
      to: 'recipe',
      title: 'Rate limiter',
      body: 'Add a rate limiter to the gateway. Cover the burst case.',
      recipe: { name: 'build', input: { to: 'codex', worktree: false, rounds: 1 } },
    });
    console.log(`1. Claude starts the recipe "build" as job #${job.number}, and its turn ends\n`);

    const work = await next(1);
    console.log(`2. The bridge hands the work to ${work.agent} as job #${work.letter.job}`);
    const codex = await as('codex', 1);
    await codex.send({ job: work.letter.job, kind: 'report', body: 'The limiter is in' });

    const review = await next(2);
    console.log(`3. ${review.agent}, of another harness, gets the review:\n`);
    console.log(indent(review.letter.text.split('\n').slice(0, 2).join('\n')));
    const reviewer = await as('claude-code', 2);
    await reviewer.send({
      job: review.letter.job,
      kind: 'report',
      body: 'One thing has to change.',
      findings: [
        { severity: 'major', file: 'src/limiter.ts', line: 12, summary: 'The window never resets' },
        { severity: 'nit', summary: 'A name could be shorter' },
      ],
    });

    const fix = await mailOf(job.number + 3, 'task');
    console.log(`\n4. The author is sent back with what was found, as job #${fix.job}:\n`);
    console.log(indent(fix.text.split('\n').slice(1).join('\n')));
    await codex.send({ job: fix.job, kind: 'report', body: 'The window resets now' });

    const again = await mailOf(job.number + 4, 'task');
    console.log(`\n5. The reviewer looks again, as job #${again.job}, and finds nothing more`);
    await reviewer.send({ job: again.job, kind: 'report', body: 'Fixed.', findings: [] });

    const report = await mailOf(job.number, 'report');
    console.log('\n6. One report comes back to Claude:\n');
    console.log(indent(report.text));
    await Promise.all([codex.close(), reviewer.close()]);
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
