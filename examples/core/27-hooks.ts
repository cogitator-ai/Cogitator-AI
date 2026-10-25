import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createCogitator, header, section } from '../_shared/setup.js';
import { Agent, LocalWorkspace, workspaceTools } from '@cogitator-ai/core';

const MODEL = process.env.EXAMPLE_MODEL ?? `ollama/${process.env.OLLAMA_MODEL ?? 'qwen2.5:0.5b'}`;

const GUARD = `const fs = require('node:fs');
const input = JSON.parse(fs.readFileSync(0, 'utf8'));
if (input.hook_event_name === 'SessionStart') {
  process.stdout.write('The release branch is release/2.4. Never touch main.');
  process.exit(0);
}
const command = input.tool_input.command || '';
if (/\\bgit\\s+push\\b.*\\bmain\\b/.test(command)) {
  process.stderr.write('Pushing to main is not allowed, push the release branch instead.');
  process.exit(2);
}
`;

async function main() {
  header('27 - Hooks and project instructions: a repository that guards itself');

  const root = mkdtempSync(join(tmpdir(), 'cogitator-hooks-'));
  mkdirSync(join(root, '.claude', 'hooks'), { recursive: true });
  writeFileSync(
    join(root, 'AGENTS.md'),
    'This repository uses pnpm. Run `pnpm test` before you push.\n'
  );
  writeFileSync(join(root, '.claude', 'hooks', 'guard.cjs'), GUARD);
  const guard = {
    type: 'command',
    command: process.execPath,
    args: ['${CLAUDE_PROJECT_DIR}/.claude/hooks/guard.cjs'],
  };
  writeFileSync(
    join(root, '.claude', 'settings.json'),
    JSON.stringify(
      {
        hooks: {
          SessionStart: [{ hooks: [guard] }],
          PreToolUse: [{ matcher: 'Bash', hooks: [guard] }],
        },
      },
      null,
      2
    )
  );
  const workspace = new LocalWorkspace({ root });
  await workspace.start();

  try {
    const cog = createCogitator({
      memory: { adapter: 'memory' },
      permissions: { mode: 'bypassPermissions' },
      hooks: {
        settings: { root, userDirs: [], managedDirs: [], trusted: true },
        onHookRun: (run) =>
          console.log(
            `  hook ${run.event} ${run.outcome}${run.reason ? `: ${run.reason}` : ''} (${run.durationMs} ms)`
          ),
      },
      instructions: { projectFiles: true },
    });

    section('A PreToolUse hook refuses a call, without a model');
    const runCommand = workspaceTools().find((tool) => tool.name === 'run_command');
    if (runCommand) {
      const refused = await cog.invokeTool(
        runCommand,
        { command: 'git push origin main' },
        { workspace }
      );
      console.log(`  git push origin main -> ${refused.error}`);
      const allowed = await cog.invokeTool(runCommand, { command: 'echo pushed' }, { workspace });
      console.log(`  echo pushed -> ${JSON.stringify(allowed.result)}`);
    }

    section(
      'A run: AGENTS.md in the system prompt, SessionStart context, the guard on every command'
    );
    const coder = new Agent({
      name: 'coder',
      model: MODEL,
      instructions: 'You work in a git repository. Use run_command for shell commands.',
      tools: workspaceTools(),
      workspace,
      maxIterations: 4,
    });
    const result = await cog.run(coder, {
      input: 'Which branch may I push, and which command should I run before pushing?',
      threadId: 'hooks-demo',
    });
    console.log(`  instructions read: ${result.instructions?.map((file) => file.path).join(', ')}`);
    console.log(`  answer: ${result.output.slice(0, 240)}`);

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
