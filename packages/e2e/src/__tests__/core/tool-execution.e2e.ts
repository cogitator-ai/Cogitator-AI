import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { z } from 'zod';
import {
  Agent,
  Cogitator,
  LocalWorkspace,
  tool,
  toolOutput,
  workspaceTools,
  type RunResult,
} from '@cogitator-ai/core';
import {
  AgentStreamSession,
  StreamEventSchema,
  type StreamEvent,
} from '@cogitator-ai/server-shared';
import { MockLLMBackend } from '@cogitator-ai/test-utils';
import type { ToolInputAvailable, ToolInputStart, ToolUpdate } from '@cogitator-ai/types';
import { createTestAgent, createTestCogitator, ollamaSkipReason } from '../../helpers/setup';

const describeOllama = describe.skipIf((await ollamaSkipReason()) !== null);

const weather = tool({
  name: 'get_weather',
  description: 'Get the current temperature of a city',
  parameters: z.object({ city: z.string().describe('City name') }),
  annotations: { readOnlyHint: true },
  presentation: ({ city }) => ({ label: 'Weather', icon: 'cloud', detail: city }),
  execute: async ({ city }, context) => {
    context.update?.({ content: `asking about ${city}` });
    return toolOutput({
      content: { city, celsius: 21 },
      details: { source: 'e2e fixture' },
    });
  },
});

const weatherAgent = () =>
  createTestAgent({
    instructions:
      'You answer weather questions. Always call get_weather first, then answer with the temperature.',
    tools: [weather],
    temperature: 0,
  });

/** Runs until the small model calls the tool, at most three times */
async function runCallingTools(run: () => Promise<RunResult>): Promise<RunResult> {
  let result = await run();
  for (let attempt = 1; attempt < 3 && result.toolCalls.length === 0; attempt++) {
    result = await run();
  }
  return result;
}

describeOllama('Core: tool execution (Ollama)', () => {
  let cogitator: Cogitator;

  beforeAll(() => {
    cogitator = createTestCogitator({ memory: true });
  });

  afterAll(async () => {
    await cogitator.close();
  });

  it(
    'streams tool input, updates and the split result of a real tool call',
    { timeout: 180_000 },
    async () => {
      let starts: ToolInputStart[] = [];
      let available: ToolInputAvailable[] = [];
      let updates: ToolUpdate[] = [];
      const threadId = `tool_execution_${Date.now()}`;
      const result = await runCallingTools(() => {
        starts = [];
        available = [];
        updates = [];
        return cogitator.run(weatherAgent(), {
          input: 'What is the temperature in Lisbon?',
          threadId,
          stream: true,
          onToken: () => undefined,
          onToolInputStart: (event) => starts.push(event),
          onToolInputAvailable: (event) => available.push(event),
          onToolUpdate: (update) => updates.push(update),
        });
      });

      expect(result.toolCalls.length).toBeGreaterThan(0);
      const ids = result.toolCalls.map((call) => call.id);
      expect(starts.map((event) => event.toolCallId)).toEqual(ids);
      expect(available.map((event) => event.toolCallId)).toEqual(ids);
      expect(available[0]!.input).toEqual(result.toolCalls[0]!.arguments);
      expect(updates[0]).toMatchObject({ callId: ids[0], name: 'get_weather' });

      const entries = await cogitator.memory!.getEntries({ threadId, includeToolCalls: true });
      if (!entries.success) throw new Error(entries.error);
      const toolEntry = entries.data.find((entry) => entry.message.role === 'tool');
      expect(toolEntry?.metadata).toMatchObject({
        details: { source: 'e2e fixture' },
        presentation: { label: 'Weather', icon: 'cloud' },
      });
      expect(String(toolEntry?.message.content)).not.toContain('e2e fixture');
    }
  );

  it(
    'sends a protocol stream where every tool call opens, streams and closes once',
    { timeout: 180_000 },
    async () => {
      let events: StreamEvent[] = [];
      const result = await runCallingTools(async () => {
        events = [];
        const session = new AgentStreamSession((event) => events.push(event));
        session.start();
        const run = await cogitator.run(weatherAgent(), {
          input: 'How warm is it in Oslo?',
          threadId: session.threadId,
          stream: true,
          ...session.callbacks,
        });
        session.complete(run);
        return run;
      });

      expect(result.toolCalls.length).toBeGreaterThan(0);
      for (const event of events) StreamEventSchema.parse(event);
      for (const call of result.toolCalls) {
        const order = events
          .filter(
            (event) =>
              ('id' in event && event.id === call.id) ||
              ('toolCallId' in event && event.toolCallId === call.id)
          )
          .map((event) => event.type);
        expect(order[0]).toBe('tool-call-start');
        expect(order.filter((type) => type === 'tool-call-end')).toHaveLength(1);
        expect(order.indexOf('tool-call-end')).toBeLessThan(order.indexOf('tool-result'));
        expect(order.indexOf('tool-update')).toBeGreaterThan(order.indexOf('tool-call-end'));
      }
      const resultEvent = events.find((event) => event.type === 'tool-result');
      expect(resultEvent).toMatchObject({
        details: { source: 'e2e fixture' },
        presentation: { label: 'Weather' },
      });
    }
  );

  it(
    'fails a tool call that outlasts timeouts.toolMs and lets the model answer',
    { timeout: 180_000 },
    async () => {
      const stuck = tool({
        name: 'get_weather',
        description: 'Get the current temperature of a city',
        parameters: z.object({ city: z.string() }),
        execute: () => new Promise<never>(() => undefined),
      });
      const agent = createTestAgent({
        instructions:
          'You answer weather questions. Always call get_weather first, then answer with the temperature.',
        tools: [stuck],
        temperature: 0,
        maxIterations: 3,
      });
      const errors: (string | undefined)[] = [];
      const result = await runCallingTools(() =>
        cogitator.run(agent, {
          input: 'What is the temperature in Rome right now?',
          toolChoice: 'required',
          timeouts: { toolMs: 500 },
          onToolResult: (toolResult) => errors.push(toolResult.errorCode),
        })
      );
      expect(result.toolCalls.length).toBeGreaterThan(0);
      expect(errors[0]).toBe('TOOL_TIMEOUT');
    }
  );
});

