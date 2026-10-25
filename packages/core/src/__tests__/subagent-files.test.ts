import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { DefinitionDiagnostic, SubagentDefinition } from '@cogitator-ai/types';
import { parseCommandFile, parseSubagentFile } from '../subagents/definitions';
import { CommandFinder, SubagentFinder } from '../subagents/catalog';

const origin = { path: '/project/.claude/agents/agent.md', source: 'project' as const };

const file = (frontmatter: string, body = 'You review code.') =>
  `---\n${frontmatter}\n---\n${body}\n`;

describe('parseSubagentFile', () => {
  it.each<[string, string, Partial<SubagentDefinition>]>([
    [
      'the required fields',
      'name: reviewer\ndescription: Reviews code',
      { name: 'reviewer', description: 'Reviews code', prompt: 'You review code.' },
    ],
    [
      'a comma separated tool list',
      'name: a\ndescription: d\ntools: Read, Grep, Bash(git status *)',
      { tools: ['Read', 'Grep', 'Bash(git status *)'] },
    ],
    [
      'a YAML tool list',
      'name: a\ndescription: d\ntools:\n  - Read\n  - mcp__github__*',
      { tools: ['Read', 'mcp__github__*'] },
    ],
    [
      'disallowed tools',
      'name: a\ndescription: d\ndisallowedTools: Write, Edit',
      { disallowedTools: ['Write', 'Edit'] },
    ],
    ['a model', 'name: a\ndescription: d\nmodel: sonnet', { model: 'sonnet' }],
    [
      'manual as default mode',
      'name: a\ndescription: d\npermissionMode: manual',
      { permissionMode: 'default' },
    ],
    [
      'a permission mode',
      'name: a\ndescription: d\npermissionMode: plan',
      { permissionMode: 'plan' },
    ],
    ['maxTurns as a number', 'name: a\ndescription: d\nmaxTurns: 4', { maxTurns: 4 }],
    ['maxTurns as text', 'name: a\ndescription: d\nmaxTurns: "6"', { maxTurns: 6 }],
    [
      'skills',
      'name: a\ndescription: d\nskills:\n  - api-conventions\n  - errors',
      { skills: ['api-conventions', 'errors'] },
    ],
    ['memory', 'name: a\ndescription: d\nmemory: project', { memory: 'project' }],
    ['background as a word', 'name: a\ndescription: d\nbackground: yes', { background: true }],
    ['isolation', 'name: a\ndescription: d\nisolation: worktree', { isolation: 'worktree' }],
    [
      'color and effort',
      'name: a\ndescription: d\ncolor: cyan\neffort: high',
      { color: 'cyan', effort: 'high' },
    ],
    [
      'MCP servers by name and inline',
      'name: a\ndescription: d\nmcpServers:\n  - github\n  - playwright:\n      type: stdio\n      command: npx',
      { mcpServers: ['github', { name: 'playwright', config: { type: 'stdio', command: 'npx' } }] },
    ],
  ])('reads %s', (_label, frontmatter, expected) => {
    const parsed = parseSubagentFile(file(frontmatter), origin);
    expect(parsed.definition).toMatchObject(expected);
    expect(parsed.diagnostics).toEqual([]);
  });

  it('turns Stop hooks into SubagentStop hooks', () => {
    const parsed = parseSubagentFile(
      file(
        'name: a\ndescription: d\nhooks:\n  Stop:\n    - hooks:\n        - type: command\n          command: ./check.sh\n  PreToolUse:\n    - matcher: Bash\n      hooks:\n        - type: command\n          command: ./guard.sh'
      ),
      origin
    );
    expect(parsed.definition?.hooks).toEqual({
      SubagentStop: [{ hooks: [{ type: 'command', command: './check.sh' }] }],
      PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: './guard.sh' }] }],
    });
  });

  it.each<[string, string]>([
    ['a file without frontmatter', 'Just notes about agents.'],
    ['a file without a name', file('description: Notes')],
    [
      'a file whose frontmatter does not start on the first line',
      `\n${file('name: a\ndescription: d')}`,
    ],
  ])('skips %s as documentation, without a diagnostic', (_label, text) => {
    const parsed = parseSubagentFile(text, origin);
    expect(parsed.definition).toBeUndefined();
    expect(parsed.diagnostics).toEqual([]);
  });

  it.each<[string, string, string]>([
    ['invalid YAML', 'name: a\ndescription: [unclosed', 'not valid YAML'],
    ['a name starting with -', 'name: -bad\ndescription: d', 'may only hold lowercase letters'],
    ['a name that is a path', 'name: ..\ndescription: d', 'may only hold lowercase letters'],
    ['a name with capitals', 'name: Reviewer\ndescription: d', 'may only hold lowercase letters'],
    ['a name with a colon', 'name: my:agent\ndescription: d', 'holds ":"'],
    [
      'a name longer than 256 characters',
      `name: ${'a'.repeat(257)}\ndescription: d`,
      'longer than 256',
    ],
    ['no description', 'name: a', 'no description'],
  ])('skips %s with an error', (_label, frontmatter, message) => {
    const parsed = parseSubagentFile(file(frontmatter), origin);
    expect(parsed.definition).toBeUndefined();
    expect(parsed.diagnostics).toEqual([
      expect.objectContaining({ level: 'error', message: expect.stringContaining(message) }),
    ]);
  });

  it.each<[string, string, string]>([
    ['an unknown permission mode', 'permissionMode: yolo', 'permissionMode'],
    ['a maxTurns that is not a whole number', 'maxTurns: 2.5', 'maxTurns'],
    ['an unknown memory scope', 'memory: team', 'memory'],
    ['an unknown isolation', 'isolation: container', 'isolation'],
    ['an unknown color', 'color: magenta', 'color'],
    ['a field Cogitator does not apply', 'initialPrompt: hi', 'not applied'],
    ['an unknown field', 'maxturns: 3', 'did you mean maxTurns?'],
    ['a hook event that does not exist', 'hooks:\n  Whenever: []', 'not a hook event'],
  ])('loads a file with %s, leaving the field out with a warning', (_label, extra, message) => {
    const parsed = parseSubagentFile(file(`name: a\ndescription: d\n${extra}`), origin);
    expect(parsed.definition?.name).toBe('a');
    expect(parsed.diagnostics).toEqual([
      expect.objectContaining({ level: 'warning', message: expect.stringContaining(message) }),
    ]);
  });
});

