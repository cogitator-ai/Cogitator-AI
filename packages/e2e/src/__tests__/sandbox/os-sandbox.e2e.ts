import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { MockLLMBackend } from '@cogitator-ai/test-utils';
import { OsSandbox, SandboxManager } from '@cogitator-ai/sandbox';
import {
  Agent,
  Cogitator,
  LocalWorkspace,
  loadSandboxPolicy,
  workspaceTools,
} from '@cogitator-ai/core';
import type { Message, ToolCall, WorkspaceExecResult } from '@cogitator-ai/types';
import { getTestModel, ollamaSkipReason } from '../../helpers/setup';

const probe = await OsSandbox.probe();
const ollamaSkip = await ollamaSkipReason();
const context = () => ({ agentId: 'e2e', runId: 'e2e', signal: new AbortController().signal });

describe.skipIf(!probe.available)(`OS sandbox end to end (${probe.kind})`, () => {
  let base: string;
  let root: string;
  let server: Server;
  let port: number;

  beforeAll(async () => {
    server = createServer((_req, res) => res.end('local service'));
    await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
    port = (server.address() as { port: number }).port;
  });

  afterAll(async () => {
    await new Promise<void>((done) => server.close(() => done()));
  });

  beforeEach(async () => {
    base = await realpath(await mkdtemp(join(tmpdir(), 'e2e-os-sandbox-')));
    root = join(base, 'project');
    await mkdir(join(root, '.claude'), { recursive: true });
  });

  afterEach(async () => {
    await rm(base, { recursive: true, force: true });
  });

  it('configures the sandbox from .claude/settings.json and enforces it in run_command', async () => {
    await writeFile(
      join(root, '.claude', 'settings.json'),
      JSON.stringify({
        sandbox: {
          enabled: true,
          filesystem: { denyRead: ['./private'] },
          network: { allowedDomains: [`127.0.0.1:${port}`] },
        },
      })
    );
    await mkdir(join(root, 'private'));
    await writeFile(join(root, 'private', 'key'), 'secret');
    const { policy, warnings } = await loadSandboxPolicy(root, {
      userDirs: [join(base, 'user')],
      managedDirs: [],
    });
    expect(warnings).toEqual([]);
    expect(policy.enabled).toBe(true);

    const sandbox = new OsSandbox({ policy, onWarning: () => undefined });
    const workspace = new LocalWorkspace({ root, exec: { sandbox } });
    await workspace.start();
    const [runCommand] = workspaceTools(workspace, { tools: ['run_command'] });
    const run = async (command: string) =>
      (await runCommand.execute({ command }, context())) as WorkspaceExecResult;

    const written = await run('echo ok > inside.txt && cat inside.txt');
    expect(written.stdout).toBe('ok\n');
    expect(written.sandbox?.sandboxed).toBe(true);

    const outside = await run(`echo no > ${join(base, 'outside.txt')}`);
    expect(existsSync(join(base, 'outside.txt'))).toBe(false);
    expect(outside.stderr).toContain('<sandbox_violations>');

    const hidden = await run('cat private/key');
    expect(hidden.stdout).toBe('');

    const settings = await run('echo "{}" > .claude/settings.json');
    expect(settings.exitCode).not.toBe(0);
    expect(await readFile(join(root, '.claude', 'settings.json'), 'utf8')).toContain('sandbox');

    const fetched = await run(`curl -s -m 10 http://127.0.0.1:${port}/`);
    expect(fetched.stdout).toBe('local service');
    const refused = await run('curl -s -m 10 https://example.com/');
    expect(refused.sandbox?.violations).toContainEqual(
      expect.objectContaining({ kind: 'network', target: 'example.com:443' })
    );

    await workspace.dispose();
    await sandbox.dispose();
  });

  it('runs sandboxed commands of an agent without an approval, and asks for a critical removal', async () => {
    const sandbox = new OsSandbox({ onWarning: () => undefined });
    const workspace = new LocalWorkspace({ root, exec: { sandbox } });
    const calls: ToolCall[][] = [
      [{ id: 'c1', name: 'run_command', arguments: { command: 'echo built > out.txt' } }],
      [{ id: 'c2', name: 'run_command', arguments: { command: 'rm -rf .' } }],
    ];
    const backend = new MockLLMBackend().setResponses([
      ...calls.map((toolCalls) => ({
        content: '',
        toolCalls,
        finishReason: 'tool_calls' as const,
      })),
      { content: 'done' },
    ]);
    const cog = new Cogitator({
      memory: { adapter: 'memory' },
      llm: { backends: { mock: backend }, retry: false },
    });
    const agent = new Agent({
      name: 'builder',
      model: 'mock/m',
      instructions: 'Build.',
      tools: workspaceTools(),
      workspace,
    });
    const result = await cog.run(agent, { input: 'build', threadId: 'e2e-sandbox' });
    expect(await readFile(join(root, 'out.txt'), 'utf8')).toBe('built\n');
    expect(result.status).toBe('paused');
    expect(result.pendingApprovals?.[0]).toMatchObject({ toolCallId: 'c2' });
    expect(existsSync(root)).toBe(true);
    await cog.close();
    await workspace.dispose();
    await sandbox.dispose();
  });

  it('runs an os type execution of the SandboxManager without a fallback', async () => {
    const manager = new SandboxManager();
    const result = await manager.execute(
      { command: [`echo hi > ${join(base, 'escape.txt')}; echo done`] },
      { type: 'os', workdir: root }
    );
    expect(result.success).toBe(true);
    expect(existsSync(join(base, 'escape.txt'))).toBe(false);
    await manager.shutdown();
  });

  describe.skipIf(ollamaSkip !== null)('with a real model', () => {
    it('runs the commands of a real model without asking, nothing escaping the root', async () => {
      const sandbox = new OsSandbox({ onWarning: () => undefined });
      const workspace = new LocalWorkspace({ root, exec: { sandbox } });
      const cog = new Cogitator({ llm: { defaultModel: `ollama/${getTestModel()}` } });
      const agent = new Agent({
        name: 'tester',
        model: `ollama/${getTestModel()}`,
        instructions:
          'You run shell commands with run_command. Run exactly the command the user gives, once, then answer with one word: BLOCKED if the result has a sandbox_violations block, else OK.',
        tools: workspaceTools(undefined, { tools: ['run_command'] }),
        workspace,
        maxIterations: 4,
      });
      const result = await cog.run(agent, {
        input: `Run: echo x > ${join(base, 'escape.txt')}`,
      });
      expect(result.status).toBe('completed');
      expect(existsSync(join(base, 'escape.txt'))).toBe(false);
      for (const message of result.messages.filter((m: Message) => m.role === 'tool')) {
        const text = String(message.content);
        if (text.includes('"sandboxed":true') && text.includes('escape.txt')) {
          expect(text).toContain('sandbox_violations');
        }
      }
      await cog.close();
      await workspace.dispose();
      await sandbox.dispose();
    });
  });
});

