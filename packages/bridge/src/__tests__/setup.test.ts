import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { claudeCodeAdapter } from '../adapters/claude';
import { CommandMissingError } from '../adapters/exec';
import type { ToolsServerCommand } from '../adapters/tools-server';
import { BridgeClient } from '../client';
import { hostBridge, type BridgeHost } from '../host';
import { bridgePaths } from '../paths';
import { claudeSetup, withBridgeSettings, withoutBridgeSettings } from '../setup/claude';
import { codexSetup } from '../setup/codex';
import type { InstallContext, SetupStep } from '../setup/setup';
import { installFakeHarnesses, type FakeHarnesses } from '../testing/fake-harnesses';
import { BRIDGE_NOTES_END, BRIDGE_NOTES_START, bridgeNotes } from '../tools/guidance';
import {
  claudeLimitHook,
  claudeStuckHook,
  claudeToolsHook,
  claudeWaitHook,
} from '../adapters/claude';
import { socketDir } from './helpers';

const TSX = pathToFileURL(createRequire(import.meta.url).resolve('tsx')).href;
const WAIT = fileURLToPath(new URL('./fixtures/wait.ts', import.meta.url));
const TOOLS_SERVER = fileURLToPath(new URL('./fixtures/tools-server.ts', import.meta.url));
const BRIDGE_COMMAND = `${process.execPath} --import ${TSX} ${WAIT} bridge`;
const posix = process.platform !== 'win32';

let fakes: FakeHarnesses;
let home: string;
let project: string;
const folders: (() => void)[] = [];
const hosts: BridgeHost[] = [];
const clients: BridgeClient[] = [];

function folder(): string {
  const made = socketDir();
  folders.push(made.remove);
  return realpathSync(made.dir);
}

const env = (): NodeJS.ProcessEnv => fakes.env({ ...process.env, COGITATOR_BRIDGE_HOME: home });

const server = (): ToolsServerCommand => ({
  command: process.execPath,
  args: ['--import', TSX, TOOLS_SERVER, '--home', home],
});

const claude = (options: Partial<Parameters<typeof claudeSetup>[0]> = {}) =>
  claudeSetup({
    toolsServer: server(),
    env: env(),
    bridgeCommand: BRIDGE_COMMAND,
    bridgeHome: home,
    ...options,
  });

const codex = (options: Partial<Parameters<typeof codexSetup>[0]> = {}) =>
  codexSetup({ toolsServer: server(), env: env(), ...options });

const wanted = (overrides: Partial<InstallContext> = {}): InstallContext => ({
  project,
  scope: 'project',
  notes: true,
  takeJobs: false,
  allowTools: true,
  ...overrides,
});

async function apply(steps: SetupStep[]): Promise<void> {
  for (const step of steps) await step.apply();
}

const read = (...parts: string[]): string => readFileSync(join(...parts), 'utf8');
const json = (...parts: string[]): Record<string, unknown> =>
  JSON.parse(read(...parts)) as Record<string, unknown>;

const claudeConfig = (): {
  mcpServers?: Record<string, unknown>;
  projects?: Record<string, { mcpServers?: Record<string, unknown> }>;
} => JSON.parse(read(fakes.home, 'claude-config', '.claude.json')) as never;

beforeEach(() => {
  fakes = installFakeHarnesses();
  home = folder();
  project = folder();
});

afterEach(async () => {
  await Promise.all(clients.splice(0).map((client) => client.close().catch(() => undefined)));
  for (const host of hosts.splice(0)) await host.close();
  await fakes.cleanup();
  for (const remove of folders.splice(0)) remove();
});

