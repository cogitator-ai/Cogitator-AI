import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { z } from 'zod';
import {
  Agent,
  Cogitator,
  LocalWorkspace,
  WorkspaceError,
  tool,
  toolResultPath,
  workspaceTools,
} from '@cogitator-ai/core';
import { DockerWorkspace } from '@cogitator-ai/sandbox';
import { MockLLMBackend } from '@cogitator-ai/test-utils';
import type { ToolCall } from '@cogitator-ai/types';
import { getTestModel, ollamaSkipReason } from '../../helpers/setup';

const BUILD_LOG = Array.from({ length: 600 }, (_, i) =>
  i === 437 ? `step ${i + 1}: ERROR missing export in src/app.ts` : `step ${i + 1}: ok`
).join('\n');

const buildLog = tool({
  name: 'build_log',
  description: 'The log of the last build',
  parameters: z.object({}),
  maxResultLength: 2000,
  execute: async () => BUILD_LOG,
});

let base: string;
let workspace: LocalWorkspace;

beforeEach(async () => {
  base = realpathSync(mkdtempSync(join(tmpdir(), 'workspace-e2e-')));
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

function toolTexts(backend: MockLLMBackend): string[] {
  const last = backend.getLastCall();
  return (last?.messages ?? []).filter((m) => m.role === 'tool').map((m) => String(m.content));
}

describe('Workspace: an agent works on files through workspaceTools (MockLLMBackend)', () => {
  it('writes, edits and reads files, and reads back an offloaded result by line range', async () => {
    const pageCall = call('call_page', 'read_file', { path: '', offset: 438, limit: 1 });
    const backend = new MockLLMBackend().setResponses([
      {
        toolCalls: [
          call('call_write', 'write_file', {
            path: 'src/app.ts',
            content: 'export const a = 1;\nconst b = 2;\n',
          }),
        ],
        finishReason: 'tool_calls',
      },
      {
        toolCalls: [
          call('call_edit', 'edit_file', {
            path: 'src/app.ts',
            oldString: 'const b = 2;',
            newString: 'export const b = 2;',
          }),
        ],
        finishReason: 'tool_calls',
      },
      {
        toolCalls: [call('call_read', 'read_file', { path: 'src/app.ts' })],
        finishReason: 'tool_calls',
      },
      { toolCalls: [call('call_log', 'build_log', {})], finishReason: 'tool_calls' },
      { toolCalls: [pageCall], finishReason: 'tool_calls' },
      { content: 'Step 438 failed: missing export in src/app.ts.', finishReason: 'stop' },
    ]);
    const cog = new Cogitator({ llm: { backends: { mock: backend }, retry: false } });
    const agent = new Agent({
      name: 'builder',
      model: 'mock/scripted',
      instructions: 'Work in the workspace.',
      tools: [...workspaceTools(), buildLog],
      workspace,
      maxIterations: 10,
    });

    const result = await cog.run(agent, {
      input: 'Write the app, export b, then find the failing build step',
      onRunStart: ({ runId }) => {
        pageCall.arguments.path = toolResultPath(runId, 'call_log');
      },
    });

    expect(await workspace.read('src/app.ts')).toBe('export const a = 1;\nexport const b = 2;\n');
    const saved = toolResultPath(result.runId, 'call_log');
    expect(await workspace.read(saved)).toBe(BUILD_LOG);

    const texts = toolTexts(backend);
    expect(JSON.parse(texts[2])).toMatchObject({
      content: 'export const a = 1;\nexport const b = 2;',
    });
    expect(texts[3]).toContain(saved);
    expect(texts[3]).toContain('read_file');
    expect(texts[3]).not.toContain('step 438: ERROR');
    expect(JSON.parse(texts[4])).toMatchObject({
      content: 'step 438: ERROR missing export in src/app.ts',
      startLine: 438,
      totalLines: 600,
    });
    expect(result.output).toContain('438');
    await cog.close();
  });

  it('keeps the agent inside the workspace', async () => {
    const backend = new MockLLMBackend().setResponses([
      {
        toolCalls: [call('c1', 'read_file', { path: '../../etc/passwd' })],
        finishReason: 'tool_calls',
      },
      { content: 'Refused.', finishReason: 'stop' },
    ]);
    const cog = new Cogitator({ llm: { backends: { mock: backend }, retry: false } });
    const errors: (string | undefined)[] = [];
    await cog.run(
      new Agent({ name: 'a', model: 'mock/scripted', instructions: 'x', tools: workspaceTools() }),
      { input: 'read it', workspace, onToolResult: (r) => errors.push(r.error) }
    );
    expect(errors[0]).toContain('outside the workspace');
    await cog.close();
  });
});

const ollamaReason = await ollamaSkipReason();

describe.skipIf(ollamaReason !== null)(
  `Workspace: a real model writes a file (Ollama ${getTestModel()})`,
  () => {
    it('writes the file it was asked to write', async () => {
      const cog = new Cogitator({ llm: { defaultModel: `ollama/${getTestModel()}` } });
      const agent = new Agent({
        name: 'writer',
        model: `ollama/${getTestModel()}`,
        instructions: 'You create files with the write_file tool. Always call it.',
        tools: workspaceTools(undefined, { tools: ['write_file'] }),
        workspace,
        maxIterations: 3,
      });
      const written: string[] = [];
      await cog.run(agent, {
        input: 'Create the file hello.txt with the content "hi". Call write_file.',
        toolChoice: 'required',
        onToolResult: (r) => {
          if (!r.error) written.push(String((r.result as { path: string }).path));
        },
      });
      expect(written.length).toBeGreaterThan(0);
      for (const path of written) expect(await workspace.exists(path)).toBe(true);
      await cog.close();
    });
  }
);

describe.skipIf(process.env.TEST_DOCKER !== 'true')(
  'Workspace: DockerWorkspace on a LocalWorkspace',
  () => {
    it('runs commands in the container and refuses a symlink out that a command made', async () => {
      const docker = new DockerWorkspace({ host: workspace, image: 'alpine:3.19' });
      await docker.start();
      try {
        const made = await docker.exec('echo from-container > made.txt && ln -s /etc/passwd leak');
        expect(made.exitCode).toBe(0);
        expect(await docker.read('made.txt')).toBe('from-container\n');
        const error = await docker.read('leak').then(
          () => undefined,
          (reason: unknown) => reason
        );
        expect(WorkspaceError.is(error, 'OUTSIDE_ROOT')).toBe(true);
      } finally {
        await docker.dispose();
      }
    });
  }
);
