import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { Agent, Cogitator, LocalWorkspace, tool } from '@cogitator-ai/core';
import { MockLLMBackend, type MockChatResponse } from '@cogitator-ai/test-utils';
import type { DefinitionFileOptions, Message, ToolCall } from '@cogitator-ai/types';
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
  messages.filter((message) => message.role === 'tool').map((message) => String(message.content));

let base: string;
let root: string;
let workspace: LocalWorkspace;
let files: DefinitionFileOptions;

beforeEach(async () => {
  base = realpathSync(mkdtempSync(join(tmpdir(), 'e2e-subagents-')));
  root = join(base, 'repo');
  mkdirSync(join(root, '.claude', 'agents'), { recursive: true });
  mkdirSync(join(root, '.claude', 'commands', 'team'), { recursive: true });
  writeFileSync(
    join(root, '.claude', 'agents', 'releaser.md'),
    '---\nname: releaser\ndescription: Releases builds\ntools: deploy, Agent\nmodel: inner/m\n---\nYou release builds with the deploy tool.\n'
  );
  writeFileSync(
    join(root, '.claude', 'agents', 'operator.md'),
    '---\nname: operator\ndescription: Runs deploys\ntools: deploy\nmodel: leaf/m\n---\nYou operate deploys.\n'
  );
  writeFileSync(
    join(root, '.claude', 'commands', 'team', 'greet.md'),
    '---\ndescription: Greets someone\nargument-hint: "[name]"\n---\nReply with exactly this sentence and nothing else: Hello, $0!\n'
  );
  workspace = new LocalWorkspace({ root });
  await workspace.start();
  files = { root, trusted: true, userDirs: [], managedDirs: [] };
});

afterEach(async () => {
  await workspace.dispose();
  rmSync(base, { recursive: true, force: true });
});

const deployed: string[] = [];
const deploy = tool({
  name: 'deploy',
  description: 'Deploys a build',
  parameters: z.object({ target: z.string() }),
  requiresApproval: true,
  execute: async ({ target }) => {
    deployed.push(target);
    return `deployed ${target}`;
  },
});

