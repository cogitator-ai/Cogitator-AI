import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { createServer, type Server } from 'node:net';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  installFakeHarnesses,
  type FakeHarnesses,
  type FakeToolRun,
  type FakeTurn,
} from '../testing/fake-harnesses';

const PROBE = fileURLToPath(new URL('./fixtures/probe-server.mjs', import.meta.url));
const NEEDS_APPROVAL = 'MCP tool call requires approval, but approval policy is never';
const posix = process.platform !== 'win32';

/** What the probe server saw of a call, as it answers it */
interface Seen {
  tool: string;
  args: Record<string, unknown>;
  meta: Record<string, unknown>;
  cwd: string;
  env: string[];
  session?: string;
  mark?: string;
  wrote?: string;
}

let fakes: FakeHarnesses;
let work: string;
let outside: string;
const listening: Server[] = [];

function seenBy(run: FakeToolRun): Seen {
  expect(run.isError, run.text).toBe(false);
  return JSON.parse(run.text) as Seen;
}

function probe(env: Record<string, string> = {}): Record<string, unknown> {
  return { command: process.execPath, args: [PROBE], env };
}

/** `-c` overrides that give one `codex exec` the probe server, as the Codex adapter writes them */
function probeOverrides(env: Record<string, string> = {}): string[] {
  const table = Object.entries(env)
    .map(([name, value]) => `${name}=${JSON.stringify(value)}`)
    .join(',');
  return [
    '-c',
    `mcp_servers.probe.command=${JSON.stringify(process.execPath)}`,
    '-c',
    `mcp_servers.probe.args=[${JSON.stringify(PROBE)}]`,
    ...(table ? ['-c', `mcp_servers.probe.env={${table}}`] : []),
  ];
}

async function exec(args: string[], prompt: string): Promise<{ threadId: string; turn: FakeTurn }> {
  const result = await fakes.run('codex', ['exec', '--json', ...args, prompt], { cwd: work });
  expect(result).toMatchObject({ code: 0, stderr: '' });
  const { thread_id: threadId } = JSON.parse(result.stdout.split('\n')[0]) as {
    thread_id: string;
  };
  return { threadId, turn: fakes.transcript('codex', threadId)[0] };
}

const nodeRun = (script: string, ...args: string[]): string =>
  `run: ${process.execPath} -e ${JSON.stringify(script)} ${args.map((arg) => JSON.stringify(arg)).join(' ')}`;

const WRITE = "require('node:fs').writeFileSync(process.argv[1], 'written by a command')";
const CONNECT =
  "require('node:net').connect(process.argv[1]).on('connect', () => { console.log('connected'); process.exit(0); }).on('error', (error) => { console.log(error.code); process.exit(3); })";

function listen(): Promise<string> {
  const path = join(outside, 'bridge.sock');
  const server = createServer((socket) => socket.end());
  listening.push(server);
  return new Promise((resolve) => server.listen(path, () => resolve(path)));
}

beforeEach(() => {
  fakes = installFakeHarnesses();
  work = realpathSync(mkdtempSync(join(fakes.home, 'work-')));
  outside = realpathSync(mkdtempSync(join(posix ? '/tmp' : fakes.home, 'fo-')));
});

afterEach(async () => {
  await Promise.all(
    listening.splice(0).map((server) => new Promise((done) => server.close(() => done(undefined))))
  );
  await fakes.cleanup();
  rmSync(outside, { recursive: true, force: true });
});

