import { mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { SessionUpdate } from '@agentclientprotocol/sdk';
import { LocalWorkspace, workspaceTools } from '@cogitator-ai/core';
import type { StreamEvent } from '@cogitator-ai/server-shared';
import { DEFAULT_ACP_EFFORTS, applyConfigOption, configOptions, modeState } from '../agent/config';
import { expandSkill } from '../agent/commands';
import { mcpServerConfigs } from '../agent/mcp-servers';
import { titleOf, toUserInput } from '../agent/prompt';
import { diffOfToolCall, resultContent, viewOfToolCall } from '../agent/tool-calls';
import { TurnUpdates, type PendingUpdate } from '../agent/updates';
import { AcpPermissions, commandLine, commandOf, subjectOf } from '../client/permissions';
import { launchOfRegistryAgent, resolveAcpAgent, splitCommand } from '../client/registry';
import { AcpTerminals, keepLast } from '../client/terminals';
import { AcpStreamMapper } from '../client/updates';
import { sliceLines } from '../client/provider';

let dir: string;
let workspace: LocalWorkspace;

beforeEach(async () => {
  dir = realpathSync(mkdtempSync(join(tmpdir(), 'acp-mapping-')));
  workspace = new LocalWorkspace({ root: dir });
  await workspace.start();
});

afterEach(async () => {
  await workspace.dispose();
  rmSync(dir, { recursive: true, force: true });
});

const tools = new Map(workspaceTools().map((tool) => [tool.name, tool]));

describe('prompts', () => {
  it('turns content blocks into input parts', () => {
    expect(
      toUserInput([
        { type: 'text', text: 'Fix it' },
        { type: 'image', data: 'AAAA', mimeType: 'image/png' },
        { type: 'image', data: '', mimeType: 'image/tiff', uri: 'https://x.dev/a.tiff' },
        { type: 'resource', resource: { uri: 'file:///p/a.ts', text: 'const a = 1' } },
        { type: 'resource_link', uri: 'file:///p/b.ts', name: 'b.ts' },
        { type: 'audio', data: 'AAAA', mimeType: 'audio/wav' },
      ])
    ).toEqual([
      { type: 'text', text: 'Fix it' },
      { type: 'image', data: 'AAAA', mimeType: 'image/png' },
      { type: 'image', url: 'https://x.dev/a.tiff' },
      { type: 'text', text: '<resource uri="file:///p/a.ts">\nconst a = 1\n</resource>' },
      { type: 'text', text: 'Referenced file: /p/b.ts' },
    ]);
  });

  it('titles a session by the first line of its first prompt', () => {
    expect(titleOf('\n  Fix the login bug\nmore')).toBe('Fix the login bug');
    expect(titleOf('x'.repeat(100), 20)).toBe(`${'x'.repeat(17)}...`);
    expect(titleOf('<resource uri="a">\nbody\n</resource>')).toBeUndefined();
  });

  it('spells out a skill request and leaves commands to the runtime', () => {
    const skills = new Set(['deploy-check']);
    expect(expandSkill('/deploy-check staging', skills)).toBe(
      'Use the deploy-check skill (load it with use_skill) to do this: staging'
    );
    expect(expandSkill('/review src', skills)).toBe('/review src');
  });

  it('gives MCP servers in the shape of .mcp.json', () => {
    expect(
      mcpServerConfigs(
        [
          { name: 'fs', command: '/bin/fs', args: ['-v'], env: [{ name: 'A', value: '1' }] },
          {
            type: 'http',
            name: 'api',
            url: 'https://x.dev/mcp',
            headers: [{ name: 'K', value: 'v' }],
          },
        ],
        '/p'
      )
    ).toEqual([
      {
        name: 'fs',
        config: { type: 'stdio', command: '/bin/fs', args: ['-v'], env: { A: '1' }, cwd: '/p' },
      },
      { name: 'api', config: { type: 'http', url: 'https://x.dev/mcp', headers: { K: 'v' } } },
    ]);
  });
});

describe('tool calls', () => {
  it('shows a call by its presentation, kind and locations', () => {
    expect(viewOfToolCall('read_file', { path: 'src/a.ts' }, tools.get('read_file'), dir)).toEqual({
      title: 'Read file: src/a.ts',
      kind: 'read',
      locations: [{ path: join(dir, 'src/a.ts') }],
    });
    expect(
      viewOfToolCall('run_command', { command: 'npm test' }, tools.get('run_command'), dir)
    ).toEqual({
      title: '`npm test`',
      kind: 'execute',
      locations: [],
    });
    expect(viewOfToolCall('delete_file', { path: 'x' }, tools.get('delete_file'), dir).kind).toBe(
      'delete'
    );
    expect(viewOfToolCall('grep', { pattern: 'x' }, tools.get('grep'), dir).kind).toBe('search');
    expect(viewOfToolCall('mystery', {}, undefined, dir)).toEqual({
      title: 'mystery',
      kind: 'other',
      locations: [],
    });
  });

  it('computes the diff of writes and edits', async () => {
    writeFileSync(join(dir, 'a.ts'), 'one two two');
    expect(await diffOfToolCall('write_file', { path: 'new.ts', content: 'x' }, workspace)).toEqual(
      {
        type: 'diff',
        path: join(dir, 'new.ts'),
        newText: 'x',
      }
    );
    expect(
      await diffOfToolCall(
        'edit_file',
        { path: 'a.ts', oldString: 'two', newString: '2', replaceAll: true },
        workspace
      )
    ).toEqual({
      type: 'diff',
      path: join(dir, 'a.ts'),
      oldText: 'one two two',
      newText: 'one 2 2',
    });
    expect(
      await diffOfToolCall(
        'edit_file',
        { path: 'a.ts', oldString: 'zzz', newString: '2' },
        workspace
      )
    ).toBeUndefined();
    expect(await diffOfToolCall('read_file', { path: 'a.ts' }, workspace)).toBeUndefined();
  });

  it('shows results as text, command output and errors', () => {
    expect(resultContent({ stdout: 'ok', stderr: '', exitCode: 0 })).toEqual([
      { type: 'content', content: { type: 'text', text: 'ok\nexit code 0' } },
    ]);
    expect(resultContent(null, 'boom')).toEqual([
      { type: 'content', content: { type: 'text', text: 'Error: boom' } },
    ]);
    expect(resultContent(undefined)).toEqual([]);
    const long = resultContent('x'.repeat(9000))[0];
    expect(long?.type === 'content' && long.content.type === 'text' && long.content.text).toContain(
      '1000 more characters'
    );
  });

  it('maps the stream of a turn to session updates in order', async () => {
    const sent: PendingUpdate[] = [];
    const updates = new TurnUpdates({
      tool: (name) => tools.get(name),
      workspace,
      root: dir,
      send: (update) => sent.push(update),
    });
    const events: StreamEvent[] = [
      { type: 'text-start', id: 't' },
      { type: 'text-delta', id: 't', delta: 'Hi' },
      { type: 'reasoning-delta', id: 'r', delta: 'hmm' },
      { type: 'tool-call-start', id: 'c1', toolName: 'read_file' },
      { type: 'tool-call-delta', id: 'c1', argsTextDelta: '{"path":"a.ts"}' },
      { type: 'tool-call-end', id: 'c1' },
      { type: 'tool-result', id: 'r1', toolCallId: 'c1', result: 'text' },
      { type: 'tool-call-start', id: 'c2', toolName: 'write_todos' },
      { type: 'tool-call-end', id: 'c2' },
      { type: 'finish', messageId: 'm', truncated: true },
    ];
    for (const event of events) updates.event(event);
    const resolved = (await Promise.all(sent.map((update) => Promise.resolve(update)))).filter(
      (update): update is SessionUpdate => update !== undefined
    );
    expect(resolved).toEqual([
      { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'Hi' } },
      { sessionUpdate: 'agent_thought_chunk', content: { type: 'text', text: 'hmm' } },
      {
        sessionUpdate: 'tool_call',
        toolCallId: 'c1',
        title: 'read_file',
        kind: 'read',
        status: 'pending',
      },
      {
        sessionUpdate: 'tool_call_update',
        toolCallId: 'c1',
        title: 'Read file: a.ts',
        kind: 'read',
        rawInput: { path: 'a.ts' },
        locations: [{ path: join(dir, 'a.ts') }],
      },
      {
        sessionUpdate: 'tool_call_update',
        toolCallId: 'c1',
        status: 'completed',
        content: [{ type: 'content', content: { type: 'text', text: 'text' } }],
        rawOutput: 'text',
      },
    ]);
    expect(updates.finish).toEqual({ truncated: true });
  });
});

