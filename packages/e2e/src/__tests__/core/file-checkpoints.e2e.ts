import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Agent, Cogitator, LocalWorkspace, workspaceTools } from '@cogitator-ai/core';
import { MockLLMBackend } from '@cogitator-ai/test-utils';
import { fileCheckpointOf, type MemoryEntry, type ToolCall } from '@cogitator-ai/types';
import { getTestModel, ollamaSkipReason } from '../../helpers/setup';

let base: string;
let workspace: LocalWorkspace;

beforeEach(async () => {
  base = realpathSync(mkdtempSync(join(tmpdir(), 'file-checkpoints-e2e-')));
  workspace = new LocalWorkspace({ root: join(base, 'project') });
  await workspace.start();
});

afterEach(async () => {
  await workspace.dispose();
  rmSync(base, { recursive: true, force: true });
});

function call(id: string, name: string, args: Record<string, unknown>): ToolCall {
  return { id, name, arguments: args };
}

/** The file as it is now, undefined when it does not exist */
function fileNow(path: string): string | undefined {
  const full = join(workspace.root, path);
  return existsSync(full) ? readFileSync(full, 'utf8') : undefined;
}

async function activePath(cog: Cogitator, threadId: string): Promise<MemoryEntry[]> {
  const memory = await cog.getMemory();
  const path = await memory!.getPath!({ threadId, types: 'all' });
  if (!path.success) throw new Error(path.error);
  return path.data;
}

describe('File checkpoints: rewind restores conversation and files (MockLLMBackend)', () => {
  it('brings back the files and the conversation of an earlier message', async () => {
    const backend = new MockLLMBackend().setResponses([
      {
        toolCalls: [
          call('c1', 'write_file', { path: 'src/app.ts', content: 'export const v = 1;\n' }),
        ],
        finishReason: 'tool_calls',
      },
      { content: 'Wrote v1.' },
      {
        toolCalls: [
          call('c2', 'write_file', { path: 'src/app.ts', content: 'export const v = 2;\n' }),
          call('c3', 'run_command', { command: 'mkdir -p dist && echo built > dist/out.js' }),
        ],
        finishReason: 'tool_calls',
      },
      { content: 'Wrote v2 and built.' },
    ]);
    const cog = new Cogitator({
      llm: { backends: { mock: backend } },
      memory: { adapter: 'memory' },
      checkpoints: true,
    });
    const agent = new Agent({
      id: 'coder',
      name: 'coder',
      model: 'mock/m',
      instructions: 'You edit the project.',
      tools: workspaceTools(undefined, { requireApproval: () => false }),
      workspace,
    });
    try {
      await cog.run(agent, { input: 'Write v1', threadId: 'project' });
      await cog.run(agent, { input: 'Write v2 and build', threadId: 'project' });
      expect(fileNow('src/app.ts')).toBe('export const v = 2;\n');
      expect(fileNow('dist/out.js')).toBe('built\n');

      const before = await activePath(cog, 'project');
      const second = before.findIndex((entry) => entry.message.content === 'Write v2 and build');
      const point = before[second - 1]!;
      const plan = await cog.rewind('project', point.id, {
        files: true,
        dryRun: true,
        agents: [agent],
      });
      expect(plan.files?.restored).toEqual(['src/app.ts']);
      expect(plan.files?.deleted).toEqual(['dist', 'dist/out.js']);
      expect(fileNow('src/app.ts')).toBe('export const v = 2;\n');

      const report = await cog.rewind('project', point.id, { files: true, agents: [agent] });
      expect(report.files?.exact).toBe(true);
      expect(fileNow('src/app.ts')).toBe('export const v = 1;\n');
      expect(fileNow('dist/out.js')).toBeUndefined();
      const after = await activePath(cog, 'project');
      expect(after.at(-1)!.id).toBe(point.id);
      expect(after.some((entry) => entry.message.content === 'Write v2 and build')).toBe(false);
      expect(fileCheckpointOf(after[0]!.metadata)?.root).toBe(workspace.root);
    } finally {
      await cog.close();
    }
  });
});

const ollamaReason = await ollamaSkipReason();

describe.skipIf(ollamaReason !== null)(
  `File checkpoints: a real model edits files over several messages (Ollama ${getTestModel()})`,
  () => {
    it(
      'restores the files and the conversation as they were after the first message',
      { timeout: 600_000 },
      async () => {
        const model = `ollama/${getTestModel()}`;
        const cog = new Cogitator({
          llm: { defaultModel: model },
          memory: { adapter: 'memory' },
          checkpoints: true,
        });
        const agent = new Agent({
          id: 'notes',
          name: 'notes',
          model,
          instructions:
            'You keep the file notes.txt. When asked, call write_file with path "notes.txt" and the content you are given, then answer in one short sentence.',
          tools: workspaceTools(undefined, { tools: ['write_file'] }),
          workspace,
          maxIterations: 3,
        });
        try {
          const states: (string | undefined)[] = [];
          const asks = ['first draft', 'second draft', 'third draft'];
          for (const content of asks) {
            await cog.run(agent, {
              input: `Write "${content}" into notes.txt with write_file.`,
              threadId: 'notes',
              toolChoice: 'required',
            });
            states.push(fileNow('notes.txt'));
          }
          const path = await activePath(cog, 'notes');
          const users = path.filter((entry) => entry.message.role === 'user');
          expect(users).toHaveLength(3);
          expect(users.every((entry) => fileCheckpointOf(entry.metadata))).toBe(true);
          const point = path[path.indexOf(users[1]!) - 1]!;

          const report = await cog.rewind('notes', point.id, { files: true, agents: [agent] });

          expect(report.conversation.rewound).toBe(true);
          expect(report.files?.exact).toBe(true);
          expect(fileNow('notes.txt')).toBe(states[0]);
          const after = await activePath(cog, 'notes');
          expect(after.at(-1)!.id).toBe(point.id);
          expect(after.filter((entry) => entry.message.role === 'user')).toHaveLength(1);
        } finally {
          await cog.close();
        }
      }
    );
  }
);