describe('parseCommandFile', () => {
  const at = { path: '/project/.claude/commands/fix.md', source: 'project' as const };

  it('reads the frontmatter and the template', () => {
    const parsed = parseCommandFile(
      '---\ndescription: Fix an issue\nargument-hint: "[issue]"\nallowed-tools: Bash(gh *) Read\nmodel: haiku\narguments: issue branch\n---\nFix issue $issue on $branch.\n',
      'fix',
      at
    );
    expect(parsed.definition).toEqual({
      name: 'fix',
      description: 'Fix an issue',
      argumentHint: '[issue]',
      arguments: ['issue', 'branch'],
      allowedTools: ['Bash(gh *)', 'Read'],
      model: 'haiku',
      template: 'Fix issue $issue on $branch.',
      source: 'project',
      path: at.path,
    });
  });

  it('warns about a forked context it does not support', () => {
    const parsed = parseCommandFile(
      '---\ncontext: fork\nagent: Explore\neffort: low\n---\nDo it.\n',
      'fork',
      at
    );
    expect(parsed.definition?.effort).toBe('low');
    expect(parsed.diagnostics.map((diagnostic) => diagnostic.message)).toEqual([
      expect.stringContaining('context is not supported'),
      expect.stringContaining('agent is not supported'),
    ]);
  });

  it('takes a file without frontmatter as the template, its first line as the description', () => {
    const parsed = parseCommandFile('# Review the diff\n\nReview $ARGUMENTS.\n', 'review', at);
    expect(parsed.definition).toMatchObject({
      description: 'Review the diff',
      template: '# Review the diff\n\nReview $ARGUMENTS.',
    });
  });

  it('skips a file whose frontmatter is not valid YAML', () => {
    const parsed = parseCommandFile('---\ndescription: [x\n---\nbody', 'x', at);
    expect(parsed.definition).toBeUndefined();
    expect(parsed.diagnostics[0]?.level).toBe('error');
  });
});

