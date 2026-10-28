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
import { dirname, join, resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { MockLLMBackend, type MockChatResponse } from '@cogitator-ai/test-utils';
import type { ChatRequest, HookRunRecord, Message, Tool, ToolCall } from '@cogitator-ai/types';
import { Cogitator } from '../cogitator';
import { createHarnessAgent, harnessPrompt } from '../harness-agent/index';
import { tool } from '../tool';
import { recallToolOutputTool } from '../tools/recall-tool-output';
import { WORKSPACE_TOOL_NAMES, workspaceTools } from '../tools/workspace-tools';
import { LocalWorkspace } from '../workspace/local-workspace';

let dir: string;

beforeEach(() => {
  dir = realpathSync(mkdtempSync(join(tmpdir(), 'harness-agent-')));
});

afterEach(() => {
  vi.unstubAllEnvs();
  rmSync(dir, { recursive: true, force: true });
});

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

const sentTools = (request: ChatRequest | undefined): string[] =>
  (request?.tools ?? []).map((schema) => schema.name);

const systemPromptOf = (request: ChatRequest | undefined): string =>
  String(request?.messages.find((message: Message) => message.role === 'system')?.content ?? '');

const names = (tools: readonly Tool<unknown, unknown, unknown>[]): string[] =>
  tools.map((candidate) => candidate.name);

function extraTools(count: number): Tool[] {
  return Array.from({ length: count }, (_, index) =>
    tool({
      name: `extra_${index}`,
      description: `Extra tool number ${index}`,
      parameters: z.object({}),
      execute: async () => index,
    })
  );
}

function write(path: string, content: string): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content);
}

/** Keeps the user's own settings, subagents and commands out of a test */
function isolateHome(): void {
  const home = join(dir, 'home');
  mkdirSync(home, { recursive: true });
  vi.stubEnv('HOME', home);
  vi.stubEnv('CLAUDE_CONFIG_DIR', join(home, '.claude'));
}

describe('createHarnessAgent: the coding preset', () => {
  it('gives every workspace tool, todos, skills and permissions to the agent', () => {
    const harness = createHarnessAgent({ workspace: dir });
    const { agent } = harness;

    expect(harness.preset).toBe('coding');
    expect(agent.name).toBe('coder');
    expect(names(agent.tools)).toEqual(expect.arrayContaining([...WORKSPACE_TOOL_NAMES]));
    expect(agent.config).toMatchObject({
      todos: true,
      skills: [{}],
      permissions: {},
      maxIterations: 100,
    });
    expect(agent.config.workspace).toBe(harness.workspace);
    expect(harness.workspace).toBeInstanceOf(LocalWorkspace);
    expect(harness.workspace?.root).toBe(dir);
  });

  it('puts project instructions, subagents, commands, compaction and offload on the runtime', () => {
    const { config, runOptions } = createHarnessAgent({ workspace: dir });

    expect(config.instructions).toEqual({ projectFiles: true });
    expect(config.subagents).toMatchObject({
      files: { root: dir },
      approvalMode: 'bubble',
      agents: { 'general-purpose': expect.objectContaining({ description: expect.any(String) }) },
    });
    expect(config.commands).toMatchObject({ files: { root: dir } });
    expect(config.context).toMatchObject({ clearToolOutputs: true });
    expect(config.limits).toMatchObject({ maxToolResultLength: 30_000 });
    expect(config.permissions).toBeUndefined();
    expect(config.hooks).toBeUndefined();
    expect(config.memory).toBeUndefined();
    expect(runOptions).toMatchObject({ parallelToolCalls: true });
  });

  it('describes the workspace, the shell, todos, subagents and approvals in the system prompt', () => {
    const { agent } = createHarnessAgent({ workspace: dir });

    expect(agent.instructions).toMatch(/^You are a coding agent/);
    for (const heading of ['## Workspace', '## Planning', '## Subagents', '## Approvals']) {
      expect(agent.instructions).toContain(heading);
    }
    expect(agent.instructions).toContain('run_command');
    expect(agent.instructions).toContain('saved to a file of the workspace');
    expect(agent.instructions).not.toContain('## More tools');
    expect(agent.instructions).not.toContain(dir);
  });
});

