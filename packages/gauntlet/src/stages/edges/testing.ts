import { Agent, Cogitator, tool } from '@cogitator-ai/core';
import {
  MockLLMBackend,
  MockMemoryAdapter,
  createMockRunResult,
  createTestAgentConfig,
  createToolCall,
  waitFor,
  withTimeout,
} from '@cogitator-ai/test-utils';
import type { Message } from '@cogitator-ai/types';
import { z } from 'zod';
import type { StageContext, StageDefinition } from '../../runner/types.js';

const TEST_UTILS = '@cogitator-ai/test-utils';
const CORE = '@cogitator-ai/core';

function text(message: Message | undefined): string {
  if (!message) return '';
  if (typeof message.content === 'string') return message.content;
  return message.content.map((part) => (part.type === 'text' ? part.text : '')).join(' ');
}

/** A runtime on the mock backend alone, closed when the gauntlet ends. */
function mockRuntime(ctx: StageContext, mock: MockLLMBackend, retry?: false): Cogitator {
  const runtime = new Cogitator({
    llm: { backends: { mock }, ...(retry === false ? { retry } : {}) },
  });
  ctx.onCleanup(() => runtime.close());
  return runtime;
}

/** Proves a user can test agent code end to end without a model: scripted calls, real tools, recorded memory. */
const testUtils: StageDefinition = {
  id: 'test-utils',
  title: 'Deterministic testing kit',
  description:
    'A full agent run on MockLLMBackend and MockMemoryAdapter: a scripted tool call runs the real tool, memory is written and reloaded, streams and failures are scripted, with no model involved.',
  packages: [TEST_UTILS, CORE],
  timeoutMs: 30_000,
  async run(ctx) {
    const ledger: string[] = [];
    const ledgerWrite = tool({
      name: 'ledger_write',
      description: 'Append an entry to the stock ledger.',
      parameters: z.object({ entry: z.string() }),
      execute: async ({ entry }) => {
        ledger.push(entry);
        return { written: true, lines: ledger.length };
      },
    });
    const agent = new Agent(
      createTestAgentConfig({
        name: 'ledger-keeper',
        instructions: 'You keep the stock ledger.',
        tools: [ledgerWrite],
      })
    );

    const mock = new MockLLMBackend().setResponses([
      { toolCalls: [createToolCall('ledger_write', { entry: 'brass gears x417' })] },
      { content: 'Logged 417 brass gears.' },
    ]);
    const memory = new MockMemoryAdapter();
    await memory.connect();
    const runtime = mockRuntime(ctx, mock);
    runtime.memory = memory;
    const threadId = 'ledger-thread';

    await ctx.check('a scripted tool call runs the real tool', async (evidence) => {
      const result = await runtime.run(agent, { input: 'Log the brass gears delivery.', threadId });
      evidence('output', result.output);
      evidence(
        'toolCalls',
        result.toolCalls.map((call) => call.name)
      );
      evidence('ledger', [...ledger]);
      evidence('backendCalls', mock.getCallCount());
      evidence('model', mock.getLastCall()?.model);
      if (result.output !== 'Logged 417 brass gears.') {
        throw new Error(`Unexpected output: ${result.output}`);
      }
      if (ledger.join() !== 'brass gears x417') {
        throw new Error('The tool did not run with the scripted arguments');
      }
      if (mock.getCallCount() !== 2) {
        throw new Error(`Expected 2 backend calls, saw ${mock.getCallCount()}`);
      }
      if (mock.getLastCall()?.model !== 'test-model') {
        throw new Error('The mock did not get the bare model name');
      }
      const offered = mock.getCalls()[0]?.tools?.map((spec) => spec.name) ?? [];
      if (!offered.includes('ledger_write')) {
        throw new Error('The tool was not offered to the backend');
      }
    });

    await ctx.check('requests are recorded as snapshots', (evidence) => {
      const [first, second] = mock.getCalls();
      evidence('firstMessages', first?.messages.length);
      evidence('secondMessages', second?.messages.length);
      evidence(
        'secondRoles',
        second?.messages.map((message) => message.role)
      );
      if (!first || !second) throw new Error('Calls were not recorded');
      if (first.messages.some((message) => message.role === 'tool')) {
        throw new Error('The first recorded request shows the tool result added after it was sent');
      }
      if (!second.messages.some((message) => message.role === 'tool')) {
        throw new Error('The second request does not carry the tool result');
      }
    });

    await ctx.check('memory is written and loaded on the next turn', async (evidence) => {
      mock.reset();
      mock.setResponse({ content: 'You logged brass gears.' });
      const result = await runtime.run(agent, { input: 'What did I log?', threadId });
      const stored = await memory.getEntries({ threadId });
      if (!stored.success) throw new Error(stored.error);
      const sent = mock.getLastCall()?.messages ?? [];
      evidence('addEntryCalls', memory.getCallsFor('addEntry').length);
      evidence(
        'storedRoles',
        stored.data.map((entry) => entry.message.role)
      );
      evidence('sentMessages', sent.length);
      evidence('output', result.output);
      if (memory.getCallsFor('addEntry').length === 0) {
        throw new Error('Nothing was written to memory');
      }
      if (!sent.some((message) => text(message).includes('Log the brass gears delivery.'))) {
        throw new Error('The first turn was not loaded from memory into the second request');
      }
      if (!stored.data.some((entry) => text(entry.message).includes('What did I log?'))) {
        throw new Error('The second turn was not stored');
      }
    });

    await ctx.check('streamed chunks reach onToken and the result', async (evidence) => {
      const streaming = new MockLLMBackend().setMultipleStreamChunks([
        [
          {
            toolCalls: [
              { id: 'call_stream', name: 'ledger_write', arguments: { entry: 'copper wire x12' } },
            ],
          },
        ],
        [{ content: 'Logged ' }, { content: '12 copper wire.' }],
      ]);
      const tokens: string[] = [];
      const result = await mockRuntime(ctx, streaming).run(agent, {
        input: 'Log the copper wire.',
        stream: true,
        onToken: (token) => tokens.push(token),
      });
      evidence('tokens', tokens);
      evidence('output', result.output);
      evidence('ledger', [...ledger]);
      if (tokens.join('') !== 'Logged 12 copper wire.') {
        throw new Error('Tokens were not streamed in order');
      }
      if (result.output !== 'Logged 12 copper wire.') {
        throw new Error(`Unexpected output: ${result.output}`);
      }
      if (!ledger.includes('copper wire x12')) {
        throw new Error('The streamed tool call did not run');
      }
    });

    await ctx.check('a scripted failure surfaces once without retries', async (evidence) => {
      const failing = new MockLLMBackend().setResponse({ error: new Error('provider down') });
      let message = '';
      try {
        await mockRuntime(ctx, failing, false).run(agent, { input: 'hi' });
      } catch (error) {
        message = error instanceof Error ? error.message : String(error);
      }
      evidence('error', message);
      evidence('calls', failing.getCallCount());
      if (!message.includes('provider down')) {
        throw new Error('The scripted error did not reach the caller');
      }
      if (failing.getCallCount() !== 1) throw new Error('retry: false still retried');
    });

    await ctx.check('fixtures and async helpers', async (evidence) => {
      const fixture = createMockRunResult('done', {
        toolCalls: [createToolCall('ledger_write', {})],
      });
      evidence('fixtureUsage', fixture.usage.totalTokens);
      let flips = 0;
      const value = await waitFor(() => (++flips >= 3 ? flips : 0), {
        timeout: 1_000,
        interval: 5,
      });
      let timedOut = false;
      try {
        await withTimeout(new Promise((resolve) => setTimeout(resolve, 500)), 20);
      } catch {
        timedOut = true;
      }
      evidence('waitFor', value);
      evidence('withTimeoutRejected', timedOut);
      if (fixture.output !== 'done' || fixture.toolCalls.length !== 1) {
        throw new Error('The run result fixture is off');
      }
      if (value !== 3 || !timedOut) throw new Error('The async helpers misbehaved');
    });
  },
};

export const testingStages: StageDefinition[] = [testUtils];
