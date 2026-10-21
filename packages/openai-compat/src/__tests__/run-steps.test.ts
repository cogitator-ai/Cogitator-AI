import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest';
import OpenAI from 'openai';
import { z } from 'zod';
import { Cogitator, tool } from '@cogitator-ai/core';
import type {
  Agent,
  ChatRequest,
  ChatResponse,
  ChatStreamChunk,
  LLMBackend,
  RunOptions,
  RunResult,
  ToolCall,
} from '@cogitator-ai/types';
import { OpenAIServer } from '../server/api-server';
import type { RunStep } from '../types/openai-types';

const lookup = tool({
  name: 'lookup',
  description: 'Look an order up',
  parameters: z.object({ order: z.string() }),
  execute: async ({ order }) => ({ order, status: 'shipped' }),
});

let toolTurn: ToolCall[] | null = null;
let failAfterTools = false;
let toolTurnText = '';

function answer(request: ChatRequest): ChatResponse {
  const results = request.messages.filter((m) => m.role === 'tool');
  if (toolTurn && results.length === 0) {
    return {
      id: 'r1',
      content: toolTurnText,
      toolCalls: toolTurn,
      finishReason: 'tool_calls',
      usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 },
    };
  }
  if (failAfterTools && results.length > 0) {
    throw new Error('backend exploded');
  }
  return {
    id: 'r2',
    content:
      results.length > 0
        ? `Result: ${results.map((m) => String(m.content)).join(' | ')}`
        : 'Hi there',
    finishReason: 'stop',
    usage: { inputTokens: 20, outputTokens: 4, totalTokens: 24 },
  };
}

const backend: LLMBackend = {
  provider: 'openai',
  chat: vi.fn(async (request: ChatRequest) => answer(request)),
  chatStream: vi.fn(async function* (request: ChatRequest): AsyncGenerator<ChatStreamChunk> {
    const response = answer(request);
    if (response.content) yield { id: response.id, delta: { content: response.content } };
    if (response.toolCalls) yield { id: response.id, delta: { toolCalls: response.toolCalls } };
    yield {
      id: response.id,
      delta: {},
      finishReason: response.finishReason,
      usage: response.usage,
    };
  }),
};

const weatherFunction = {
  type: 'function' as const,
  function: {
    name: 'get_weather',
    description: 'Weather for a city',
    parameters: { type: 'object', properties: { city: { type: 'string' } }, required: ['city'] },
  },
};

const POLL = { pollIntervalMs: 10 };