describe('the workspace trash end to end', () => {
  let root: string;

  beforeEach(async () => {
    root = await realpath(await mkdtemp(join(tmpdir(), 'e2e-trash-')));
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it('deletes with delete_file, lists, restores and empties the trash', async () => {
    const workspace = new LocalWorkspace({ root });
    await workspace.write('src/a.ts', 'export const a = 1;\n');
    await workspace.write('src/b.ts', 'export const b = 2;\n');
    const [deleteFile] = workspaceTools(workspace, { tools: ['delete_file'] });
    await deleteFile.execute({ path: 'src/a.ts' }, context());
    await deleteFile.execute({ path: 'src', recursive: true }, context());
    const entries = await workspace.listTrash();
    expect(entries.map((entry) => entry.path)).toEqual(['src/a.ts', 'src']);
    await workspace.restoreFromTrash(entries[1].id);
    expect(await workspace.read('src/b.ts')).toBe('export const b = 2;\n');
    await workspace.restoreFromTrash(entries[0].id);
    expect(await workspace.read('src/a.ts')).toBe('export const a = 1;\n');
    await deleteFile.execute({ path: 'src/b.ts' }, context());
    expect((await workspace.emptyTrash()).deleted).toHaveLength(1);
    expect(await workspace.listTrash()).toEqual([]);
    await workspace.dispose();
  });
});
