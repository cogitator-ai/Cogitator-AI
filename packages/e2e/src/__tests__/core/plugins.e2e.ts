import { execFileSync } from 'node:child_process';
import {
  cpSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  Agent,
  Cogitator,
  experimental_memorySecretStore,
  experimental_PluginInstaller,
} from '@cogitator-ai/core';
import { experimental_mcpConnector } from '@cogitator-ai/mcp';
import { MockLLMBackend, type MockChatResponse } from '@cogitator-ai/test-utils';
import { ErrorCode, type Message, type ToolCall } from '@cogitator-ai/types';
import { getTestModel, ollamaSkipReason } from '../../helpers/setup';

const describeOllama = describe.skipIf((await ollamaSkipReason()) !== null);

const CORE_FIXTURES = join(
  __dirname,
  '..',
  '..',
  '..',
  '..',
  'core',
  'src',
  '__tests__',
  'fixtures',
  'plugins'
);
const MCP_SERVER = join(__dirname, '..', 'mcp', 'fixtures', 'stdio-server.mjs');

const call = (id: string, name: string, args: Record<string, unknown>): ToolCall => ({
  id,
  name,
  arguments: args,
});

const turn = (...calls: ToolCall[]): MockChatResponse => ({
  content: '',
  toolCalls: calls,
  finishReason: 'tool_calls',
});

const toolTexts = (messages: readonly Message[]): string[] =>
  messages.filter((message) => message.role === 'tool').map((message) => String(message.content));

const git = (cwd: string, ...args: string[]) =>
  execFileSync(
    'git',
    [
      '-c',
      'user.email=e2e@example.com',
      '-c',
      'user.name=E2E',
      '-c',
      'commit.gpgsign=false',
      ...args,
    ],
    { cwd, encoding: 'utf8' }
  ).trim();

let base: string;
let pluginsRoot: string;
let home: string;
let project: string;

beforeEach(() => {
  base = realpathSync(mkdtempSync(join(tmpdir(), 'e2e-plugins-')));
  pluginsRoot = join(base, 'plugins');
  home = join(base, 'home');
  project = join(base, 'project');
  mkdirSync(project, { recursive: true });
});

afterEach(() => {
  rmSync(base, { recursive: true, force: true });
});

/** A git marketplace holding the Claude Code fixture, the isolated fixture and a plugin with an MCP server */
function marketplace(): string {
  const repo = join(base, 'market');
  cpSync(join(CORE_FIXTURES, 'deploy-tools'), join(repo, 'plugins', 'deploy-tools'), {
    recursive: true,
  });
  cpSync(join(CORE_FIXTURES, 'weather'), join(repo, 'plugins', 'weather'), { recursive: true });
  const pinger = join(repo, 'plugins', 'pinger');
  mkdirSync(join(pinger, '.claude-plugin'), { recursive: true });
  writeFileSync(
    join(pinger, '.claude-plugin', 'plugin.json'),
    JSON.stringify({ name: 'pinger', version: '1.0.0' })
  );
  writeFileSync(
    join(pinger, '.mcp.json'),
    JSON.stringify({ mcpServers: { ping: { command: process.execPath, args: [MCP_SERVER] } } })
  );
  mkdirSync(join(repo, '.claude-plugin'), { recursive: true });
  writeFileSync(
    join(repo, '.claude-plugin', 'marketplace.json'),
    JSON.stringify({
      name: 'e2e-market',
      owner: { name: 'E2E' },
      plugins: [
        { name: 'deploy-tools', source: './plugins/deploy-tools' },
        { name: 'weather', source: './plugins/weather' },
        { name: 'pinger', source: './plugins/pinger' },
      ],
    })
  );
  git(repo, 'init', '--quiet', '--initial-branch=main');
  git(repo, 'add', '-A');
  git(repo, 'commit', '--quiet', '-m', 'marketplace');
  return repo;
}

const installer = () =>
  new experimental_PluginInstaller({
    root: pluginsRoot,
    projectRoot: project,
    userDirs: [home],
    secrets: experimental_memorySecretStore(),
    confirm: async () => true,
  });