describe('createHarnessAgent: the assistant preset', () => {
  it('has no shell, subagents, commands or project instructions', () => {
    const harness = createHarnessAgent({ preset: 'assistant', workspace: dir });

    expect(harness.agent.name).toBe('assistant');
    expect(names(harness.agent.tools)).not.toContain('run_command');
    expect(names(harness.agent.tools)).toContain('write_file');
    expect(harness.agent.config.maxIterations).toBe(30);
    expect(harness.config.subagents).toBeUndefined();
    expect(harness.config.commands).toBeUndefined();
    expect(harness.config.instructions).toBeUndefined();
    expect(harness.agent.instructions).not.toContain('run_command');
    expect(harness.agent.instructions).not.toContain('## Subagents');
    expect(harness.agent.instructions).toContain('## Planning');
  });

  it('keeps memory files whenever the runtime has a memory adapter, here or in the base', () => {
    const harness = createHarnessAgent({ preset: 'assistant', memory: { adapter: 'memory' } });
    expect(harness.workspace?.root).toBe(resolve('workspace'));
    expect(harness.config.memory).toEqual({ adapter: 'memory', files: { scope: 'user' } });

    const plain = createHarnessAgent({ preset: 'assistant', workspace: dir });
    expect(plain.config.memory).toBeUndefined();
    expect(plain.mergeConfig({ memory: { adapter: 'memory' } }).memory).toEqual({
      adapter: 'memory',
      files: { scope: 'user' },
    });
    expect(
      plain.mergeConfig({ memory: { adapter: 'memory', files: { scope: 'thread' } } }).memory?.files
    ).toEqual({ scope: 'thread' });
    expect(
      createHarnessAgent({ workspace: dir }).mergeConfig({ memory: { adapter: 'memory' } }).memory
    ).toEqual({ adapter: 'memory' });
  });

  it('turns pieces of the coding preset on when asked', () => {
    const harness = createHarnessAgent({
      preset: 'assistant',
      workspace: dir,
      shell: true,
      subagents: true,
      projectInstructions: { files: ['AGENTS.md'] },
    });
    expect(names(harness.agent.tools)).toContain('run_command');
    expect(harness.config.subagents?.agents?.['general-purpose']).toBeDefined();
    expect(harness.config.instructions).toEqual({ projectFiles: { files: ['AGENTS.md'] } });
  });
});