describe('configuration options', () => {
  const choices = {
    modes: ['default', 'plan'] as const,
    models: ['a/x'],
    efforts: DEFAULT_ACP_EFFORTS,
  };

  it('offers mode, model and reasoning effort', () => {
    const options = configOptions({ mode: 'plan', model: 'b/y', effort: 'high' }, choices);
    expect(options.map((o) => [o.id, o.type === 'select' && o.currentValue])).toEqual([
      ['mode', 'plan'],
      ['model', 'b/y'],
      ['reasoning_effort', 'high'],
    ]);
    const models = options[1];
    expect(models?.type === 'select' && models.options).toEqual([
      { value: 'b/y', name: 'b/y' },
      { value: 'a/x', name: 'a/x' },
    ]);
    expect(modeState(choices.modes, 'plan')).toMatchObject({
      currentModeId: 'plan',
      availableModes: [
        { id: 'default', name: 'Ask' },
        { id: 'plan', name: 'Plan' },
      ],
    });
  });

  it('sets an offered value and refuses others', () => {
    const settings = { mode: 'default' as const, model: 'a/x', effort: 'default' as const };
    expect(applyConfigOption(settings, 'mode', 'plan', choices).mode).toBe('plan');
    expect(applyConfigOption(settings, 'reasoning_effort', 'max', choices).effort).toBe('max');
    expect(() => applyConfigOption(settings, 'mode', 'auto', choices)).toThrow(/Unknown mode/);
    expect(() => applyConfigOption(settings, 'model', 'z/z', choices)).toThrow(/Unknown model/);
    expect(() => applyConfigOption(settings, 'mode', true, choices)).toThrow();
    expect(() => applyConfigOption(settings, 'nope', 'x', choices)).toThrow(
      /Unknown configuration/
    );
  });
});