describe('run steps', () => {
  let cogitator: Cogitator;
  let server: OpenAIServer;
  let client: OpenAI;

  beforeAll(async () => {
    cogitator = new Cogitator({ llm: { backends: { mock: backend } } });
    server = new OpenAIServer(cogitator, {
      port: 0,
      host: '127.0.0.1',
      defaultModel: 'mock/m',
      tools: [lookup],
    });
    await server.start();
    client = new OpenAI({ baseURL: server.getBaseUrl(), apiKey: 'unused', maxRetries: 0 });
  });

  afterAll(async () => {
    await server.stop();
    await cogitator.close();
  });

  beforeEach(() => {
    toolTurn = null;
    failAfterTools = false;
    toolTurnText = '';
  });

  async function start(tools: OpenAI.Beta.AssistantTool[] = [], content = 'Hello') {
    const assistant = await client.beta.assistants.create({ model: 'cogitator', tools });
    const thread = await client.beta.threads.create({ messages: [{ role: 'user', content }] });
    return { assistant, thread };
  }

  async function stepsOf(threadId: string, runId: string): Promise<RunStep[]> {
    const page = await client.beta.threads.runs.steps.list(runId, {
      thread_id: threadId,
      order: 'asc',
    });
    return page.data as RunStep[];
  }

  it('records a message_creation step for a run without tools', async () => {
    const { assistant, thread } = await start();

    const run = await client.beta.threads.runs.createAndPoll(
      thread.id,
      { assistant_id: assistant.id },
      POLL
    );
    const steps = await stepsOf(thread.id, run.id);
    const messages = await client.beta.threads.messages.list(thread.id);

    expect(steps).toHaveLength(1);
    expect(steps[0]).toMatchObject({
      object: 'thread.run.step',
      type: 'message_creation',
      status: 'completed',
      run_id: run.id,
      thread_id: thread.id,
      assistant_id: assistant.id,
      step_details: {
        type: 'message_creation',
        message_creation: { message_id: messages.data[0].id },
      },
      last_error: null,
      failed_at: null,
      cancelled_at: null,
      expired_at: null,
      usage: { prompt_tokens: 20, completion_tokens: 4, total_tokens: 24 },
    });
    expect(steps[0].id).toMatch(/^step_/);
    expect(steps[0].completed_at).toBeGreaterThanOrEqual(steps[0].created_at);

    const retrieved = await client.beta.threads.runs.steps.retrieve(steps[0].id, {
      thread_id: thread.id,
      run_id: run.id,
    });
    expect(retrieved).toEqual(steps[0]);
  });

  it('records a tool_calls step per model turn with outputs, then the message step', async () => {
    toolTurn = [
      { id: 'call_1', name: 'lookup', arguments: { order: 'A-1' } },
      { id: 'call_2', name: 'lookup', arguments: { order: 'B-2' } },
    ];
    const { assistant, thread } = await start();

    const run = await client.beta.threads.runs.createAndPoll(
      thread.id,
      { assistant_id: assistant.id },
      POLL
    );
    const steps = await stepsOf(thread.id, run.id);

    expect(steps.map((step) => step.type)).toEqual(['tool_calls', 'message_creation']);
    expect(steps[0]).toMatchObject({
      status: 'completed',
      usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
      step_details: {
        type: 'tool_calls',
        tool_calls: [
          {
            id: 'call_1',
            type: 'function',
            function: {
              name: 'lookup',
              arguments: '{"order":"A-1"}',
              output: '{"order":"A-1","status":"shipped"}',
            },
          },
          {
            id: 'call_2',
            type: 'function',
            function: { name: 'lookup', output: '{"order":"B-2","status":"shipped"}' },
          },
        ],
      },
    });
    expect(steps[1]).toMatchObject({
      status: 'completed',
      usage: { prompt_tokens: 20, completion_tokens: 4, total_tokens: 24 },
    });
  });

  it('keeps a client function step in progress until the outputs are submitted', async () => {
    toolTurn = [{ id: 'w1', name: 'get_weather', arguments: { city: 'Paris' } }];
    const { assistant, thread } = await start([weatherFunction]);

    const paused = await client.beta.threads.runs.createAndPoll(
      thread.id,
      { assistant_id: assistant.id },
      POLL
    );
    const waiting = await stepsOf(thread.id, paused.id);

    expect(paused.status).toBe('requires_action');
    expect(waiting).toHaveLength(1);
    expect(waiting[0]).toMatchObject({
      type: 'tool_calls',
      status: 'in_progress',
      completed_at: null,
      step_details: {
        tool_calls: [{ id: 'w1', function: { name: 'get_weather', output: null } }],
      },
    });

    const done = await client.beta.threads.runs.submitToolOutputsAndPoll(
      paused.id,
      { thread_id: thread.id, tool_outputs: [{ tool_call_id: 'w1', output: 'sunny' }] },
      POLL
    );
    const steps = await stepsOf(thread.id, done.id);

    expect(done.status).toBe('completed');
    expect(steps.map((step) => [step.type, step.status])).toEqual([
      ['tool_calls', 'completed'],
      ['message_creation', 'completed'],
    ]);
    expect(steps[0].step_details).toMatchObject({
      tool_calls: [{ id: 'w1', function: { output: 'sunny' } }],
    });
  });

  it('cancels the waiting tool_calls step with the run', async () => {
    toolTurn = [{ id: 'w1', name: 'get_weather', arguments: { city: 'Rome' } }];
    const { assistant, thread } = await start([weatherFunction]);
    const paused = await client.beta.threads.runs.createAndPoll(
      thread.id,
      { assistant_id: assistant.id },
      POLL
    );

    await client.beta.threads.runs.cancel(paused.id, { thread_id: thread.id });
    const final = await client.beta.threads.runs.poll(paused.id, { thread_id: thread.id }, POLL);
    const [step] = await stepsOf(thread.id, paused.id);

    expect(final.status).toBe('cancelled');
    expect(step.status).toBe('cancelled');
    expect(step.cancelled_at).toEqual(expect.any(Number));
    expect(step.step_details).toMatchObject({ tool_calls: [{ function: { output: null } }] });
  });

  it('keeps a finished tool_calls step completed when the run fails afterwards', async () => {
    toolTurn = [{ id: 'w1', name: 'get_weather', arguments: { city: 'Oslo' } }];
    failAfterTools = true;
    const { assistant, thread } = await start([weatherFunction]);
    const paused = await client.beta.threads.runs.createAndPoll(
      thread.id,
      { assistant_id: assistant.id },
      POLL
    );

    const failed = await client.beta.threads.runs.submitToolOutputsAndPoll(
      paused.id,
      { thread_id: thread.id, tool_outputs: [{ tool_call_id: 'w1', output: 'snow' }] },
      POLL
    );
    const steps = await stepsOf(thread.id, failed.id);

    expect(failed.status).toBe('failed');
    expect(steps).toHaveLength(1);
    expect(steps[0]).toMatchObject({ type: 'tool_calls', status: 'completed', last_error: null });
  });

  it('paginates steps with limit, order, after and before', async () => {
    toolTurn = [{ id: 'call_1', name: 'lookup', arguments: { order: 'A-1' } }];
    const { assistant, thread } = await start();
    const run = await client.beta.threads.runs.createAndPoll(
      thread.id,
      { assistant_id: assistant.id },
      POLL
    );
    const [toolStep, messageStep] = await stepsOf(thread.id, run.id);
    const base = `${server.getBaseUrl()}/threads/${thread.id}/runs/${run.id}/steps`;

    const newest = (await (await fetch(`${base}?limit=1`)).json()) as {
      data: RunStep[];
      has_more: boolean;
      first_id: string;
      last_id: string;
    };
    expect(newest.data.map((step) => step.id)).toEqual([messageStep.id]);
    expect(newest.has_more).toBe(true);
    expect(newest.first_id).toBe(messageStep.id);

    const after = (await (await fetch(`${base}?limit=1&after=${messageStep.id}`)).json()) as {
      data: RunStep[];
      has_more: boolean;
    };
    expect(after.data.map((step) => step.id)).toEqual([toolStep.id]);
    expect(after.has_more).toBe(false);

    const before = (await (await fetch(`${base}?order=asc&before=${messageStep.id}`)).json()) as {
      data: RunStep[];
    };
    expect(before.data.map((step) => step.id)).toEqual([toolStep.id]);

    expect((await fetch(`${base}?limit=101`)).status).toBe(400);
    expect((await fetch(`${base}?order=sideways`)).status).toBe(400);
  });

  it('answers 404 for an unknown run or step', async () => {
    const { assistant, thread } = await start();
    const run = await client.beta.threads.runs.createAndPoll(
      thread.id,
      { assistant_id: assistant.id },
      POLL
    );
    const base = `${server.getBaseUrl()}/threads/${thread.id}/runs`;

    const unknownRun = await fetch(`${base}/run_missing/steps`);
    const unknownStep = await fetch(`${base}/${run.id}/steps/step_missing`);
    const stepOfMissingRun = await fetch(`${base}/run_missing/steps/step_missing`);

    expect(unknownRun.status).toBe(404);
    expect(unknownStep.status).toBe(404);
    expect(((await unknownStep.json()) as { error: { message: string } }).error.message).toContain(
      'run step'
    );
    expect(stepOfMissingRun.status).toBe(404);
  });

  it('streams step events in order around the message events', async () => {
    const { assistant, thread } = await start();

    const events: string[] = [];
    const stream = client.beta.threads.runs
      .stream(thread.id, { assistant_id: assistant.id })
      .on('event', (event) => events.push(event.event));
    const finalRun = await stream.finalRun();

    expect(finalRun.status).toBe('completed');
    expect(events.filter((event) => event !== 'thread.message.delta')).toEqual([
      'thread.run.created',
      'thread.run.queued',
      'thread.run.in_progress',
      'thread.run.step.created',
      'thread.run.step.in_progress',
      'thread.message.created',
      'thread.message.in_progress',
      'thread.message.completed',
      'thread.run.step.completed',
      'thread.run.completed',
    ]);
  });

  describe('a tool turn that also writes text', () => {
    function messageIdOf(step: RunStep): string | undefined {
      return step.step_details.type === 'message_creation'
        ? step.step_details.message_creation.message_id
        : undefined;
    }

    async function storedTexts(threadId: string, runId: string) {
      const page = await client.beta.threads.messages.list(threadId, {
        order: 'asc',
        run_id: runId,
      });
      return page.data.map((m) => ({
        id: m.id,
        status: m.status,
        text: m.content[0]?.type === 'text' ? m.content[0].text.value : undefined,
      }));
    }

    it('streams a server tool turn through the SDK with sequential steps', async () => {
      toolTurn = [{ id: 'call_1', name: 'lookup', arguments: { order: 'A-1' } }];
      toolTurnText = 'Let me check.';
      const { assistant, thread } = await start();

      const done: RunStep[] = [];
      const stream = client.beta.threads.runs
        .stream(thread.id, { assistant_id: assistant.id })
        .on('runStepDone', (step) => done.push(step as RunStep));
      const finalRun = await stream.finalRun();
      const streamed = await stream.finalMessages();
      const stored = await storedTexts(thread.id, finalRun.id);
      const steps = await stepsOf(thread.id, finalRun.id);

      expect(finalRun.status).toBe('completed');
      expect(stored).toEqual([
        { id: expect.any(String), status: 'completed', text: 'Let me check.' },
        {
          id: expect.any(String),
          status: 'completed',
          text: 'Result: {"order":"A-1","status":"shipped"}',
        },
      ]);
      expect(streamed.map((m) => m.id)).toEqual(stored.map((m) => m.id));
      expect(steps.map((step) => step.type)).toEqual([
        'message_creation',
        'tool_calls',
        'message_creation',
      ]);
      expect(steps.map(messageIdOf)).toEqual([stored[0].id, undefined, stored[1].id]);
      expect(done.map((step) => step.id)).toEqual(steps.map((step) => step.id));
      expect(steps[0].usage).toEqual({ prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 });
      expect(steps[2].usage).toEqual({ prompt_tokens: 20, completion_tokens: 4, total_tokens: 24 });
    });

    it('streams the text before a client function, then continues with submitToolOutputsStream', async () => {
      toolTurn = [{ id: 'w1', name: 'get_weather', arguments: { city: 'Paris' } }];
      toolTurnText = 'Checking the weather.';
      const { assistant, thread } = await start([weatherFunction]);

      const firstDone: RunStep[] = [];
      const first = client.beta.threads.runs
        .stream(thread.id, { assistant_id: assistant.id })
        .on('runStepDone', (step) => firstDone.push(step as RunStep));
      const paused = await first.finalRun();
      const waiting = await stepsOf(thread.id, paused.id);

      expect(paused.status).toBe('requires_action');
      expect(firstDone.map((step) => step.type)).toEqual(['message_creation']);
      expect(waiting.map((step) => [step.type, step.status])).toEqual([
        ['message_creation', 'completed'],
        ['tool_calls', 'in_progress'],
      ]);
      expect(await storedTexts(thread.id, paused.id)).toEqual([
        { id: messageIdOf(waiting[0]), status: 'completed', text: 'Checking the weather.' },
      ]);

      const resumedDone: RunStep[] = [];
      const resumed = client.beta.threads.runs
        .submitToolOutputsStream(paused.id, {
          thread_id: thread.id,
          tool_outputs: [{ tool_call_id: 'w1', output: 'sunny' }],
        })
        .on('runStepDone', (step) => resumedDone.push(step as RunStep));
      const finalRun = await resumed.finalRun();
      const stored = await storedTexts(thread.id, finalRun.id);
      const steps = await stepsOf(thread.id, finalRun.id);

      expect(finalRun.status).toBe('completed');
      expect(stored.map((m) => m.text)).toEqual(['Checking the weather.', 'Result: "sunny"']);
      expect(steps.map((step) => [step.type, step.status])).toEqual([
        ['message_creation', 'completed'],
        ['tool_calls', 'completed'],
        ['message_creation', 'completed'],
      ]);
      expect(steps.map(messageIdOf)).toEqual([stored[0].id, undefined, stored[1].id]);
      expect(resumedDone.map((step) => step.id)).toEqual([steps[1].id, steps[2].id]);
    });

    async function snapshot(threadId: string, runId: string) {
      const stored = await storedTexts(threadId, runId);
      const steps = await stepsOf(threadId, runId);
      return {
        messages: stored.map(({ status, text }) => ({ status, text })),
        steps: steps.map((step) => ({
          type: step.type,
          status: step.status,
          usage: step.usage,
          details:
            step.step_details.type === 'message_creation'
              ? stored.findIndex((m) => m.id === messageIdOf(step))
              : step.step_details.tool_calls.map((call) =>
                  call.type === 'function' ? call.function : call.type
                ),
        })),
      };
    }

    async function runScripted(stream: boolean, tools: OpenAI.Beta.AssistantTool[]) {
      const { assistant, thread } = await start(tools);
      let run = stream
        ? await client.beta.threads.runs
            .stream(thread.id, { assistant_id: assistant.id })
            .finalRun()
        : await client.beta.threads.runs.createAndPoll(
            thread.id,
            { assistant_id: assistant.id },
            POLL
          );
      if (run.status === 'requires_action') {
        const params = {
          thread_id: thread.id,
          tool_outputs: [{ tool_call_id: 'w1', output: 'sunny' }],
        };
        run = stream
          ? await client.beta.threads.runs.submitToolOutputsStream(run.id, params).finalRun()
          : await client.beta.threads.runs.submitToolOutputsAndPoll(run.id, params, POLL);
      }
      expect(run.status).toBe('completed');
      return snapshot(thread.id, run.id);
    }

    it.each([
      ['a server tool', [{ id: 'call_1', name: 'lookup', arguments: { order: 'A-1' } }], []],
      [
        'a client function',
        [{ id: 'w1', name: 'get_weather', arguments: { city: 'Paris' } }],
        [weatherFunction],
      ],
      ['no tool', null, []],
    ] as const)(
      'stores the same messages and steps streaming or not, for a turn with text and %s',
      async (_name, calls, tools) => {
        toolTurn = calls ? [...calls] : null;
        toolTurnText = 'Let me check.';

        const streamed = await runScripted(true, [...tools]);
        const polled = await runScripted(false, [...tools]);

        expect(polled).toEqual(streamed);
        if (calls) {
          expect(polled.messages.map((m) => m.text)).toEqual([
            'Let me check.',
            expect.stringMatching(/^Result: /),
          ]);
          expect(polled.steps.map((step) => [step.type, step.details])).toEqual([
            ['message_creation', 0],
            ['tool_calls', [expect.objectContaining({ name: calls[0].name })]],
            ['message_creation', 1],
          ]);
        }
      }
    );

    it('keeps the turn text before a client function as its own message while the run waits', async () => {
      toolTurn = [{ id: 'w1', name: 'get_weather', arguments: { city: 'Paris' } }];
      toolTurnText = 'Checking the weather.';
      const { assistant, thread } = await start([weatherFunction]);

      const paused = await client.beta.threads.runs.createAndPoll(
        thread.id,
        { assistant_id: assistant.id },
        POLL
      );
      const waiting = await snapshot(thread.id, paused.id);

      expect(paused.status).toBe('requires_action');
      expect(waiting.messages).toEqual([{ status: 'completed', text: 'Checking the weather.' }]);
      expect(waiting.steps.map((step) => [step.type, step.status])).toEqual([
        ['message_creation', 'completed'],
        ['tool_calls', 'in_progress'],
      ]);

      const done = await client.beta.threads.runs.submitToolOutputsAndPoll(
        paused.id,
        { thread_id: thread.id, tool_outputs: [{ tool_call_id: 'w1', output: 'sunny' }] },
        POLL
      );
      const all = await client.beta.threads.messages.list(thread.id, { order: 'asc' });

      expect(done.status).toBe('completed');
      expect(all.data.map((m) => m.role)).toEqual(['user', 'assistant', 'assistant']);
      expect((await snapshot(thread.id, done.id)).messages.map((m) => m.text)).toEqual([
        'Checking the weather.',
        'Result: "sunny"',
      ]);
    });

    it('keeps the earlier turn when the run is cancelled in requires_action', async () => {
      toolTurn = [{ id: 'w1', name: 'get_weather', arguments: { city: 'Rome' } }];
      toolTurnText = 'Checking the weather.';
      const { assistant, thread } = await start([weatherFunction]);
      const paused = await client.beta.threads.runs
        .stream(thread.id, { assistant_id: assistant.id })
        .finalRun();

      await client.beta.threads.runs.cancel(paused.id, { thread_id: thread.id });
      const final = await client.beta.threads.runs.poll(paused.id, { thread_id: thread.id }, POLL);
      const stored = await storedTexts(thread.id, paused.id);
      const steps = await stepsOf(thread.id, paused.id);

      expect(final.status).toBe('cancelled');
      expect(stored).toEqual([
        { id: messageIdOf(steps[0]), status: 'completed', text: 'Checking the weather.' },
      ]);
      expect(steps.map((step) => [step.type, step.status])).toEqual([
        ['message_creation', 'completed'],
        ['tool_calls', 'cancelled'],
      ]);
    });
  });

  it('streams a tool_calls step with deltas the SDK assembles, across submit_tool_outputs', async () => {
    toolTurn = [{ id: 'w1', name: 'get_weather', arguments: { city: 'Paris' } }];
    const { assistant, thread } = await start([weatherFunction]);

    const events: string[] = [];
    const created: string[] = [];
    const first = client.beta.threads.runs
      .stream(thread.id, { assistant_id: assistant.id })
      .on('event', (event) => events.push(event.event))
      .on('toolCallCreated', (call) => created.push(call.id));
    const paused = await first.finalRun();

    expect(events.slice(3)).toEqual([
      'thread.run.step.created',
      'thread.run.step.in_progress',
      'thread.run.step.delta',
      'thread.run.requires_action',
    ]);
    expect(created).toEqual(['w1']);

    const resumedEvents: string[] = [];
    const done: RunStep[] = [];
    const resumed = client.beta.threads.runs
      .submitToolOutputsStream(paused.id, {
        thread_id: thread.id,
        tool_outputs: [{ tool_call_id: 'w1', output: 'sunny' }],
      })
      .on('event', (event) => resumedEvents.push(event.event))
      .on('runStepDone', (step) => done.push(step as RunStep));
    const finalRun = await resumed.finalRun();

    expect(finalRun.status).toBe('completed');
    expect(resumedEvents.filter((event) => event !== 'thread.message.delta')).toEqual([
      'thread.run.in_progress',
      'thread.run.step.completed',
      'thread.run.step.created',
      'thread.run.step.in_progress',
      'thread.message.created',
      'thread.message.in_progress',
      'thread.message.completed',
      'thread.run.step.completed',
      'thread.run.completed',
    ]);
    expect(done.map((step) => step.type)).toEqual(['tool_calls', 'message_creation']);
    expect(done[0].step_details).toMatchObject({
      tool_calls: [{ id: 'w1', function: { arguments: '{"city":"Paris"}', output: 'sunny' } }],
    });
  });
});

