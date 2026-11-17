import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BridgeClient, callerFromEnv, factLine, hostBridge } from '@cogitator-ai/bridge';
import { memoryBoard } from '@cogitator-ai/bridge/memory';
import { header } from '../_shared/setup.js';

/**
 * What a job is handed over with, and the board. Agents do not see each other's conversations:
 * the one that hands a job over names what it knows, the bridge adds the lines of the files it
 * points at and the notes of the project's board that fit, and what the job taught goes back to
 * the board for the next job like it.
 *
 * No model is called: the example plays the Claude Code session, the Codex thread and the
 * person itself.
 */
async function main() {
  header('Agent bridge: the handover of a job, and the board');

  const base = process.platform !== 'win32' && existsSync('/tmp') ? '/tmp' : tmpdir();
  const bridgeDir = mkdtempSync(join(base, 'bridge-example-'));
  const project = realpathSync(mkdtempSync(join(base, 'bridge-project-')));
  mkdirSync(join(project, '.git'));
  mkdirSync(join(project, 'src'));
  writeFileSync(
    join(project, 'src', 'limiter.ts'),
    ['export const limit = 10;', 'export const burst = 1;', 'export const windowMs = 1000;'].join(
      '\n'
    )
  );

  const board = await memoryBoard({ store: ':memory:' });
  const host = await hostBridge({ home: bridgeDir, tickMs: 200, board });
  const connect = (env: NodeJS.ProcessEnv) =>
    BridgeClient.connect({ socketPath: host.paths.socket, caller: callerFromEnv(env, project) });
  const claude = await connect({ CLAUDE_CODE_SESSION_ID: 'example-claude-session' });
  const codex = await connect({ CODEX_THREAD_ID: 'example-codex-thread' });
  const you = await BridgeClient.connect({ socketPath: host.paths.socket });

  try {
    await you.remember({
      text: 'The burst limit is a product decision: ask before raising it',
      project,
    });
    console.log('1. The person puts a note on the board of the project\n');

    const { job } = await claude.createJob({
      to: 'codex',
      title: 'Burst limit',
      body: 'Raise the burst limit of the limiter to 3.',
      context: {
        done: ['The burst test passes'],
        constraints: ['Do not touch the public API'],
        decisions: ['The limit stays per user'],
        files: [{ path: 'src/limiter.ts', lines: '2', why: 'the constant' }],
      },
    });
    const [task] = await codex.inbox();
    console.log(`2. Claude hands job #${job.number} over with its context. Codex reads:\n`);
    console.log(indent(task.text));

    await codex.remember({ text: 'The limiter reads its constants at start only' });
    await codex.send({
      job: job.number,
      kind: 'report',
      body: 'Raised the burst limit to 3, the tests pass.',
      lessons: ['Changing a constant of the limiter needs a restart of the worker'],
    });
    await host.dispatcher.idle();
    console.log('\n3. Codex notes a fact, and reports with what the job taught. The board now:\n');
    for (const fact of await claude.recall()) console.log(indent(`${fact.id}  ${factLine(fact)}`));

    await codex.inbox();
    const next = await claude.createJob({
      to: 'codex',
      body: 'Lower the burst limit of the limiter to 2.',
    });
    const [again] = await codex.inbox();
    console.log(
      `\n4. Job #${next.job.number} names no context, and still comes with what is known:\n`
    );
    console.log(indent(again.text));
  } finally {
    await Promise.all([claude.close(), codex.close(), you.close()]);
    await host.close();
    await board.close?.();
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
