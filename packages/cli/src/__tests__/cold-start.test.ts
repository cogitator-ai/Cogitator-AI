import { describe, it, expect, afterEach } from 'vitest';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { createServer, type Server } from 'node:http';
import { createRequire } from 'node:module';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { createInterface } from 'node:readline';
import { fileURLToPath, pathToFileURL } from 'node:url';

const require = createRequire(import.meta.url);
const HERE = dirname(fileURLToPath(import.meta.url));
const ENTRY = join(HERE, '../index.ts');
const TSX = pathToFileURL(require.resolve('tsx')).href;
const RECORDER = pathToFileURL(join(HERE, 'fixtures/loaded-modules.mjs')).href;
const RUNTIME = pathToFileURL(require.resolve('@cogitator-ai/core')).href;
const CHANNELS = pathToFileURL(require.resolve('@cogitator-ai/channels')).href;
const COMMANDS = pathToFileURL(join(HERE, '../commands')).href;

const dirs: string[] = [];
const servers: Server[] = [];
const children: ChildProcessWithoutNullStreams[] = [];

afterEach(async () => {
  for (const child of children.splice(0)) child.kill();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  await Promise.all(
    servers.splice(0).map((server) => new Promise((resolve) => server.close(resolve)))
  );
});

function scratch(): string {
  const base = process.platform !== 'win32' && existsSync('/tmp') ? '/tmp' : tmpdir();
  const dir = mkdtempSync(join(base, 'cg-cold-'));
  dirs.push(dir);
  return dir;
}

interface Started {
  child: ChildProcessWithoutNullStreams;
  /** The modules the process has loaded so far */
  loaded(): string[];
}

function start(args: string[]): Started {
  const record = join(scratch(), 'loaded.txt');
  const child = spawn(process.execPath, ['--import', TSX, '--import', RECORDER, ENTRY, ...args], {
    cwd: tmpdir(),
    env: { ...process.env, FORCE_COLOR: '0', COGITATOR_TEST_LOADED_MODULES: record },
  });
  children.push(child);
  return {
    child,
    loaded: () => (existsSync(record) ? readFileSync(record, 'utf-8').split('\n') : []),
  };
}

async function run(args: string[]): Promise<{ code: number | null; loaded: string[] }> {
  const { child, loaded } = start(args);
  child.stdout.resume();
  child.stderr.resume();
  const code = await new Promise<number | null>((resolve) => child.on('close', resolve));
  return { code, loaded: loaded() };
}

describe('what the binary loads', () => {
  it('is no command for the version', async () => {
    const { code, loaded } = await run(['--version']);

    expect(code).toBe(0);
    expect(loaded).toContain(pathToFileURL(ENTRY).href);
    expect(loaded.filter((url) => url.startsWith(COMMANDS))).toEqual([]);
  }, 60_000);

  it('is one command without the runtime for a command that runs no agent', async () => {
    const server = createServer((_req, res) => {
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ models: [] }));
    });
    servers.push(server);
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    const url = `http://127.0.0.1:${typeof address === 'object' && address ? address.port : 0}`;

    const { code, loaded } = await run(['models', '--json', '--url', url]);

    expect(code).toBe(0);
    expect(loaded.filter((each) => each.startsWith(COMMANDS))).toEqual([`${COMMANDS}/models.ts`]);
    expect(loaded).not.toContain(RUNTIME);
    expect(loaded).not.toContain(CHANNELS);
  }, 60_000);

  it('is the runtime only from the first tool call of the server of the bridge tools', async () => {
    const { child, loaded } = start(['bridge', 'mcp', '--home', scratch()]);
    child.stderr.resume();
    const answers = new Map<number, (message: Record<string, unknown>) => void>();
    createInterface({ input: child.stdout }).on('line', (line) => {
      const message = JSON.parse(line) as Record<string, unknown>;
      if (typeof message.id === 'number') answers.get(message.id)?.(message);
    });
    const send = (message: Record<string, unknown>): void => {
      child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', ...message })}\n`);
    };
    const request = (
      id: number,
      method: string,
      params: Record<string, unknown>
    ): Promise<Record<string, unknown>> =>
      new Promise((resolve) => {
        answers.set(id, resolve);
        send({ id, method, params });
      });

    const initialized = await request(1, 'initialize', {
      protocolVersion: '2025-06-18',
      capabilities: {},
      clientInfo: { name: 'cold-start', version: '0.0.0' },
    });
    send({ method: 'notifications/initialized' });
    const listed = await request(2, 'tools/list', {});

    expect(initialized.result).toMatchObject({ serverInfo: { name: 'cogitator-bridge' } });
    expect(listed.result).toMatchObject({ tools: expect.arrayContaining([expect.anything()]) });
    expect(loaded()).toContain(`${COMMANDS}/bridge-tools.ts`);
    expect(loaded()).not.toContain(RUNTIME);
    expect(loaded()).not.toContain(CHANNELS);

    const called = await request(3, 'tools/call', { name: 'inbox', arguments: {} });

    expect(called.result).toMatchObject({ content: [{ type: 'text' }] });
    expect(loaded()).toContain(RUNTIME);

    child.stdin.end();
    expect(await new Promise((resolve) => child.on('close', resolve))).toBe(0);
  }, 60_000);
});
