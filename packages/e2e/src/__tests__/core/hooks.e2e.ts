import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Agent, Cogitator, LocalWorkspace, workspaceTools } from '@cogitator-ai/core';
import { MockLLMBackend, type MockChatResponse } from '@cogitator-ai/test-utils';
import type { Message, ToolCall } from '@cogitator-ai/types';
import { getTestModel, ollamaSkipReason } from '../../helpers/setup';

const describeOllama = describe.skipIf((await ollamaSkipReason()) !== null);

const call = (id: string, name: string, args: Record<string, unknown>): ToolCall => ({
  id,
  name,
  arguments: args,
});

const turn = (...calls: ToolCall[]): MockChatResponse => ({
  content: '',
  toolCalls: calls,
  finishReason: 'tool_calls',
});

const toolTexts = (messages: readonly Message[]): string[] =>
  messages.filter((m) => m.role === 'tool').map((m) => String(m.content));

let base: string;
let root: string;
let workspace: LocalWorkspace;

beforeEach(async () => {
  base = realpathSync(mkdtempSync(join(tmpdir(), 'e2e-hooks-')));
  root = join(base, 'repo');
  mkdirSync(join(root, '.claude', 'hooks'), { recursive: true });
  writeFileSync(join(root, 'AGENTS.md'), 'The project codename is Zephyr.\n');
  writeFileSync(
    join(root, '.claude', 'hooks', 'guard.cjs'),
    `const fs = require('node:fs');
const input = JSON.parse(fs.readFileSync(0, 'utf8'));
fs.appendFileSync(process.env.CLAUDE_PROJECT_DIR + '/hooks.log', input.hook_event_name + ' ' + (input.tool_input ? input.tool_input.command : '') + '\\n');
if (input.hook_event_name === 'PreToolUse' && /^rm\\b/.test(input.tool_input.command)) {
  process.stderr.write('rm is not allowed in this repository');
  process.exit(2);
}
if (input.hook_event_name === 'SessionStart') {
  process.stdout.write('The secret code is 4417.');
}
`
  );
  const guard = {
    type: 'command',
    command: process.execPath,
    args: ['${CLAUDE_PROJECT_DIR}/.claude/hooks/guard.cjs'],
  };
  writeFileSync(
    join(root, '.claude', 'settings.json'),
    JSON.stringify({
      hooks: {
        PreToolUse: [{ matcher: 'Bash', hooks: [guard] }],
        SessionStart: [{ hooks: [guard] }],
      },
    })
  );
  workspace = new LocalWorkspace({ root });
  await workspace.start();
});

afterEach(async () => {
  await workspace.dispose();
  rmSync(base, { recursive: true, force: true });
});

const settings = () => ({
  root,
  userDirs: [join(base, 'user')],
  managedDirs: [join(base, 'managed')],
});

describe('Core: hooks and project instructions from a repository on disk', () => {
  it('runs the trusted project hooks of .claude/settings.json and reads AGENTS.md', async () => {
    const backend = new MockLLMBackend().setResponses([
      turn(
        call('c1', 'run_command', { command: 'rm -rf build' }),
        call('c2', 'run_command', { command: 'echo ok' })
      ),
      { content: 'done' },
    ]);
    const cogitator = new Cogitator({
      llm: { backends: { mock: backend }, retry: false },
      permissions: { mode: 'bypassPermissions' },
      hooks: { settings: { ...settings(), trusted: true } },
      instructions: { projectFiles: true },
    });
    const agent = new Agent({
      name: 'coder',
      model: 'mock/m',
      instructions: 'You code.',
      tools: workspaceTools(),
      workspace,
    });
    const result = await cogitator.run(agent, { input: 'clean up' });
    const texts = toolTexts(result.messages);
    expect(texts[0]).toContain('rm is not allowed in this repository');
    expect(texts[1]).toContain('ok');
    const first = backend.getCalls()[0]?.messages ?? [];
    expect(String(first[0]?.content)).toContain('The project codename is Zephyr.');
    expect(first[1]?.content).toBe(
      'SessionStart hook additional context: The secret code is 4417.'
    );
    expect(result.instructions?.map((file) => file.path)).toEqual(['AGENTS.md']);
    expect(readFileSync(join(root, 'hooks.log'), 'utf8').trim().split('\n')).toEqual([
      'SessionStart ',
      'PreToolUse rm -rf build',
      'PreToolUse echo ok',
    ]);
    await cogitator.close();
  });

  it('leaves the hooks of an untrusted repository alone', async () => {
    const backend = new MockLLMBackend().setResponses([
      turn(call('c1', 'run_command', { command: 'rm -f nothing' })),
      { content: 'done' },
    ]);
    const cogitator = new Cogitator({
      llm: { backends: { mock: backend }, retry: false },
      permissions: { mode: 'bypassPermissions' },
      hooks: { settings: settings() },
    });
    const agent = new Agent({
      name: 'coder',
      model: 'mock/m',
      instructions: 'You code.',
      tools: workspaceTools(),
      workspace,
    });
    const result = await cogitator.run(agent, { input: 'clean up' });
    expect(toolTexts(result.messages)[0]).not.toContain('not allowed');
    expect(() => readFileSync(join(root, 'hooks.log'))).toThrow();
    await cogitator.close();
  });
});

describeOllama('Core: hooks and project instructions on Ollama', () => {
  it(
    'answers from the context a SessionStart hook adds and from AGENTS.md',
    { timeout: 120_000 },
    async () => {
      const cogitator = new Cogitator({
        llm: { defaultModel: `ollama/${getTestModel()}` },
        hooks: { settings: { ...settings(), trusted: true } },
        instructions: { projectFiles: true },
      });
      const agent = new Agent({
        name: 'helper',
        model: `ollama/${getTestModel()}`,
        instructions: 'Answer in one short sentence, using what the system messages tell you.',
        workspace,
        temperature: 0,
      });
      const code = await cogitator.run(agent, { input: 'What is the secret code?' });
      expect(code.output).toContain('4417');
      const name = await cogitator.run(agent, { input: 'What is the project codename?' });
      expect(name.output.toLowerCase()).toContain('zephyr');
      await cogitator.close();
    }
  );
});
