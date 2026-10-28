import { Agent, LocalWorkspace } from '@cogitator-ai/core';
import { SessionHost, type AppServerNotification } from '@cogitator-ai/app-server';
import {
  AcpAgentProvider,
  createAcpAgent,
  resolveAcpAgent,
  type AcpAgentTarget,
} from '@cogitator-ai/acp';
import { createCogitator, DEFAULT_MODEL, header } from '../_shared/setup.js';

/**
 * An external ACP agent as an agent of an app-server host, next to a native one: its turns
 * stream as stream events, and every permission it asks for is decided by the permission rules,
 * the rest asked of the client of the turn. `--agent claude` (or `codex`, `gemini`,
 * `registry:<id>`, a command line) launches that agent, which needs its own login. Without it,
 * a Cogitator agent served over ACP in this process plays the external agent
 */
async function target(spec: string | undefined): Promise<AcpAgentTarget> {
  if (spec) {
    const launch = await resolveAcpAgent(spec);
    return { command: launch.command, args: launch.args, ...(launch.env && { env: launch.env }) };
  }
  const cogitator = createCogitator({ memory: { adapter: 'memory' } });
  const helper = new Agent({
    name: 'helper',
    model: DEFAULT_MODEL,
    instructions: 'You are a concise helper. Answer in one sentence.',
  });
  const host = new SessionHost({ cogitator, agents: { helper } });
  return { app: createAcpAgent({ host, cogitator }).app };
}

async function main() {
  header('An external ACP agent in an app-server host');
  const at = process.argv.indexOf('--agent');
  const spec = at >= 0 ? process.argv[at + 1] : undefined;
  const workspace = new LocalWorkspace({ root: process.cwd() });
  const external = new AcpAgentProvider({
    agent: await target(spec),
    workspace,
    name: spec ?? 'helper',
    permissions: { rules: { allow: ['Read', 'Bash(git status *)'], deny: ['Bash(rm *)'] } },
  });

  const host = new SessionHost({
    cogitator: createCogitator({ memory: { adapter: 'memory' } }),
    agents: {
      native: new Agent({ name: 'native', model: DEFAULT_MODEL, instructions: 'Answer briefly.' }),
    },
    providers: { external },
  });
  console.log(
    host
      .agents()
      .map((agent) => `${agent.name}${agent.external ? ' (external)' : ''}`)
      .join(', ')
  );

  const done = new Promise<void>((resolve) => {
    host.subscribe((notification: AppServerNotification) => {
      if (notification.method === 'turn/event') {
        const event = notification.params.event;
        if (event.type === 'text-delta') process.stdout.write(event.delta);
        if (event.type === 'tool-call-start') console.log(`\n[tool] ${event.toolName}`);
      }
      if (notification.method === 'turn/completed') {
        console.log(`\n\nTurn ${notification.params.turn.status}`);
        resolve();
      }
    });
  });

  const thread = await host.startThread({ agent: 'external' });
  await host.startTurn(
    {
      threadId: thread.id,
      input: [{ type: 'text', text: 'What is the Agent Client Protocol for?' }],
    },
    {
      onApproval: async (ask) => {
        console.log(`\n[asked] ${ask.request.toolName}: ${ask.request.reason ?? ''}`);
        return { approved: false, reason: 'The example allows only what the rules allow' };
      },
    }
  );
  await done;
  await host.close();
  await external.close();
  await workspace.dispose();
}

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
