import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { existsSync, mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import { BridgeClient, bridgePaths } from '@cogitator-ai/bridge';
import { installFakeHarnesses, type FakeHarnesses } from '@cogitator-ai/bridge/testing';

const CLI = fileURLToPath(new URL('../../../../cli/dist/index.js', import.meta.url));
const BRIDGE = `"${process.execPath}" "${CLI}" bridge`;
const posix = process.platform !== 'win32';

let fakes: FakeHarnesses;
let bridgeDir: string;
let project: string;
const children: ChildProcess[] = [];
const clients: BridgeClient[] = [];

function scratch(prefix: string): string {
  const base = posix && existsSync('/tmp') ? '/tmp' : tmpdir();
  return realpathSync(mkdtempSync(join(base, prefix)));
}

function env(extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  return {
    ...fakes.env({
      ...process.env,
      FORCE_COLOR: '0',
      NO_COLOR: '1',
      COGITATOR_BRIDGE_HOME: bridgeDir,
    }),
    ...extra,
  };
}

async function until<T>(
  read: () => Promise<T | undefined | false> | T | undefined | false,
  what: string,
  detail: () => string = () => ''
): Promise<T> {
  const deadline = Date.now() + 30_000;
  for (;;) {
    const value = await read();
    if (value !== undefined && value !== false) return value;
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${what}. ${detail()}`);
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

async function serve(): Promise<void> {
  const child = spawn(process.execPath, [CLI, 'bridge', 'serve'], { env: env() });
  children.push(child);
  let output = '';
  child.stdout?.on('data', (chunk: Buffer) => (output += chunk.toString()));
  child.stderr?.on('data', (chunk: Buffer) => (output += chunk.toString()));
  await until(
    () => output.includes('Bridge dispatcher running'),
    'the dispatcher to start',
    () => output
  );
}

function cli(args: string[]) {
  const result = spawnSync(process.execPath, [CLI, 'bridge', ...args], {
    env: env(),
    cwd: project,
    encoding: 'utf-8',
    timeout: 60_000,
    killSignal: 'SIGKILL',
  });
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}

async function connect(caller?: { harness: string; sessionId: string }): Promise<BridgeClient> {
  const client = await BridgeClient.connect({
    socketPath: bridgePaths({ home: bridgeDir }).socket,
    ...(caller && { caller: { ...caller, cwd: project, project } }),
  });
  clients.push(client);
  return client;
}

function tool(name: string, args: Record<string, unknown> = {}): string {
  return `tool: bridge.${name} ${JSON.stringify(args)}`;
}

interface ListedTool {
  name: string;
  inputSchema: { properties?: Record<string, unknown> };
  annotations?: Record<string, unknown>;
}

/** The server of tools as a harness starts it, spoken to in JSON-RPC by hand */
function startServer(serverEnv: NodeJS.ProcessEnv) {
  const child = spawn(process.execPath, [CLI, 'bridge', 'mcp', '--home', bridgeDir], {
    env: serverEnv,
    cwd: project,
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  children.push(child);
  const waiting = new Map<number, (message: Record<string, unknown>) => void>();
  const stray: string[] = [];
  createInterface({ input: child.stdout }).on('line', (line) => {
    let message: Record<string, unknown>;
    try {
      message = JSON.parse(line) as Record<string, unknown>;
    } catch {
      stray.push(line);
      return;
    }
    const resolve = typeof message.id === 'number' ? waiting.get(message.id) : undefined;
    if (resolve) {
      waiting.delete(message.id as number);
      resolve(message);
    }
  });
  let nextId = 0;
  const request = (method: string, params?: Record<string, unknown>) =>
    new Promise<Record<string, unknown>>((resolve, reject) => {
      const id = (nextId += 1);
      const timer = setTimeout(() => reject(new Error(`No answer to ${method}`)), 30_000);
      waiting.set(id, (message) => {
        clearTimeout(timer);
        resolve(message);
      });
      child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
    });
  return {
    child,
    stray,
    async initialize(clientName: string) {
      const hello = await request('initialize', {
        protocolVersion: '2025-06-18',
        capabilities: {},
        clientInfo: { name: clientName, version: '1.0.0' },
      });
      child.stdin.write(
        `${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' })}\n`
      );
      return hello.result as { instructions?: string; serverInfo: { name: string } };
    },
    async tools(): Promise<ListedTool[]> {
      const listed = await request('tools/list', {});
      return (listed.result as { tools: ListedTool[] }).tools;
    },
    async call(name: string, args: Record<string, unknown>, meta: Record<string, unknown> = {}) {
      const answered = await request('tools/call', { name, arguments: args, _meta: meta });
      const result = answered.result as {
        content: { type: string; text: string }[];
        isError?: boolean;
      };
      return {
        text: result.content.map((part) => part.text).join('\n'),
        isError: result.isError === true,
      };
    },
  };
}