describe('run steps of a run that stops mid-message', () => {
  type RunHandler = (agent: Agent, options: RunOptions) => Promise<Partial<RunResult>>;
  let handler: RunHandler = async () => ({ output: 'ok' });

  const fakeCogitator = {
    run: async (agent: Agent, options: RunOptions) => {
      const partial = await handler(agent, options);
      return {
        output: '',
        runId: 'run',
        agentId: agent.id,
        threadId: options.threadId ?? 'thread',
        usage: { inputTokens: 3, outputTokens: 5, totalTokens: 8, cost: 0, duration: 1 },
        toolCalls: [],
        messages: [],
        trace: { traceId: 't', spans: [] },
        ...partial,
      } as RunResult;
    },
  } as unknown as Cogitator;

  let server: OpenAIServer;
  let client: OpenAI;

  beforeAll(async () => {
    server = new OpenAIServer(fakeCogitator, { port: 0, host: '127.0.0.1' });
    await server.start();
    client = new OpenAI({ baseURL: server.getBaseUrl(), apiKey: 'unused', maxRetries: 0 });
  });

  afterAll(async () => {
    await server.stop();
  });

  it('uses the run usage for the only step when no model call reported its own', async () => {
    handler = async () => ({ output: 'done' });
    const assistant = await client.beta.assistants.create({ model: 'm' });
    const thread = await client.beta.threads.create({ messages: [{ role: 'user', content: 'x' }] });

    const run = await client.beta.threads.runs.createAndPoll(
      thread.id,
      { assistant_id: assistant.id },
      POLL
    );
    const steps = await client.beta.threads.runs.steps.list(run.id, { thread_id: thread.id });

    expect(steps.data[0].usage).toEqual({
      prompt_tokens: 3,
      completion_tokens: 5,
      total_tokens: 8,
    });
  });

  it('keeps the streamed part of a cancelled message and cancels its step', async () => {
    handler = (_agent, options) =>
      new Promise((_resolve, reject) => {
        options.onToken?.('Half an ans');
        options.signal?.addEventListener('abort', () => reject(new Error('aborted')));
      });
    const assistant = await client.beta.assistants.create({ model: 'm' });
    const thread = await client.beta.threads.create({ messages: [{ role: 'user', content: 'x' }] });
    const run = await client.beta.threads.runs.create(thread.id, { assistant_id: assistant.id });
    await vi.waitFor(async () => {
      const steps = await client.beta.threads.runs.steps.list(run.id, { thread_id: thread.id });
      expect(steps.data).toHaveLength(1);
    });

    await client.beta.threads.runs.cancel(run.id, { thread_id: thread.id });
    const final = await client.beta.threads.runs.poll(run.id, { thread_id: thread.id }, POLL);
    const [step] = (await client.beta.threads.runs.steps.list(run.id, { thread_id: thread.id }))
      .data;
    const [message] = (await client.beta.threads.messages.list(thread.id)).data;

    expect(final.status).toBe('cancelled');
    expect(step).toMatchObject({ type: 'message_creation', status: 'cancelled' });
    expect(step.step_details).toEqual({
      type: 'message_creation',
      message_creation: { message_id: message.id },
    });
    expect(message).toMatchObject({
      role: 'assistant',
      status: 'incomplete',
      incomplete_details: { reason: 'run_cancelled' },
      content: [{ type: 'text', text: { value: 'Half an ans' } }],
    });
  });

  it('fails an open message step with the error of the run', async () => {
    handler = async (_agent, options) => {
      options.onToken?.('Par');
      throw new Error('boom');
    };
    const assistant = await client.beta.assistants.create({ model: 'm' });
    const thread = await client.beta.threads.create({ messages: [{ role: 'user', content: 'x' }] });

    const run = await client.beta.threads.runs.createAndPoll(
      thread.id,
      { assistant_id: assistant.id },
      POLL
    );
    const [step] = (await client.beta.threads.runs.steps.list(run.id, { thread_id: thread.id }))
      .data;

    expect(run.status).toBe('failed');
    expect(step).toMatchObject({
      status: 'failed',
      last_error: { code: 'server_error', message: 'Internal server error' },
    });
    expect(step.failed_at).toEqual(expect.any(Number));
  });
});
