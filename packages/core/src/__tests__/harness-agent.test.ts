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
import { join, resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { MockLLMBackend, type MockChatResponse } from '@cogitator-ai/test-utils';
import type { ChatRequest, Message, Tool, ToolCall } from '@cogitator-ai/types';
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
  (request?.tools ?? []).map((schema) => schema.name).sort();

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

describe('createHarnessAgent: the coding preset', () => {
  it('gives every workspace tool, todos, skills and permissions to the agent', () => {
    const harness = createHarnessAgent({ workspace: dir });
    const { agent } = harness;

    expect(harness.preset).toBe('coding');
    expect(agent.name).toBe('coder');
    expect(names(agent.tools)).toEqual([...WORKSPACE_TOOL_NAMES]);
    expect(agent.config.todos).toBe(true);
    expect(agent.config.skills).toEqual([{}]);
    expect(agent.config.permissions).toEqual({});
    expect(agent.config.maxIterations).toBe(100);
    expect(agent.config.workspace).toBe(harness.workspace);
    expect(harness.workspace).toBeInstanceOf(LocalWorkspace);
    expect(harness.workspace?.root).toBe(dir);
  });

  it('puts project instructions, subagents, commands, compaction and offload on the runtime', () => {
    const { config, runOptions } = createHarnessAgent({ workspace: dir });

    expect(config.instructions).toEqual({ projectFiles: true });
    expect(config.subagents?.files).toBe(true);
    expect(config.subagents?.approvalMode).toBe('bubble');
    expect(Object.keys(config.subagents?.agents ?? {})).toEqual(['general-purpose']);
    expect(config.commands).toEqual({ files: true });
    expect(config.context).toEqual({ clearToolOutputs: true });
    expect(config.limits).toEqual({ maxToolResultLength: 30_000 });
    expect(config.permissions).toBeUndefined();
    expect(config.hooks).toBeUndefined();
    expect(config.memory).toBeUndefined();
    expect(runOptions).toEqual({ parallelToolCalls: true });
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

  it('works in ./workspace by default and keeps memory files when the runtime has memory', () => {
    const harness = createHarnessAgent({
      preset: 'assistant',
      memory: { adapter: 'memory' },
    });
    expect(harness.workspace?.root).toBe(resolve('workspace'));
    expect(harness.config.memory).toEqual({ adapter: 'memory', files: { scope: 'user' } });
    expect(
      createHarnessAgent({
        preset: 'assistant',
        workspace: dir,
        memory: { adapter: 'memory', files: { scope: 'thread' } },
      }).config.memory?.files
    ).toEqual({ scope: 'thread' });
    expect(
      createHarnessAgent({ preset: 'assistant', workspace: dir }).config.memory
    ).toBeUndefined();
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
    expect(names(agent.tools)).toContain('extra_0');
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
    expect(harness.agent.config.maxIterations).toBe(7);
    expect(harness.agent.config.timeouts).toEqual({ toolMs: 1000 });
    expect(harness.agent.config.temperature).toBe(0.1);

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
    expect(harness.config).toEqual({ limits: { maxToolResultLength: 30_000 } });
    expect(harness.runOptions).toEqual({});
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
    expect(harness.config.permissions).toEqual({ classifier, rememberIn: 'session' });
  });

  it('reads settings files and trusts the project only when asked', () => {
    const untrusted = createHarnessAgent({ workspace: dir, settings: true });
    expect(untrusted.config.permissions?.settings).toEqual({ root: dir, trusted: false });
    expect(untrusted.config.hooks?.settings).toEqual({ root: dir, trusted: false });

    const trusted = createHarnessAgent({ workspace: dir, settings: true, trusted: true });
    expect(trusted.config.permissions?.settings).toEqual({ root: dir, trusted: true });
    expect(trusted.config.subagents?.files).toEqual({ trusted: true });
    expect(trusted.config.commands?.files).toEqual({ trusted: true });

    const own = createHarnessAgent({
      workspace: dir,
      settings: true,
      permissions: { settings: { root: '/elsewhere' } },
      hooks: { settings: false },
    });
    expect(own.config.permissions?.settings).toEqual({ root: '/elsewhere' });
    expect(own.config.hooks?.settings).toBe(false);
  });

  it('merges subagents and commands over the preset defaults', () => {
    const harness = createHarnessAgent({
      workspace: dir,
      subagents: {
        approvalMode: 'decline',
        agents: { reviewer: { description: 'Reviews code', prompt: 'Review.' } },
      },
      commands: { commands: { hello: 'Say hello to $ARGUMENTS' } },
    });
    expect(harness.config.subagents?.approvalMode).toBe('decline');
    expect(Object.keys(harness.config.subagents?.agents ?? {})).toEqual([
      'general-purpose',
      'reviewer',
    ]);
    expect(harness.config.commands).toEqual({
      files: true,
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
    expect(harness.config.context).toEqual({ clearToolOutputs: true, strategy: 'truncate' });
    expect(harness.config.limits).toEqual({
      maxToolResultLength: 5000,
      toolResultRetention: 60_000,
    });
    expect(harness.runOptions).toEqual({ parallelToolCalls: true, maxParallelToolCalls: 4 });
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
  it('defers your tools once the agent would have more than 20, but not the harness tools', () => {
    const few = createHarnessAgent({ workspace: dir, tools: extraTools(13) });
    expect(few.agent.tools.some((candidate) => candidate.deferred)).toBe(false);

    const many = createHarnessAgent({ workspace: dir, tools: extraTools(14) });
    const deferred = many.agent.tools.filter((candidate) => candidate.deferred);
    expect(names(deferred)).toEqual(names(extraTools(14)));
    expect(many.agent.instructions).toContain('## More tools');
  });

  it('keeps the tools named in keep and the ones the runtime knows by identity', () => {
    const recall = recallToolOutputTool(undefined, () => undefined);
    const [reader] = workspaceTools(undefined, { tools: ['read_file'] });
    const harness = createHarnessAgent({
      workspace: dir,
      workspaceTools: false,
      tools: [...extraTools(3), recall, reader!],
      toolSearch: { threshold: 0, keep: ['extra_1'] },
    });
    const byName = new Map(harness.agent.tools.map((candidate) => [candidate.name, candidate]));
    expect(byName.get('extra_0')?.deferred).toBe(true);
    expect(byName.get('extra_1')?.deferred).toBeUndefined();
    expect(byName.get(recall.name)).toBe(recall);
    expect(byName.get('read_file')).toBe(reader);
  });

  it('defers always with true and never with false', () => {
    const always = createHarnessAgent({ workspace: dir, tools: extraTools(1), toolSearch: true });
    expect(always.agent.tools.find((candidate) => candidate.name === 'extra_0')?.deferred).toBe(
      true
    );
    const never = createHarnessAgent({ workspace: dir, tools: extraTools(30), toolSearch: false });
    expect(never.agent.tools.some((candidate) => candidate.deferred)).toBe(false);
  });

  it('copies a deferred tool without changing the one you passed', async () => {
    const [extra] = extraTools(1);
    const harness = createHarnessAgent({ workspace: dir, tools: [extra!], toolSearch: true });
    const copy = harness.agent.tools.find((candidate) => candidate.name === 'extra_0');
    expect(extra!.deferred).toBeUndefined();
    expect(copy).not.toBe(extra);
    expect(copy?.toJSON().name).toBe('extra_0');
    await expect(
      copy?.execute({}, { agentId: 'a', runId: 'r', signal: new AbortController().signal })
    ).resolves.toBe(0);
  });
});

describe('createHarnessAgent: the result', () => {
  it('merges its config into a base config one level deep', () => {
    const harness = createHarnessAgent({ workspace: dir, budget: { warnAt: 0.5 } });
    const merged = harness.mergeConfig({
      llm: { defaultModel: 'mock/m' },
      limits: { maxConcurrentRuns: 2, maxToolResultLength: 1 },
      memory: { adapter: 'memory' },
      budget: { session: { maxTokens: 10 } },
    });
    expect(merged.llm).toEqual({ defaultModel: 'mock/m' });
    expect(merged.limits).toEqual({ maxConcurrentRuns: 2, maxToolResultLength: 30_000 });
    expect(merged.memory).toEqual({ adapter: 'memory' });
    expect(merged.budget).toEqual({ session: { maxTokens: 10 }, warnAt: 0.5 });
    expect(merged.subagents).toBe(harness.config.subagents);
    expect(harness.mergeConfig()).toEqual(harness.config);
  });

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
    mkdirSync(root, { recursive: true });
    writeFileSync(join(root, 'AGENTS.md'), 'Always write notes in English.\n');
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
        [
          ...WORKSPACE_TOOL_NAMES,
          'write_todos',
          'recall_tool_output',
          'agent',
          'send_message',
          'task_output',
          'task_stop',
        ].sort()
      );
      const system = systemPromptOf(first);
      expect(system).toContain('## Workspace');
      expect(system).toContain('Always write notes in English.');
      expect(result.instructions?.map((file) => file.path)).toEqual(['AGENTS.md']);
      const read = result.toolCalls.find((entry) => entry.name === 'read_file');
      expect(read).toBeDefined();
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

  it('sends deferred tools only after tool_search finds them', async () => {
    const backend = new MockLLMBackend().setResponses([
      turn(call('s1', 'tool_search', { query: 'extra tool number 3' })),
      { content: 'Found it.' },
    ]);
    const harness = createHarnessAgent({
      workspace: join(dir, 'project'),
      model: 'mock/m',
      tools: extraTools(25),
      subagents: false,
    });
    const cog = new Cogitator(
      harness.mergeConfig({ llm: { backends: { mock: backend }, retry: false } })
    );
    try {
      await cog.run(harness.agent, { input: 'Find the tool', ...harness.runOptions });
      const [first, second] = backend.getCalls();
      expect(sentTools(first)).toEqual(
        [...WORKSPACE_TOOL_NAMES, 'tool_search', 'write_todos', 'recall_tool_output'].sort()
      );
      expect(sentTools(second)).toContain('extra_3');
    } finally {
      await cog.close();
      await harness.dispose();
    }
  });
});
