import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest';
import OpenAI from 'openai';
import { Agent, type Cogitator } from '@cogitator-ai/core';
import type {
  Agent as AgentType,
  ResumeOptions,
  RunCheckpoint,
  RunOptions,
  RunResult,
  ToolContext,
} from '@cogitator-ai/types';
import { OpenAIServer } from '../server/api-server';

type Script = (agent: AgentType, options: RunOptions) => Promise<Partial<RunResult>>;

const runs: Array<{ agent: AgentType; options: RunOptions }> = [];
const resumes: Array<{ agent: AgentType; checkpoint: RunCheckpoint; options: ResumeOptions }> = [];
let script: Script = async () => ({ output: 'ok' });

function complete(agent: AgentType, partial: Partial<RunResult>): RunResult {
  return {
    output: '',
    runId: 'run',
    agentId: agent.id,
    threadId: 'thread',
    usage: {
      inputTokens: 11,
      outputTokens: 7,
      totalTokens: 18,
      cost: 0,
      duration: 1,
      cachedInputTokens: 4,
      reasoningTokens: 2,
    },
    toolCalls: [],
    messages: [],
    trace: { traceId: 't', spans: [] },
    ...partial,
  } as RunResult;
}

const checkpoint = { version: 1, runId: 'run', threadId: 'thread' } as RunCheckpoint;

function pausedOn(toolName: string, args: Record<string, unknown>): Partial<RunResult> {
  return {
    output: 'Let me check.',
    status: 'paused',
    checkpoint,
    pendingApprovals: [
      { toolCallId: 'model_call_1', toolName, arguments: args, description: toolName },
    ],
  } as Partial<RunResult>;
}

/** Streams the output word by word through onToken, like a real backend. */
function say(output: string, extra: Partial<RunResult> = {}): Script {
  return async (_agent, options) => {
    for (const token of output.split(/(?= )/)) options.onToken?.(token);
    return { output, ...extra };
  };
}

const cogitator = {
  run: async (agent: AgentType, options: RunOptions) => {
    runs.push({ agent, options });
    return complete(agent, await script(agent, options));
  },
  resume: async (agent: AgentType, target: RunCheckpoint, options: ResumeOptions) => {
    resumes.push({ agent, checkpoint: target, options });
    const outputs: string[] = [];
    for (const [toolCallId, decision] of Object.entries(options.decisions ?? {})) {
      const tool = agent.tools.find((candidate) => candidate.requiresApproval);
      if (!tool || !decision.approved) continue;
      const context: ToolContext = {
        agentId: agent.id,
        runId: 'run',
        signal: new AbortController().signal,
        toolCallId,
      };
      outputs.push(String(await tool.execute({}, context)));
    }
    const output = `Sunny, the function said: ${outputs.join(', ')}`;
    for (const token of output.split(/(?= )/)) options.onToken?.(token);
    return complete(agent, { output });
  },
} as unknown as Cogitator;

const support = new Agent({
  name: 'support',
  model: 'mock/model',
  instructions: 'You are the support agent.',
});

