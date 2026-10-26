import {
  existsSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Cogitator, createHarnessAgent, type HarnessAgent } from '@cogitator-ai/core';
import { MockLLMBackend, type MockChatResponse } from '@cogitator-ai/test-utils';
import type { TodoItem, ToolCall } from '@cogitator-ai/types';
import { getTestModel, ollamaSkipReason } from '../../helpers/setup';

let base: string;
let harness: HarnessAgent | undefined;

beforeEach(() => {
  base = realpathSync(mkdtempSync(join(tmpdir(), 'harness-agent-e2e-')));
});

afterEach(async () => {
  await harness?.dispose();
  harness = undefined;
  rmSync(base, { recursive: true, force: true });
});

const turn = (...calls: ToolCall[]): MockChatResponse => ({
  content: '',
  toolCalls: calls,
  finishReason: 'tool_calls',
});

describe('Harness agent in a runtime (MockLLMBackend)', () => {
  it('reads the project, delegates to the general-purpose subagent and asks before it writes', async () => {
    const root = join(base, 'project');
    harness = createHarnessAgent({
      workspace: root,
      model: 'lead/m',
      subagents: {
        agents: { 'general-purpose': { description: 'Does tasks', model: 'delegate/m' } },
      },
    });
    await harness.workspace?.start();
    writeFileSync(join(root, 'AGENTS.md'), 'Name every file in kebab-case.\n');
    const lead = new MockLLMBackend().setResponses([
      turn({
        id: 'a1',
        name: 'agent',
        arguments: {
          description: 'write the summary',
          prompt: 'Write "all good" to summary.md',
          subagent_type: 'general-purpose',
        },
      }),
      { content: 'The subagent wrote summary.md.' },
    ]);
    const delegate = new MockLLMBackend().setResponses([
      turn({
        id: 'w1',
        name: 'write_file',
        arguments: { path: 'summary.md', content: 'all good' },
      }),
      { content: 'Wrote summary.md.' },
    ]);
    const cog = new Cogitator(
      harness.mergeConfig({ llm: { backends: { lead, delegate }, retry: false } })
    );
    const asked: string[] = [];
    try {
      const result = await cog.run(harness.agent, {
        input: 'Summarize the project into summary.md',
        ...harness.runOptions,
        onApproval: (request) => {
          asked.push(request.toolName);
          return { approved: true };
        },
      });

      expect(result.output).toBe('The subagent wrote summary.md.');
      expect(readFileSync(join(root, 'summary.md'), 'utf8')).toBe('all good');
      expect(asked).toEqual(['write_file']);
      expect(result.instructions?.map((file) => file.path)).toEqual(['AGENTS.md']);
      const system = String(lead.getCalls()[0]?.messages[0]?.content);
      expect(system).toContain('Name every file in kebab-case.');
      expect(system).toContain('## Subagents');
    } finally {
      await cog.close();
    }
  });
});

const ollamaReason = await ollamaSkipReason();

/** Tries of a small local model, which may not call the tool asked for every time */
const ATTEMPTS = 10;

/** Most milliseconds one try may take */
const ATTEMPT_TIMEOUT = 90_000;

/** Covers every try at its longest */
const TEST_TIMEOUT = ATTEMPTS * ATTEMPT_TIMEOUT + 30_000;

/**
 * Runs `attempt` until `done()` or {@link ATTEMPTS} tries. A try that fails (the model wrote a
 * call that does not parse, the try ran out of time) counts as a try, the last failure is thrown
 * when none succeeded
 */
async function tryRuns(attempt: () => Promise<unknown>, done: () => boolean): Promise<void> {
  let failure: unknown;
  for (let tries = 0; tries < ATTEMPTS && !done(); tries++) {
    try {
      await attempt();
    } catch (error) {
      failure = error;
    }
  }
  if (!done() && failure !== undefined) throw failure;
}

describe.skipIf(ollamaReason !== null)(
  `Harness agent with a real model (Ollama ${getTestModel()})`,
  () => {
    const model = `ollama/${getTestModel()}`;

    it(
      'writes a file in a temporary workspace and reads it back',
      { timeout: TEST_TIMEOUT * 2 },
      async () => {
        const root = join(base, 'workspace');
        harness = createHarnessAgent({
          preset: 'assistant',
          workspace: root,
          model,
          maxIterations: 2,
          timeouts: { totalMs: ATTEMPT_TIMEOUT },
        });
        const cog = new Cogitator(harness.mergeConfig({ llm: { defaultModel: model } }));
        const approved: string[] = [];
        const notes = join(root, 'notes.txt');
        try {
          await tryRuns(
            () =>
              cog.run(harness!.agent, {
                input:
                  'Call write_file with {"path": "notes.txt", "content": "hello harness"}. Do nothing else.',
                ...harness!.runOptions,
                toolChoice: 'required',
                onApproval: (request) => {
                  approved.push(request.toolName);
                  return { approved: true };
                },
              }),
            () => existsSync(notes)
          );
          expect(readFileSync(notes, 'utf8')).toContain('hello');
          expect(approved).toContain('write_file');

          const read: string[] = [];
          await tryRuns(
            () =>
              cog.run(harness!.agent, {
                input: 'Call read_file with {"path": "notes.txt"} and tell me what the file says.',
                ...harness!.runOptions,
                toolChoice: 'required',
                onToolResult: (result) => {
                  if (!result.error && result.name === 'read_file') {
                    read.push(JSON.stringify(result.result));
                  }
                },
              }),
            () => read.length > 0
          );
          expect(read[0]).toContain('hello');
        } finally {
          await cog.close();
        }
      }
    );

    it('plans with write_todos', { timeout: TEST_TIMEOUT }, async () => {
      harness = createHarnessAgent({
        workspace: join(base, 'project'),
        model,
        subagents: false,
        maxIterations: 2,
        timeouts: { totalMs: ATTEMPT_TIMEOUT },
      });
      const cog = new Cogitator(harness.mergeConfig({ llm: { defaultModel: model } }));
      let todos: readonly TodoItem[] | undefined;
      try {
        await tryRuns(
          async () => {
            const result = await cog.run(harness!.agent, {
              input:
                'Call write_todos with {"todos": [{"id": "read", "content": "Read the code", "status": "in_progress"}, {"id": "fix", "content": "Fix the bug", "status": "pending"}]}.',
              ...harness!.runOptions,
              toolChoice: 'required',
              onApproval: () => ({ approved: false, reason: 'Only plan in this test' }),
            });
            todos = result.todos;
          },
          () => (todos?.length ?? 0) > 0
        );
        expect(todos?.length).toBeGreaterThan(0);
        expect(todos!.filter((todo) => todo.status === 'in_progress').length).toBeLessThanOrEqual(
          1
        );
      } finally {
        await cog.close();
      }
    });
  }
);