beforeEach(() => {
  bridgeDir = scratch('cb-e2e-');
  project = scratch('cb-proj-');
  fakes = installFakeHarnesses({ env: { COGITATOR_BRIDGE_HOME: bridgeDir } });
});

afterEach(async () => {
  await Promise.all(clients.splice(0).map((client) => client.close().catch(() => undefined)));
  for (const child of children.splice(0)) {
    if (child.exitCode === null && child.signalCode === null) {
      const exited = new Promise((resolve) => child.once('exit', resolve));
      child.kill('SIGTERM');
      await exited;
    }
  }
  await fakes.cleanup();
  for (const folder of [bridgeDir, project]) rmSync(folder, { recursive: true, force: true });
});

describe.skipIf(!posix)('bridge mcp', () => {
  it('tells a client how the tools go together, and lists them as tools that destroy nothing', async () => {
    const server = startServer({ PATH: process.env.PATH, HOME: process.env.HOME });

    const hello = await server.initialize('codex-mcp-client');
    const tools = await server.tools();

    expect(hello.serverInfo.name).toBe('cogitator-bridge');
    expect(hello.instructions).toContain('delegate hands a job over');
    expect(hello.instructions).toContain('not the user');
    expect(tools.map((listed) => listed.name)).toEqual([
      'delegate',
      'ask',
      'answer',
      'report',
      'note',
      'inbox',
      'job',
      'jobs',
      'cancel',
      'agents',
    ]);
    for (const listed of tools) {
      expect(listed.annotations?.openWorldHint).toBe(false);
      expect(
        listed.annotations?.readOnlyHint === true || listed.annotations?.destructiveHint === false
      ).toBe(true);
      expect(Object.keys(listed.inputSchema.properties ?? {})).not.toContain('_bridge');
    }
    expect(server.stray).toEqual([]);
  });

  it('acts for the thread Codex names in a call, with nothing of it in its environment', async () => {
    await serve();
    const worker = await connect({ harness: 'claude-code', sessionId: 'session-worker' });
    const server = startServer({ PATH: process.env.PATH, HOME: process.env.HOME });
    await server.initialize('codex-mcp-client');
    const asThread = (thread: string) => ({
      threadId: thread,
      'x-codex-turn-metadata': { thread_id: thread, turn_id: 'turn-1' },
    });

    const handed = await server.call(
      'delegate',
      { to: worker.agent?.name, task: 'Review the diff' },
      asThread('thread-a')
    );
    expect(handed.isError, handed.text).toBe(false);
    expect(handed.text).toMatch(/^Job #1 is with claude@/);

    const other = await server.call('jobs', {}, asThread('thread-b'));
    expect(other.text).toBe('This session has no jobs in progress.');
    expect((await server.call('jobs', {}, asThread('thread-a'))).text).toContain('#1 ');

    const watcher = await connect();
    const threads = await watcher.agents({ harness: 'codex' });
    expect(threads.map((agent) => agent.sessionId).sort()).toEqual(['thread-a', 'thread-b']);
    expect((await watcher.job(1)).from).toBe(
      threads.find((agent) => agent.sessionId === 'thread-a')?.name
    );
  });

  it('says what to tell the user when it cannot tell the session, or no dispatcher runs', async () => {
    const server = startServer({ PATH: process.env.PATH, HOME: process.env.HOME });
    await server.initialize('some-client');

    const nobody = await server.call('jobs', {});
    expect(nobody.isError).toBe(true);
    expect(nobody.text).toContain('cannot tell which session is calling');

    const noDispatcher = await server.call(
      'jobs',
      {},
      { 'x-codex-turn-metadata': { thread_id: 'thread-a' } }
    );
    expect(noDispatcher.isError).toBe(true);
    expect(noDispatcher.text).toContain('cogitator bridge serve');

    await serve();
    const now = await server.call(
      'jobs',
      {},
      { 'x-codex-turn-metadata': { thread_id: 'thread-a' } }
    );
    expect(now).toEqual({ text: 'This session has no jobs in progress.', isError: false });
  });

  it('ends when the harness closes its input', async () => {
    const server = startServer({ PATH: process.env.PATH, HOME: process.env.HOME });
    await server.initialize('codex-mcp-client');
    const exited = new Promise<number | null>((resolve) => server.child.once('exit', resolve));

    server.child.stdin.end();

    expect(await exited).toBe(0);
  });
});

describe.skipIf(!posix)('the bridge tools from a sandbox', () => {
  it('reach the bridge for a Codex thread whose commands the sandbox keeps from it', async () => {
    expect(cli(['install', 'codex', '--yes']).status).toBe(0);
    await serve();
    await fakes.startCodexApp();
    const thread = await fakes.openCodexThread({ cwd: project, sandbox: 'workspace-write' });
    const conductor = await connect({ harness: 'conductor', sessionId: 'c-1' });

    await fakes.run(
      'codex',
      [
        'queue',
        '--thread',
        thread,
        '--message',
        `run: ${BRIDGE} inbox\n${tool('inbox')}`,
        '--resume',
      ],
      { env: env() }
    );
    const first = await fakes.waitForTurn('codex', thread, () => true);
    expect(first.ran[0].code).not.toBe(0);
    expect(first.ran[0].stderr).toContain('EPERM');
    expect(first.tools[0]).toMatchObject({
      isError: false,
      text: 'No letters wait for this session.',
    });

    const worker = await until(
      async () => (await conductor.agents({ harness: 'codex', statuses: ['active'] }))[0],
      'the thread to join the bridge through its tools'
    );
    expect(worker.sessionId).toBe(thread);
    await conductor.createJob({
      to: 'codex',
      body: `Write the tests\n${tool('report', { job: 1, result: 'Done from inside the sandbox' })}`,
    });

    const [report] = await until(async () => {
      const inbox = await conductor.inbox();
      return inbox.length > 0 ? inbox : undefined;
    }, 'the report of the sandboxed thread');
    expect(report).toMatchObject({
      kind: 'report',
      from: worker.name,
      body: 'Done from inside the sandbox',
    });
    expect((await conductor.job(1)).state).toBe('completed');
  });

  it('reach the bridge for a thread the bridge starts in a sandbox, whatever Codex has set up', async () => {
    await serve();
    const conductor = await connect({ harness: 'conductor', sessionId: 'c-1' });

    const { job } = await conductor.createJob({
      to: 'codex',
      body: [
        'Write the tests',
        `run: ${BRIDGE} send --job 1 --kind report "From the command line"`,
        tool('report', { job: 1, result: 'From the tool' }),
        'say: This is not the report',
      ].join('\n'),
    });

    const [report] = await until(async () => {
      const inbox = await conductor.inbox();
      return inbox.length > 0 ? inbox : undefined;
    }, 'the report of the thread');
    expect(report).toMatchObject({ kind: 'report', from: job.to, body: 'From the tool' });
    const [worker] = await conductor.agents({ harness: 'codex' });
    const [turn] = fakes.transcript('codex', worker.sessionId);
    expect(turn.ran[0].stderr).toContain('EPERM');
    expect(turn.input).toContain('Report on job #1 with the report tool of the bridge');
    expect((await fakes.run('codex', ['mcp', 'get', 'bridge'])).code).toBe(1);
  });
});