describe.skipIf(!posix)('setting Claude Code up for a project', () => {
  it('registers the server, adds the hooks and the notes, and says each change before it makes it', async () => {
    const steps = await claude().install(wanted());

    expect(steps.map((step) => step.title)).toEqual([
      "Register the bridge's server of tools with Claude Code, for you in this project",
      `Edit ${join(project, '.claude', 'settings.local.json')}: the hooks that wake a session for its mail, name it to the tools, and say when it waits for you or ran into its limit`,
      `Add the notes of the bridge in ${join(project, 'CLAUDE.md')} (a new file)`,
    ]);
    expect(steps[0].lines).toEqual([
      `claude mcp add --scope local bridge -- ${process.execPath} --import ${TSX} ${TOOLS_SERVER} --home ${home}`,
    ]);
    expect(steps[1].lines).toEqual([
      `+ hooks.Stop: ${BRIDGE_COMMAND} wait --hook claude-code --timeout 43140 --home ${home} --tools`,
      `+ hooks.PreToolUse: ${BRIDGE_COMMAND} caller --hook claude-code`,
      `+ hooks.Notification: ${BRIDGE_COMMAND} stuck --hook claude-code --home ${home}`,
      `+ hooks.StopFailure: ${BRIDGE_COMMAND} limited --hook claude-code --home ${home}`,
      '+ permissions.allow: mcp__bridge',
    ]);
    expect(steps[2].lines[0]).toBe(`+ ${BRIDGE_NOTES_START}`);
    expect(steps[2].lines.join('\n')).toContain("needs the user's go");
    expect(existsSync(join(project, '.claude'))).toBe(false);
    expect(existsSync(join(project, 'CLAUDE.md'))).toBe(false);

    await apply(steps);

    expect(claudeConfig().projects?.[project].mcpServers?.bridge).toMatchObject({
      command: process.execPath,
      args: ['--import', TSX, TOOLS_SERVER, '--home', home],
    });
    expect(json(project, '.claude', 'settings.local.json')).toEqual({
      hooks: {
        Stop: claudeWaitHook({ bridgeCommand: BRIDGE_COMMAND, bridgeHome: home, tools: true }).hooks
          .Stop,
        PreToolUse: claudeToolsHook({ bridgeCommand: BRIDGE_COMMAND }).hooks.PreToolUse,
        Notification: claudeStuckHook({ bridgeCommand: BRIDGE_COMMAND, bridgeHome: home }).hooks
          .Notification,
        StopFailure: claudeLimitHook({ bridgeCommand: BRIDGE_COMMAND, bridgeHome: home }).hooks
          .StopFailure,
      },
      permissions: { allow: ['mcp__bridge'] },
    });
    expect(read(project, 'CLAUDE.md')).toBe(`${bridgeNotes()}\n`);
  });

  it('changes nothing the second time', async () => {
    await apply(await claude().install(wanted()));

    expect(await claude().install(wanted())).toEqual([]);
  });

  it('gives a window of the project the tools, the name of its session and its mail', async () => {
    await apply(await claude().install(wanted()));
    const host = await hostBridge({
      home,
      tickMs: 50,
      adapters: [claudeCodeAdapter({ env: env(), bridgeCommand: BRIDGE_COMMAND })],
    });
    hosts.push(host);
    const sessionId = await fakes.openClaudeWindow({ cwd: project, env: env() });

    await fakes.say(sessionId, 'tool: bridge.agents\nsay: looked');
    const first = await fakes.waitForTurn('claude', sessionId, () => true);

    expect(first.tools[0].isError, first.tools[0].text).toBe(false);
    expect(first.tools[0].text).toContain('claude-code, this session');
    expect(first.tools[0].sent).toMatchObject({
      _bridge: { harness: 'claude-code', session: sessionId },
    });

    const conductor = await BridgeClient.connect({
      socketPath: bridgePaths({ home }).socket,
      caller: { harness: 'conductor', sessionId: 'c-1', cwd: project, project },
    });
    clients.push(conductor);
    await conductor.createJob({ to: 'claude', body: 'Review the diff\nsay: reviewing' });
    const woken = await fakes.waitForTurn('claude', sessionId, (turn) => turn.wokenBy === 'hook');
    expect(woken.input).toContain('Review the diff');
  });

  it('keeps what the settings hold besides, and replaces a hook of the bridge it finds', async () => {
    const settings = join(project, '.claude', 'settings.local.json');
    mkdirSync(join(project, '.claude'));
    const lint = { matcher: 'Bash', hooks: [{ type: 'command', command: 'lint --staged' }] };
    const notify = { hooks: [{ type: 'command', command: 'notify-send done' }] };
    const stale = claudeWaitHook({ bridgeCommand: 'old-cogitator bridge' }).hooks.Stop[0];
    writeFileSync(
      settings,
      JSON.stringify({
        model: 'sonnet',
        hooks: { Stop: [notify, stale], PreToolUse: [lint], Notification: [notify] },
        permissions: { allow: ['Bash(pnpm test:*)'], deny: ['Read(.env)'] },
      })
    );

    const steps = await claude().install(wanted({ notes: false }));
    expect(steps.map((step) => step.title.split(':')[0])).toEqual([
      "Register the bridge's server of tools with Claude Code, for you in this project",
      `Edit ${settings}`,
    ]);
    await apply(steps);

    const after = json(settings) as {
      model: string;
      hooks: Record<string, { hooks: { command: string }[] }[]>;
      permissions: Record<string, string[]>;
    };
    expect(after.model).toBe('sonnet');
    expect(after.hooks.Notification).toEqual([
      notify,
      claudeStuckHook({ bridgeCommand: BRIDGE_COMMAND, bridgeHome: home }).hooks.Notification[0],
    ]);
    expect(after.hooks.Stop.map((group) => group.hooks[0].command)).toEqual([
      'notify-send done',
      `${BRIDGE_COMMAND} wait --hook claude-code --timeout 43140 --home ${home} --tools`,
    ]);
    expect(after.hooks.PreToolUse[0]).toEqual(lint);
    expect(after.hooks.PreToolUse).toHaveLength(2);
    expect(after.permissions).toEqual({
      allow: ['Bash(pnpm test:*)', 'mcp__bridge'],
      deny: ['Read(.env)'],
    });
    expect(existsSync(join(project, 'CLAUDE.md'))).toBe(false);
  });

  it('leaves the permission prompt alone when asked to, and a rule that is there in place', async () => {
    const settings = join(project, '.claude', 'settings.local.json');

    await apply(await claude().install(wanted({ allowTools: false, notes: false })));
    expect(json(settings)).not.toHaveProperty('permissions');

    await apply(await claude().install(wanted({ notes: false })));
    expect(json(settings).permissions).toEqual({ allow: ['mcp__bridge'] });
    expect(await claude().install(wanted({ allowTools: false, notes: false }))).toEqual([]);
  });

  it('puts the notes after what CLAUDE.md says, and rewrites only them when the answer changes', async () => {
    writeFileSync(join(project, 'CLAUDE.md'), '# Demo\n\nUse pnpm.\n');

    await apply(await claude().install(wanted()));
    expect(read(project, 'CLAUDE.md')).toBe(`# Demo\n\nUse pnpm.\n\n${bridgeNotes()}\n`);

    const steps = await claude().install(wanted({ takeJobs: true }));
    expect(steps.map((step) => step.title)).toEqual([
      `Update the notes of the bridge in ${join(project, 'CLAUDE.md')}`,
    ]);
    await apply(steps);
    expect(read(project, 'CLAUDE.md')).toBe(
      `# Demo\n\nUse pnpm.\n\n${bridgeNotes({ takeJobs: true })}\n`
    );
  });

  it('replaces a server that is started another way', async () => {
    await fakes.run('claude', ['mcp', 'add', 'bridge', '--', 'node', '/old/cli.js'], {
      cwd: project,
    });

    const [step] = await claude().install(wanted({ notes: false }));

    expect(step.title).toBe(
      "Replace the bridge's server of tools with Claude Code, for you in this project"
    );
    expect(step.lines[0]).toBe('claude mcp remove bridge --scope local');
    await step.apply();
    expect(claudeConfig().projects?.[project].mcpServers?.bridge).toMatchObject({
      command: process.execPath,
    });
  });

  it('sets up every project of a person in the places Claude Code keeps for a person', async () => {
    const userDir = join(fakes.home, 'claude-config');

    const steps = await claude().install(wanted({ scope: 'user' }));
    expect(steps.map((step) => step.title.split(':')[0])).toEqual([
      "Register the bridge's server of tools with Claude Code, for every project of yours",
      `Edit ${join(userDir, 'settings.json')}`,
      `Add the notes of the bridge in ${join(userDir, 'CLAUDE.md')} (a new file)`,
    ]);
    await apply(steps);

    expect(claudeConfig().mcpServers?.bridge).toMatchObject({ command: process.execPath });
    expect(json(userDir, 'settings.json')).toHaveProperty('hooks.Stop');
    expect(existsSync(join(project, '.claude'))).toBe(false);
    expect(await claude().install(wanted({ scope: 'user' }))).toEqual([]);
    expect((await claude().install(wanted())).length).toBe(3);
  });

  it('refuses to touch settings it cannot read, and changes nothing then', async () => {
    mkdirSync(join(project, '.claude'));
    const settings = join(project, '.claude', 'settings.local.json');
    writeFileSync(settings, '{ "hooks": ');

    await expect(claude().install(wanted())).rejects.toThrow(
      `${settings} is not valid JSON. Fix it first: nothing was changed`
    );
    writeFileSync(settings, '[]');
    await expect(claude().install(wanted())).rejects.toThrow('does not hold a JSON object');
    expect(existsSync(join(project, 'CLAUDE.md'))).toBe(false);
  });

  it('says Claude Code is missing before it plans anything', async () => {
    const absent = claudeSetup({ toolsServer: server(), env: { PATH: join(home, 'nothing') } });

    await expect(absent.install(wanted())).rejects.toBeInstanceOf(CommandMissingError);
  });
});

