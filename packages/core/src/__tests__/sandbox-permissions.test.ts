import { mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type {
  PermissionLayerSettings,
  PermissionMode,
  Tool,
  WorkspaceCommandSandbox,
  WorkspaceSandboxRoute,
} from '@cogitator-ai/types';
import { fileDelete } from '../tools/filesystem';
import { workspaceTools } from '../tools/workspace-tools';
import { LocalWorkspace } from '../workspace/local-workspace';
import {
  PermissionRuleSet,
  criticalRemoval,
  parseCommandLine,
  plainForSandbox,
  resolvePermission,
} from '../permissions/index';

const [runCommand] = workspaceTools(undefined, { tools: ['run_command'] });

interface FakeSandbox extends WorkspaceCommandSandbox {
  routes: string[];
}

function fakeSandbox(
  options: { autoAllow?: boolean; excluded?: string[]; allowUnsandboxed?: boolean } = {}
): FakeSandbox {
  const routes: string[] = [];
  return {
    kind: 'seatbelt',
    autoAllow: options.autoAllow ?? true,
    acceptsCommandDomains: true,
    routes,
    async route(command, request): Promise<WorkspaceSandboxRoute> {
      routes.push(command);
      if (options.excluded?.includes(command)) return { sandboxed: false, reason: 'excluded' };
      if (request?.dangerouslyDisableSandbox && options.allowUnsandboxed) {
        return { sandboxed: false, reason: 'requested' };
      }
      return { sandboxed: true };
    },
    async start() {},
    async launch(launch) {
      return { file: launch.file, args: launch.args };
    },
  };
}

let base: string;
let root: string;
let sandboxed: LocalWorkspace;
let plain: LocalWorkspace;
const sandbox = fakeSandbox();

beforeAll(async () => {
  base = realpathSync(mkdtempSync(join(tmpdir(), 'sandbox-permissions-')));
  root = join(base, 'project');
  mkdirSync(join(root, 'src'), { recursive: true });
  mkdirSync(join(base, 'outside'), { recursive: true });
  sandboxed = new LocalWorkspace({ root, exec: { sandbox } });
  plain = new LocalWorkspace({ root });
  await sandboxed.start();
  await plain.start();
});

afterAll(async () => {
  await sandboxed.dispose();
  await plain.dispose();
  rmSync(base, { recursive: true, force: true });
});

function rules(settings: Omit<PermissionLayerSettings, 'layer'> = {}) {
  return new PermissionRuleSet([
    { layer: 'project', anchor: root, origin: 'project.json', ...settings },
  ]);
}

async function decide(
  args: Record<string, unknown>,
  options: {
    rules?: Omit<PermissionLayerSettings, 'layer'>;
    mode?: PermissionMode;
    workspace?: LocalWorkspace;
    needsApproval?: boolean;
    guardrailsApproval?: boolean;
    tool?: Tool;
  } = {}
) {
  return resolvePermission(options.tool ?? runCommand, args, {
    mode: options.mode ?? 'default',
    rules: rules(options.rules),
    needsApproval: options.needsApproval ?? true,
    ...(options.guardrailsApproval && { guardrailsApproval: true }),
    workspace: options.workspace ?? sandboxed,
    projectRoot: root,
  });
}

describe('commands that run in the OS sandbox', () => {
  it('run without asking, decided by the sandbox', async () => {
    const decision = await decide({ command: 'npm test' });
    expect(decision).toMatchObject({ decision: 'allow', decidedBy: 'sandbox' });
    expect(decision.reason).toContain('seatbelt');
    expect(sandbox.routes).toContain('npm test');
  });

  it('ask as before in a workspace without a sandbox', async () => {
    expect(await decide({ command: 'npm test' }, { workspace: plain })).toMatchObject({
      decision: 'ask',
      decidedBy: 'tool',
    });
  });

  it('are still refused by deny rules and asked by ask rules with a pattern', async () => {
    expect(
      (await decide({ command: 'git push origin main' }, { rules: { deny: ['Bash(git push *)'] } }))
        .decision
    ).toBe('deny');
    expect(
      await decide({ command: 'git push origin main' }, { rules: { ask: ['Bash(git push *)'] } })
    ).toMatchObject({ decision: 'ask', decidedBy: 'rule' });
  });

  it('skip a bare Bash ask rule, but not in plan mode', async () => {
    expect((await decide({ command: 'npm test' }, { rules: { ask: ['Bash'] } })).decision).toBe(
      'allow'
    );
    expect((await decide({ command: 'npm test' }, { rules: { ask: ['Bash(*)'] } })).decision).toBe(
      'allow'
    );
    expect(
      await decide({ command: 'ls' }, { rules: { ask: ['Bash'] }, mode: 'plan' })
    ).toMatchObject({ decision: 'ask', decidedBy: 'rule' });
    expect((await decide({ command: 'npm test' }, { mode: 'plan' })).decision).toBe('deny');
  });

  it('go through the normal flow when a variable, eval or make X=y could change the program', async () => {
    for (const command of [
      'FOO=bar npm test',
      'env FOO=bar npm test',
      'eval "ls"',
      'make CC=clang',
    ]) {
      expect((await decide({ command })).decision, command).toBe('ask');
    }
    expect(
      (await decide({ command: 'make CC=clang' }, { rules: { allow: ['Bash(make *)'] } })).decision
    ).toBe('allow');
  });

  it('go through the normal flow outside the sandbox: excluded or unsandboxed on request', async () => {
    const excluded = new LocalWorkspace({
      root,
      exec: { sandbox: fakeSandbox({ excluded: ['docker ps'], allowUnsandboxed: true }) },
    });
    expect((await decide({ command: 'docker ps' }, { workspace: excluded })).decision).toBe('ask');
    expect(
      (
        await decide(
          { command: 'npm test', dangerouslyDisableSandbox: true },
          { workspace: excluded }
        )
      ).decision
    ).toBe('ask');
    expect((await decide({ command: 'npm test', dangerouslyDisableSandbox: true })).decision).toBe(
      'allow'
    );
    expect(
      await decide(
        { command: 'npm test', dangerouslyDisableSandbox: true },
        { rules: { ask: ['Bash(dangerouslyDisableSandbox:true)'] } }
      )
    ).toMatchObject({ decision: 'ask', decidedBy: 'rule' });
  });

  it('ask when the policy turns auto-allow off or the guardrails want an approval', async () => {
    const regular = new LocalWorkspace({
      root,
      exec: { sandbox: fakeSandbox({ autoAllow: false }) },
    });
    expect((await decide({ command: 'npm test' }, { workspace: regular })).decision).toBe('ask');
    expect((await decide({ command: 'npm test' }, { guardrailsApproval: true })).decision).toBe(
      'ask'
    );
  });

  it('ask for a command that names hosts of its own, which no allow rule approves', async () => {
    expect(
      await decide({ command: 'npm install', allowedDomains: ['registry.npmjs.org'] })
    ).toMatchObject({ decision: 'ask', decidedBy: 'tool' });
    expect(
      (
        await decide(
          { command: 'npm install', allowedDomains: ['registry.npmjs.org'] },
          { rules: { allow: ['Bash(npm install)'] } }
        )
      ).decision
    ).toBe('ask');
    expect(
      (
        await decide(
          { command: 'npm install', allowedDomains: ['registry.npmjs.org'] },
          { mode: 'bypassPermissions' }
        )
      ).decision
    ).toBe('allow');
  });
});

describe('removals that always ask', () => {
  it('asks for rm and rmdir of a critical path in every mode, allow rules and the sandbox too', async () => {
    for (const command of [
      'rm -rf .',
      `rm -rf ${root}`,
      'rm -rf ..',
      'rm -rf ~',
      'rm -rf /',
      'rm -rf .git',
      'rm .git/config',
      'rmdir ~',
      'rm -rf *',
      'rm -rf "$HOME"',
      'cd src && rm -rf ../..',
    ]) {
      for (const mode of ['default', 'acceptEdits', 'bypassPermissions', 'auto'] as const) {
        const decision = await decide({ command }, { mode, rules: { allow: ['Bash(rm *)'] } });
        expect(decision.decision, `${command} in ${mode}`).toBe('ask');
        expect(decision.reason).toContain('critical path');
      }
    }
    expect((await decide({ command: 'rm -rf .' }, { mode: 'dontAsk' })).decision).toBe('deny');
  });

  it('lets other removals through the sandbox as any command', async () => {
    expect((await decide({ command: 'rm -rf src/build dist' })).decision).toBe('allow');
    expect((await decide({ command: 'rm -rf node_modules/*' })).decision).toBe('allow');
  });

  it('asks for removals outside the workspace without the sandbox, except in bypass mode', async () => {
    const target = join(base, 'outside', 'x');
    const allowAll = { allow: ['Bash(rm *)'] };
    expect(
      await decide({ command: `rm -rf ${target}` }, { workspace: plain, rules: allowAll })
    ).toMatchObject({ decision: 'ask', decidedBy: 'mode' });
    expect(
      (await decide({ command: `rm -rf ${target}` }, { workspace: plain, mode: 'acceptEdits' }))
        .decision
    ).toBe('ask');
    expect(
      (
        await decide(
          { command: `rm -rf ${target}` },
          { workspace: plain, mode: 'bypassPermissions' }
        )
      ).decision
    ).toBe('allow');
    expect(
      (await decide({ command: 'rm -rf src/x' }, { workspace: plain, rules: allowAll })).decision
    ).toBe('allow');
    expect((await decide({ command: `rm -rf ${target}` })).decision).toBe('allow');
  });

  it('asks for file_delete outside the workspace, except in bypass mode', async () => {
    const target = join(base, 'outside', 'x');
    expect(
      (
        await decide(
          { path: target },
          { tool: fileDelete, rules: { allow: ['file_delete'] }, needsApproval: false }
        )
      ).decision
    ).toBe('ask');
    expect(
      (
        await decide(
          { path: target },
          { tool: fileDelete, mode: 'bypassPermissions', needsApproval: false }
        )
      ).decision
    ).toBe('allow');
  });
});

describe('the command checks', () => {
  it('finds the critical operand of a removal', () => {
    const line = (text: string) => parseCommandLine(text);
    expect(criticalRemoval(line('rm -rf build'), root, root, homedir())).toBeUndefined();
    expect(criticalRemoval(line('rm -- -weird'), root, root, homedir())).toBeUndefined();
    expect(criticalRemoval(line('rm -rf src/.g*'), root, root, homedir())).toBe('src/.g*');
    expect(criticalRemoval(line('sh -c "rm -rf /"'), root, root, homedir())).toBe('/');
    expect(criticalRemoval(line('ls /'), root, root, homedir())).toBeUndefined();
  });

  it('tells plain commands from those that can change the program they run', () => {
    expect(plainForSandbox(parseCommandLine('npm test && git status'))).toBe(true);
    expect(plainForSandbox(parseCommandLine('PATH=. ls'))).toBe(false);
    expect(plainForSandbox(parseCommandLine('gmake -j4 CC=gcc'))).toBe(false);
  });
});