describe('Core: tool execution scheduling (mock model, real workspace)', () => {
  let root: string;

  beforeAll(async () => {
    root = await mkdtemp(join(tmpdir(), 'tool-execution-e2e-'));
  });

  afterAll(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it(
    'keeps two runs that write one file at once from interleaving their edits',
    { timeout: 60_000 },
    async () => {
      const workspace = new LocalWorkspace({ root });
      await workspace.write('notes.md', 'start\n');
      const backend = (marker: string) =>
        new MockLLMBackend().setResponses([
          {
            toolCalls: [
              {
                id: `w_${marker}`,
                name: 'edit_file',
                arguments: {
                  path: 'notes.md',
                  oldString: 'start\n',
                  newString: `start\n${marker}\n`,
                },
              },
            ],
            finishReason: 'tool_calls',
          },
          { content: 'Edited.' },
        ]);
      const runIn = (marker: string) => {
        const cog = new Cogitator({ llm: { backends: { mock: backend(marker) } } });
        const agent = new Agent({
          name: `editor_${marker}`,
          model: 'mock/m',
          instructions: 'Edit.',
          tools: workspaceTools(),
          workspace,
        });
        return { cog, run: cog.run(agent, { input: 'Edit the notes', parallelToolCalls: true }) };
      };

      const runs = [runIn('one'), runIn('two')];
      const results = await Promise.all(runs.map((entry) => entry.run));
      for (const entry of runs) await entry.cog.close();

      const content = await readFile(join(root, 'notes.md'), 'utf8');
      expect(content.split('\n').filter((line) => line === 'one' || line === 'two')).toHaveLength(
        2
      );
      expect(results.every((result) => result.output === 'Edited.')).toBe(true);
    }
  );

  it(
    'runs read-only workspace calls of a step together and keeps their results in call order',
    { timeout: 60_000 },
    async () => {
      const workspace = new LocalWorkspace({ root });
      await workspace.write('a.txt', 'alpha');
      await workspace.write('b.txt', 'beta');
      const backend = new MockLLMBackend().setResponses([
        {
          toolCalls: [
            { id: 'ra', name: 'read_file', arguments: { path: 'a.txt' } },
            { id: 'rb', name: 'read_file', arguments: { path: 'b.txt' } },
          ],
          finishReason: 'tool_calls',
        },
        { content: 'Read both.' },
      ]);
      const cog = new Cogitator({ llm: { backends: { mock: backend } } });
      const agent = new Agent({
        name: 'reader',
        model: 'mock/m',
        instructions: 'Read.',
        tools: workspaceTools(),
        workspace,
      });
      const presented: unknown[] = [];
      await cog.run(agent, {
        input: 'Read the files',
        parallelToolCalls: true,
        onToolResult: (result) => presented.push(result.presentation?.detail),
      });
      const sent = backend.getLastCall()!.messages.filter((message) => message.role === 'tool');
      expect(sent.map((message) => message.toolCallId)).toEqual(['ra', 'rb']);
      expect(String(sent[0]!.content)).toContain('alpha');
      expect(presented.sort()).toEqual(['a.txt', 'b.txt']);
      await cog.close();
    }
  );
});
