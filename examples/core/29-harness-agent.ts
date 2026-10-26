import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createCogitator, header, section } from '../_shared/setup.js';
import { createHarnessAgent } from '@cogitator-ai/core';

const MODEL = process.env.EXAMPLE_MODEL ?? `ollama/${process.env.OLLAMA_MODEL ?? 'qwen2.5:0.5b'}`;

async function main() {
  header('29 - Harness agent: a coding agent in one call');

  const root = mkdtempSync(join(tmpdir(), 'cogitator-harness-'));
  writeFileSync(join(root, 'AGENTS.md'), 'Keep every change small and say what you changed.\n');
  writeFileSync(join(root, 'math.ts'), 'export const add = (a: number, b: number) => a - b;\n');

  const harness = createHarnessAgent({
    preset: 'coding',
    model: MODEL,
    workspace: root,
    permissions: { mode: 'default', deny: ['Bash(rm *)'] },
  });

  try {
    section('What the harness assembled');
    console.log(
      `  agent: ${harness.agent.name}, tools: ${harness.agent.tools.map((t) => t.name).join(', ')}`
    );
    console.log(`  runtime: ${Object.keys(harness.config).join(', ')}`);
    console.log(`  run options: ${JSON.stringify(harness.runOptions)}`);
    console.log(
      `  prompt sections: ${harness.agent.instructions.match(/^## .+$/gm)?.join(', ') ?? 'none'}`
    );

    const cog = createCogitator(harness.mergeConfig({ memory: { adapter: 'memory' } }));

    section('A task in the workspace, approvals asked of the user');
    const result = await cog.run(harness.agent, {
      input: 'math.ts has a bug: add subtracts. Fix it with edit_file, then read the file back.',
      ...harness.runOptions,
      onApproval: (request) => {
        console.log(`  approve ${request.toolName}? yes (${request.reason ?? 'needs approval'})`);
        return { approved: true };
      },
      onToolCall: (call) => console.log(`  > ${call.name} ${JSON.stringify(call.arguments)}`),
    });
    console.log(`  answer: ${result.output.slice(0, 240)}`);
    console.log(
      `  project instructions read: ${result.instructions?.map((f) => f.path).join(', ')}`
    );
    console.log(`  math.ts now: ${readFileSync(join(root, 'math.ts'), 'utf8').trim()}`);
    if (result.todos?.length)
      console.log(`  todos: ${result.todos.map((t) => t.content).join('; ')}`);

    section('The assistant preset: files without a shell');
    const assistant = createHarnessAgent({ preset: 'assistant', workspace: join(root, 'notes') });
    console.log(`  tools: ${assistant.agent.tools.map((t) => t.name).join(', ')}`);
    await assistant.dispose();

    await cog.close();
  } finally {
    await harness.dispose();
    rmSync(root, { recursive: true, force: true });
  }
}

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
