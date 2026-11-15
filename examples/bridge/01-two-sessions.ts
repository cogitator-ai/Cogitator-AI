import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  BridgeClient,
  callerFromEnv,
  hostBridge,
  type BridgeAdapter,
  type JournalEntry,
} from '@cogitator-ai/bridge';
import { header } from '../_shared/setup.js';

/**
 * Two sessions hand a job back and forth through the bridge. No model is called: the two
 * "sessions" are plain code, so the example shows the protocol itself. In real use one is a
 * Claude Code window and the other a Codex window, each calling the bridge with the session id
 * its harness put in the environment.
 *
 * The dispatcher runs in this process on a throwaway folder, so nothing on the machine changes.
 * Against the dispatcher of the machine it would be `cogitator bridge serve` and
 * `bridgePaths().socket`.
 */
async function main() {
  header('Agent bridge: a job between two sessions');

  const base = process.platform !== 'win32' && existsSync('/tmp') ? '/tmp' : tmpdir();
  const bridgeDir = mkdtempSync(join(base, 'bridge-example-'));
  const projectDir = process.cwd();

  /**
   * An adapter pushes letters into the sessions of its harness. This one only prints what a
   * real one would hand to the window of a "demo" session
   */
  const demoAdapter: BridgeAdapter = {
    harness: 'demo',
    delivery: 'print',
    capabilities: { createSession: false, push: true, steer: false, nativeWindow: false },
    deliver: async ({ agent, letter }) => {
      console.log(`\n  pushed to ${agent.name}:\n    ${letter.text.replaceAll('\n', '\n    ')}`);
    },
  };

  const host = await hostBridge({ home: bridgeDir, adapters: [demoAdapter], tickMs: 1_000 });
  const socketPath = host.paths.socket;

  const orchestrator = await BridgeClient.connect({
    socketPath,
    caller: callerFromEnv({ CLAUDE_CODE_SESSION_ID: 'example-claude-session' }, projectDir),
  });
  const worker = await BridgeClient.connect({
    socketPath,
    caller: callerFromEnv({ CODEX_THREAD_ID: 'example-codex-thread' }, projectDir),
  });
  const watcher = await BridgeClient.connect({
    socketPath,
    caller: { harness: 'demo', sessionId: 'example-watcher', cwd: projectDir },
  });
  console.log(
    `Sessions: ${orchestrator.agent?.name}, ${worker.agent?.name}, ${watcher.agent?.name}`
  );

  const journal: JournalEntry[] = [];
  await watcher.subscribe((entry) => journal.push(entry));

  console.log('\n1. The orchestrator hands a job over and gets its number at once');
  const { job } = await orchestrator.createJob({
    to: 'codex',
    body: 'Write the tests for the rate limiter. Cover the burst case.',
    checks: [{ command: 'pnpm test' }],
    budget: { letters: 20 },
  });
  console.log(`   job #${job.number} is ${job.state}, with ${job.to}`);

  console.log('\n2. The worker takes it from its inbox');
  const [task] = await worker.inbox();
  console.log(`   ${task!.text.split('\n')[0]}`);
  console.log(`   job is now ${(await worker.job(job.number)).state}`);

  console.log('\n3. The worker asks, the job waits');
  const question = await worker.send({
    job: job.number,
    kind: 'question',
    body: 'Mock Redis or run a real one?',
  });
  console.log(`   job is ${question.job.state}`);

  console.log('\n4. The orchestrator finds the question and answers');
  const [asked] = await orchestrator.inbox();
  console.log(`   "${asked!.body}"`);
  const answer = await orchestrator.send({ job: job.number, kind: 'answer', body: 'Mock it' });
  console.log(`   job is ${answer.job.state} again`);

  console.log('\n5. The same letter twice in a row is held back');
  await worker.inbox();
  await worker.send({ job: job.number, kind: 'note', body: 'Half way there' });
  try {
    await worker.send({ job: job.number, kind: 'note', body: 'Half way there' });
  } catch (error) {
    console.log(`   refused: ${error instanceof Error ? error.message : String(error)}`);
  }

  console.log('\n6. The worker reports, the orchestrator records what the checks showed');
  await worker.send({ job: job.number, kind: 'report', body: 'Done: 14 tests pass' });
  const verified = await orchestrator.recordVerification(job.number, {
    verified: true,
    summary: '14 of 14 pass',
  });
  console.log(`   job is ${verified.state}, verified: ${verified.verification?.verified}`);

  console.log('\n7. A job for a session whose harness has an adapter is pushed to it');
  const second = await orchestrator.createJob({ to: watcher.agent!.name, body: 'Review job 1' });
  await new Promise((resolve) => setTimeout(resolve, 200));
  await orchestrator.cancel(second.job.number, 'It was only a demonstration');
  await new Promise((resolve) => setTimeout(resolve, 200));

  console.log(`\nThe journal heard ${journal.length} entries. The letters of job #${job.number}:`);
  for (const entry of journal) {
    if (entry.type !== 'letter.queued' || entry.job !== job.number) continue;
    console.log(
      `   ${String(entry.data?.kind).padEnd(9)} ${entry.data?.from} -> ${entry.data?.to}`
    );
  }

  await Promise.all([orchestrator.close(), worker.close(), watcher.close()]);
  await host.close();
  rmSync(bridgeDir, { recursive: true, force: true });
}

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