describe.skipIf(!posix)('taking Claude Code out of the bridge again', () => {
  it('leaves a project as it was before', async () => {
    await apply(await claude().install(wanted()));

    const steps = await claude().uninstall({ project, scope: 'project' });
    expect(steps.map((step) => step.title)).toEqual([
      "Remove the bridge's server of tools from Claude Code",
      `Remove ${join(project, '.claude', 'settings.local.json')}, which holds only the hooks of the bridge`,
      `Remove ${join(project, 'CLAUDE.md')}, which holds only the notes of the bridge`,
    ]);
    expect(steps[0].lines).toEqual(['claude mcp remove bridge --scope local']);
    expect(steps[1].lines).toHaveLength(5);
    expect(steps[1].lines.every((line) => line.startsWith('- '))).toBe(true);
    await apply(steps);

    expect(claudeConfig().projects?.[project].mcpServers).toEqual({});
    expect(existsSync(join(project, '.claude', 'settings.local.json'))).toBe(false);
    expect(existsSync(join(project, 'CLAUDE.md'))).toBe(false);
    expect(await claude().uninstall({ project, scope: 'project' })).toEqual([]);
  });

  it('takes only its own out of files that hold more', async () => {
    const settings = join(project, '.claude', 'settings.local.json');
    mkdirSync(join(project, '.claude'));
    const original = {
      model: 'sonnet',
      hooks: { Stop: [{ hooks: [{ type: 'command', command: 'notify-send done' }] }] },
      permissions: { allow: ['Bash(pnpm test:*)'] },
    };
    writeFileSync(settings, JSON.stringify(original));
    writeFileSync(join(project, 'CLAUDE.md'), '# Demo\n\nUse pnpm.\n');
    await apply(await claude().install(wanted()));

    const steps = await claude().uninstall({ project, scope: 'project' });
    expect(steps[1].title).toBe(`Edit ${settings}: take the hooks of the bridge out`);
    expect(steps[2].title).toBe(
      `Remove the notes of the bridge from ${join(project, 'CLAUDE.md')}`
    );
    await apply(steps);

    expect(json(settings)).toEqual(original);
    expect(read(project, 'CLAUDE.md')).toBe('# Demo\n\nUse pnpm.\n');
  });

  it('finds nothing to undo in a project that was never set up', async () => {
    expect(await claude().uninstall({ project, scope: 'project' })).toEqual([]);
    expect(await claude().uninstall({ project, scope: 'user' })).toEqual([]);
  });
});

