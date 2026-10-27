import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  Agent,
  LocalWorkspace,
  workspaceTools,
  type Cogitator,
  type Workspace,
} from '@cogitator-ai/core';
import type { MemoryEntry } from '@cogitator-ai/types';
import { createCogitator, header, section } from '../_shared/setup.js';

const MODEL = process.env.EXAMPLE_MODEL ?? `ollama/${process.env.OLLAMA_MODEL ?? 'qwen2.5:0.5b'}`;
const THREAD = 'release-notes';

/** The files of a workspace with what they hold, the way the model left them */
async function files(workspace: Workspace): Promise<string> {
  const entries = await workspace.list('.', { recursive: true });
  const shown: string[] = [];
  for (const entry of entries.filter((each) => each.type === 'file')) {
    shown.push(`${entry.path} = ${JSON.stringify(await workspace.read(entry.path))}`);
  }
  return shown.join(', ') || '(no files)';
}

async function activeBranch(cog: Cogitator): Promise<MemoryEntry[]> {
  const memory = await cog.getMemory();
  const path = await memory!.getPath!({ threadId: THREAD, types: 'all' });
  if (!path.success) throw new Error(path.error);
  return path.data;
}

async function main() {
  header('31 - Rewind: conversation, memory and files back to an earlier message');
  const dir = mkdtempSync(join(tmpdir(), 'cogitator-rewind-'));
  const workspace = new LocalWorkspace({ root: join(dir, 'project') });
  const forkWorkspace = new LocalWorkspace({ root: join(dir, 'fork') });
  const cog = createCogitator({
    memory: { adapter: 'sqlite', sqlite: { path: join(dir, 'memory.db') } },
    checkpoints: true,
  });
  const writer = new Agent({
    id: 'writer',
    name: 'writer',
    model: MODEL,
    instructions:
      'You keep the file NOTES.md. When asked, call write_file with path "NOTES.md" and the text you are given, then answer in one short sentence.',
    tools: workspaceTools(undefined, { tools: ['write_file'] }),
    workspace,
    maxIterations: 3,
  });

  try {
    section('Three messages, each followed by a checkpoint of the files');
    for (const text of ['- Faster startup', '- Faster startup\n- New CLI', '- Everything broke']) {
      await cog.run(writer, {
        input: `Write this into NOTES.md: ${JSON.stringify(text)}`,
        threadId: THREAD,
        toolChoice: 'required',
      });
      console.log(`  files: ${await files(workspace)}`);
    }
    await workspace.exec('echo "draft" > scratch.txt');
    console.log('  a shell command left scratch.txt behind');

    const branch = await activeBranch(cog);
    const users = branch.filter((entry) => entry.message.role === 'user');
    const point = branch[branch.indexOf(users[2]!) - 1]!;

    section('Dry run: what a rewind to the end of the second message would change');
    const plan = await cog.rewind(THREAD, point.id, {
      files: true,
      agents: [writer],
      dryRun: true,
    });
    console.log(`  entries leaving the branch: ${plan.conversation.cut.length}`);
    console.log(`  files restored: ${plan.files?.restored.join(', ') || 'none'}`);
    console.log(`  files deleted: ${plan.files?.deleted.join(', ') || 'none'}`);

    section('Rewind for real');
    const report = await cog.rewind(THREAD, point.id, { files: true, agents: [writer] });
    console.log(`  exact checkpoint: ${report.files?.exact}`);
    console.log(`  files: ${await files(workspace)}`);
    console.log(
      `  messages on the branch: ${(await activeBranch(cog)).filter((e) => e.message.role === 'user').length}`
    );

    section('Fork the thread at the first message, with its files, into another directory');
    const first = branch[branch.indexOf(users[1]!) - 1]!;
    const fork = await cog.forkThread(THREAD, first.id, {
      files: true,
      workspace: forkWorkspace,
      source: workspace,
    });
    console.log(
      `  new thread ${fork.thread.id}, ${fork.snapshotsCopied.length} checkpoint(s) copied`
    );
    console.log(`  fork files: ${await files(forkWorkspace)}`);
    console.log(`  original files: ${await files(workspace)}`);
  } finally {
    await cog.close();
    await workspace.dispose();
    await forkWorkspace.dispose();
    rmSync(dir, { recursive: true, force: true });
  }
}

main().catch(console.error);