describe.skipIf(!posix)('fake codex with MCP servers', () => {
  it('adds, shows, lists and removes a server the way codex mcp does', async () => {
    const add = () =>
      fakes.run('codex', [
        'mcp',
        'add',
        'bridge',
        '--env',
        'K=V',
        '--',
        'node',
        '/x/cli.js',
        'mcp',
      ]);
    expect(await add()).toEqual({
      code: 0,
      stdout: "Added global MCP server 'bridge'.\n",
      stderr: '',
    });
    expect((await add()).code).toBe(0);

    const got = await fakes.run('codex', ['mcp', 'get', 'bridge', '--json']);
    expect(JSON.parse(got.stdout)).toMatchObject({
      name: 'bridge',
      enabled: true,
      transport: { type: 'stdio', command: 'node', args: ['/x/cli.js', 'mcp'], env: { K: 'V' } },
    });
    const listed = await fakes.run('codex', ['mcp', 'list', '--json']);
    expect((JSON.parse(listed.stdout) as { name: string }[]).map(({ name }) => name)).toEqual([
      'bridge',
    ]);
    expect(await fakes.run('codex', ['mcp', 'get', 'nothing', '--json'])).toMatchObject({
      code: 1,
      stderr: "Error: No MCP server named 'nothing' found.\n",
    });

    expect((await fakes.run('codex', ['mcp', 'remove', 'bridge'])).stdout).toBe(
      "Removed global MCP server 'bridge'.\n"
    );
    expect(await fakes.run('codex', ['mcp', 'remove', 'bridge'])).toMatchObject({
      code: 0,
      stdout: "No MCP server named 'bridge' found.\n",
    });
    expect((await fakes.run('codex', ['mcp', 'get', 'bridge'])).code).toBe(1);
  });

  it('gives a server next to nothing of the environment, and names the thread in every call', async () => {
    const { threadId, turn } = await exec(
      probeOverrides({ PROBE_MARK: 'from the config' }),
      'tool: probe.safe {"note":"hi"}\nsay: called'
    );

    const seen = seenBy(turn.tools[0]);
    expect(turn.tools[0]).toMatchObject({ tool: 'probe.safe', args: { note: 'hi' } });
    expect(seen.args).toEqual({ note: 'hi' });
    expect(seen.cwd).toBe(work);
    expect(seen.mark).toBe('from the config');
    expect(seen.env).not.toContain('CODEX_THREAD_ID');
    expect(seen.env.filter((name) => name.startsWith('FAKE_'))).toEqual([]);
    expect(seen.env).toContain('PATH');
    expect(seen.meta).toMatchObject({
      threadId,
      sessionId: threadId,
      'x-codex-turn-metadata': { thread_id: threadId, sandbox_mode: 'read-only' },
    });
  });

  it('gives a thread the servers of mcp add, and lets an override replace one', async () => {
    await fakes.run('codex', [
      'mcp',
      'add',
      'probe',
      '--env',
      'PROBE_MARK=added',
      '--',
      process.execPath,
      PROBE,
    ]);

    const added = await exec([], 'tool: probe.safe');
    const overridden = await exec(probeOverrides({ PROBE_MARK: 'overridden' }), 'tool: probe.safe');

    expect(seenBy(added.turn.tools[0]).mark).toBe('added');
    expect(seenBy(overridden.turn.tools[0]).mark).toBe('overridden');
  });

  it('refuses a thread of exec a tool it would have to ask about, and a thread of the app not', async () => {
    const { turn } = await exec(probeOverrides(), 'tool: probe.whoami\ntool: probe.safe');
    expect(turn.tools[0]).toMatchObject({
      tool: 'probe.whoami',
      isError: true,
      text: NEEDS_APPROVAL,
    });
    expect(turn.tools[1].isError).toBe(false);

    await fakes.run('codex', ['mcp', 'add', 'probe', '--', process.execPath, PROBE]);
    await fakes.startCodexApp();
    const threadId = await fakes.openCodexThread({ cwd: work });
    await fakes.run('codex', ['queue', '--thread', threadId, '--message', 'tool: probe.whoami']);
    const asked = await fakes.waitForTurn('codex', threadId, () => true);
    expect(seenBy(asked.tools[0]).meta).toMatchObject({ threadId });
  });

  it('says so when a turn calls a tool that is not there', async () => {
    const { turn } = await exec(
      probeOverrides(),
      'tool: nothing.safe\ntool: probe.nothing\ntool: probe.safe {broken'
    );

    expect(turn.tools.map((run) => [run.isError, run.text])).toEqual([
      [true, "unknown MCP server 'nothing'"],
      [true, "unknown tool 'nothing' of 'probe'"],
      [true, 'not a tool call: expected <server>.<tool> {json}'],
    ]);
  });

  it('keeps the commands of a sandboxed thread from sockets and from writing outside its folder, and its servers from neither', async () => {
    const socket = await listen();
    const byServer = join(outside, 'by-server.txt');
    const { turn } = await exec(
      ['--sandbox', 'workspace-write', ...probeOverrides({ PROBE_WRITE: byServer })],
      [
        nodeRun(WRITE, join(work, 'inside.txt')),
        nodeRun(WRITE, join(outside, 'by-command.txt')),
        nodeRun(CONNECT, socket),
        'tool: probe.safe',
      ].join('\n')
    );

    expect(turn.ran.map((run) => run.code)).toEqual([0, 1, 3]);
    expect(existsSync(join(work, 'inside.txt'))).toBe(true);
    expect(existsSync(join(outside, 'by-command.txt'))).toBe(false);
    expect(turn.ran[1].stderr).toContain('EPERM');
    expect(turn.ran[2].stdout).toBe('EPERM\n');
    expect(seenBy(turn.tools[0]).wrote).toBe(byServer);
    expect(readFileSync(byServer, 'utf8')).toBe('written by the server');
  });

  it('lets a read-only thread write nowhere, and a thread without a sandbox anywhere', async () => {
    const socket = await listen();
    const script = [
      nodeRun(WRITE, join(work, 'inside.txt')),
      nodeRun(WRITE, join(outside, 'by-command.txt')),
      nodeRun(CONNECT, socket),
    ].join('\n');

    const readOnly = await exec(['--sandbox', 'read-only'], script);
    expect(readOnly.turn.ran.map((run) => run.code)).toEqual([1, 1, 3]);
    expect(existsSync(join(work, 'inside.txt'))).toBe(false);

    const free = await exec(['--sandbox', 'danger-full-access'], script);
    expect(free.turn.ran.map((run) => run.code)).toEqual([0, 0, 0]);
    expect(free.turn.ran[2].stdout).toBe('connected\n');
  });

  it('sandboxes a thread a person opened in a sandbox mode', async () => {
    const socket = await listen();
    await fakes.startCodexApp();
    const threadId = await fakes.openCodexThread({ cwd: work, sandbox: 'workspace-write' });

    await fakes.run('codex', [
      'queue',
      '--thread',
      threadId,
      '--message',
      nodeRun(CONNECT, socket),
    ]);

    const turn = await fakes.waitForTurn('codex', threadId, () => true);
    expect(turn.ran[0].stdout).toBe('EPERM\n');
  });
});

