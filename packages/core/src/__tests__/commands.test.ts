import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { MockLLMBackend } from '@cogitator-ai/test-utils';
import type { CogitatorConfig } from '@cogitator-ai/types';
import { commandInvocation, expandCommand, splitArguments } from '../commands/expand';
import { Cogitator } from '../cogitator';
import { Agent } from '../agent';
import { tool } from '../tool';

describe('commandInvocation', () => {
  it.each<[string, { name: string; arguments: string } | undefined]>([
    ['/review', { name: 'review', arguments: '' }],
    ['/fix 123 high', { name: 'fix', arguments: '123 high' }],
    ['/frontend:component Button', { name: 'frontend:component', arguments: 'Button' }],
    ['/fix\nwith details\n', { name: 'fix', arguments: 'with details' }],
    ['review this', undefined],
    ['/', undefined],
    ['/usr/bin/env', undefined],
    [' /fix', undefined],
  ])('reads %j', (input, expected) => {
    expect(commandInvocation(input)).toEqual(expected);
  });
});

describe('splitArguments', () => {
  it.each<[string, string[]]>([
    ['a b  c', ['a', 'b', 'c']],
    ['"hello world" second', ['hello world', 'second']],
    ["'single quoted' x", ['single quoted', 'x']],
    ['escaped\\ space', ['escaped space']],
    ['""', ['']],
    ['', []],
  ])('splits %j', (text, expected) => {
    expect(splitArguments(text)).toEqual(expected);
  });
});

describe('expandCommand', () => {
  const expand = (template: string, args: string, names?: string[]) =>
    expandCommand({ template, ...(names && { arguments: names }) }, args);

  it.each<[string, string, string, string[]?]>([
    ['Fix issue $ARGUMENTS now', '123 high', 'Fix issue 123 high now'],
    ['Migrate $0 from $1 to $2', 'SearchBar JS TS', 'Migrate SearchBar from JS to TS'],
    ['Migrate $ARGUMENTS[0] from $ARGUMENTS[1]', 'A B', 'Migrate A from B'],
    ['Quoted $0 and $1', '"hello world" second', 'Quoted hello world and second'],
    ['Issue $issue on $branch', '7 main', 'Issue 7 on main', ['issue', 'branch']],
    ['Issue $issue on $branch.', '7', 'Issue 7 on .', ['issue', 'branch']],
    ['Missing $3 stays', 'a', 'Missing $3 stays\n\nARGUMENTS: a'],
    ['Costs \\$1.00 for $0', 'tea', 'Costs $1.00 for tea'],
    ['Keeps \\\\$0', 'x', 'Keeps \\\\x'],
    ['Unknown $thing stays', 'x', 'Unknown $thing stays\n\nARGUMENTS: x'],
    ['No placeholder', 'some args', 'No placeholder\n\nARGUMENTS: some args'],
    ['No args', '', 'No args'],
    ['Summarize $0', '"$ARGUMENTS from yesterday"', 'Summarize $ARGUMENTS from yesterday'],
  ])('expands %j with %j', (template, args, expected, names) => {
    expect(expand(template, args, names)).toBe(expected);
  });

  it('replaces variables', () => {
    expect(
      expandCommand({ template: 'Run ${CLAUDE_PROJECT_DIR}/x.sh ${OTHER}' }, '', {
        CLAUDE_PROJECT_DIR: '/repo',
      })
    ).toBe('Run /repo/x.sh ${OTHER}');
  });
});