describe('the settings of Claude Code with and without the bridge', () => {
  const bridge = {
    wait: claudeWaitHook({ tools: true }),
    tools: claudeToolsHook(),
    stuck: claudeStuckHook(),
    limit: claudeLimitHook(),
    allow: true,
  };

  it('come back as they were', () => {
    for (const settings of [
      {},
      { model: 'sonnet' },
      { hooks: { Stop: [{ hooks: [{ type: 'command', command: 'beep' }] }] } },
      { permissions: { allow: ['Bash(ls:*)'], deny: [] } },
    ]) {
      const there = withBridgeSettings(settings, bridge);
      expect(withBridgeSettings(there, bridge)).toEqual(there);
      expect(withoutBridgeSettings(there)).toEqual(settings);
    }
  });

  it('do not keep a list the bridge was the only entry of', () => {
    const empty = { hooks: {}, permissions: { allow: [] } };

    expect(withoutBridgeSettings(withBridgeSettings(empty, bridge))).toEqual({});
    expect(
      withoutBridgeSettings({ permissions: { allow: ['mcp__bridge'], deny: ['Read(.env)'] } })
    ).toEqual({
      permissions: { deny: ['Read(.env)'] },
    });
  });

  it('take a hook of the bridge out of a group it shares', () => {
    const shared = {
      hooks: {
        Stop: [
          {
            hooks: [{ type: 'command', command: 'beep' }, ...claudeWaitHook().hooks.Stop[0].hooks],
          },
        ],
      },
    };

    expect(withoutBridgeSettings(shared)).toEqual({
      hooks: { Stop: [{ hooks: [{ type: 'command', command: 'beep' }] }] },
    });
  });

  it('survive settings that are not shaped as expected', () => {
    const odd = { hooks: { Stop: 'nothing', PreToolUse: [7, { hooks: 'x' }] }, permissions: [] };

    expect(withoutBridgeSettings(odd)).toEqual({
      hooks: { PreToolUse: [7, { hooks: 'x' }] },
      permissions: [],
    });
    expect(withBridgeSettings(odd, { ...bridge, allow: false })).toMatchObject({
      hooks: { Stop: bridge.wait.hooks.Stop },
      permissions: [],
    });
  });
});

