import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { hostBridge, type BridgeAdapter } from '@cogitator-ai/bridge';
import { BRIDGE_INSTRUCTIONS, TOOL_CALL_HINT_KEY, bridgeTools } from '@cogitator-ai/bridge/tools';
import type { Tool } from '@cogitator-ai/types';
import { header } from '../_shared/setup.js';

/**
 * The bridge as tools of an agent: what `cogitator bridge mcp` serves to Claude Code and Codex.
 * No model is called and no harness is needed: the example calls the tools itself, the way each
 * harness would, to show how one set of tools serves many sessions.
 *
 * A server of tools does not know its session for good. Codex names the thread in `_meta` of
 * every call. Claude Code keeps one server across `/clear`, so a hook adds the session to the
 * arguments of the call. The tools read the caller from each call.
 */
async function main() {
  header('Agent bridge: the tools');

  const base = process.platform !== 'win32' && existsSync('/tmp') ? '/tmp' : tmpdir();
  const bridgeDir = mkdtempSync(join(base, 'bridge-example-'));

  const printing: BridgeAdapter = {
    harness: 'codex',
    delivery: 'print',
    capabilities: { createSession: false, push: true, steer: false, nativeWindow: true },
    deliver: async ({ agent, letter }) => {
      console.log(`     -> ${agent.name} gets: ${letter.text.split('\n')[0]}`);
    },
  };
  const host = await hostBridge({ home: bridgeDir, adapters: [printing], tickMs: 1_000 });

  /** The tools of one server process: what it knows of its session is its environment */
  const serverOf = (env: NodeJS.ProcessEnv): Tool[] =>
    bridgeTools({ socketPath: host.paths.socket, env, cwd: process.cwd() });

  /** One tool call: `meta` is what the client sends with it, `hint` what a hook adds */
  async function call(
    tools: Tool[],
    name: string,
    args: Record<string, unknown>,
    from: { meta?: Record<string, unknown>; hint?: { harness: string; session: string } } = {}
  ): Promise<string> {
    const tool = tools.find((candidate) => candidate.name === name);
    if (!tool) throw new Error(`No tool ${name}`);
    const parameters = tool.parameters as { parse(value: unknown): unknown };
    const parsed = parameters.parse(
      from.hint ? { ...args, [TOOL_CALL_HINT_KEY]: from.hint } : args
    );
    const context = {
      agentId: 'example',
      runId: 'example',
      signal: new AbortController().signal,
      request: { ...(from.meta && { meta: from.meta }), client: { name: 'codex-mcp-client' } },
    };
    return String(await tool.execute(parsed as never, context as never));
  }

  console.log(`What the server tells every client:\n\n${BRIDGE_INSTRUCTIONS}\n`);

  const claudeServer = serverOf({ CLAUDE_CODE_SESSION_ID: 'session-one' });
  const codexServer = serverOf({});
  const thread = { meta: { 'x-codex-turn-metadata': { thread_id: 'thread-one' } } };

  console.log('1. A Codex thread joins: Codex names it in the call, not in the environment');
  console.log(`   ${await call(codexServer, 'inbox', {}, thread)}`);

  console.log('\n2. A Claude Code session hands it a job and gets the number at once');
  const handed = await call(claudeServer, 'delegate', {
    to: 'codex',
    task: 'Write the tests for the rate limiter',
  });
  console.log(`   ${handed}`);
  const job = Number(/#(\d+)/.exec(handed)?.[1]);

  console.log('\n3. The thread asks, the session answers, the thread reports');
  console.log(`   ${await call(codexServer, 'ask', { job, question: 'Mock Redis?' }, thread)}`);
  console.log(`   ${await call(claudeServer, 'answer', { job, answer: 'Mock it' })}`);
  console.log(
    `   ${await call(codexServer, 'report', { job, result: '14 tests, all pass' }, thread)}`
  );

  console.log('\n4. After /clear the same server serves another session: a hook says which');
  const afterClear = { hint: { harness: 'claude-code', session: 'session-two' } };
  console.log(`   as the first session: ${await call(claudeServer, 'jobs', { all: true })}`);
  console.log(
    `   as the second one:    ${await call(claudeServer, 'jobs', { all: true }, afterClear)}`
  );

  console.log('\n5. Who can take a job');
  for (const line of (await call(claudeServer, 'agents', {})).split('\n')) {
    console.log(`   ${line}`);
  }

  await host.close();
  rmSync(bridgeDir, { recursive: true, force: true });
}

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
