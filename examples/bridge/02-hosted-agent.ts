import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  BridgeClient,
  callerFromEnv,
  cogitatorSessions,
  hostBridge,
  hostedAdapter,
  type JournalEntry,
} from '@cogitator-ai/bridge';
import { Agent } from '@cogitator-ai/core';
import { createCogitator, header } from '../_shared/setup.js';

const MODEL = process.env.EXAMPLE_MODEL ?? `ollama/${process.env.OLLAMA_MODEL ?? 'qwen2.5:0.5b'}`;

/**
 * An agent of the runtime takes jobs through the bridge. The bridge hosts it: a job addressed to
 * `reviewer` starts a session of the agent, the job's first letter is its turn, and its answer
 * is the job's report. Whoever handed the job over never waits, the report arrives as a letter.
 *
 * Here the one handing over is plain code that says it is a Claude Code session. In real use it
 * is a Claude Code or Codex window calling `cogitator bridge delegate reviewer "..."`, and the
 * host is the dispatcher of the machine with this adapter added.
 */
async function main() {
  header('Agent bridge: a job for an agent the bridge hosts');

  const base = process.platform !== 'win32' && existsSync('/tmp') ? '/tmp' : tmpdir();
  const bridgeDir = mkdtempSync(join(base, 'bridge-example-'));
  const cogitator = createCogitator({ memory: { adapter: 'memory' } });
  const reviewer = new Agent({
    name: 'reviewer',
    model: MODEL,
    instructions:
      'You review short pieces of code. The first line of a message says who sent it and for ' +
      'which job. Answer in two sentences: what is wrong, and how to fix it.',
  });

  const host = await hostBridge({
    home: bridgeDir,
    tickMs: 1_000,
    adapters: [
      hostedAdapter({
        harness: 'reviewer',
        steer: true,
        open: cogitatorSessions({ runtime: cogitator, agent: reviewer }),
        onError: (error) => console.error(`  bridge: ${error.message}`),
      }),
    ],
  });

  const orchestrator = await BridgeClient.connect({
    socketPath: host.paths.socket,
    caller: callerFromEnv({ CLAUDE_CODE_SESSION_ID: 'example-claude-session' }, process.cwd()),
  });
  const reported = new Promise<void>((resolve) => {
    void orchestrator.subscribe((entry: JournalEntry) => {
      if (entry.type === 'job.state' && entry.data?.to !== 'working') resolve();
    });
  });

  console.log(`1. ${orchestrator.agent?.name} hands a job to "reviewer" and gets its number`);
  const { job } = await orchestrator.createJob({
    to: 'reviewer',
    title: 'Review the retry loop',
    body: [
      'Review this function:',
      '',
      'async function retry(fn) {',
      '  for (let i = 0; i < 3; i++) {',
      '    try { return await fn(); } catch {}',
      '  }',
      '}',
    ].join('\n'),
    budget: { durationMs: 5 * 60_000 },
  });
  console.log(`   job #${job.number} is ${job.state}, with ${job.to} on ${MODEL}`);

  console.log('\n2. Nobody waits: the report arrives as a letter');
  await reported;
  const [report] = await orchestrator.inbox({ job: job.number });
  console.log(`   ${report!.text.split('\n')[0]}`);
  console.log(`   ${report!.body.replaceAll('\n', '\n   ')}`);
  console.log(`   job is ${(await orchestrator.job(job.number)).state}`);

  console.log('\n3. The session stays for the next job, on a thread of its own');
  const [session] = await orchestrator.agents({ harness: 'reviewer' });
  console.log(
    `   ${session!.name}, reached by "${session!.delivery}", takes a note in the middle of a turn: ${session!.capabilities.steer}`
  );

  await orchestrator.close();
  await host.close();
  await cogitator.close();
  rmSync(bridgeDir, { recursive: true, force: true });
}

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