const runtime = (
  backends: Record<string, MockLLMBackend>,
  extra: Partial<NonNullable<ConstructorParameters<typeof Cogitator>[0]>> = {}
) =>
  new Cogitator({
    memory: { adapter: 'memory' },
    llm: { backends, retry: false },
    experimental_plugins: {
      installed: { root: pluginsRoot },
      settings: { root: project, userDirs: [home], managedDirs: [], layers: ['user'] },
      secrets: experimental_memorySecretStore({
        'cogitator-plugin:weather@e2e-market': { api_key: 'k' },
      }),
      mcp: experimental_mcpConnector(),
    },
    ...extra,
  });

describe('Core: plugins installed from a marketplace', () => {
  it(
    'runs the tools of an isolated plugin and refuses what its permission manifest does not allow',
    { timeout: 60_000 },
    async () => {
      const tools = installer();
      await tools.addMarketplace(`file://${marketplace()}`);
      await tools.install('weather@e2e-market', { yes: true });
      mkdirSync(join(project, 'allowed'), { recursive: true });
      writeFileSync(join(project, 'allowed', 'open.txt'), 'open data');
      writeFileSync(join(project, 'private.txt'), 'private data');
      const backend = new MockLLMBackend().setResponses([
        turn(
          call('c1', 'weather_now', { city: 'Oslo' }),
          call('c2', 'weather_probe', { what: 'host-read', target: 'allowed/open.txt' })
        ),
        turn(
          call('c3', 'weather_probe', { what: 'host-read', target: 'private.txt' }),
          call('c4', 'weather_probe', { what: 'direct-read', target: join(project, 'private.txt') })
        ),
        { content: 'reported' },
      ]);
      const cogitator = runtime({ mock: backend });
      const result = await cogitator.run(
        new Agent({ name: 'reporter', model: 'mock/m', instructions: 'Report the weather.' }),
        { input: 'weather?' }
      );
      expect(result.output).toBe('reported');
      const texts = toolTexts(result.messages);
      expect(JSON.parse(texts[0] ?? '""')).toBe('Sunny in Oslo, metric');
      expect(JSON.parse(texts[1] ?? '{}')).toEqual({ ok: true, value: 'open data' });
      expect(JSON.parse(texts[2] ?? '{}')).toMatchObject({
        ok: false,
        code: ErrorCode.PLUGIN_PERMISSION_DENIED,
      });
      expect(JSON.parse(texts[3] ?? '{}')).toMatchObject({ ok: false, code: 'ERR_ACCESS_DENIED' });
      expect(cogitator.experimental_plugins.get('weather@e2e-market')).toMatchObject({
        status: 'active',
        isolated: true,
        origin: 'installed',
      });
      await cogitator.close();
    }
  );

  it(
    'connects the MCP server a plugin declares in .mcp.json and calls its tool by its Claude Code name',
    { timeout: 60_000 },
    async () => {
      const tools = installer();
      await tools.addMarketplace(`file://${marketplace()}`);
      await tools.install('pinger@e2e-market');
      const backend = new MockLLMBackend().setResponses([
        turn(call('c1', 'mcp__plugin_pinger_ping__add', { a: 2, b: 3 })),
        { content: 'pinged' },
      ]);
      const cogitator = runtime({ mock: backend });
      const result = await cogitator.run(
        new Agent({ name: 'pinger', model: 'mock/m', instructions: 'Ping.' }),
        { input: 'ping it' }
      );
      expect(toolTexts(result.messages).map((text) => JSON.parse(text) as unknown)).toEqual([
        { sum: 5 },
      ]);
      expect(
        cogitator.experimental_plugins.get('pinger@e2e-market')?.contributions.mcpServers
      ).toEqual(['plugin:pinger:ping']);
      await cogitator.close();
    }
  );

  it(
    'reloads a changed plugin in place and keeps the working generation when the change breaks it',
    { timeout: 60_000 },
    async () => {
      const dir = join(base, 'live');
      mkdirSync(join(dir, '.claude-plugin'), { recursive: true });
      mkdirSync(join(dir, 'commands'), { recursive: true });
      writeFileSync(
        join(dir, '.claude-plugin', 'plugin.json'),
        JSON.stringify({ name: 'live', version: '1.0.0' })
      );
      writeFileSync(join(dir, 'commands', 'say.md'), 'Say one.');
      const backend = new MockLLMBackend().setResponses([
        { content: 'one' },
        { content: 'two' },
        { content: 'still two' },
      ]);
      const cogitator = new Cogitator({
        memory: { adapter: 'memory' },
        llm: { backends: { mock: backend }, retry: false },
        experimental_plugins: { dirs: [dir], installed: false, settings: false },
      });
      const agent = new Agent({ name: 'speaker', model: 'mock/m', instructions: 'Speak.' });
      await cogitator.run(agent, { input: '/live:say' });
      writeFileSync(join(dir, 'commands', 'say.md'), 'Say two.');
      expect(await cogitator.experimental_plugins.reload('live@inline')).toEqual([
        { id: 'live@inline', ok: true, generation: 2 },
      ]);
      await cogitator.run(agent, { input: '/live:say' });
      writeFileSync(join(dir, '.claude-plugin', 'plugin.json'), '{ not json');
      const [failed] = await cogitator.experimental_plugins.reload('live@inline');
      expect(failed).toMatchObject({ ok: false, generation: 2 });
      await cogitator.run(agent, { input: '/live:say' });
      const sent = backend
        .getCalls()
        .map((request) =>
          String(request.messages.find((message) => message.role === 'user')?.content)
        );
      expect(sent).toEqual(['Say one.', 'Say two.', 'Say two.']);
      await cogitator.close();
    }
  );

  it('installs a plugin straight from git at a pinned commit', { timeout: 60_000 }, async () => {
    const repo = join(base, 'direct');
    cpSync(join(CORE_FIXTURES, 'deploy-tools'), repo, { recursive: true });
    git(repo, 'init', '--quiet', '--initial-branch=main');
    git(repo, 'add', '-A');
    git(repo, 'commit', '--quiet', '-m', 'v1');
    const pinned = git(repo, 'rev-parse', 'HEAD');
    writeFileSync(join(repo, 'commands', 'status.md'), 'Changed after the pin.');
    git(repo, 'commit', '--quiet', '-am', 'v2');
    const result = await installer().install(`git+file://${repo}#${pinned}`);
    expect(result).toMatchObject({ id: 'deploy-tools@git', version: '1.2.0' });
    expect(readFileSync(join(result.installPath, 'commands', 'status.md'), 'utf8')).toContain(
      'Report the deployment status'
    );
    const records = JSON.parse(
      readFileSync(join(pluginsRoot, 'installed_plugins.json'), 'utf8')
    ) as { plugins: Record<string, { pin: { commit: string } }> };
    expect(records.plugins['deploy-tools@git']?.pin.commit).toBe(pinned);
  });
});

