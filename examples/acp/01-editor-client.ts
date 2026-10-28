import { spawn } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  client as createClientApp,
  type AgentApp,
  type ClientConnection,
} from '@agentclientprotocol/sdk';
import { Agent, workspaceTools } from '@cogitator-ai/core';
import { SessionHost } from '@cogitator-ai/app-server';
import { createAcpAgent, nodeNdJsonStream } from '@cogitator-ai/acp';
import { createCogitator, DEFAULT_MODEL, header } from '../_shared/setup.js';

/**
 * What an editor does with an ACP agent: initialize it, open a session in a directory, prompt it,
 * show its updates and answer its permission questions. The agent is a Cogitator agent in this
 * process, or `cogitator acp` launched as an editor launches it with `--spawn` (the `cogitator`
 * binary on the PATH, or the CLI script `COGITATOR_CLI` names)
 */
function connect(app: ReturnType<typeof createClientApp>): ClientConnection {
  if (!process.argv.includes('--spawn')) {
    const cogitator = createCogitator({ memory: { adapter: 'memory' }, permissions: {} });
    const coder = new Agent({
      name: 'coder',
      model: DEFAULT_MODEL,
      instructions: 'You are a careful coding agent. Keep answers short.',
      tools: workspaceTools(),
      todos: true,
    });
    const host = new SessionHost({ cogitator, agents: { coder } });
    const acp = createAcpAgent({
      host,
      cogitator,
      agentInfo: { name: 'example', version: '1.0.0' },
    });
    const agentApp: AgentApp = acp.app;
    return app.connect(agentApp);
  }
  const script = process.env.COGITATOR_CLI;
  const [command, ...args] = script ? [process.execPath, script] : ['cogitator'];
  const model = process.env.COGITATOR_MODEL ?? 'ollama/qwen3:8b';
  const child = spawn(command!, [...args, 'acp', '-m', model], {
    stdio: ['pipe', 'pipe', 'inherit'],
  });
  return app.connect(nodeNdJsonStream(child.stdin, child.stdout));
}

async function main() {
  header('An editor driving an ACP agent');
  const app = createClientApp({ name: 'example-editor' })
    .onNotification('session/update', ({ params }) => {
      const update = params.update;
      switch (update.sessionUpdate) {
        case 'agent_message_chunk':
          if (update.content.type === 'text') process.stdout.write(update.content.text);
          break;
        case 'tool_call':
          console.log(`\n[tool] ${update.title} (${update.kind ?? 'other'})`);
          break;
        case 'tool_call_update':
          if (update.status === 'completed' || update.status === 'failed') {
            console.log(`[tool] ${update.toolCallId} ${update.status}`);
          }
          break;
        case 'plan':
          console.log(
            `\n[plan] ${update.entries.map((entry) => `${entry.status}: ${entry.content}`).join(' | ')}`
          );
          break;
        case 'available_commands_update':
          console.log(
            `[commands] ${update.availableCommands.map((c) => `/${c.name}`).join(' ') || 'none'}`
          );
          break;
        default:
          break;
      }
    })
    .onRequest('session/request_permission', ({ params }) => {
      console.log(`\n[permission] ${params.toolCall.title}: allowing once`);
      const allow = params.options.find((option) => option.kind === 'allow_once');
      return allow
        ? { outcome: { outcome: 'selected', optionId: allow.optionId } }
        : { outcome: { outcome: 'cancelled' } };
    });
  const connection = connect(app);
  const agent = connection.agent;

  const init = await agent.request('initialize', {
    protocolVersion: 1,
    clientInfo: { name: 'example-editor', version: '1.0.0' },
  });
  console.log(`Agent ${init.agentInfo?.title ?? init.agentInfo?.name ?? 'unknown'}`);
  console.log(`Auth methods: ${(init.authMethods ?? []).map((method) => method.name).join(', ')}`);

  const cwd = mkdtempSync(join(tmpdir(), 'acp-example-'));
  const session = await agent.request('session/new', { cwd, mcpServers: [] });
  const options = session.configOptions ?? [];
  console.log(`Session ${session.sessionId} in ${cwd}`);
  console.log(`Options: ${options.map((option) => option.name).join(', ')}\n`);

  const response = await agent.request('session/prompt', {
    sessionId: session.sessionId,
    prompt: [
      {
        type: 'text',
        text: 'Write a file hello.txt that says hello, then tell me what you did in one sentence.',
      },
    ],
  });
  console.log(`\n\nStopped: ${response.stopReason}`);
  connection.close();
  process.exit(0);
}

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