describe('commands in a run', () => {
  let base: string;
  let project: string;

  beforeEach(() => {
    base = realpathSync(mkdtempSync(join(tmpdir(), 'commands-')));
    project = join(base, 'project');
    mkdirSync(join(project, '.claude', 'commands', 'git'), { recursive: true });
  });

  afterEach(() => {
    rmSync(base, { recursive: true, force: true });
  });

  const setup = (config: CogitatorConfig) => {
    const backend = new MockLLMBackend().setResponses([{ content: 'ok' }]);
    const other = new MockLLMBackend().setResponses([{ content: 'from the other model' }]);
    const cog = new Cogitator({
      ...config,
      llm: { ...config.llm, backends: { mock: backend, other }, retry: false },
    });
    const agent = new Agent({ name: 'coder', model: 'mock/m', instructions: 'You code.' });
    return { cog, backend, other, agent };
  };

  it('expands a project command before the run and reports it', async () => {
    writeFileSync(
      join(project, '.claude', 'commands', 'git', 'commit.md'),
      '---\ndescription: Commit staged changes\nargument-hint: "[message]"\n---\nCommit with the message: $ARGUMENTS\nProject: ${CLAUDE_PROJECT_DIR}\n'
    );
    const { cog, backend, agent } = setup({
      commands: { files: { root: project, trusted: true, userDirs: [], managedDirs: [] } },
    });
    const result = await cog.run(agent, { input: '/git:commit fix the bug' });
    expect(backend.getLastCall()?.messages.at(-1)?.content).toBe(
      `Commit with the message: fix the bug\nProject: ${project}`
    );
    expect(result.command).toMatchObject({
      name: 'git:commit',
      arguments: 'fix the bug',
      source: 'project',
    });
    const listed = await cog.listCommands({ root: project });
    expect(listed.commands.map((command) => [command.name, command.argumentHint])).toEqual([
      ['git:commit', '[message]'],
    ]);
    await cog.close();
  });

  it('leaves an input alone without commands, for an unknown command and from an untrusted project', async () => {
    writeFileSync(join(project, '.claude', 'commands', 'deploy.md'), 'Deploy everything');
    const plain = setup({});
    await plain.cog.run(plain.agent, { input: '/deploy' });
    expect(plain.backend.getLastCall()?.messages.at(-1)?.content).toBe('/deploy');
    await plain.cog.close();

    const untrusted = setup({
      commands: { files: { root: project, userDirs: [], managedDirs: [] } },
    });
    const result = await untrusted.cog.run(untrusted.agent, { input: '/deploy' });
    expect(untrusted.backend.getLastCall()?.messages.at(-1)?.content).toBe('/deploy');
    expect(result.command).toBeUndefined();
    await untrusted.cog.close();
  });

  it('runs a code command on the model it names and allows its tools', async () => {
    const { cog, other, agent } = setup({
      llm: { modelAliases: { fast: 'other/m' } },
      permissions: {},
      commands: {
        commands: {
          tidy: { template: 'Tidy $0', model: 'fast', allowedTools: ['Bash(prettier *)'] },
        },
      },
    });
    const result = await cog.run(agent, { input: '/tidy src' });
    expect(result.output).toBe('from the other model');
    expect(other.getLastCall()?.messages.at(-1)?.content).toBe('Tidy src');
    expect(result.command?.allowedTools).toEqual(['Bash(prettier *)']);
    await cog.close();
  });

  it('allows the tools of allowed-tools for the run the command starts only', async () => {
    const format = tool({
      name: 'format',
      description: 'Formats files',
      parameters: z.object({}),
      requiresApproval: true,
      execute: async () => 'formatted',
    });
    const backend = new MockLLMBackend().setResponses([
      {
        content: '',
        toolCalls: [{ id: 'c1', name: 'format', arguments: {} }],
        finishReason: 'tool_calls',
      },
      { content: 'formatted it' },
      {
        content: '',
        toolCalls: [{ id: 'c2', name: 'format', arguments: {} }],
        finishReason: 'tool_calls',
      },
    ]);
    const cog = new Cogitator({
      permissions: {},
      commands: { commands: { fmt: { template: 'Format the code', allowedTools: ['format'] } } },
      llm: { backends: { mock: backend }, retry: false },
    });
    const agent = new Agent({
      name: 'coder',
      model: 'mock/m',
      instructions: 'You code.',
      tools: [format],
    });
    const expanded = await cog.run(agent, { input: '/fmt' });
    expect(expanded.status).toBe('completed');
    expect(expanded.output).toBe('formatted it');
    const plain = await cog.run(agent, { input: 'format please' });
    expect(plain.status).toBe('paused');
    await cog.close();
  });
});