describe.skipIf(!posix)('setting Codex up', () => {
  const registered = async (): Promise<{ transport: { command: string; args: string[] } }> =>
    JSON.parse((await fakes.run('codex', ['mcp', 'get', 'bridge', '--json'])).stdout) as never;

  it('registers the server and adds the notes to AGENTS.md', async () => {
    const steps = await codex().install(wanted({ takeJobs: true }));

    expect(steps.map((step) => step.title)).toEqual([
      "Register the bridge's server of tools with Codex, which keeps its servers for every project",
      `Add the notes of the bridge in ${join(project, 'AGENTS.md')} (a new file)`,
    ]);
    expect(steps[0].lines).toEqual([
      `codex mcp add bridge -- ${process.execPath} --import ${TSX} ${TOOLS_SERVER} --home ${home}`,
    ]);
    await apply(steps);

    expect((await registered()).transport).toMatchObject({
      command: process.execPath,
      args: ['--import', TSX, TOOLS_SERVER, '--home', home],
    });
    expect(read(project, 'AGENTS.md')).toBe(`${bridgeNotes({ takeJobs: true })}\n`);
    expect(await codex().install(wanted({ takeJobs: true }))).toEqual([]);
  });

  it('replaces a server that is started another way', async () => {
    await fakes.run('codex', ['mcp', 'add', 'bridge', '--', 'node', '/old/cli.js']);

    const [step] = await codex().install(wanted({ notes: false }));

    expect(step.title).toContain("Replace the bridge's server of tools with Codex");
    await step.apply();
    expect((await registered()).transport.command).toBe(process.execPath);
  });

  it('gives a thread of the project the tools, in a sandbox too', async () => {
    await apply(await codex().install(wanted()));
    const host = await hostBridge({ home, tickMs: 50 });
    hosts.push(host);
    await fakes.startCodexApp();
    const threadId = await fakes.openCodexThread({ cwd: project, sandbox: 'workspace-write' });

    await fakes.run('codex', ['queue', '--thread', threadId, '--message', 'tool: bridge.agents']);
    const turn = await fakes.waitForTurn('codex', threadId, () => true);

    expect(turn.tools[0].isError, turn.tools[0].text).toBe(false);
    expect(turn.tools[0].text).toContain('codex, this session');
    const reader = await BridgeClient.connect({ socketPath: bridgePaths({ home }).socket });
    clients.push(reader);
    expect((await reader.agents({ harness: 'codex' })).map((agent) => agent.sessionId)).toEqual([
      threadId,
    ]);
  });

  it('keeps the server when one project is taken out, and removes it for every project', async () => {
    await apply(await codex().install(wanted()));

    const forProject = await codex().uninstall({ project, scope: 'project' });
    expect(forProject.map((step) => step.title)).toEqual([
      `Remove ${join(project, 'AGENTS.md')}, which holds only the notes of the bridge`,
    ]);
    await apply(forProject);
    expect((await fakes.run('codex', ['mcp', 'get', 'bridge'])).code).toBe(0);

    const forAll = await codex().uninstall({ project, scope: 'user' });
    expect(forAll.map((step) => step.lines)).toEqual([['codex mcp remove bridge']]);
    await apply(forAll);
    expect((await fakes.run('codex', ['mcp', 'get', 'bridge'])).code).toBe(1);
    expect(await codex().uninstall({ project, scope: 'user' })).toEqual([]);
  });

  it('keeps the notes of every project in the home of Codex', async () => {
    const notes = join(home, 'codex-home', 'AGENTS.md');

    await apply(await codex({ userNotesPath: notes }).install(wanted({ scope: 'user' })));

    expect(read(notes)).toContain(BRIDGE_NOTES_END);
    expect(existsSync(join(project, 'AGENTS.md'))).toBe(false);
  });

  it('says Codex is missing before it plans anything', async () => {
    const absent = codexSetup({ toolsServer: server(), env: { PATH: join(home, 'nothing') } });

    await expect(absent.install(wanted())).rejects.toBeInstanceOf(CommandMissingError);
  });
});
