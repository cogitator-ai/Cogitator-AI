import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createCogitator, header, section } from '../_shared/setup.js';
import {
  Agent,
  LocalWorkspace,
  PermissionRuleSet,
  loadPermissionSettings,
  resolvePermission,
  workspaceTools,
} from '@cogitator-ai/core';

const MODEL = process.env.EXAMPLE_MODEL ?? `ollama/${process.env.OLLAMA_MODEL ?? 'qwen2.5:0.5b'}`;

async function main() {
  header('26 - Permissions: rules, modes, an audit log and session budgets');

  const root = mkdtempSync(join(tmpdir(), 'cogitator-permissions-'));
  mkdirSync(join(root, '.claude'), { recursive: true });
  mkdirSync(join(root, 'src'), { recursive: true });
  writeFileSync(join(root, 'src', 'greet.ts'), 'export const greet = () => "hi";\n');
  writeFileSync(join(root, '.env'), 'TOKEN=secret\n');
  writeFileSync(
    join(root, '.claude', 'settings.json'),
    JSON.stringify(
      {
        permissions: {
          allow: ['Bash(ls *)', 'Bash(cat src/*)', 'Read'],
          ask: ['Bash(git push *)'],
          deny: ['Read(.env)', 'Bash(rm -rf *)'],
        },
      },
      null,
      2
    )
  );
  const workspace = new LocalWorkspace({ root });
  await workspace.start();

  try {
    section('The rules of .claude/settings.json, decided without a model');
    const { layers } = await loadPermissionSettings(root, { userDirs: [], managedDirs: [] });
    const rules = new PermissionRuleSet(layers);
    const tools = new Map(workspaceTools().map((t) => [t.name, t]));
    const calls: Array<[string, Record<string, unknown>]> = [
      ['run_command', { command: 'ls -la src' }],
      ['run_command', { command: 'ls src && rm -rf src' }],
      ['run_command', { command: 'git push origin main' }],
      ['read_file', { path: '.env' }],
      ['read_file', { path: 'src/../.env' }],
      ['write_file', { path: 'src/greet.ts', content: '' }],
    ];
    for (const [name, args] of calls) {
      const target = tools.get(name);
      if (!target) continue;
      for (const mode of ['default', 'acceptEdits', 'plan'] as const) {
        const decision = await resolvePermission(target, args, {
          mode,
          rules,
          needsApproval: name === 'run_command',
          workspace,
        });
        console.log(
          `  ${mode.padEnd(11)} ${name}(${JSON.stringify(args)}) -> ${decision.decision}: ${decision.reason}`
        );
      }
    }

    section('A run in plan mode: read-only until a plan is approved');
    const cog = createCogitator({
      memory: { adapter: 'memory' },
      permissions: { settings: { root, userDirs: [], managedDirs: [] } },
      budget: {
        session: { maxTokens: 6000 },
        onWarning: (warning) =>
          console.log(`  budget warning: ${warning.metric} ${warning.used}/${warning.limit}`),
      },
    });
    const coder = new Agent({
      name: 'coder',
      model: MODEL,
      instructions:
        'You change code in the workspace. Read the files you need with read_file. In plan mode, present your plan with exit_plan_mode before you edit.',
      tools: workspaceTools(),
      workspace,
      maxIterations: 6,
    });
    const threadId = 'permissions-demo';
    const paused = await cog.run(coder, {
      input: 'Make greet() in src/greet.ts return "hello" instead of "hi".',
      threadId,
      permissions: { mode: 'plan' },
      onPermissionDecision: (event) =>
        console.log(`  ${event.decision.padEnd(5)} ${event.toolName}: ${event.reason}`),
    });
    console.log(`  status: ${paused.status}`);
    const plan = paused.interrupts?.find((entry) => entry.kind === 'plan');
    if (plan) {
      console.log(`  plan:\n${String(plan.details?.plan)}`);
      const done = await cog.resume(coder, threadId, {
        responses: { [plan.id]: { approved: true, mode: 'acceptEdits' } },
        onPermissionDecision: (event) =>
          console.log(`  ${event.decision.padEnd(5)} ${event.toolName}: ${event.reason}`),
      });
      console.log(`  after the plan: ${done.status}, ${done.output.slice(0, 160)}`);
    } else {
      console.log(`  the model answered without a plan: ${paused.output.slice(0, 160)}`);
    }

    section('The session budget');
    const memory = await cog.getMemory();
    const thread = await memory?.getThread(threadId);
    console.log('  spent so far:', thread?.success ? thread.data?.metadata.budget : undefined);

    await cog.close();
  } finally {
    await workspace.dispose();
    rmSync(root, { recursive: true, force: true });
  }
}

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
