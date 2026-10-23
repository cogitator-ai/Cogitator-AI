import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { z } from 'zod';
import {
  Agent,
  Cogitator,
  LocalWorkspace,
  SkillRegistry,
  renderTodos,
  tool,
  workspaceTools,
} from '@cogitator-ai/core';
import { MockLLMBackend } from '@cogitator-ai/test-utils';
import type { Message, TodoItem, ToolCall } from '@cogitator-ai/types';
import { getTestModel, ollamaSkipReason } from '../../helpers/setup';

let base: string;
let workspace: LocalWorkspace;

beforeEach(async () => {
  base = realpathSync(mkdtempSync(join(tmpdir(), 'skills-e2e-')));
  workspace = new LocalWorkspace({ root: join(base, 'project') });
  await workspace.start();
});

afterEach(async () => {
  await workspace.dispose();
  rmSync(base, { recursive: true, force: true });
});

function write(path: string, content: string): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content);
}

function addSkill(root: string, name: string, description: string, body: string): string {
  const folder = join(root, name);
  write(
    join(folder, 'SKILL.md'),
    `---\nname: ${name}\ndescription: ${description}\n---\n${body}\n`
  );
  return folder;
}

function call(id: string, name: string, args: Record<string, unknown>): ToolCall {
  return { id, name, arguments: args };
}

function resultOf(messages: readonly Message[], callId: string): string {
  return String(messages.find((m) => m.role === 'tool' && m.toolCallId === callId)?.content);
}

const releaseNotes = tool({
  name: 'publishReleaseNotes',
  description: 'Publish the release notes of a version to the changelog site',
  parameters: z.object({ version: z.string().describe('Semantic version being released') }),
  deferred: true,
  execute: async ({ version }) => `Published notes for ${version}`,
});

const unrelated = Array.from({ length: 8 }, (_, i) =>
  tool({
    name: `inventory_tool_${i}`,
    description: `Count warehouse stock in aisle ${i}`,
    parameters: z.object({}),
    deferred: true,
    execute: async () => i,
  })
);

describe('Skills, todos and tool_search in a run (MockLLMBackend)', () => {
  it('activates skills from the workspace and the host, plans with todos and loads a deferred tool', async () => {
    const hostSkills = join(base, 'host-skills');
    const release = addSkill(
      hostSkills,
      'release',
      'Release a version. Use when asked to ship or release.',
      'Read checklist.md, plan the steps with write_todos, then publish the notes.'
    );
    write(join(release, 'checklist.md'), '1. Bump the version\n2. Publish the notes');
    addSkill(
      join(workspace.root, '.agents/skills'),
      'style',
      'House style for prose. Use when writing text.',
      'Write short sentences.'
    );
    const todos: TodoItem[] = [
      { id: 'bump', content: 'Bump the version', status: 'completed' },
      { id: 'notes', content: 'Publish the notes', status: 'in_progress' },
    ];
    const backend = new MockLLMBackend().setResponses([
      { toolCalls: [call('u1', 'use_skill', { skill: 'release' })] },
      { toolCalls: [call('r1', 'read_skill_file', { skill: 'release', path: 'checklist.md' })] },
      { toolCalls: [call('u2', 'use_skill', { skill: 'style' })] },
      { toolCalls: [call('t1', 'write_todos', { todos })] },
      { toolCalls: [call('s1', 'tool_search', { query: 'release notes changelog' })] },
      { toolCalls: [call('p1', 'publishReleaseNotes', { version: '2.0.0' })] },
      { toolCalls: [call('u3', 'use_skill', { skill: 'release' })] },
      { content: 'Released 2.0.0.' },
    ]);
    const cog = new Cogitator({
      llm: { backends: { mock: backend }, retry: false },
      memory: { adapter: 'memory' },
    });
    const agent = new Agent({
      name: 'releaser',
      model: 'mock/scripted',
      instructions: 'You ship releases.',
      tools: [...workspaceTools(undefined, { tools: ['read_file'] }), releaseNotes, ...unrelated],
      workspace,
      todos: true,
      maxIterations: 12,
      skills: [new SkillRegistry({ dirs: [hostSkills] })],
    });
    const reported: (readonly TodoItem[])[] = [];

    const result = await cog.run(agent, {
      input: 'Release 2.0.0',
      threadId: 'release-thread',
      onTodos: (list) => reported.push(list),
    });

    const calls = backend.getCalls();
    const system = String(calls[0]?.messages[0]?.content);
    expect(system).toContain('<skill name="release">Release a version.');
    expect(system).toContain('<skill name="style">House style for prose.');
    const firstTools = calls[0]?.tools?.map((t) => t.name) ?? [];
    expect(firstTools).toEqual(
      expect.arrayContaining([
        'read_file',
        'use_skill',
        'read_skill_file',
        'write_todos',
        'tool_search',
      ])
    );
    expect(firstTools).not.toContain('publishReleaseNotes');

    expect(resultOf(result.messages, 'u1')).toContain('Read checklist.md, plan the steps');
    expect(resultOf(result.messages, 'r1')).toContain('Bump the version');
    expect(resultOf(result.messages, 'u2')).toContain('.agents/skills/style (in the workspace');
    expect(resultOf(result.messages, 't1')).toBe(renderTodos(todos));
    expect(JSON.parse(resultOf(result.messages, 's1')).tools[0].name).toBe('publishReleaseNotes');
    expect(calls[5]?.tools?.map((t) => t.name)).toContain('publishReleaseNotes');
    expect(resultOf(result.messages, 'p1')).toContain('Published notes for 2.0.0');
    expect(resultOf(result.messages, 'u3')).toContain('already active');

    expect(result.output).toBe('Released 2.0.0.');
    expect(result.todos).toEqual(todos);
    expect(reported).toEqual([todos]);
    const thread = await (await cog.getMemory())!.getThread('release-thread');
    expect(thread.success && thread.data?.metadata.todos).toEqual({
      items: todos,
      entryId: expect.any(String),
    });
    await cog.close();
  });

  it('brings the todo list into a later run of the thread from its metadata', async () => {
    const todos: TodoItem[] = [{ id: 'a', content: 'Write the draft', status: 'in_progress' }];
    const backend = new MockLLMBackend().setResponses([
      { toolCalls: [call('t1', 'write_todos', { todos })] },
      { content: 'Planned.' },
      { content: 'Still drafting.' },
    ]);
    const cog = new Cogitator({
      llm: { backends: { mock: backend }, retry: false },
      memory: { adapter: 'memory' },
    });
    const agent = new Agent({
      name: 'writer',
      model: 'mock/m',
      instructions: 'Write.',
      todos: true,
    });

    await cog.run(agent, { input: 'Plan', threadId: 'todo-thread' });
    const later = await cog.run(agent, {
      input: 'Status?',
      threadId: 'todo-thread',
      loadHistory: false,
    });

    expect(later.todos).toEqual(todos);
    const sent = backend.getLastCall()!.messages.map((m) => String(m.content));
    expect(sent.some((text) => text.includes('[>] a: Write the draft'))).toBe(true);
    await cog.close();
  });
});

