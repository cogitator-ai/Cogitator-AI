import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { z } from 'zod';
import { header, section } from '../_shared/setup.js';
import {
  Agent,
  Cogitator,
  LocalWorkspace,
  WorkspaceError,
  tool,
  toolResultPath,
  workspaceTools,
} from '@cogitator-ai/core';

const OLLAMA_URL = process.env.OLLAMA_URL || 'http://localhost:11434';
const MODEL = process.env.OLLAMA_MODEL || 'qwen2.5:0.5b';

async function ollamaIsUp(): Promise<boolean> {
  try {
    const response = await fetch(`${OLLAMA_URL}/api/tags`, { signal: AbortSignal.timeout(3000) });
    return response.ok;
  } catch {
    return false;
  }
}

const buildLog = tool({
  name: 'build_log',
  description: 'Return the log of the last build',
  parameters: z.object({}),
  maxResultLength: 2_000,
  execute: async () =>
    Array.from({ length: 500 }, (_, i) =>
      i === 412 ? `step ${i}: ERROR missing semicolon in src/app.ts` : `step ${i}: ok`
    ).join('\n'),
});

async function main() {
  header('22 - Workspace: files and commands confined to one directory');

  const root = await mkdtemp(join(tmpdir(), 'cogitator-workspace-'));
  const workspace = new LocalWorkspace({ root });
  await workspace.start();

  try {
    section('The workspace API');
    await workspace.write('src/app.ts', "export const greeting = 'hello'\n");
    const listed = await workspace.list('.', { recursive: true });
    console.log(`  files: ${listed.map((entry) => `${entry.path} (${entry.type})`).join(', ')}`);
    const run = await workspace.exec('wc -l src/app.ts');
    console.log(`  exec: ${run.stdout.trim()} (exit ${run.exitCode})`);
    try {
      await workspace.read('../../etc/passwd');
    } catch (error) {
      if (WorkspaceError.is(error, 'OUTSIDE_ROOT')) console.log(`  refused: ${error.message}`);
    }
    const trashed = await workspace.remove('src/app.ts', { trash: true });
    console.log(`  removed to the trash: ${trashed.trashedTo}`);

    if (!(await ollamaIsUp())) {
      console.error(`\n  Ollama is not answering at ${OLLAMA_URL}, skipping the agent part.`);
      console.error(`  Start it with \`ollama serve\` and pull the model: ollama pull ${MODEL}\n`);
      return;
    }

    const cog = new Cogitator({ llm: { providers: { ollama: { baseUrl: OLLAMA_URL } } } });
    const agent = new Agent({
      name: 'builder',
      model: `ollama/${MODEL}`,
      instructions:
        'You work on files with the workspace tools. Call write_file to create files. ' +
        'When a tool result says it was saved to a file, read that file with read_file.',
      maxIterations: 3,
      tools: [
        ...workspaceTools(undefined, { tools: ['read_file', 'write_file', 'list_files'] }),
        buildLog,
      ],
      workspace,
    });

    section('An agent writes a file in the workspace');
    await cog.run(agent, {
      input: 'Create notes/todo.md containing "- fix the build". Use write_file.',
      toolChoice: { type: 'function', function: { name: 'write_file' } },
      onToolCall: (call) => console.log(`  ${call.name} ${JSON.stringify(call.arguments)}`),
    });
    const written = await workspace.list('.', { recursive: true });
    console.log(`  files now: ${written.map((entry) => entry.path).join(', ')}`);

    section('A long tool result is saved to the workspace, the model gets a preview');
    const result = await cog.run(agent, {
      input: 'Call build_log and tell me which step failed.',
      toolChoice: { type: 'function', function: { name: 'build_log' } },
      onToolCall: (call) => console.log(`  ${call.name} ${JSON.stringify(call.arguments)}`),
    });
    const logCall = result.toolCalls.find((call) => call.name === 'build_log');
    if (!logCall) {
      console.log(`  ${MODEL} did not call build_log this time, run the example again`);
    } else {
      const savedPath = toolResultPath(result.runId, logCall.id);
      const page = await workspace.read(savedPath);
      console.log(`  saved in full: ${savedPath} (${page.split('\n').length} lines)`);
    }
    console.log(`  answer: ${result.output.trim()}`);

    await cog.close();
  } finally {
    await workspace.dispose();
    await rm(root, { recursive: true, force: true });
  }
}

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