describe('external agents', () => {
  it('reads the calls of an agent as calls the rules name', () => {
    expect(subjectOf({ kind: 'execute', title: '`npm test`' }, 'claude', dir)).toMatchObject({
      tool: { name: 'run_command' },
      args: { command: 'npm test' },
      needsApproval: true,
    });
    expect(
      subjectOf({ kind: 'edit', rawInput: { file_path: 'src/a.ts' } }, 'claude', dir)
    ).toMatchObject({ tool: { name: 'edit_file' }, args: { paths: [join(dir, 'src/a.ts')] } });
    expect(
      subjectOf({ kind: 'fetch', rawInput: { url: 'https://x.dev' } }, 'c', dir).tool.name
    ).toBe('web_fetch');
    expect(subjectOf({ kind: 'think' }, 'c', dir)).toMatchObject({ needsApproval: false });
    expect(subjectOf({ kind: 'other', name: 'Web Search!' }, 'my agent', dir).tool.name).toBe(
      'acp__my_agent__Web_Search'
    );
    expect(commandOf({ rawInput: { command: ['git', 'commit', '-m', 'a b'] } })).toBe(
      "git commit -m 'a b'"
    );
    expect(commandLine('/bin/bash', ['-lc', 'npm test'])).toBe('npm test');
  });

  it('decides with rules and the mode, and remembers always answers', async () => {
    const permissions = new AcpPermissions(workspace, { rules: { deny: ['Bash(rm *)'] } });
    const run = (command: string) =>
      subjectOf({ kind: 'execute', rawInput: { command } }, 'a', dir);
    const edit = subjectOf({ kind: 'edit', locations: [{ path: join(dir, 'x.ts') }] }, 'a', dir);
    expect((await permissions.decide(run('rm -rf build'), 'default', 't')).decision).toBe('deny');
    expect((await permissions.decide(run('npm test'), 'default', 't')).decision).toBe('ask');
    expect((await permissions.decide(edit, 'acceptEdits', 't')).decision).toBe('allow');
    expect((await permissions.decide(edit, 'plan', 't')).decision).toBe('deny');
    expect(await permissions.remember(run('npm test'), 'allow', 't')).toEqual({
      rule: 'run_command(npm test *)',
      layer: 'session',
    });
    expect((await permissions.decide(run('npm test --watch'), 'default', 't')).decision).toBe(
      'allow'
    );
    expect((await permissions.decide(run('npm test'), 'default', 'other')).decision).toBe('ask');
  });

  it('saves always answers to the local settings file when it reads settings', async () => {
    const permissions = new AcpPermissions(workspace, {
      settings: { root: dir, userDirs: [join(dir, 'home')], managedDirs: [] },
      rememberIn: 'local',
    });
    const run = subjectOf({ kind: 'execute', rawInput: { command: 'make deploy' } }, 'a', dir);
    await permissions.remember(run, 'deny', 't');
    const { readFileSync } = await import('node:fs');
    expect(
      JSON.parse(readFileSync(join(dir, '.cogitator', 'settings.local.json'), 'utf8'))
    ).toEqual({
      permissions: { deny: ['run_command(make deploy *)'] },
    });
    expect((await permissions.decide(run, 'bypassPermissions', 'other')).decision).toBe('deny');
  });

  it('maps the updates of an agent to stream events', () => {
    const events: StreamEvent[] = [];
    const mapper = new AcpStreamMapper((event) => events.push(event));
    const updates: SessionUpdate[] = [
      { sessionUpdate: 'agent_thought_chunk', content: { type: 'text', text: 'think' } },
      { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'Hi' } },
      {
        sessionUpdate: 'tool_call',
        toolCallId: 'k',
        title: 'Run',
        kind: 'execute',
        rawInput: { command: 'ls' },
      },
      {
        sessionUpdate: 'tool_call_update',
        toolCallId: 'k',
        content: [{ type: 'content', content: { type: 'text', text: 'partial' } }],
      },
      {
        sessionUpdate: 'tool_call_update',
        toolCallId: 'k',
        status: 'failed',
        content: [{ type: 'content', content: { type: 'text', text: 'nope' } }],
      },
      { sessionUpdate: 'available_commands_update', availableCommands: [] },
    ];
    for (const update of updates) mapper.update(update);
    mapper.end();
    expect(events.map((e) => e.type)).toEqual([
      'reasoning-start',
      'reasoning-delta',
      'reasoning-end',
      'text-start',
      'text-delta',
      'text-end',
      'tool-call-start',
      'tool-call-delta',
      'tool-call-end',
      'tool-update',
      'tool-result',
    ]);
    expect(events.at(-1)).toMatchObject({ toolCallId: 'k', result: { error: 'nope' } });
    expect(mapper.output).toBe('Hi');
  });

  it('runs the commands of terminals in the workspace and keeps their newest output', async () => {
    const terminals = new AcpTerminals(workspace);
    const id = terminals.create(
      { sessionId: 's', command: 'sh', outputByteLimit: 5 },
      'printf hello-world'
    );
    expect(await terminals.waitForExit('s', id)).toEqual({ exitCode: 0, signal: null });
    expect(terminals.output('s', id)).toEqual({
      output: 'world',
      truncated: true,
      exitStatus: { exitCode: 0, signal: null },
    });
    expect(() => terminals.output('other', id)).toThrow();
    const slow = terminals.create({ sessionId: 's', command: 'sh' }, 'sleep 5');
    terminals.kill('s', slow);
    expect((await terminals.waitForExit('s', slow)).signal).toBe('SIGTERM');
    terminals.release('s', slow);
    expect(keepLast('héllo', 4)).toEqual({ text: 'llo', cut: true });
    expect(sliceLines('a\nb\nc', 2, 1)).toBe('b');
  });

  it('resolves presets, registry agents and command lines', async () => {
    expect(await resolveAcpAgent('gemini')).toMatchObject({
      command: 'npx',
      args: ['-y', '@google/gemini-cli', '--acp'],
    });
    expect(await resolveAcpAgent('my-agent --acp "a b"')).toEqual({
      name: 'my-agent',
      command: 'my-agent',
      args: ['--acp', 'a b'],
    });
    const registry = {
      agents: [
        {
          id: 'codex-acp',
          name: 'Codex',
          version: '1.0.0',
          distribution: { npx: { package: '@x/codex@1.0.0' } },
        },
        { id: 'bin', name: 'Bin', version: '1.0.0', distribution: { binary: {} } },
      ],
    };
    const fetchStub = (async () => new Response(JSON.stringify(registry))) as typeof fetch;
    expect(await resolveAcpAgent('registry:codex-acp', { fetch: fetchStub })).toEqual({
      name: 'Codex',
      command: 'npx',
      args: ['-y', '@x/codex@1.0.0'],
    });
    await expect(resolveAcpAgent('registry:bin', { fetch: fetchStub })).rejects.toThrow(/binaries/);
    await expect(resolveAcpAgent('registry:none', { fetch: fetchStub })).rejects.toThrow(
      /no agent/
    );
    expect(
      launchOfRegistryAgent({
        id: 'u',
        name: 'U',
        version: '1.0.0',
        distribution: { uvx: { package: 'u-acp', args: ['serve'], env: { A: '1' } } },
      })
    ).toEqual({ command: 'uvx', args: ['u-acp', 'serve'], env: { A: '1' } });
    expect(splitCommand(`a 'b c' "d \\"e\\""`)).toEqual(['a', 'b c', 'd "e"']);
  });
});