describe('Core: subagents and commands from files', () => {
  it('bubbles the approval of a project subagent up two levels and resumes it there', async () => {
    deployed.length = 0;
    const outer = new MockLLMBackend().setResponses([
      turn(
        call('o1', 'agent', {
          description: 'release',
          prompt: 'ship eu',
          subagent_type: 'releaser',
        })
      ),
      { content: 'released' },
    ]);
    const inner = new MockLLMBackend().setResponses([
      turn(
        call('m1', 'agent', {
          description: 'deploy',
          prompt: 'deploy eu',
          subagent_type: 'operator',
        })
      ),
      { content: 'operator finished' },
    ]);
    const leaf = new MockLLMBackend().setResponses([
      turn(call('l1', 'deploy', { target: 'eu' })),
      { content: 'eu is live' },
    ]);
    const cogitator = new Cogitator({
      memory: { adapter: 'memory' },
      llm: { backends: { outer, inner, leaf }, retry: false },
      subagents: { files, approvalMode: 'bubble' },
    });
    const lead = new Agent({
      name: 'lead',
      model: 'outer/m',
      instructions: 'You lead releases.',
      tools: [deploy],
      workspace,
    });

    const paused = await cogitator.run(lead, { input: 'release', threadId: 'e2e-bubble' });
    expect(paused.status).toBe('paused');
    expect(paused.pendingApprovals?.map((request) => request.toolCallId)).toEqual(['o1/m1/l1']);
    expect(paused.interrupts?.[0]?.details?.subagent).toBe('releaser/operator');

    const done = await cogitator.resume(lead, 'e2e-bubble', {
      responses: { 'o1/m1/l1': { approved: true } },
    });
    expect(done.status).toBe('completed');
    expect(done.output).toBe('released');
    expect(deployed).toEqual(['eu']);
    expect(JSON.parse(toolTexts(done.messages)[0] ?? '{}')).toMatchObject({
      status: 'completed',
      output: 'operator finished',
    });
    await cogitator.close();
  });

  it('declines a subagent approval by default and keeps the run going', async () => {
    deployed.length = 0;
    const outer = new MockLLMBackend().setResponses([
      turn(
        call('o1', 'agent', {
          description: 'deploy',
          prompt: 'deploy us',
          subagent_type: 'operator',
        })
      ),
      { content: 'reported' },
    ]);
    const leaf = new MockLLMBackend().setResponses([
      turn(call('l1', 'deploy', { target: 'us' })),
      { content: 'could not deploy' },
    ]);
    const cogitator = new Cogitator({
      llm: { backends: { outer, leaf }, retry: false },
      subagents: { files },
    });
    const lead = new Agent({
      name: 'lead',
      model: 'outer/m',
      instructions: 'Lead.',
      tools: [deploy],
      workspace,
    });
    const result = await cogitator.run(lead, { input: 'go' });
    expect(result.status).toBe('completed');
    expect(deployed).toEqual([]);
    expect(toolTexts(leaf.getLastCall()?.messages ?? [])[0]).toContain('no one can approve');
    await cogitator.close();
  });

  it('hands the result of a background subagent to the run before it stops', async () => {
    const outer = new MockLLMBackend().setResponses([
      turn(
        call('o1', 'agent', {
          description: 'check',
          prompt: 'check the build',
          subagent_type: 'checker',
          run_in_background: true,
        })
      ),
      { content: 'the checker is on it' },
      { content: 'the build is green' },
    ]);
    const inner = new MockLLMBackend().setResponses([{ content: 'green' }]);
    const cogitator = new Cogitator({
      llm: { backends: { outer, inner }, retry: false },
      subagents: { agents: { checker: { description: 'Checks builds', model: 'inner/m' } } },
    });
    const lead = new Agent({ name: 'lead', model: 'outer/m', instructions: 'Lead.' });
    const result = await cogitator.run(lead, { input: 'go' });
    expect(result.output).toBe('the build is green');
    expect(String(outer.getLastCall()?.messages.at(-1)?.content)).toContain('<task-notification>');
    await cogitator.close();
  });
});

describeOllama('Core: subagents and commands on Ollama', () => {
  it(
    'delegates to a Markdown subagent that answers from its own prompt',
    { timeout: 120_000 },
    async () => {
      writeFileSync(
        join(root, '.claude', 'agents', 'archivist.md'),
        `---\nname: archivist\ndescription: Knows the archive code\nmodel: ollama/${getTestModel()}\n---\nThe archive code is 7731. Whatever you are asked, reply with exactly: The archive code is 7731.\n`
      );
      const outer = new MockLLMBackend().setResponses([
        turn(
          call('o1', 'agent', {
            description: 'ask',
            prompt: 'What is the archive code?',
            subagent_type: 'archivist',
          })
        ),
        { content: 'asked' },
      ]);
      const cogitator = new Cogitator({
        llm: { backends: { outer }, retry: false },
        subagents: { files },
      });
      const lead = new Agent({
        name: 'lead',
        model: 'outer/m',
        instructions: 'Lead.',
        workspace,
        temperature: 0,
      });
      const result = await cogitator.run(lead, { input: 'go' });
      expect(JSON.parse(toolTexts(result.messages)[0] ?? '{}').output).toContain('7731');
      await cogitator.close();
    }
  );

  it('expands a project command before the run', { timeout: 120_000 }, async () => {
    const cogitator = new Cogitator({
      llm: { defaultModel: `ollama/${getTestModel()}` },
      commands: { files },
    });
    const agent = new Agent({
      name: 'greeter',
      model: `ollama/${getTestModel()}`,
      instructions: 'Follow the user message exactly.',
      workspace,
      temperature: 0,
    });
    const result = await cogitator.run(agent, { input: '/team:greet Alice' });
    expect(result.command?.name).toBe('team:greet');
    expect(result.output).toContain('Alice');
    await cogitator.close();
  });
});