describeOllama('Core: a Claude Code plugin on Ollama', () => {
  it('expands a plugin command and lets a real model answer it', { timeout: 120_000 }, async () => {
    const dir = join(base, 'greeter');
    mkdirSync(join(dir, '.claude-plugin'), { recursive: true });
    mkdirSync(join(dir, 'commands'), { recursive: true });
    writeFileSync(
      join(dir, '.claude-plugin', 'plugin.json'),
      JSON.stringify({ name: 'greeter', version: '1.0.0' })
    );
    writeFileSync(
      join(dir, 'commands', 'greet.md'),
      '---\ndescription: Greets someone\nargument-hint: "[name]"\n---\nReply with exactly this sentence and nothing else: Hello, $0!\n'
    );
    const cogitator = new Cogitator({
      llm: { defaultModel: `ollama/${getTestModel()}` },
      experimental_plugins: { dirs: [dir], installed: false, settings: false },
    });
    const agent = new Agent({
      name: 'greeter',
      instructions: 'You follow instructions exactly.',
      temperature: 0,
    });
    const result = await cogitator.run(agent, { input: '/greeter:greet Ada' });
    expect(result.command).toMatchObject({ name: 'greeter:greet', source: 'plugin' });
    expect(result.output).toContain('Ada');
    await cogitator.close();
  });
});
