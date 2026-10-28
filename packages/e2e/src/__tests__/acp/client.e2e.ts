import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import { spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import { AcpAgentProvider } from '@cogitator-ai/acp';
import {
  APP_SERVER_PROTOCOL_VERSION,
  AppServerClient,
  type Turn,
} from '@cogitator-ai/app-server/client';
import { SessionHost, type AppServerNotification, type TurnInfo } from '@cogitator-ai/app-server';
import { Cogitator, LocalWorkspace } from '@cogitator-ai/core';

const CLI = fileURLToPath(new URL('../../../../cli/dist/index.js', import.meta.url));
const FAKE_AGENT = fileURLToPath(new URL('../../../fixtures/acp/fake-agent.mjs', import.meta.url));
const SCRATCH_ROOT = fileURLToPath(new URL('../../../.tmp-acp-client-e2e', import.meta.url));

async function until(predicate: () => boolean, what: string): Promise<void> {
  const deadline = Date.now() + 30_000;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

describe('external ACP agents as session providers (fake agent process)', () => {
  let workDir: string;
  let workspace: LocalWorkspace;

  beforeEach(async () => {
    mkdirSync(SCRATCH_ROOT, { recursive: true });
    workDir = realpathSync(mkdtempSync(join(SCRATCH_ROOT, 'run-')));
    workspace = new LocalWorkspace({ root: workDir });
    await workspace.start();
  });

  afterEach(async () => {
    await workspace.dispose();
    rmSync(workDir, { recursive: true, force: true });
  });

  afterAll(() => {
    rmSync(SCRATCH_ROOT, { recursive: true, force: true });
  });

  it('launches the agent, decides its permissions and serves its terminals and files', async () => {
    let stderr = '';
    const provider = new AcpAgentProvider({
      agent: { command: process.execPath, args: [FAKE_AGENT] },
      workspace,
      name: 'fake',
      authMethodId: 'fake',
      permissions: { rules: { allow: ['Bash(echo *)'], deny: ['Bash(rm *)'] } },
      onStderr: (chunk) => (stderr += chunk),
    });
    const host = new SessionHost({
      cogitator: new Cogitator({ memory: { adapter: 'memory' } }),
      agents: {},
      providers: { fake: provider },
      exposeErrors: true,
    });
    const notifications: AppServerNotification[] = [];
    host.subscribe((notification) => notifications.push(notification));
    const completed = async (turnId: string): Promise<TurnInfo> => {
      let found: TurnInfo | undefined;
      await until(() => {
        for (const n of notifications) {
          if (n.method === 'turn/completed' && n.params.turn.id === turnId) found = n.params.turn;
        }
        return found !== undefined;
      }, `turn ${turnId} (${stderr})`);
      return found!;
    };
    try {
      expect((await provider.connect()).agentInfo).toMatchObject({ name: 'fake-acp-agent' });
      const thread = await host.startThread({ agent: 'fake', permissionMode: 'acceptEdits' });
      const turn = await host.startTurn({
        threadId: thread.id,
        input: [
          {
            type: 'text',
            text: `speak hi; command echo from-terminal; command rm -rf build; write ${join(workDir, 'out.txt')}`,
          },
        ],
      });
      const done = await completed(turn.id);
      expect(done).toMatchObject({
        status: 'completed',
        output: 'hi ran:from-terminal refused wrote',
      });
      expect(readFileSync(join(workDir, 'out.txt'), 'utf8')).toBe('from the fake agent\n');
      const events = notifications.flatMap((n) =>
        n.method === 'turn/event' && n.params.turnId === turn.id ? [n.params.event] : []
      );
      expect(events.filter((event) => event.type === 'tool-result')).toHaveLength(2);

      const waiting = await host.startTurn({
        threadId: thread.id,
        input: [{ type: 'text', text: 'wait' }],
      });
      await new Promise((resolve) => setTimeout(resolve, 200));
      host.interruptTurn(thread.id, waiting.id);
      expect((await completed(waiting.id)).status).toBe('interrupted');
    } finally {
      await provider.close();
      await host.close();
    }
  });

  it('serves the agent to app-server clients next to the native one', async () => {
    const child = spawn(
      process.execPath,
      [
        CLI,
        'app-server',
        '-m',
        'ollama/fake-model',
        '--acp-agent',
        `fake=${process.execPath} ${FAKE_AGENT}`,
      ],
      {
        cwd: workDir,
        env: {
          ...process.env,
          HOME: workDir,
          COGITATOR_MODEL: '',
          COGITATOR_SESSIONS_DB: join(workDir, 'sessions.db'),
        },
      }
    );
    let stderr = '';
    child.stderr.on('data', (chunk: Buffer) => (stderr += chunk.toString()));
    const lines = createInterface({ input: child.stdout });
    const listeners: Array<(line: string) => void> = [];
    lines.on('line', (line) => listeners.forEach((listener) => listener(line)));
    const client = new AppServerClient({
      send: (line) => child.stdin.write(`${line}\n`),
      onLine: (callback) => listeners.push(callback),
      close: () => child.stdin.end(),
    });
    const done = new Map<string, Turn>();
    client.on('turn/completed', ({ turn }) => done.set(turn.id, turn));
    const asked: string[] = [];
    client.onRequest('approval/request', ({ toolCall }) => {
      asked.push(`${toolCall.toolName}:${JSON.stringify(toolCall.arguments)}`);
      return { outcome: { outcome: 'selected', optionId: 'allow_once' } };
    });
    const exited = new Promise<number | null>((resolve) =>
      child.on('exit', (code) => resolve(code))
    );
    const init = await client.initialize({
      protocolVersion: APP_SERVER_PROTOCOL_VERSION,
      clientInfo: { name: 'e2e', version: '1' },
      capabilities: { approvals: 'request' },
    });
    expect(init.agents).toEqual([
      { name: 'default', model: 'ollama/fake-model', default: true },
      expect.objectContaining({ name: 'fake', external: true, default: false }),
    ]);
    const { thread } = await client.threadStart({ agent: 'fake' });
    const { turn } = await client.turnStart({
      threadId: thread.id,
      input: [{ type: 'text', text: 'speak hello; command echo asked' }],
    });
    await until(() => done.has(turn.id), `the turn (${stderr})`);
    expect(done.get(turn.id)).toMatchObject({ status: 'completed', output: 'hello ran:asked' });
    expect(asked).toEqual(['run_command:{"command":"echo asked"}']);
    client.close();
    expect(await exited).toBe(0);
  });
});
