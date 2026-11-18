import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  BridgeClient,
  callerFromEnv,
  hostBridge,
  resultRow,
  suggestionLines,
  type BridgeAdapter,
  type Finding,
} from '@cogitator-ai/bridge';
import { header } from '../_shared/setup.js';

/**
 * The scoreboard of the bridge: every job that ends leaves a result, a review counts on the work
 * it reviewed, and from that the bridge says who a job of a type should go to. A job handed to
 * `auto` goes there, with the reason.
 *
 * No model is called: the example plays the Claude Code session that hands the jobs over, the
 * agents that do them and the reviewers.
 */
async function main() {
  header('Agent bridge: the scoreboard and auto');

  const base = process.platform !== 'win32' && existsSync('/tmp') ? '/tmp' : tmpdir();
  const bridgeDir = mkdtempSync(join(base, 'bridge-example-'));
  const project = realpathSync(mkdtempSync(join(base, 'bridge-project-')));
  mkdirSync(join(project, '.git'));

  const sessions = new Map<string, { harness: string; session: string }>();
  let started = 0;
  const starts = (harness: string): BridgeAdapter => ({
    harness,
    delivery: 'example',
    capabilities: { createSession: true, push: true, steer: false, nativeWindow: false },
    createSession: async (request) => {
      const session = `${harness}-${(started += 1)}`;
      sessions.set(request.agentName, { harness, session });
      return { sessionId: session, deliveredFirstLetter: true };
    },
    deliver: async () => undefined,
  });

  const host = await hostBridge({
    home: bridgeDir,
    tickMs: 200,
    adapters: [starts('claude-code'), starts('codex')],
    limits: { scoreMinJobs: 3 },
  });
  const claude = await BridgeClient.connect({
    socketPath: host.paths.socket,
    caller: callerFromEnv({ CLAUDE_CODE_SESSION_ID: 'example-claude-session' }, project),
  });

  /** Reports on a job as the session the bridge started for it. */
  const report = async (agent: string, job: number, body: string, findings?: Finding[]) => {
    for (;;) {
      const known = sessions.get(agent);
      if (known) {
        const client = await BridgeClient.connect({
          socketPath: host.paths.socket,
          caller: { harness: known.harness, sessionId: known.session, cwd: project, project },
        });
        await client.send({ job, kind: 'report', body, ...(findings && { findings }) });
        await client.close();
        return;
      }
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
  };

  /** A fix by a fresh session of `harness`, then a review of it that finds what `found` says. */
  const fixAndReview = async (harness: string, what: string, found: Finding[]) => {
    const work = await claude.createJob({ to: `${harness}:new`, body: what, type: 'fix' });
    await report(work.job.to, work.job.number, 'Fixed');
    const reviewer = harness === 'codex' ? 'claude:new' : 'codex:new';
    const review = await claude.createJob({
      to: reviewer,
      body: `Review the work of job #${work.job.number}`,
      type: 'review',
      reviewOf: work.job.number,
    });
    await report(review.job.to, review.job.number, 'Reviewed', found);
  };

  const major: Finding = { severity: 'major', summary: 'The fix breaks the burst case' };
  const nit: Finding = { severity: 'nit', summary: 'A name could be shorter' };

  try {
    console.log('1. With no job done yet, the bridge says it cannot tell the agents apart:\n');
    console.log(indent(suggestionLines(await claude.suggest({ type: 'fix' })).join('\n')));

    console.log('\n2. Claude hands out six fixes, three to each agent, and has each reviewed');
    await fixAndReview('codex', 'Fix the burst limit', []);
    await fixAndReview('codex', 'Fix the retry backoff', [nit]);
    await fixAndReview('codex', 'Fix the timeout of the health check', []);
    await fixAndReview('claude', 'Fix the cache key', [major]);
    await fixAndReview('claude', 'Fix the log rotation', []);
    await fixAndReview('claude', 'Fix the flaky upload test', [major, nit]);

    console.log('\n3. What became of the fixes, as the bridge keeps it:\n');
    const results = await claude.results({ type: 'fix' });
    console.log(indent(results.map(resultRow).join('\n')));

    console.log('\n4. Now the scoreboard has something to go by:\n');
    console.log(indent(suggestionLines(await claude.suggest({ type: 'fix' })).join('\n')));

    const { job, routed } = await claude.createJob({
      to: 'auto',
      body: 'Fix the limit of open sockets',
      type: 'fix',
    });
    console.log(`\n5. A fix handed to auto is job #${job.number}, with ${job.to}. Why:\n`);
    console.log(indent(routed ?? ''));
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