const ollamaReason = await ollamaSkipReason();

/** Tries of a small local model, which may not call the tool asked for every time */
const ATTEMPTS = 10;

/** Most milliseconds one try may take */
const ATTEMPT_TIMEOUT = 60_000;

/** Covers every try at its longest */
const TEST_TIMEOUT = ATTEMPTS * ATTEMPT_TIMEOUT + 30_000;

/** Runs `attempt` until `done()` or {@link ATTEMPTS} tries, closing `cog` either way. */
async function tryRuns(
  cog: Cogitator,
  attempt: () => Promise<unknown>,
  done: () => boolean
): Promise<void> {
  try {
    for (let tries = 0; tries < ATTEMPTS && !done(); tries++) await attempt();
  } finally {
    await cog.close();
  }
}

describe.skipIf(ollamaReason !== null)(
  `Skills, todos and tool_search with a real model (Ollama ${getTestModel()})`,
  () => {
    it('activates a skill with use_skill', { timeout: TEST_TIMEOUT }, async () => {
      const skills = join(base, 'skills');
      addSkill(
        skills,
        'haiku-writer',
        'Write haiku poems. Use whenever the user asks for a haiku.',
        'A haiku has three lines of five, seven and five syllables.'
      );
      const cog = new Cogitator({ llm: { defaultModel: `ollama/${getTestModel()}` } });
      const agent = new Agent({
        name: 'poet',
        model: `ollama/${getTestModel()}`,
        instructions: 'You write poems. Activate the matching skill first.',
        skills: [new SkillRegistry({ dirs: [skills] })],
        maxIterations: 2,
        timeout: ATTEMPT_TIMEOUT,
      });
      const activated: string[] = [];
      await tryRuns(
        cog,
        () =>
          cog.run(agent, {
            input:
              'Activate the haiku-writer skill with use_skill, then write a haiku about the sea.',
            toolChoice: 'required',
            onToolResult: (r) => {
              if (!r.error && r.name === 'use_skill') activated.push(JSON.stringify(r.result));
            },
          }),
        () => activated.length > 0
      );
      expect(activated.length).toBeGreaterThan(0);
      expect(activated[0]).toContain('five, seven and five syllables');
    });

    it('keeps a todo list with write_todos', { timeout: TEST_TIMEOUT }, async () => {
      const cog = new Cogitator({ llm: { defaultModel: `ollama/${getTestModel()}` } });
      const agent = new Agent({
        name: 'planner',
        model: `ollama/${getTestModel()}`,
        instructions: 'You plan work as a todo list with the write_todos tool. Always call it.',
        todos: true,
        maxIterations: 2,
        timeout: ATTEMPT_TIMEOUT,
      });
      let todos: readonly TodoItem[] | undefined;
      await tryRuns(
        cog,
        async () => {
          const result = await cog.run(agent, {
            input:
              'Call write_todos with {"todos": [{"id": "food", "content": "Buy food", "status": "in_progress"}, {"id": "drive", "content": "Drive to the park", "status": "pending"}]}.',
            toolChoice: 'required',
          });
          todos = result.todos;
        },
        () => (todos?.length ?? 0) > 0
      );
      expect(todos?.length).toBeGreaterThan(0);
      expect(todos!.filter((todo) => todo.status === 'in_progress').length).toBeLessThanOrEqual(1);
    });

    it('finds a deferred tool with tool_search', { timeout: TEST_TIMEOUT }, async () => {
      const cog = new Cogitator({ llm: { defaultModel: `ollama/${getTestModel()}` } });
      const agent = new Agent({
        name: 'releaser',
        model: `ollama/${getTestModel()}`,
        instructions: 'Search for the tool you need with tool_search before anything else.',
        tools: [releaseNotes, ...unrelated],
        maxIterations: 2,
        timeout: ATTEMPT_TIMEOUT,
      });
      const found: string[] = [];
      await tryRuns(
        cog,
        () =>
          cog.run(agent, {
            input:
              'Call tool_search with {"query": "release notes"} to find the tool that publishes release notes.',
            toolChoice: { type: 'function', function: { name: 'tool_search' } },
            onToolResult: (r) => {
              const tools = (r.result as { tools?: { name: string }[] } | null)?.tools ?? [];
              found.push(...tools.map((t) => t.name));
            },
          }),
        () => found.length > 0
      );
      expect(found).toContain('publishReleaseNotes');
    });
  }
);
