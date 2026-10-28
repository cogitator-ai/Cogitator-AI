import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { Agent } from '@cogitator-ai/core';
import { SessionHost, createAppServer } from '@cogitator-ai/app-server';
import {
  APP_SERVER_PROTOCOL_VERSION,
  AppServerClient,
  type AppServerClientTransport,
  type Turn,
} from '@cogitator-ai/app-server/client';
import { createCogitator, DEFAULT_MODEL, header } from '../_shared/setup.js';

/**
 * The transport of a client that spawned `cogitator app-server`: lines go to its stdin, lines
 * come from its stdout. Run with `--spawn` to use it instead of the host in this process. The
 * `cogitator` binary on the PATH runs, or the CLI script `COGITATOR_CLI` names
 */
function spawnedTransport(model: string): AppServerClientTransport {
  const script = process.env.COGITATOR_CLI;
  const [command, ...args] = script ? [process.execPath, script] : ['cogitator'];
  const child = spawn(command!, [...args, 'app-server', '-m', model], {
    stdio: ['pipe', 'pipe', 'inherit'],
  });
  const lines = createInterface({ input: child.stdout });
  return {
    send: (line) => child.stdin.write(`${line}\n`),
    onLine: (callback) => lines.on('line', callback),
    close: () => child.stdin.end(),
  };
}

/** The transport of a host in this process: the same protocol, without a child process */
function inProcessTransport(): AppServerClientTransport {
  const cogitator = createCogitator({ memory: { adapter: 'memory' } });
  const assistant = new Agent({
    name: 'assistant',
    model: DEFAULT_MODEL,
    instructions: 'You are a concise assistant. Answer in two sentences at most.',
  });
  const host = new SessionHost({ cogitator, agents: { assistant } });
  let deliver: (line: string) => void = () => undefined;
  const connection = createAppServer(host).connect((message) => {
    queueMicrotask(() => deliver(JSON.stringify(message)));
  });
  return {
    send: (line) => void connection.receive(JSON.parse(line)),
    onLine: (callback) => {
      deliver = callback;
    },
    close: () => {
      void connection.close().then(() => host.close());
    },
  };
}

async function main() {
  header('App-server client');
  const transport = process.argv.includes('--spawn')
    ? spawnedTransport(process.env.COGITATOR_MODEL ?? 'ollama/qwen3:8b')
    : inProcessTransport();
  const client = new AppServerClient(transport);

  const finished = new Map<string, (turn: Turn) => void>();
  client.on('turn/event', ({ event, parentToolCallId }) => {
    if (event.type === 'text-delta' && parentToolCallId === undefined) {
      process.stdout.write(event.delta);
    }
  });
  client.on('turn/completed', ({ turn }) => finished.get(turn.id)?.(turn));
  const completion = (turnId: string) =>
    new Promise<Turn>((resolve) => finished.set(turnId, resolve));

  const init = await client.initialize({
    protocolVersion: APP_SERVER_PROTOCOL_VERSION,
    clientInfo: { name: 'example-client', version: '1.0.0' },
    capabilities: { approvals: 'request' },
  });
  console.log(`Server ${init.serverInfo.name} ${init.serverInfo.version}`);
  console.log(`Agents: ${init.agents.map((agent) => agent.name).join(', ')}\n`);

  client.onRequest('approval/request', ({ toolCall }) => {
    console.log(`\nApproving ${toolCall.toolName}`);
    return { outcome: { outcome: 'selected', optionId: 'allow_once' } };
  });

  const { thread } = await client.threadStart();
  for (const question of [
    'What is a JSON-RPC notification?',
    'And how does it differ from a request?',
  ]) {
    console.log(`> ${question}`);
    const { turn } = await client.turnStart({
      threadId: thread.id,
      input: [{ type: 'text', text: question }],
    });
    const done = await completion(turn.id);
    console.log(
      `\n[${done.status}, ${done.usage?.totalTokens ?? 0} tokens]${done.error ? ` ${done.error.message}` : ''}\n`
    );
  }

  const { threads } = await client.threadList({ limit: 5 });
  console.log(`Threads: ${threads.map((t) => `${t.id} (${t.status})`).join(', ')}`);
  const resumed = await client.threadResume({ threadId: thread.id });
  console.log(`Thread ${thread.id} holds ${resumed.messages.length} messages`);
  client.close();
}

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
