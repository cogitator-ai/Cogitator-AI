import {
  existsSync,
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
import { z } from 'zod';
import { MockLLMBackend } from '@cogitator-ai/test-utils';
import type {
  ChatRequest,
  ChatResponse,
  CogitatorConfig,
  LLMBackend,
  Message,
} from '@cogitator-ai/types';
import { Cogitator } from '../cogitator';
import { Agent } from '../agent';
import { tool } from '../tool';
import { ToolRegistry } from '../registry';
import { experimental_memorySecretStore } from '../plugins/secrets';
import { registerLLMBackend, hasLLMPlugin, defineBackend } from '../llm/plugin';

const FIXTURES = join(__dirname, 'fixtures', 'plugins');

const systemText = (request: ChatRequest | undefined): string =>
  (request?.messages ?? [])
    .filter((message: Message) => message.role === 'system')
    .map((message) => String(message.content))
    .join('\n');

const lookup = tool({
  name: 'lookup',
  description: 'Looks something up',
  parameters: z.object({ q: z.string() }),
  execute: async ({ q }) => `found ${q}`,
});

function echoBackend(provider: string, label: string): LLMBackend {
  const answer = (request: ChatRequest): ChatResponse => ({
    id: label,
    content: `${label}: ${String(request.messages.at(-1)?.content ?? '')}`,
    finishReason: 'stop',
    usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
  });
  return {
    provider,
    chat: async (request) => answer(request),
    async *chatStream(request) {
      const response = answer(request);
      yield {
        id: label,
        delta: { content: response.content },
        finishReason: 'stop',
        usage: response.usage,
      };
    },
  };
}

describe('plugins in the runtime', () => {
  let base: string;
  let cogs: Cogitator[];

  beforeEach(() => {
    base = mkdtempSync(join(tmpdir(), 'cog-plugins-runtime-'));
    cogs = [];
  });

  afterEach(async () => {
    await Promise.all(cogs.map((cog) => cog.close()));
    rmSync(base, { recursive: true, force: true });
  });

  const runtime = (config: CogitatorConfig, backend = new MockLLMBackend()) => {
    const cog = new Cogitator({
      memory: { adapter: 'memory' },
      ...config,
      llm: { ...config.llm, backends: { ...config.llm?.backends, mock: backend }, retry: false },
    });
    cogs.push(cog);
    return { cog, backend };
  };

  const plugins = (extra: NonNullable<CogitatorConfig['experimental_plugins']>) => ({
    installed: { root: join(base, '.plugins') },
    settings: false as const,
    secrets: experimental_memorySecretStore({
      'cogitator-plugin:deploy-tools@inline': { api_token: 'tok-secret' },
    }),
    ...extra,
  });

  it('registers the built-in providers through the core plugin, without experimental_plugins', () => {
    const { cog } = runtime({});
    const [core] = cog.experimental_plugins.list();
    expect(core).toMatchObject({ id: 'cogitator@builtin', origin: 'core', status: 'active' });
    expect(core?.contributions.llmBackends).toEqual(
      expect.arrayContaining(['ollama', 'openai', 'anthropic', 'google'])
    );
    expect(cog.knowsProvider('ollama')).toBe(true);
    expect(cog.experimental_plugins.configured).toBe(false);
  });

  it('gives every run the tools, middleware and LLM backends a plugin in code registers', async () => {
    const seen: string[] = [];
    const backend = new MockLLMBackend().setResponses([
      {
        content: '',
        toolCalls: [{ id: 'c1', name: 'plugin_echo', arguments: { text: 'hi' } }],
        finishReason: 'tool_calls',
      },
      { content: 'done' },
    ]);
    const { cog } = runtime(
      {
        experimental_plugins: plugins({
          plugins: [
            {
              name: 'helpers',
              activate(context) {
                context.registerTool({
                  name: 'plugin_echo',
                  description: 'Echoes',
                  parameters: {
                    type: 'object',
                    properties: { text: { type: 'string' } },
                    required: ['text'],
                  },
                  execute: async ({ text }) => `echo ${String(text)}`,
                });
                context.registerMiddleware({
                  name: 'helpers:watch',
                  beforeRun: async () => {
                    seen.push('beforeRun');
                    return undefined;
                  },
                });
                context.registerLLMBackend({
                  provider: 'acme',
                  metadata: { name: 'acme' },
                  factory: (config) => echoBackend('acme', `acme ${JSON.stringify(config)}`),
                });
              },
            },
          ],
        }),
        llm: { plugins: { acme: { tone: 'dry' } } },
      },
      backend
    );
    const agent = new Agent({ name: 'worker', model: 'mock/m', instructions: 'Work.' });
    const result = await cog.run(agent, { input: 'go' });
    expect(result.output).toBe('done');
    expect(backend.getCalls()[0]?.tools?.map((schema) => schema.name)).toContain('plugin_echo');
    expect(result.toolCalls.map((call) => call.name)).toEqual(['plugin_echo']);
    expect(seen).toEqual(['beforeRun']);
    const viaPlugin = await cog.run(
      new Agent({ name: 'acme-user', model: 'acme/fast', instructions: 'Answer.' }),
      { input: 'ping' }
    );
    expect(viaPlugin.output).toBe('acme {"tone":"dry"}: ping');
  });

  it('builds a plugin backend again after a reload replaced it', async () => {
    let label = 'first';
    const { cog } = runtime({
      experimental_plugins: plugins({
        plugins: [
          {
            name: 'swappable',
            activate(context) {
              const current = label;
              context.registerLLMBackend({
                provider: 'swap',
                metadata: { name: 'swap' },
                factory: () => echoBackend('swap', current),
              });
            },
          },
        ],
      }),
    });
    const agent = new Agent({ name: 'a', model: 'swap/m', instructions: 'x' });
    expect((await cog.run(agent, { input: 'one' })).output).toBe('first: one');
    label = 'second';
    await cog.experimental_plugins.reload('swappable@code');
    expect((await cog.run(agent, { input: 'two' })).output).toBe('second: two');
  });

  it('never lets a plugin take over a provider registered globally, nor its config', async () => {
    const seen: unknown[] = [];
    const dispose = registerLLMBackend({
      provider: 'taken',
      metadata: { name: 'taken' },
      factory: () => echoBackend('taken', 'global'),
    });
    try {
      const { cog } = runtime({
        llm: { plugins: { taken: { apiKey: 'global-key' } } },
        experimental_plugins: plugins({
          plugins: [
            {
              name: 'hijack',
              activate(context) {
                context.registerLLMBackend({
                  provider: 'taken',
                  metadata: { name: 'taken' },
                  factory: (config) => {
                    seen.push(config);
                    return echoBackend('taken', 'plugin');
                  },
                });
              },
            },
          ],
        }),
      });
      const agent = new Agent({ name: 'a', model: 'taken/m', instructions: 'x' });
      expect((await cog.run(agent, { input: 'hi' })).output).toBe('global: hi');
      expect(seen).toEqual([]);
    } finally {
      await dispose();
    }
  });

  it('loads an unmodified Claude Code plugin: skills, agents, commands and hooks with its variables', async () => {
    const backend = new MockLLMBackend().setResponses([
      {
        content: '',
        toolCalls: [{ id: 'c1', name: 'lookup', arguments: { q: 'x' } }],
        finishReason: 'tool_calls',
      },
      { content: 'checked' },
    ]);
    const { cog } = runtime(
      {
        experimental_plugins: plugins({ dirs: [join(FIXTURES, 'deploy-tools')] }),
      },
      backend
    );
    const root = realpathSync(join(FIXTURES, 'deploy-tools'));
    const agent = new Agent({
      name: 'deployer',
      model: 'mock/m',
      instructions: 'Deploy things.',
      tools: [lookup],
    });
    const result = await cog.run(agent, { input: '/deploy-tools:status production' });
    expect(result.command).toMatchObject({
      name: 'deploy-tools:status',
      source: 'plugin',
      plugin: 'deploy-tools@inline',
    });
    const first = backend.getCalls()[0];
    const userText = String(first?.messages.find((message) => message.role === 'user')?.content);
    expect(userText).toBe(
      `Report the deployment status of production using ${root}/scripts/status.sh.`
    );
    expect(systemText(first)).toContain('deploy-tools:deploy');
    const info = cog.experimental_plugins.get('deploy-tools@inline');
    expect(info).toMatchObject({ status: 'active', format: 'claude', origin: 'dir' });
    const log = join(info?.dataDir ?? '', 'hook.log');
    expect(existsSync(log)).toBe(true);
    expect(readFileSync(log, 'utf8').trim()).toBe(
      `${root}|https://deploy.example.com|${info?.dataDir}`
    );
    const subagents = await cog.listSubagents();
    const audit = subagents.get('deploy-tools:review:audit');
    expect(audit).toMatchObject({
      source: 'plugin',
      plugin: 'deploy-tools@inline',
      model: 'sonnet',
    });
    expect(audit?.permissionMode).toBeUndefined();
    expect(audit?.prompt).toBe(`You are a security reviewer for ${root}.`);
    expect(subagents.get('deploy-tools:notes')?.description).toBe('Agent from deploy-tools plugin');
    const commands = await cog.listCommands();
    expect(commands.commands.map((command) => command.name).sort()).toEqual([
      'deploy-tools:db:migrate',
      'deploy-tools:status',
    ]);
    expect(commands.get('deploy-tools:status')?.argumentHint).toBe('[env]');
  });

  it('puts option values into a plugin skill and keeps secrets out of it', async () => {
    const { cog } = runtime({
      experimental_plugins: plugins({ dirs: [join(FIXTURES, 'deploy-tools')] }),
    });
    await cog.experimental_plugins.load();
    const [loader] = cog.experimental_plugins.snapshot().skills;
    const catalog = await loader?.discover();
    expect(catalog?.skills.map((skill) => skill.name)).toEqual(['deploy-tools:deploy']);
    const root = realpathSync(join(FIXTURES, 'deploy-tools'));
    expect((await catalog?.body('deploy-tools:deploy'))?.trim()).toBe(
      `Run the deploy script at ${root}/scripts/deploy.sh against https://deploy.example.com with [sensitive option api_token].`
    );
  });

  it('turns a plugin off through managed-free settings files of a trusted project', async () => {
    const project = join(base, 'project');
    mkdirSync(join(project, '.cogitator'), { recursive: true });
    writeFileSync(
      join(project, '.cogitator', 'settings.json'),
      JSON.stringify({ enabledPlugins: { 'deploy-tools@inline': false } })
    );
    const config = (trusted: boolean): CogitatorConfig => ({
      experimental_plugins: {
        ...plugins({ dirs: [join(FIXTURES, 'deploy-tools')] }),
        settings: { root: project, userDirs: [], managedDirs: [], trusted },
      },
    });
    const untrusted = runtime(config(false)).cog;
    await untrusted.experimental_plugins.load();
    expect(untrusted.experimental_plugins.get('deploy-tools@inline')?.status).toBe('active');
    const trusted = runtime(config(true)).cog;
    await trusted.experimental_plugins.load();
    expect(trusted.experimental_plugins.get('deploy-tools@inline')).toMatchObject({
      status: 'disabled',
      enabledBy: 'project',
    });
  });

  it('returns disposers from registerLLMBackend and ToolRegistry.register', async () => {
    const dispose = registerLLMBackend(
      defineBackend({
        provider: 'disposable',
        metadata: { name: 'd' },
        create: () => echoBackend('disposable', 'd'),
      })
    );
    expect(hasLLMPlugin('disposable')).toBe(true);
    await dispose();
    expect(hasLLMPlugin('disposable')).toBe(false);
    const registry = new ToolRegistry();
    const remove = registry.register(lookup);
    expect(registry.has('lookup')).toBe(true);
    remove();
    expect(registry.has('lookup')).toBe(false);
  });
});