describe.skipIf(!posix)('fake claude with MCP servers', () => {
  const window = (options: { settings?: unknown; mcpConfig?: unknown } = {}): Promise<string> =>
    fakes.openClaudeWindow({ cwd: work, ...options });

  async function turnOf(sessionId: string, text: string): Promise<FakeTurn> {
    const seen = fakes.transcript('claude', sessionId).length;
    await fakes.say(sessionId, text);
    return fakes.waitForTurn('claude', sessionId, (turn) => turn.turn > seen);
  }

  const hookFile = (name: string, script: string): string => {
    const file = join(work, name);
    mkdirSync(work, { recursive: true });
    writeFileSync(file, script);
    return `${process.execPath} ${JSON.stringify(file)}`;
  };

  it('adds a server in each scope, finds it, and removes it the way claude mcp does', async () => {
    const run = (...args: string[]) => fakes.run('claude', ['mcp', ...args], { cwd: work });

    expect(
      await run('add', '--scope', 'local', 'bridge', '-e', 'K=V', '--', 'node', '/x/cli.js')
    ).toEqual({
      code: 0,
      stdout: 'Added stdio MCP server bridge with command: node /x/cli.js to local config\n',
      stderr: '',
    });
    expect(await run('add', 'bridge', '--', 'node', '/x/cli.js')).toMatchObject({
      code: 1,
      stderr: 'MCP server bridge already exists in local config\n',
    });
    const config = JSON.parse(
      readFileSync(join(fakes.home, 'claude-config', '.claude.json'), 'utf8')
    ) as {
      projects: Record<string, { mcpServers: Record<string, unknown> }>;
    };
    expect(config.projects[work].mcpServers.bridge).toEqual({
      type: 'stdio',
      command: 'node',
      args: ['/x/cli.js'],
      env: { K: 'V' },
    });

    expect((await run('get', 'bridge')).stdout).toContain('Scope: local');
    expect(await run('remove', 'bridge', '--scope', 'user')).toMatchObject({
      code: 1,
      stderr: 'No MCP server named "bridge" in user scope\n',
    });
    expect((await run('remove', 'bridge', '-s', 'local')).stdout).toBe(
      'Removed MCP server bridge from local config\n'
    );
    expect((await run('get', 'bridge')).code).toBe(1);

    expect((await run('add', '-s', 'project', 'shared', '--', 'node', '/y.js')).code).toBe(0);
    expect(JSON.parse(readFileSync(join(work, '.mcp.json'), 'utf8'))).toEqual({
      mcpServers: { shared: { type: 'stdio', command: 'node', args: ['/y.js'], env: {} } },
    });
    expect((await run('add', '-s', 'user', 'mine', '--', 'node', '/z.js')).code).toBe(0);
    expect((await run('remove', 'mine')).stdout).toBe('Removed MCP server mine from user config\n');
  });

  it('starts a server with the environment of the session and the id it has then', async () => {
    const sessionId = await window({
      mcpConfig: { mcpServers: { probe: probe({ PROBE_MARK: 'cfg' }) } },
    });

    const turn = await turnOf(sessionId, 'tool: probe.whoami {"note":"hi"}');

    const seen = seenBy(turn.tools[0]);
    expect(seen.session).toBe(sessionId);
    expect(seen.env).toEqual(
      expect.arrayContaining(['CLAUDE_CODE_SESSION_ID', 'CLAUDE_PROJECT_DIR'])
    );
    expect(seen.mark).toBe('cfg');
    expect(seen.cwd).toBe(work);
    expect(seen.args).toEqual({ note: 'hi' });
    expect(seen.meta['claudecode/toolUseId']).toMatch(/^toolu_/);
    expect(turn.tools[0].sent).toBeUndefined();
  });

  it('gives a session the servers added for its folder in every scope', async () => {
    const run = (...args: string[]) => fakes.run('claude', ['mcp', ...args], { cwd: work });
    await run(
      'add',
      '-s',
      'local',
      'mine',
      '-e',
      'PROBE_MARK=local',
      '--',
      process.execPath,
      PROBE
    );
    await run(
      'add',
      '-s',
      'project',
      'ours',
      '-e',
      'PROBE_MARK=project',
      '--',
      process.execPath,
      PROBE
    );
    await run('add', '-s', 'user', 'all', '-e', 'PROBE_MARK=user', '--', process.execPath, PROBE);
    const sessionId = await window();

    const turn = await turnOf(
      sessionId,
      'tool: mine.safe\ntool: ours.safe\ntool: all.safe\ntool: none.safe'
    );

    expect(turn.tools.slice(0, 3).map((run) => seenBy(run).mark)).toEqual([
      'local',
      'project',
      'user',
    ]);
    expect(turn.tools[3]).toMatchObject({ isError: true, text: 'No MCP server named "none"' });
  });

  it('lets a PreToolUse hook that matches the tool change its arguments', async () => {
    const adds = hookFile(
      'adds.cjs',
      "let text = ''; process.stdin.on('data', (chunk) => (text += chunk)).on('end', () => { const input = JSON.parse(text); process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: 'PreToolUse', updatedInput: { ...input.tool_input, _bridge: { session: input.session_id, tool: input.tool_name, id: input.tool_use_id } } } })); });"
    );
    const other = hookFile('other.cjs', "require('node:fs').writeFileSync('other-ran', '1');");
    const sessionId = await window({
      mcpConfig: { mcpServers: { probe: probe() } },
      settings: {
        hooks: {
          PreToolUse: [
            { matcher: 'mcp__probe__.*', hooks: [{ type: 'command', command: adds }] },
            { matcher: 'mcp__bridge__.*', hooks: [{ type: 'command', command: other }] },
          ],
        },
      },
    });

    const turn = await turnOf(sessionId, 'tool: probe.whoami {"note":"hi"}');

    const seen = seenBy(turn.tools[0]);
    expect(turn.tools[0].args).toEqual({ note: 'hi' });
    expect(seen.args).toEqual({
      note: 'hi',
      _bridge: {
        session: sessionId,
        tool: 'mcp__probe__whoami',
        id: seen.meta['claudecode/toolUseId'],
      },
    });
    expect(turn.tools[0].sent).toEqual(seen.args);
    expect(existsSync(join(work, 'other-ran'))).toBe(false);
  });

  it('does not call a tool a PreToolUse hook blocks, and goes on when a hook fails', async () => {
    const blocks = hookFile('blocks.cjs', "process.stderr.write('not this one'); process.exit(2);");
    const fails = hookFile('fails.cjs', 'process.exit(1);');
    const sessionId = await window({
      mcpConfig: { mcpServers: { probe: probe() } },
      settings: {
        hooks: {
          PreToolUse: [
            { matcher: 'mcp__probe__whoami', hooks: [{ type: 'command', command: blocks }] },
            { matcher: 'mcp__probe__safe', hooks: [{ type: 'command', command: fails }] },
          ],
        },
      },
    });

    const turn = await turnOf(sessionId, 'tool: probe.whoami\ntool: probe.safe {"note":"kept"}');

    expect(turn.tools[0]).toMatchObject({ isError: true, text: 'not this one' });
    expect(seenBy(turn.tools[1]).args).toEqual({ note: 'kept' });
  });

  it('lets a background session call only the tools its settings allow', async () => {
    fakes.trustFolder(work);
    const start = async (settings: unknown): Promise<FakeTurn> => {
      const result = await fakes.run(
        'claude',
        [
          '--bg',
          '--settings',
          JSON.stringify(settings),
          '--mcp-config',
          JSON.stringify({ mcpServers: { probe: probe() } }),
          'tool: probe.whoami',
        ],
        { cwd: work }
      );
      expect(result).toMatchObject({ code: 0, stderr: '' });
      const [session] = (await fakes.claudeSessions()).slice(-1);
      return fakes.waitForTurn('claude', session.sessionId, () => true);
    };

    const refused = await start({});
    expect(refused.tools[0]).toMatchObject({
      isError: true,
      text: "Claude requested permissions to use mcp__probe__whoami, but you haven't granted it yet.",
    });

    const allowed = await start({ permissions: { allow: ['mcp__probe'] } });
    expect(allowed.tools[0].isError).toBe(false);
  });

  it('refuses --mcp-config that is not JSON', async () => {
    const result = await fakes.run('claude', ['__open', '--mcp-config', '{broken'], { cwd: work });

    expect(result.code).toBe(1);
    expect(result.stderr).toContain('cannot load --mcp-config');
  });
});