describe('createHarnessAgent: overrides', () => {
  it('replaces a harness tool with one of the same name and adds the others', () => {
    const readFile = tool({
      name: 'read_file',
      description: 'My own reader',
      parameters: z.object({ path: z.string() }),
      execute: async () => 'mine',
    });
    const [extra] = extraTools(1);
    const { agent } = createHarnessAgent({ workspace: dir, tools: [readFile, extra!] });

    expect(agent.tools.filter((candidate) => candidate.name === 'read_file')).toEqual([readFile]);
    expect(agent.tools).toContain(extra);
  });

  it('takes instructions, the prompt switch, the agent escape hatch and limits', () => {
    const harness = createHarnessAgent({
      workspace: dir,
      name: 'fixer',
      model: 'mock/m',
      instructions: 'You fix bugs.',
      maxIterations: 7,
      timeouts: { toolMs: 1000 },
      agent: { temperature: 0.1 },
    });
    expect(harness.agent.name).toBe('fixer');
    expect(harness.agent.model).toBe('mock/m');
    expect(harness.agent.instructions).toMatch(/^You fix bugs\.\n\n## Workspace/);
    expect(harness.agent.config).toMatchObject({
      maxIterations: 7,
      timeouts: { toolMs: 1000 },
      temperature: 0.1,
    });

    const bare = createHarnessAgent({
      workspace: dir,
      instructions: 'Bare.',
      harnessPrompt: false,
    });
    expect(bare.agent.instructions).toBe('Bare.');
  });

  it('turns off workspace tools, the workspace, todos, skills, subagents, commands and compaction', () => {
    const harness = createHarnessAgent({
      workspace: false,
      workspaceTools: false,
      todos: false,
      skills: false,
      subagents: false,
      commands: false,
      projectInstructions: false,
      compaction: false,
      parallelToolCalls: false,
      permissions: false,
    });
    expect(harness.workspace).toBeUndefined();
    expect(harness.agent.tools).toEqual([]);
    expect(harness.agent.config.workspace).toBeUndefined();
    expect(harness.agent.config.todos).toBeUndefined();
    expect(harness.agent.config.skills).toBeUndefined();
    expect(harness.agent.config.permissions).toBeUndefined();
    for (const piece of ['subagents', 'commands', 'context', 'permissions', 'hooks'] as const) {
      expect(harness.config[piece], piece).toBeUndefined();
    }
    expect(harness.config.instructions).toEqual({ projectFiles: false });
    expect(harness.runOptions.parallelToolCalls).toBeUndefined();
    expect(harness.agent.instructions).not.toContain('##');
  });

  it('keeps the approvals section without permissions while a tool needs approval', () => {
    const { agent } = createHarnessAgent({ workspace: dir, permissions: false });
    expect(agent.config.permissions).toBeUndefined();
    expect(agent.instructions).toContain('## Approvals');
    const quiet = createHarnessAgent({ workspace: dir, permissions: false, shell: false });
    expect(quiet.agent.instructions).not.toContain('## Approvals');
  });

  it('splits permissions between the agent and the runtime', () => {
    const classifier = { classify: async () => ({ decision: 'allow' as const, reason: 'ok' }) };
    const harness = createHarnessAgent({
      workspace: dir,
      permissions: {
        mode: 'auto',
        allow: ['Bash(npm test *)'],
        deny: ['Read(.env)'],
        classifier,
        rememberIn: 'session',
      },
    });
    expect(harness.agent.config.permissions).toEqual({
      mode: 'auto',
      allow: ['Bash(npm test *)'],
      deny: ['Read(.env)'],
    });
    expect(harness.config.permissions).toMatchObject({ classifier, rememberIn: 'session' });
    expect(harness.config.permissions?.settings).toBeUndefined();
  });

  it('reads settings files at the project root and trusts the project only when asked', () => {
    const untrusted = createHarnessAgent({ workspace: dir, settings: true });
    expect(untrusted.config.permissions?.settings).toEqual({ root: dir, trusted: false });
    expect(untrusted.config.hooks?.settings).toEqual({ root: dir, trusted: false });
    expect(untrusted.config.subagents?.files).toEqual({ root: dir });

    const trusted = createHarnessAgent({ workspace: dir, settings: true, trusted: true });
    expect(trusted.config.permissions?.settings).toEqual({ root: dir, trusted: true });
    expect(trusted.config.subagents?.files).toEqual({ root: dir, trusted: true });
    expect(trusted.config.commands?.files).toEqual({ root: dir, trusted: true });

    const own = createHarnessAgent({
      workspace: dir,
      settings: true,
      permissions: { settings: { root: '/elsewhere' } },
      hooks: { settings: false },
    });
    expect(own.config.permissions?.settings).toEqual({ root: '/elsewhere' });
    expect(own.config.hooks?.settings).toBe(false);
  });

  it('reads hooks but leaves the permission engine off with permissions: false', () => {
    const harness = createHarnessAgent({ workspace: dir, settings: true, permissions: false });
    expect(harness.config.permissions).toBeUndefined();
    expect(harness.agent.config.permissions).toBeUndefined();
    expect(harness.config.hooks?.settings).toEqual({ root: dir, trusted: false });
  });

  it('reads the project files of projectRoot, and none without one', () => {
    const elsewhere = join(dir, 'checkout');
    const custom = createHarnessAgent({
      workspace: join(dir, 'ws'),
      projectRoot: elsewhere,
      trusted: true,
      settings: true,
    });
    expect(custom.config.subagents?.files).toEqual({ root: elsewhere, trusted: true });
    expect(custom.config.permissions?.settings).toEqual({ root: elsewhere, trusted: true });

    const none = createHarnessAgent({
      workspace: dir,
      projectRoot: false,
      trusted: true,
      settings: true,
    });
    expect(none.config.subagents?.files).toBe(true);
    expect(none.config.commands?.files).toBe(true);
    expect(none.config.permissions?.settings).toEqual({ layers: ['managed', 'user'] });
    expect(none.config.hooks?.settings).toEqual({ layers: ['managed', 'user'] });
  });

  it('merges subagents and commands over the preset defaults, agents by name', () => {
    const harness = createHarnessAgent({
      workspace: dir,
      subagents: {
        approvalMode: 'decline',
        agents: {
          reviewer: { description: 'Reviews code', prompt: 'Review.' },
          'general-purpose': { description: 'Does anything', model: 'mock/fast' },
        },
      },
      commands: { commands: { hello: 'Say hello to $ARGUMENTS' } },
    });
    expect(harness.config.subagents?.approvalMode).toBe('decline');
    expect(harness.config.subagents?.agents?.reviewer).toEqual({
      description: 'Reviews code',
      prompt: 'Review.',
    });
    expect(harness.config.subagents?.agents?.['general-purpose']).toMatchObject({
      description: 'Does anything',
      model: 'mock/fast',
      prompt: expect.stringContaining('another agent handed you'),
    });
    expect(harness.config.commands).toMatchObject({
      files: { root: dir },
      commands: { hello: 'Say hello to $ARGUMENTS' },
    });
  });

  it('passes budget, hooks, compaction, tool result limits and parallelism through', () => {
    const harness = createHarnessAgent({
      workspace: dir,
      budget: { session: { maxCostUsd: 2 } },
      hooks: { hooks: { Stop: [] } },
      compaction: { strategy: 'truncate' },
      toolResults: { maxLength: 5000, retention: 60_000 },
      parallelToolCalls: 4,
    });
    expect(harness.config.budget).toEqual({ session: { maxCostUsd: 2 } });
    expect(harness.config.hooks).toEqual({ hooks: { Stop: [] } });
    expect(harness.config.context).toMatchObject({ clearToolOutputs: true, strategy: 'truncate' });
    expect(harness.config.limits).toMatchObject({
      maxToolResultLength: 5000,
      toolResultRetention: 60_000,
    });
    expect(harness.runOptions).toMatchObject({ parallelToolCalls: true, maxParallelToolCalls: 4 });
  });

  it('takes skill sources as a registry configuration or a list', () => {
    const skillsDir = join(dir, 'skills');
    expect(
      createHarnessAgent({ workspace: dir, skills: { dirs: [skillsDir] } }).agent.config.skills
    ).toEqual([{ dirs: [skillsDir] }]);
    const list = [{ dirs: [skillsDir] }, { user: true }];
    expect(createHarnessAgent({ workspace: dir, skills: list }).agent.config.skills).toEqual(list);
  });

  it('refuses a cap of parallel calls that is not a whole number of 1 or more', () => {
    for (const cap of [0, -1, 1.5, Number.NaN]) {
      expect(() => createHarnessAgent({ workspace: dir, parallelToolCalls: cap })).toThrow(
        'parallelToolCalls must be a boolean or a whole number of calls, 1 or more'
      );
    }
  });

  it('refuses an unknown preset', () => {
    expect(() => createHarnessAgent({ preset: 'chat' as 'coding' })).toThrow(
      'Unknown harness preset "chat"'
    );
  });
});

describe('createHarnessAgent: tool_search', () => {
  it('counts every tool the model sees, the built-in ones too, against the threshold', () => {
    const few = createHarnessAgent({ workspace: dir, tools: extraTools(4) });
    expect(few.agent.config.deferredTools).toBeUndefined();

    const many = createHarnessAgent({ workspace: dir, tools: extraTools(5) });
    expect(many.agent.config.deferredTools).toEqual(names(extraTools(5)));
    expect(many.agent.instructions).toContain('## More tools');

    const lean = createHarnessAgent({
      workspace: dir,
      tools: extraTools(5),
      subagents: false,
      skills: false,
    });
    expect(lean.agent.config.deferredTools).toBeUndefined();
  });

  it('defers by name without copying or changing a tool', () => {
    const tools = extraTools(3);
    const harness = createHarnessAgent({ workspace: dir, tools, toolSearch: true });
    for (const original of tools) {
      expect(harness.agent.tools).toContain(original);
      expect(original.deferred).toBeUndefined();
    }
    expect(harness.agent.config.deferredTools).toEqual(names(tools));
  });

  it('keeps the tools named in keep, the workspace tools and recall_tool_output', () => {
    const recall = recallToolOutputTool(undefined, () => undefined);
    const [reader] = workspaceTools(undefined, { tools: ['read_file'] });
    const harness = createHarnessAgent({
      workspace: dir,
      workspaceTools: false,
      tools: [...extraTools(3), recall, reader!],
      toolSearch: { threshold: 0, keep: ['extra_1'] },
    });
    expect(harness.agent.config.deferredTools).toEqual(['extra_0', 'extra_2']);
  });

  it('defers always with true and never with false', () => {
    const always = createHarnessAgent({ workspace: dir, tools: extraTools(1), toolSearch: true });
    expect(always.agent.config.deferredTools).toEqual(['extra_0']);
    const never = createHarnessAgent({ workspace: dir, tools: extraTools(30), toolSearch: false });
    expect(never.agent.config.deferredTools).toBeUndefined();
  });
});

describe('createHarnessAgent: mergeConfig', () => {
  it('puts the base over the preset defaults and your options over the base', () => {
    const harness = createHarnessAgent({
      workspace: dir,
      budget: { warnAt: 0.5 },
      toolResults: { retention: 1000 },
      subagents: { agents: { reviewer: { description: 'Reviews' } } },
    });
    const merged = harness.mergeConfig({
      llm: { defaultModel: 'mock/m' },
      limits: { maxConcurrentRuns: 2, maxToolResultLength: 50_000, toolResultRetention: 5 },
      context: { clearToolOutputs: false, strategy: 'truncate' },
      instructions: { projectFiles: { files: ['AGENTS.md'] } },
      memory: { adapter: 'memory' },
      budget: { session: { maxTokens: 10 }, warnAt: 0.9 },
      subagents: {
        maxDepth: 1,
        agents: { researcher: { description: 'Researches' } },
        files: { root: '/srv/repo', userDirs: [] },
      },
    });
    expect(merged.llm).toEqual({ defaultModel: 'mock/m' });
    expect(merged.limits).toEqual({
      maxConcurrentRuns: 2,
      maxToolResultLength: 50_000,
      toolResultRetention: 1000,
    });
    expect(merged.context).toEqual({ clearToolOutputs: false, strategy: 'truncate' });
    expect(merged.instructions).toEqual({ projectFiles: { files: ['AGENTS.md'] } });
    expect(merged.memory).toEqual({ adapter: 'memory' });
    expect(merged.budget).toEqual({ session: { maxTokens: 10 }, warnAt: 0.5 });
    expect(merged.subagents).toMatchObject({
      maxDepth: 1,
      approvalMode: 'bubble',
      files: { root: '/srv/repo', userDirs: [] },
    });
    expect(Object.keys(merged.subagents?.agents ?? {}).sort()).toEqual([
      'general-purpose',
      'researcher',
      'reviewer',
    ]);
    expect(harness.mergeConfig()).toEqual(harness.config);
  });

  it('keeps a piece you turned off with false off, whatever the base enables', async () => {
    const base = {
      llm: { defaultModel: 'mock/m' },
      subagents: { files: true, agents: { helper: { description: 'Helps' } } },
      commands: { commands: { hello: 'Say hello' } },
      permissions: { mode: 'acceptEdits' as const, settings: true },
      hooks: { settings: true, hooks: { Stop: [] } },
      context: { clearToolOutputs: true },
      memory: { adapter: 'memory' as const, files: { scope: 'user' as const } },
      limits: { maxConcurrentRuns: 3 },
    };
    const off = createHarnessAgent({
      preset: 'assistant',
      workspace: dir,
      subagents: false,
      commands: false,
      permissions: false,
      hooks: false,
      compaction: false,
      memoryFiles: false,
    }).mergeConfig(base);
    for (const piece of ['subagents', 'commands', 'permissions', 'hooks', 'context'] as const) {
      expect(off[piece], piece).toBeUndefined();
    }
    expect(off.memory).toEqual({ adapter: 'memory' });
    expect(off.llm).toEqual(base.llm);
    expect(off.limits).toMatchObject({ maxConcurrentRuns: 3 });

    const noSettings = createHarnessAgent({ workspace: dir, settings: false }).mergeConfig(base);
    expect(noSettings.permissions).toEqual({ mode: 'acceptEdits' });
    expect(noSettings.hooks).toEqual({ hooks: { Stop: [] } });

    const kept = createHarnessAgent({ preset: 'assistant', workspace: dir }).mergeConfig(base);
    expect(kept.subagents).toMatchObject({ agents: { helper: { description: 'Helps' } } });
    expect(kept.commands).toMatchObject({ commands: { hello: 'Say hello' } });

    const cog = new Cogitator(off);
    try {
      expect((await cog.listSubagents()).agents).toEqual([]);
      expect((await cog.listCommands()).commands).toEqual([]);
    } finally {
      await cog.close();
    }
  });

  it('replaces arrays and class instances instead of merging them', () => {
    const adapter = new MockLLMBackend();
    const harness = createHarnessAgent({
      workspace: dir,
      permissions: { rememberLayers: ['session'] },
    });
    const merged = harness.mergeConfig({
      llm: { backends: { mock: adapter } },
      permissions: { rememberLayers: ['local', 'session'], rememberIn: 'local' },
    });
    expect(merged.llm?.backends?.mock).toBe(adapter);
    expect(merged.permissions).toEqual({ rememberLayers: ['session'], rememberIn: 'local' });
  });
});

describe('createHarnessAgent: the result', () => {
  it('disposes a workspace it made, never one you passed', async () => {
    const owned = createHarnessAgent({ workspace: join(dir, 'owned') });
    await owned.workspace?.start();
    await owned.dispose();
    await expect(owned.workspace?.read('x.txt')).rejects.toThrow();

    const yours = new LocalWorkspace({ root: join(dir, 'yours') });
    const harness = createHarnessAgent({ workspace: yours });
    expect(harness.workspace).toBe(yours);
    await harness.dispose();
    await yours.write('x.txt', 'still open');
    expect(await yours.read('x.txt')).toBe('still open');
    await yours.dispose();
  });

  it('makes a LocalWorkspace from its options', () => {
    const harness = createHarnessAgent({ workspace: { root: dir, cwd: 'src' } });
    expect(harness.workspace?.root).toBe(dir);
    expect(harness.workspace?.cwd).toBe('src');
  });
});

describe('harnessPrompt', () => {
  it('is empty for an agent without harness pieces', () => {
    expect(harnessPrompt({ workspaceTools: [] })).toBe('');
  });

  it('mentions only the tools the agent has', () => {
    const prompt = harnessPrompt({ workspaceTools: ['read_file', 'list_files'] });
    expect(prompt).toContain('List a directory with list_files');
    expect(prompt).toContain('Read files with read_file.');
    expect(prompt).not.toContain('grep');
    expect(prompt).not.toContain('edit_file');
  });
});

describe('a harness agent in a run (MockLLMBackend)', () => {
  it('writes, reads and plans in its workspace with project instructions in the prompt', async () => {
    const root = join(dir, 'project');
    write(join(root, 'AGENTS.md'), 'Always write notes in English.\n');
    const backend = new MockLLMBackend().setResponses([
      turn(
        call('t1', 'write_todos', {
          todos: [{ id: 'note', content: 'Write the note', status: 'in_progress' }],
        })
      ),
      turn(call('w1', 'write_file', { path: 'notes.md', content: 'hello' })),
      turn(call('r1', 'read_file', { path: 'notes.md' }), call('g1', 'glob', { pattern: '*.md' })),
      { content: 'Done.' },
    ]);
    const harness = createHarnessAgent({ workspace: root, model: 'mock/m' });
    const cog = new Cogitator(
      harness.mergeConfig({ llm: { backends: { mock: backend }, retry: false } })
    );
    const approvals: string[] = [];
    try {
      const result = await cog.run(harness.agent, {
        input: 'Write a note',
        ...harness.runOptions,
        onApproval: (request) => {
          approvals.push(request.toolName);
          return { approved: true };
        },
      });

      expect(result.output).toBe('Done.');
      expect(readFileSync(join(root, 'notes.md'), 'utf8')).toBe('hello');
      expect(approvals).toEqual(['write_file']);
      expect(result.todos).toEqual([
        { id: 'note', content: 'Write the note', status: 'in_progress' },
      ]);
      const first = backend.getCalls()[0];
      expect(sentTools(first)).toEqual(
        expect.arrayContaining([...WORKSPACE_TOOL_NAMES, 'write_todos', 'agent'])
      );
      const system = systemPromptOf(first);
      expect(system).toContain('## Workspace');
      expect(system).toContain('Always write notes in English.');
      expect(result.instructions?.map((file) => file.path)).toEqual(['AGENTS.md']);
      expect(result.toolCalls.map((entry) => entry.name)).toContain('read_file');
    } finally {
      await cog.close();
      await harness.dispose();
    }
  });

  it('runs without asking in acceptEdits mode and refuses what a deny rule names', async () => {
    const root = join(dir, 'project');
    const backend = new MockLLMBackend().setResponses([
      turn(
        call('w1', 'write_file', { path: 'a.txt', content: 'a' }),
        call('w2', 'write_file', { path: 'secret.txt', content: 's' })
      ),
      { content: 'Done.' },
    ]);
    const harness = createHarnessAgent({
      preset: 'assistant',
      workspace: root,
      model: 'mock/m',
      permissions: { mode: 'acceptEdits', deny: ['Edit(secret.txt)'] },
    });
    const cog = new Cogitator(
      harness.mergeConfig({ llm: { backends: { mock: backend }, retry: false } })
    );
    try {
      const result = await cog.run(harness.agent, { input: 'Write', ...harness.runOptions });
      expect(result.output).toBe('Done.');
      expect(readFileSync(join(root, 'a.txt'), 'utf8')).toBe('a');
      expect(existsSync(join(root, 'secret.txt'))).toBe(false);
    } finally {
      await cog.close();
      await harness.dispose();
    }
  });

  it('sends deferred tools only after tool_search finds them, the tools left as they are', async () => {
    const backend = new MockLLMBackend().setResponses([
      turn(call('s1', 'tool_search', { query: 'extra tool number 3' })),
      { content: 'Found it.' },
    ]);
    const tools = extraTools(25);
    const harness = createHarnessAgent({
      workspace: join(dir, 'project'),
      model: 'mock/m',
      tools,
      subagents: false,
    });
    const cog = new Cogitator(
      harness.mergeConfig({ llm: { backends: { mock: backend }, retry: false } })
    );
    try {
      await cog.run(harness.agent, { input: 'Find the tool', ...harness.runOptions });
      const [first, second] = backend.getCalls();
      expect(sentTools(first)).toEqual(
        expect.arrayContaining([...WORKSPACE_TOOL_NAMES, 'tool_search', 'write_todos'])
      );
      expect(sentTools(first).some((name) => name.startsWith('extra_'))).toBe(false);
      expect(sentTools(second)).toContain('extra_3');
      expect(tools.every((candidate) => candidate.deferred === undefined)).toBe(true);
    } finally {
      await cog.close();
      await harness.dispose();
    }
  });
});

describe('a harness agent with a project that is not the working directory', () => {
  function project(): string {
    isolateHome();
    const root = join(dir, 'repo');
    write(
      join(root, '.claude/agents/reviewer.md'),
      '---\nname: reviewer\ndescription: Reviews code ZZREVIEWER\n---\nYou review.\n'
    );
    write(
      join(root, '.claude/commands/hello.md'),
      '---\ndescription: hi\n---\nSAY ZZCMD $ARGUMENTS\n'
    );
    write(
      join(root, '.claude/settings.json'),
      JSON.stringify({
        permissions: { allow: ['Bash(echo *)'] },
        hooks: { UserPromptSubmit: [{ hooks: [{ type: 'command', command: 'true' }] }] },
      })
    );
    expect(resolve(process.cwd())).not.toBe(root);
    return root;
  }

  async function runIn(root: string, trusted: boolean) {
    const backend = new MockLLMBackend().setResponses([
      turn(call('c1', 'run_command', { command: 'echo hi' })),
      { content: 'Done.' },
    ]);
    const hookRuns: HookRunRecord[] = [];
    const harness = createHarnessAgent({
      workspace: root,
      model: 'mock/m',
      trusted,
      settings: true,
      hooks: { onHookRun: (run) => hookRuns.push(run) },
    });
    const cog = new Cogitator(
      harness.mergeConfig({ llm: { backends: { mock: backend }, retry: false } })
    );
    const asked: string[] = [];
    try {
      const subagents = await cog.listSubagents();
      const commands = await cog.listCommands();
      const result = await cog.run(harness.agent, {
        input: '/hello world',
        ...harness.runOptions,
        onApproval: (request) => {
          asked.push(request.toolName);
          return { approved: true };
        },
      });
      const first = backend.getCalls()[0];
      const agentTool = JSON.stringify(first?.tools?.find((schema) => schema.name === 'agent'));
      return {
        subagents: subagents.agents.map((agent) => agent.name),
        commands: commands.commands.map((command) => command.name),
        expanded: result.command?.input,
        listedToModel: agentTool.includes('ZZREVIEWER'),
        hooks: hookRuns.map((run) => run.event),
        asked,
      };
    } finally {
      await cog.close();
      await harness.dispose();
    }
  }

  it('reads the subagents, commands, hooks and allow rules of a trusted project', async () => {
    const seen = await runIn(project(), true);
    expect(seen.subagents).toEqual(expect.arrayContaining(['reviewer', 'general-purpose']));
    expect(seen.commands).toContain('hello');
    expect(seen.expanded).toContain('SAY ZZCMD world');
    expect(seen.listedToModel).toBe(true);
    expect(seen.hooks).toContain('UserPromptSubmit');
    expect(seen.asked).toEqual([]);
  });

  it('reads none of them from an untrusted project', async () => {
    const seen = await runIn(project(), false);
    expect(seen.subagents).not.toContain('reviewer');
    expect(seen.commands).not.toContain('hello');
    expect(seen.expanded).toBeUndefined();
    expect(seen.listedToModel).toBe(false);
    expect(seen.hooks).not.toContain('UserPromptSubmit');
    expect(seen.asked).toEqual(['run_command']);
  });
});