describe('OpenAI endpoints over registered agents, through the official SDK', () => {
  let server: OpenAIServer;
  let client: OpenAI;

  beforeAll(async () => {
    server = new OpenAIServer(cogitator, {
      port: 0,
      host: '127.0.0.1',
      agents: { support },
      sseHeartbeatMs: 0,
    });
    await server.start();
    client = new OpenAI({ baseURL: server.getBaseUrl(), apiKey: 'unused', maxRetries: 0 });
  });

  afterAll(async () => {
    await server.stop();
  });

  beforeEach(() => {
    runs.length = 0;
    resumes.length = 0;
    script = say('Hello there');
  });

  describe('GET /v1/models', () => {
    it('lists the agents as models', async () => {
      const ids: string[] = [];
      for await (const model of client.models.list()) ids.push(model.id);
      expect(ids).toEqual(['support', 'cogitator']);

      const model = await client.models.retrieve('support');
      expect(model).toMatchObject({ id: 'support', object: 'model', owned_by: 'cogitator' });
      await expect(client.models.retrieve('nope')).rejects.toBeInstanceOf(OpenAI.NotFoundError);
    });
  });

  describe('POST /v1/chat/completions', () => {
    it('answers with the agent, its instructions first and the client system prompt after', async () => {
      const completion = await client.chat.completions.create({
        model: 'support',
        messages: [
          { role: 'system', content: 'Answer in English.' },
          { role: 'user', content: 'Hi' },
        ],
        temperature: 0.2,
        max_completion_tokens: 50,
      });

      expect(completion.object).toBe('chat.completion');
      expect(completion.model).toBe('support');
      expect(completion.choices[0].message).toMatchObject({
        role: 'assistant',
        content: 'Hello there',
      });
      expect(completion.choices[0].finish_reason).toBe('stop');
      expect(completion.usage).toMatchObject({
        prompt_tokens: 11,
        completion_tokens: 7,
        total_tokens: 18,
        prompt_tokens_details: { cached_tokens: 4 },
        completion_tokens_details: { reasoning_tokens: 2 },
      });

      const { agent, options } = runs[0];
      expect(agent.instructions).toBe('You are the support agent.\n\nAnswer in English.');
      expect(agent.config.temperature).toBe(0.2);
      expect(agent.config.maxTokens).toBe(50);
      expect(options.input).toBe('Hi');
      expect(options.useMemory).toBe(false);
      expect(options.signal).toBeInstanceOf(AbortSignal);
    });

    it('replays the earlier turns of the conversation', async () => {
      await client.chat.completions.create({
        model: 'support',
        messages: [
          { role: 'user', content: 'My name is Ada.' },
          { role: 'assistant', content: 'Hi Ada.' },
          { role: 'user', content: 'Who am I?' },
        ],
      });

      const { options } = runs[0];
      expect(options.input).toContain('User: My name is Ada.');
      expect(options.input).toContain('Assistant: Hi Ada.');
      expect(options.input).toMatch(/User: Who am I\?$/);
      expect(options.loadHistory).toBe(false);
    });

    it('streams the answer token by token, then the finish reason and the usage', async () => {
      const stream = await client.chat.completions.create({
        model: 'support',
        messages: [{ role: 'user', content: 'Hi' }],
        stream: true,
        stream_options: { include_usage: true },
      });

      let text = '';
      const finishReasons: (string | null)[] = [];
      let usage: OpenAI.CompletionUsage | null | undefined;
      for await (const chunk of stream) {
        expect(chunk.object).toBe('chat.completion.chunk');
        for (const choice of chunk.choices) {
          text += choice.delta.content ?? '';
          finishReasons.push(choice.finish_reason);
        }
        if (chunk.usage) usage = chunk.usage;
      }

      expect(text).toBe('Hello there');
      expect(finishReasons.filter(Boolean)).toEqual(['stop']);
      expect(usage?.total_tokens).toBe(18);
      expect(runs[0].options.stream).toBe(true);
    });

    it('returns client function calls, then resumes the same run with their outputs', async () => {
      script = async () => pausedOn('get_weather', { city: 'Paris' });
      const tools: OpenAI.ChatCompletionTool[] = [
        {
          type: 'function',
          function: {
            name: 'get_weather',
            description: 'Weather of a city',
            parameters: { type: 'object', properties: { city: { type: 'string' } } },
          },
        },
      ];
      const messages: OpenAI.ChatCompletionMessageParam[] = [
        { role: 'user', content: 'Weather in Paris?' },
      ];

      const first = await client.chat.completions.create({ model: 'support', messages, tools });
      const choice = first.choices[0];
      expect(choice.finish_reason).toBe('tool_calls');
      const call = choice.message.tool_calls?.[0];
      expect(call?.type).toBe('function');
      if (call?.type !== 'function') return;
      expect(call.function).toEqual({ name: 'get_weather', arguments: '{"city":"Paris"}' });
      expect(call.id).toMatch(/^call_/);
      expect(call.id).not.toBe('model_call_1');

      const second = await client.chat.completions.create({
        model: 'support',
        tools,
        messages: [
          ...messages,
          choice.message,
          { role: 'tool', tool_call_id: call.id, content: '22 degrees' },
        ],
      });

      expect(second.choices[0].message.content).toBe('Sunny, the function said: 22 degrees');
      expect(resumes).toHaveLength(1);
      expect(resumes[0].options.decisions).toEqual({ model_call_1: { approved: true } });
      expect(runs).toHaveLength(1);
    });

    it('streams client function calls with their index', async () => {
      script = async () => pausedOn('get_weather', { city: 'Rome' });
      const stream = await client.chat.completions.create({
        model: 'support',
        messages: [{ role: 'user', content: 'Weather in Rome?' }],
        tools: [{ type: 'function', function: { name: 'get_weather' } }],
        stream: true,
      });
      const calls: OpenAI.ChatCompletionChunk.Choice.Delta.ToolCall[] = [];
      let finish: string | null = null;
      for await (const chunk of stream) {
        calls.push(...(chunk.choices[0]?.delta.tool_calls ?? []));
        finish = chunk.choices[0]?.finish_reason ?? finish;
      }
      expect(calls).toEqual([
        expect.objectContaining({
          index: 0,
          type: 'function',
          function: { name: 'get_weather', arguments: '{"city":"Rome"}' },
        }),
      ]);
      expect(finish).toBe('tool_calls');
    });

    it('replays function results this server no longer waits on', async () => {
      await client.chat.completions.create({
        model: 'support',
        messages: [
          { role: 'user', content: 'Weather?' },
          {
            role: 'assistant',
            content: null,
            tool_calls: [
              {
                id: 'call_old',
                type: 'function',
                function: { name: 'get_weather', arguments: '{}' },
              },
            ],
          },
          { role: 'tool', tool_call_id: 'call_old', content: 'rainy' },
        ],
        tools: [{ type: 'function', function: { name: 'get_weather' } }],
      });

      expect(resumes).toHaveLength(0);
      expect(runs[0].options.input).toContain('Function result for call call_old: rainy');
    });

    it('reports a truncated answer as length and a filtered one as content_filter', async () => {
      script = async () => ({ output: 'cut', truncated: true });
      const truncated = await client.chat.completions.create({
        model: 'support',
        messages: [{ role: 'user', content: 'Long story' }],
      });
      expect(truncated.choices[0].finish_reason).toBe('length');

      script = async () => ({ output: '', blocked: 'content_filter' });
      const filtered = await client.chat.completions.create({
        model: 'support',
        messages: [{ role: 'user', content: 'Something' }],
      });
      expect(filtered.choices[0].finish_reason).toBe('content_filter');

      script = async () => ({ output: 'I cannot help with that.', blocked: 'refusal' });
      const refused = await client.chat.completions.create({
        model: 'support',
        messages: [{ role: 'user', content: 'Something' }],
      });
      expect(refused.choices[0].message).toMatchObject({
        content: null,
        refusal: 'I cannot help with that.',
      });
    });

    it('passes images of the last user message to the run', async () => {
      await client.chat.completions.create({
        model: 'support',
        messages: [
          {
            role: 'user',
            content: [
              { type: 'text', text: 'What is this?' },
              { type: 'image_url', image_url: { url: 'data:image/png;base64,iVBORw0K' } },
              { type: 'image_url', image_url: { url: 'https://example.com/cat.jpg' } },
            ],
          },
        ],
      });
      expect(runs[0].options.images).toEqual([
        { data: 'iVBORw0K', mimeType: 'image/png' },
        'https://example.com/cat.jpg',
      ]);
    });

    it('answers an unknown model with 404 model_not_found', async () => {
      const error = await client.chat.completions
        .create({ model: 'gpt-4o', messages: [{ role: 'user', content: 'Hi' }] })
        .catch((e: unknown) => e);
      expect(error).toBeInstanceOf(OpenAI.NotFoundError);
      expect((error as InstanceType<typeof OpenAI.NotFoundError>).code).toBe('model_not_found');
      expect(runs).toHaveLength(0);
    });

    it('answers invalid parameters with 400 and the parameter', async () => {
      const error = await client.chat.completions
        .create({ model: 'support', messages: [{ role: 'user', content: 'Hi' }], temperature: 5 })
        .catch((e: unknown) => e);
      expect(error).toBeInstanceOf(OpenAI.BadRequestError);
      expect((error as InstanceType<typeof OpenAI.BadRequestError>).param).toBe('temperature');

      const several = await client.chat.completions
        .create({ model: 'support', messages: [{ role: 'user', content: 'Hi' }], n: 2 })
        .catch((e: unknown) => e);
      expect(several).toBeInstanceOf(OpenAI.BadRequestError);
    });

    it('answers a failed run with 500 and no internal detail', async () => {
      const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
      script = async () => {
        throw new Error('connect ECONNREFUSED 10.0.0.5:5432');
      };
      const error = await client.chat.completions
        .create({ model: 'support', messages: [{ role: 'user', content: 'Hi' }] })
        .catch((e: unknown) => e);
      expect(error).toBeInstanceOf(OpenAI.InternalServerError);
      expect(String((error as Error).message)).not.toContain('10.0.0.5');
      consoleError.mockRestore();
    });

    it('aborts the run when the client of a non-streamed request goes away', async () => {
      let runSignal: AbortSignal | undefined;
      script = (_agent, options) =>
        new Promise((resolve) => {
          runSignal = options.signal;
          options.signal?.addEventListener('abort', () => resolve({ output: '' }), { once: true });
        });
      const controller = new AbortController();
      const pending = client.chat.completions
        .create(
          { model: 'support', messages: [{ role: 'user', content: 'Hi' }] },
          { signal: controller.signal }
        )
        .catch(() => undefined);
      await vi.waitFor(() => expect(runSignal).toBeDefined());
      expect(runSignal?.aborted).toBe(false);

      controller.abort();
      await pending;

      await vi.waitFor(() => expect(runSignal?.aborted).toBe(true));
    });

    it('refuses a tool_choice that names no tool before any output', async () => {
      const response = await fetch(`${server.getBaseUrl()}/chat/completions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: 'support',
          stream: true,
          messages: [{ role: 'user', content: 'Hi' }],
          tool_choice: { type: 'function', function: { name: 'missing' } },
        }),
      });
      expect(response.status).toBe(400);
      expect(((await response.json()) as { error: { param: string } }).error.param).toBe(
        'tool_choice'
      );
      expect(runs).toHaveLength(0);
    });

    it('aborts the run when the client goes away mid-stream', async () => {
      let runSignal: AbortSignal | undefined;
      script = (_agent, options) =>
        new Promise((resolve) => {
          runSignal = options.signal;
          options.onToken?.('Thinking');
          options.signal?.addEventListener('abort', () => resolve({ output: '' }), { once: true });
        });
      const controller = new AbortController();
      const stream = await client.chat.completions.create(
        { model: 'support', messages: [{ role: 'user', content: 'Hi' }], stream: true },
        { signal: controller.signal }
      );
      const iterator = stream[Symbol.asyncIterator]();
      await iterator.next();
      controller.abort();
      await iterator.next().catch(() => undefined);

      await vi.waitFor(() => expect(runSignal?.aborted).toBe(true));
    });
  });

  describe('/v1/responses', () => {
    it('answers with an output message, usage, and keeps the response', async () => {
      const response = await client.responses.create({
        model: 'support',
        instructions: 'Be brief.',
        input: 'Hi',
        max_output_tokens: 64,
      });

      expect(response).toMatchObject({
        object: 'response',
        status: 'completed',
        model: 'support',
        instructions: 'Be brief.',
        usage: {
          input_tokens: 11,
          output_tokens: 7,
          total_tokens: 18,
          input_tokens_details: { cached_tokens: 4 },
          output_tokens_details: { reasoning_tokens: 2 },
        },
      });
      expect(response.output_text).toBe('Hello there');
      expect(response.output[0]).toMatchObject({
        type: 'message',
        role: 'assistant',
        status: 'completed',
        content: [{ type: 'output_text', text: 'Hello there', annotations: [] }],
      });
      expect(runs[0].agent.instructions).toBe('You are the support agent.\n\nBe brief.');

      const retrieved = await client.responses.retrieve(response.id);
      expect(retrieved.output_text).toBe('Hello there');

      const items = await client.responses.inputItems.list(response.id);
      expect(items.data).toHaveLength(1);
      expect(items.data[0]).toMatchObject({ type: 'message', role: 'user' });
    });

    it('carries a conversation on with previous_response_id, without the earlier instructions', async () => {
      script = say('Hi Ada.');
      const first = await client.responses.create({
        model: 'support',
        instructions: 'Only for the first turn.',
        input: 'My name is Ada.',
      });
      script = say('You are Ada.');
      const second = await client.responses.create({
        model: 'support',
        input: [{ role: 'user', content: 'Who am I?' }],
        previous_response_id: first.id,
      });

      expect(second.previous_response_id).toBe(first.id);
      const { agent, options } = runs[1];
      expect(options.input).toContain('User: My name is Ada.');
      expect(options.input).toContain('Assistant: Hi Ada.');
      expect(options.input).toMatch(/User: Who am I\?$/);
      expect(agent.instructions).toBe('You are the support agent.');
    });

    it('refuses an unknown previous_response_id', async () => {
      const error = await client.responses
        .create({ model: 'support', input: 'Hi', previous_response_id: 'resp_missing' })
        .catch((e: unknown) => e);
      expect(error).toBeInstanceOf(OpenAI.BadRequestError);
      expect((error as InstanceType<typeof OpenAI.BadRequestError>).param).toBe(
        'previous_response_id'
      );
    });

    it('streams the events the SDK assembles into the response', async () => {
      const stream = client.responses.stream({ model: 'support', input: 'Hi' });
      const types: string[] = [];
      const sequence: number[] = [];
      for await (const event of stream) {
        types.push(event.type);
        sequence.push(event.sequence_number);
      }
      const final = await stream.finalResponse();

      expect(final.output_text).toBe('Hello there');
      expect(final.status).toBe('completed');
      expect(types[0]).toBe('response.created');
      expect(types).toContain('response.output_text.delta');
      expect(types).toContain('response.output_text.done');
      expect(types.at(-1)).toBe('response.completed');
      expect(sequence).toEqual(sequence.map((_, index) => index));

      const stored = await client.responses.retrieve(final.id);
      expect(stored.output_text).toBe('Hello there');
    });

    it('returns function calls, then resumes the run with function_call_output', async () => {
      script = async () => pausedOn('lookup_order', { id: 'A-1' });
      const tools: OpenAI.Responses.FunctionTool[] = [
        {
          type: 'function',
          name: 'lookup_order',
          parameters: { type: 'object', properties: { id: { type: 'string' } } },
          strict: false,
        },
      ];
      const first = await client.responses.create({
        model: 'support',
        input: 'Where is A-1?',
        tools,
      });
      const call = first.output.find((item) => item.type === 'function_call');
      expect(call).toMatchObject({ name: 'lookup_order', arguments: '{"id":"A-1"}' });
      if (call?.type !== 'function_call') return;

      const second = await client.responses.create({
        model: 'support',
        previous_response_id: first.id,
        tools,
        input: [{ type: 'function_call_output', call_id: call.call_id, output: 'shipped' }],
      });

      expect(second.output_text).toBe('Sunny, the function said: shipped');
      expect(resumes).toHaveLength(1);
    });

    it('streams function calls the SDK accepts', async () => {
      script = async () => pausedOn('lookup_order', { id: 'B-2' });
      const stream = client.responses.stream({
        model: 'support',
        input: 'Where is B-2?',
        tools: [{ type: 'function', name: 'lookup_order', parameters: null, strict: false }],
      });
      const final = await stream.finalResponse();
      expect(final.output.map((item) => item.type)).toEqual(['message', 'function_call']);
      expect(final.output[1]).toMatchObject({ arguments: '{"id":"B-2"}', status: 'completed' });
    });

    it('ends a truncated answer incomplete with max_output_tokens', async () => {
      script = async () => ({ output: 'cut', truncated: true });
      const response = await client.responses.create({ model: 'support', input: 'Long story' });
      expect(response.status).toBe('incomplete');
      expect(response.incomplete_details).toEqual({ reason: 'max_output_tokens' });
    });

    it('streams response.failed when the run fails', async () => {
      const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
      script = async () => {
        throw new Error('database down at 10.0.0.5');
      };
      const response = await fetch(`${server.getBaseUrl()}/responses`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ model: 'support', input: 'Hi', stream: true }),
      });
      const text = await response.text();
      expect(text).toContain('event: response.failed');
      expect(text).toContain('"status":"failed"');
      expect(text).not.toContain('10.0.0.5');
      consoleError.mockRestore();
    });

    it('refuses tools other than functions', async () => {
      const response = await fetch(`${server.getBaseUrl()}/responses`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ model: 'support', input: 'Hi', tools: [{ type: 'web_search' }] }),
      });
      expect(response.status).toBe(400);
      const body = (await response.json()) as { error: { type: string; param: string } };
      expect(body.error.type).toBe('invalid_request_error');
      expect(body.error.param).toBe('tools.0.type');
    });

    it('deletes a response', async () => {
      const response = await client.responses.create({ model: 'support', input: 'Hi' });
      await client.responses.delete(response.id);
      await expect(client.responses.retrieve(response.id)).rejects.toBeInstanceOf(
        OpenAI.NotFoundError
      );
    });
  });
});

describe('OpenAI endpoints with API keys', () => {
  let server: OpenAIServer;

  beforeAll(async () => {
    server = new OpenAIServer(cogitator, {
      port: 0,
      host: '127.0.0.1',
      agents: { support },
      apiKeys: ['sk-test'],
    });
    await server.start();
  });

  afterAll(async () => {
    await server.stop();
  });

  it('refuses requests without a valid key and serves those with one', async () => {
    const anonymous = new OpenAI({ baseURL: server.getBaseUrl(), apiKey: 'wrong', maxRetries: 0 });
    await expect(
      anonymous.chat.completions.create({
        model: 'support',
        messages: [{ role: 'user', content: 'Hi' }],
      })
    ).rejects.toBeInstanceOf(OpenAI.AuthenticationError);
    await expect(
      anonymous.responses.create({ model: 'support', input: 'Hi' })
    ).rejects.toBeInstanceOf(OpenAI.AuthenticationError);

    script = say('Hello there');
    const authorized = new OpenAI({
      baseURL: server.getBaseUrl(),
      apiKey: 'sk-test',
      maxRetries: 0,
    });
    const completion = await authorized.chat.completions.create({
      model: 'support',
      messages: [{ role: 'user', content: 'Hi' }],
    });
    expect(completion.choices[0].message.content).toBe('Hello there');
  });
});