describe('finding subagents and commands', () => {
  let base: string;
  let project: string;
  let home: string;

  const write = (path: string, text: string) => {
    mkdirSync(join(path, '..'), { recursive: true });
    writeFileSync(path, text);
  };

  beforeEach(() => {
    base = realpathSync(mkdtempSync(join(tmpdir(), 'subagent-files-')));
    project = join(base, 'project');
    home = join(base, 'home');
    mkdirSync(project, { recursive: true });
  });

  afterEach(() => {
    rmSync(base, { recursive: true, force: true });
  });

  it('reads a trusted project, the user folders and code, the first one of a name winning', async () => {
    write(
      join(project, '.claude', 'agents', 'review', 'reviewer.md'),
      file('name: reviewer\ndescription: project reviewer')
    );
    write(
      join(project, '.cogitator', 'agents', 'reviewer.md'),
      file('name: reviewer\ndescription: cogitator reviewer')
    );
    write(
      join(home, '.claude', 'agents', 'helper.md'),
      file('name: helper\ndescription: user helper')
    );
    write(
      join(home, '.claude', 'agents', 'reviewer.md'),
      file('name: reviewer\ndescription: user reviewer')
    );
    const finder = new SubagentFinder({
      agents: { planner: { description: 'code planner' } },
    });
    const catalog = await finder.catalog({
      options: { root: project, trusted: true, userDirs: [join(home, '.claude')], managedDirs: [] },
      root: project,
    });
    expect(catalog.agents.map((agent) => [agent.name, agent.description, agent.source])).toEqual([
      ['planner', 'code planner', 'code'],
      ['reviewer', 'cogitator reviewer', 'project'],
      ['helper', 'user helper', 'user'],
    ]);
  });

  it('reads no project subagents from an untrusted project', async () => {
    write(
      join(project, '.claude', 'agents', 'evil.md'),
      file('name: evil\ndescription: runs anything')
    );
    const finder = new SubagentFinder({});
    const catalog = await finder.catalog({
      options: { root: project, userDirs: [], managedDirs: [] },
      root: project,
    });
    expect(catalog.agents).toEqual([]);
    const trusted = await finder.catalog({
      options: { trustedRoots: [project], userDirs: [], managedDirs: [] },
      root: project,
    });
    expect(trusted.agents.map((agent) => agent.name)).toEqual(['evil']);
  });

  it('puts managed subagents before the ones in code', async () => {
    const managed = join(base, 'managed');
    write(
      join(managed, '.claude', 'agents', 'reviewer.md'),
      file('name: reviewer\ndescription: org reviewer')
    );
    const catalog = await new SubagentFinder({
      agents: { reviewer: { description: 'code reviewer' } },
    }).catalog({ options: { userDirs: [], managedDirs: [managed] }, root: project });
    expect(catalog.get('reviewer')?.description).toBe('org reviewer');
  });

  it('reports a name twice in one scope once, and hands it to onDiagnostic', async () => {
    write(join(project, '.claude', 'agents', 'a.md'), file('name: twin\ndescription: first'));
    write(join(project, '.claude', 'agents', 'b.md'), file('name: twin\ndescription: second'));
    const seen: DefinitionDiagnostic[] = [];
    const finder = new SubagentFinder({ onDiagnostic: (diagnostic) => seen.push(diagnostic) });
    const place = {
      options: { root: project, trusted: true, userDirs: [], managedDirs: [] },
      root: project,
    };
    await finder.catalog(place);
    await finder.catalog(place);
    expect(seen).toEqual([expect.objectContaining({ message: expect.stringContaining('twin') })]);
  });

  it('names commands after their path, folders joined by a colon', async () => {
    write(join(project, '.claude', 'commands', 'frontend', 'component.md'), 'Make $0.');
    write(join(project, '.claude', 'commands', 'review.md'), 'Review.');
    write(join(home, '.cogitator', 'commands', 'review.md'), 'User review.');
    const catalog = await new CommandFinder({
      commands: { hello: 'Say hi to $ARGUMENTS' },
    }).catalog({
      options: {
        root: project,
        trusted: true,
        userDirs: [join(home, '.cogitator')],
        managedDirs: [],
      },
      root: project,
    });
    expect(catalog.commands.map((command) => [command.name, command.source])).toEqual([
      ['hello', 'code'],
      ['frontend:component', 'project'],
      ['review', 'project'],
    ]);
  });

  it('refuses a subagent in code without a description', () => {
    expect(() => new SubagentFinder({ agents: { bad: { description: ' ' } } })).toThrow(
      'needs a description'
    );
    expect(() => new SubagentFinder({ agents: { 'a:b': { description: 'd' } } })).toThrow('":"');
  });
});
