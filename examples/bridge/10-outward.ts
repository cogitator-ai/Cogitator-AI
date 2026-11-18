import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { A2AServer } from '@cogitator-ai/a2a';
import { BridgeClient, hostBridge, type BridgeAdapter } from '@cogitator-ai/bridge';
import { bridgeAgents } from '@cogitator-ai/bridge/outward';
import { agentTools } from '@cogitator-ai/mcp';
import { header } from '../_shared/setup.js';

/**
 * The agents of a bridge, offered to the outside world: the same agents become an A2A service
 * and the tools of an MCP server. A message or a tool call from outside is a job of the bridge,
 * and the report of the agent is the answer.
 *
 * No model is called: the example plays the Codex thread that does the jobs.
 */
async function main() {
  header('Agent bridge: its agents as an A2A service and as MCP tools');

  const base = process.platform !== 'win32' && existsSync('/tmp') ? '/tmp' : tmpdir();
  const bridgeDir = mkdtempSync(join(base, 'bridge-example-'));
  const project = realpathSync(mkdtempSync(join(base, 'bridge-project-')));
  mkdirSync(join(project, '.git'));

  const started: { agent: string; session: string; job: number; text: string }[] = [];
  const codex: BridgeAdapter = {
    harness: 'codex',
    delivery: 'example',
    capabilities: { createSession: true, push: true, steer: false, nativeWindow: false },
    createSession: async (request) => {
      const session = `codex-${started.length + 1}`;
      started.push({
        agent: request.agentName,
        session,
        job: request.job.number,
        text: request.firstLetter.text,
      });
      return { sessionId: session, deliveredFirstLetter: true };
    },
    deliver: async () => undefined,
  };

  const host = await hostBridge({ home: bridgeDir, tickMs: 100, adapters: [codex] });
  const outward = await bridgeAgents({
    socketPath: host.paths.socket,
    project,
    agents: [{ to: 'codex:new', name: 'coder', description: 'Does a coding job in this project' }],
  });

  /** Reports on a job as the Codex thread the bridge started for it. */
  const report = async (job: number, body: string): Promise<void> => {
    for (;;) {
      const thread = started.find((one) => one.job === job);
      if (thread) {
        const client = await BridgeClient.connect({
          socketPath: host.paths.socket,
          caller: { harness: 'codex', sessionId: thread.session, cwd: project, project },
        });
        await client.send({ job, kind: 'report', body });
        await client.close();
        return;
      }
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
  };

  try {
    console.log(`1. The bridge offers: ${Object.keys(outward.agents).join(', ')}\n`);

    const a2a = new A2AServer({ agents: outward.agents, cogitator: outward.runtime });
    const sent = a2a.handleJsonRpc({
      jsonrpc: '2.0',
      id: 1,
      method: 'message/send',
      params: {
        message: {
          kind: 'message',
          role: 'user',
          messageId: 'm-1',
          parts: [{ kind: 'text', text: 'Say what the README of this project is for' }],
        },
      },
    });
    await report(1, 'It introduces the demo project.');
    const answered = (await sent) as { result?: { status?: { state?: string } } };
    console.log('2. An A2A client sends a message, which becomes job #1 of the bridge:');
    console.log(`     ${started[0].text.split('\n')[0]}`);
    console.log(
      `   The task ends ${answered.result?.status?.state}, with the report as its answer\n`
    );

    const [tool] = agentTools(outward.toolHost, Object.values(outward.agents));
    const called = tool.execute(
      { task: 'List the scripts of package.json' } as never,
      {
        signal: new AbortController().signal,
      } as never
    );
    await report(2, 'There is one script: test.');
    console.log(`3. An MCP client calls the tool "${tool.name}", which becomes job #2:`);
    console.log(`     ${JSON.stringify(await called)}`);
  } finally {
    await outward.close();
    await host.close();
    rmSync(bridgeDir, { recursive: true, force: true });
    rmSync(project, { recursive: true, force: true });
  }
}

main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
