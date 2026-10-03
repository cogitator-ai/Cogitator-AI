import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest';
import OpenAI from 'openai';
import type { Cogitator } from '@cogitator-ai/core';
import {
  CogitatorError,
  ErrorCode,
  type Agent,
  type RunOptions,
  type RunResult,
  type Tool,
} from '@cogitator-ai/types';
import { OpenAIServer } from '../server/api-server';
import { ThreadManager } from '../client/thread-manager';

type RunHandler = (agent: Agent, options: RunOptions) => Promise<Partial<RunResult>>;

const calls: Array<{ agent: Agent; options: RunOptions }> = [];
let handler: RunHandler = async () => ({ output: 'ok' });

const cogitator = {
  run: async (agent: Agent, options: RunOptions) => {
    calls.push({ agent, options });
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

function findTool(agent: Agent, name: string): Tool {
  const tool = agent.tools.find((t) => t.name === name);
  if (!tool) throw new Error(`tool ${name} not exposed to agent`);
  return tool;
}

const POLL = { pollIntervalMs: 20 };

describe('OpenAI SDK compatibility', () => {
  let server: OpenAIServer;
  let client: OpenAI;
  let assistantId: string;

  beforeAll(async () => {
    server = new OpenAIServer(cogitator, {
      port: 0,
      host: '127.0.0.1',
      defaultModel: 'ollama/test-model',
    });
    await server.start();
    client = new OpenAI({ baseURL: server.getBaseUrl(), apiKey: 'unused', maxRetries: 0 });
    const assistant = await client.beta.assistants.create({
      model: 'cogitator',
      name: 'helper',
      instructions: 'Be helpful.',
    });
    assistantId = assistant.id;
  });

  afterAll(async () => {
    await server.stop();
  });

  beforeEach(() => {
    calls.length = 0;
    handler = async () => ({ output: 'ok' });
  });

  it('starts without waiting for internal setup and reports the bound port', () => {
    expect(server.getUrl()).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
    expect(server.getUrl()).not.toContain(':0');
  });

  it('runs to completion and lists the newest message first', async () => {
    handler = async () => ({ output: 'Paris.' });
    const thread = await client.beta.threads.create({
      messages: [{ role: 'user', content: 'Capital of France?' }],
    });

    const run = await client.beta.threads.runs.createAndPoll(
      thread.id,
      { assistant_id: assistantId },
      POLL
    );
    const messages = await client.beta.threads.messages.list(thread.id);

    expect(run.status).toBe('completed');
    expect(run.usage?.total_tokens).toBe(8);
    expect(messages.data[0].role).toBe('assistant');
    expect(messages.data[0].content[0]).toMatchObject({ type: 'text', text: { value: 'Paris.' } });
  });

  it("maps the advertised 'cogitator' model to the configured default model", async () => {
    const thread = await client.beta.threads.create({
      messages: [{ role: 'user', content: 'hi' }],
    });
    await client.beta.threads.runs.createAndPoll(thread.id, { assistant_id: assistantId }, POLL);

    expect(calls[0].agent.model).toBe('ollama/test-model');
  });

  it('replays the thread transcript on follow-up runs and passes the abort signal', async () => {
    const thread = await client.beta.threads.create({
      messages: [{ role: 'user', content: 'My name is Ada.' }],
    });
    handler = async () => ({ output: 'Nice to meet you, Ada.' });
    await client.beta.threads.runs.createAndPoll(thread.id, { assistant_id: assistantId }, POLL);

    await client.beta.threads.messages.create(thread.id, { role: 'user', content: 'Who am I?' });
    handler = async () => ({ output: 'You are Ada.' });
    await client.beta.threads.runs.createAndPoll(thread.id, { assistant_id: assistantId }, POLL);

    const second = calls[1].options;
    expect(second.input).toContain('User: My name is Ada.');
    expect(second.input).toContain('Assistant: Nice to meet you, Ada.');
    expect(second.input).toContain('User: Who am I?');
    expect(second.loadHistory).toBe(false);
    expect(second.threadId).toBe(thread.id);
    expect(second.signal).toBeInstanceOf(AbortSignal);
  });

  it('keeps image parts and passes them to the agent run', async () => {
    const thread = await client.beta.threads.create({
      messages: [
        {
          role: 'user',
          content: [
            { type: 'text', text: 'Describe' },
            { type: 'image_url', image_url: { url: 'https://img.test/cat.png' } },
          ],
        },
      ],
    });
    await client.beta.threads.runs.createAndPoll(thread.id, { assistant_id: assistantId }, POLL);
    const stored = await client.beta.threads.messages.list(thread.id, { order: 'asc' });

    expect(calls[0].options.images).toEqual(['https://img.test/cat.png']);
    expect(stored.data[0].content.map((c) => c.type)).toEqual(['text', 'image_url']);
  });

  it('applies run options: tool_choice none, response_format, limits and instructions', async () => {
    const thread = await client.beta.threads.create({
      messages: [{ role: 'user', content: 'json please' }],
    });
    await client.beta.threads.runs.createAndPoll(
      thread.id,
      {
        assistant_id: assistantId,
        additional_instructions: 'Answer in French.',
        response_format: { type: 'json_object' },
        tool_choice: 'none',
        max_completion_tokens: 42,
        top_p: 0.5,
        tools: [{ type: 'function', function: { name: 'unused', parameters: { type: 'object' } } }],
      },
      POLL
    );

    const { agent } = calls[0];
    expect(agent.tools).toHaveLength(0);
    expect(agent.config.responseFormat).toEqual({ type: 'json' });
    expect(agent.config.maxTokens).toBe(42);
    expect(agent.config.topP).toBe(0.5);
    expect(agent.instructions).toContain('Be helpful.');
    expect(agent.instructions).toContain('Answer in French.');
  });

  it('honours truncation_strategy last_messages', async () => {
    const thread = await client.beta.threads.create({
      messages: [
        { role: 'user', content: 'old 1' },
        { role: 'assistant', content: 'old 2' },
        { role: 'user', content: 'new' },
      ],
    });
    await client.beta.threads.runs.createAndPoll(
      thread.id,
      {
        assistant_id: assistantId,
        truncation_strategy: { type: 'last_messages', last_messages: 1 },
      },
      POLL
    );

    expect(calls[0].options.input).toBe('new');
  });

  it('pauses for client-side function calls and resumes with submitted outputs', async () => {
    handler = async (agent) => {
      const weather = await findTool(agent, 'get_weather').execute(
        { city: 'Paris' },
        { agentId: 'a', runId: 'r', signal: new AbortController().signal }
      );
      return { output: `Forecast: ${String(weather)}` };
    };
    const assistant = await client.beta.assistants.create({
      model: 'cogitator',
      tools: [
        {
          type: 'function',
          function: {
            name: 'get_weather',
            description: 'Weather for a city',
            parameters: {
              type: 'object',
              properties: { city: { type: 'string' } },
              required: ['city'],
            },
          },
        },
      ],
    });
    const thread = await client.beta.threads.create({
      messages: [{ role: 'user', content: 'Weather in Paris?' }],
    });

    const paused = await client.beta.threads.runs.createAndPoll(
      thread.id,
      { assistant_id: assistant.id },
      POLL
    );
    expect(paused.status).toBe('requires_action');
    const toolCall = paused.required_action!.submit_tool_outputs.tool_calls[0];
    expect(toolCall.function.name).toBe('get_weather');
    expect(JSON.parse(toolCall.function.arguments)).toEqual({ city: 'Paris' });

    const missing = await client.beta.threads.runs
      .submitToolOutputs(paused.id, { thread_id: thread.id, tool_outputs: [] })
      .catch((e: unknown) => e);
    expect(missing).toBeInstanceOf(OpenAI.BadRequestError);

    const done = await client.beta.threads.runs.submitToolOutputsAndPoll(
      paused.id,
      { thread_id: thread.id, tool_outputs: [{ tool_call_id: toolCall.id, output: 'sunny' }] },
      POLL
    );
    const messages = await client.beta.threads.messages.list(thread.id);

    expect(done.status).toBe('completed');
    expect(messages.data[0].content[0]).toMatchObject({ text: { value: 'Forecast: sunny' } });
  });

  it('rejects a second run while the thread has an active run', async () => {
    let release: (() => void) | undefined;
    handler = () =>
      new Promise((resolve) => {
        release = () => resolve({ output: 'done' });
      });
    const thread = await client.beta.threads.create({
      messages: [{ role: 'user', content: 'slow' }],
    });
    const first = await client.beta.threads.runs.create(thread.id, { assistant_id: assistantId });

    const second = await client.beta.threads.runs
      .create(thread.id, { assistant_id: assistantId })
      .catch((e: unknown) => e);
    expect(second).toBeInstanceOf(OpenAI.BadRequestError);

    await vi.waitFor(() => expect(release).toBeDefined());
    release!();
    const finished = await client.beta.threads.runs.poll(first.id, { thread_id: thread.id }, POLL);
    expect(finished.status).toBe('completed');

    const listed = await client.beta.threads.runs.list(thread.id);
    expect(listed.data.map((r) => r.id)).toEqual([first.id]);
  });

  it('cancels a running run, aborts the agent and rejects cancelling twice', async () => {
    let signal: AbortSignal | undefined;
    handler = (_agent, options) =>
      new Promise((_resolve, reject) => {
        signal = options.signal;
        options.signal?.addEventListener('abort', () => reject(new Error('aborted')));
      });
    const thread = await client.beta.threads.create({
      messages: [{ role: 'user', content: 'forever' }],
    });
    const run = await client.beta.threads.runs.create(thread.id, { assistant_id: assistantId });
    await vi.waitFor(() => expect(signal).toBeDefined());

    await client.beta.threads.runs.cancel(run.id, { thread_id: thread.id });
    const final = await client.beta.threads.runs.poll(run.id, { thread_id: thread.id }, POLL);

    expect(final.status).toBe('cancelled');
    expect(signal?.aborted).toBe(true);
    const again = await client.beta.threads.runs
      .cancel(run.id, { thread_id: thread.id })
      .catch((e: unknown) => e);
    expect(again).toBeInstanceOf(OpenAI.BadRequestError);
  });

  it('streams token deltas into a single message part with consistent ids', async () => {
    handler = async (_agent, options) => {
      for (const token of ['Hel', 'lo', '!']) options.onToken?.(token);
      return { output: 'Hello!' };
    };
    const thread = await client.beta.threads.create({
      messages: [{ role: 'user', content: 'greet' }],
    });

    const events: string[] = [];
    let text = '';
    const stream = client.beta.threads.runs
      .stream(thread.id, { assistant_id: assistantId })
      .on('event', (event) => events.push(event.event))
      .on('textDelta', (delta) => (text += delta.value ?? ''));
    const finalMessages = await stream.finalMessages();
    const finalRun = await stream.finalRun();

    expect(text).toBe('Hello!');
    expect(finalRun.status).toBe('completed');
    expect(finalMessages).toHaveLength(1);
    expect(finalMessages[0].content).toHaveLength(1);
    expect(finalMessages[0].content[0]).toMatchObject({ text: { value: 'Hello!' } });
    expect(events.slice(0, 3)).toEqual([
      'thread.run.created',
      'thread.run.queued',
      'thread.run.in_progress',
    ]);
    expect(events.at(-1)).toBe('thread.run.completed');

    const stored = await client.beta.threads.messages.list(thread.id);
    expect(stored.data[0].id).toBe(finalMessages[0].id);
  });

  it('streams up to requires_action and continues with submitToolOutputsStream', async () => {
    handler = async (agent, options) => {
      const result = await findTool(agent, 'lookup').execute(
        { key: 'x' },
        { agentId: 'a', runId: 'r', signal: new AbortController().signal }
      );
      options.onToken?.(`value=${String(result)}`);
      return { output: `value=${String(result)}` };
    };
    const assistant = await client.beta.assistants.create({
      model: 'cogitator',
      tools: [
        {
          type: 'function',
          function: {
            name: 'lookup',
            parameters: { type: 'object', properties: { key: { type: 'string' } } },
          },
        },
      ],
    });
    const thread = await client.beta.threads.create({
      messages: [{ role: 'user', content: 'lookup x' }],
    });

    const first = client.beta.threads.runs.stream(thread.id, { assistant_id: assistant.id });
    const paused = await first.finalRun();
    expect(paused.status).toBe('requires_action');
    const call = paused.required_action!.submit_tool_outputs.tool_calls[0];

    const resumed = client.beta.threads.runs.submitToolOutputsStream(paused.id, {
      thread_id: thread.id,
      tool_outputs: [{ tool_call_id: call.id, output: '42' }],
    });
    const run = await resumed.finalRun();
    const messages = await resumed.finalMessages();

    expect(run.status).toBe('completed');
    expect(messages[0].content[0]).toMatchObject({ text: { value: 'value=42' } });
  });

  it('validates list parameters', async () => {
    const thread = await client.beta.threads.create({
      messages: [
        { role: 'user', content: 'a' },
        { role: 'user', content: 'b' },
      ],
    });

    const page = await client.beta.threads.messages.list(thread.id, { limit: 1 });
    expect(page.data).toHaveLength(1);
    expect(page.data[0].content[0]).toMatchObject({ text: { value: 'b' } });
    expect(page.has_more).toBe(true);

    const bad = await fetch(`${server.getBaseUrl()}/threads/${thread.id}/messages?limit=0`);
    expect(bad.status).toBe(400);
  });

  it('requires a model when creating assistants', async () => {
    const response = await fetch(`${server.getBaseUrl()}/assistants`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'no model' }),
    });
    expect(response.status).toBe(400);
  });

  it('stores file purpose and serves safe download headers', async () => {
    const file = await client.files.create({
      file: new File([Buffer.from('data')], 'résumé.txt'),
      purpose: 'vision',
    });
    expect(file.purpose).toBe('vision');

    const filtered = await fetch(`${server.getBaseUrl()}/files?purpose=vision`);
    const list = (await filtered.json()) as { data: { id: string }[] };
    expect(list.data.map((f) => f.id)).toContain(file.id);

    const other = await fetch(`${server.getBaseUrl()}/files?purpose=batch`);
    expect(((await other.json()) as { data: unknown[] }).data).toHaveLength(0);

    const content = await fetch(`${server.getBaseUrl()}/files/${file.id}/content`);
    expect(content.status).toBe(200);
    expect(content.headers.get('content-disposition')).toBe(
      'attachment; filename="r_sum_.txt"; filename*=UTF-8\'\'r%C3%A9sum%C3%A9.txt'
    );
  });

  it('reports a failed run without the text of internal errors', async () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
    handler = async () => {
      throw new Error('connect ECONNREFUSED 10.0.0.5:6379');
    };
    const thread = await client.beta.threads.create({
      messages: [{ role: 'user', content: 'hi' }],
    });

    const run = await client.beta.threads.runs.createAndPoll(
      thread.id,
      { assistant_id: assistantId },
      POLL
    );

    expect(run.status).toBe('failed');
    expect(run.last_error).toEqual({ code: 'server_error', message: 'Internal server error' });
    expect(String(consoleError.mock.calls[0]?.[1])).toContain('ECONNREFUSED');
    consoleError.mockRestore();
  });

  it('reports the message of a CogitatorError on a failed run', async () => {
    handler = async () => {
      throw new CogitatorError({ message: 'Model is overloaded', code: ErrorCode.LLM_UNAVAILABLE });
    };
    const thread = await client.beta.threads.create({
      messages: [{ role: 'user', content: 'hi' }],
    });

    const run = await client.beta.threads.runs.createAndPoll(
      thread.id,
      { assistant_id: assistantId },
      POLL
    );

    expect(run.last_error?.message).toBe('Model is overloaded');
  });

  it('answers a storage failure while creating a run with a generic 500', async () => {
    const thread = await client.beta.threads.create({
      messages: [{ role: 'user', content: 'hi' }],
    });
    const getAssistant = vi
      .spyOn(ThreadManager.prototype, 'getAssistant')
      .mockRejectedValueOnce(new Error('connect ECONNREFUSED 10.0.0.5:6379'));

    const response = await fetch(`${server.getBaseUrl()}/threads/${thread.id}/runs`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ assistant_id: assistantId }),
    });
    getAssistant.mockRestore();

    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({
      error: { message: 'Internal server error', type: 'server_error', code: 'internal_error' },
    });
  });

  it('answers a refused run with 400, its message and the parameter at fault', async () => {
    const thread = await client.beta.threads.create({
      messages: [{ role: 'user', content: 'hi' }],
    });

    const response = await fetch(`${server.getBaseUrl()}/threads/${thread.id}/runs`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ assistant_id: 'asst_missing' }),
    });

    expect(response.status).toBe(400);
    expect((await response.json()).error).toMatchObject({
      message: 'Assistant asst_missing not found',
      param: 'assistant_id',
    });
  });

  it('leaves the oldest messages out of the prompt to honour max_prompt_tokens', async () => {
    const thread = await client.beta.threads.create({
      messages: [
        { role: 'user', content: 'old '.repeat(100) },
        { role: 'assistant', content: 'reply' },
        { role: 'user', content: 'Who?' },
      ],
    });

    const run = await client.beta.threads.runs.createAndPoll(
      thread.id,
      { assistant_id: assistantId, max_prompt_tokens: 60 },
      POLL
    );

    expect(run.status).toBe('completed');
    expect(calls[0].options.input).toBe('Conversation so far:\n\nAssistant: reply\n\nUser: Who?');
    expect(calls[0].options.loadHistory).toBe(false);
  });

  it('ends the run incomplete when the last message alone exceeds max_prompt_tokens', async () => {
    const thread = await client.beta.threads.create({
      messages: [{ role: 'user', content: 'x'.repeat(400) }],
    });

    const run = await client.beta.threads.runs.createAndPoll(
      thread.id,
      { assistant_id: assistantId, max_prompt_tokens: 50 },
      POLL
    );

    expect(run.status).toBe('incomplete');
    expect(run.incomplete_details).toEqual({ reason: 'max_prompt_tokens' });
    expect(calls).toHaveLength(0);
  });

  it('rejects a max_prompt_tokens that is not a positive integer', async () => {
    const thread = await client.beta.threads.create({
      messages: [{ role: 'user', content: 'hi' }],
    });

    const response = await fetch(`${server.getBaseUrl()}/threads/${thread.id}/runs`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ assistant_id: assistantId, max_prompt_tokens: 0 }),
    });

    expect(response.status).toBe(400);
    expect((await response.json()).error.param).toBe('max_prompt_tokens');
  });

  it('pages the file list with limit, after and order', async () => {
    const uploaded = [];
    for (const name of ['one.txt', 'two.txt', 'three.txt']) {
      uploaded.push(
        await client.files.create({ file: new File([name], name), purpose: 'fine-tune' })
      );
    }
    const list = async (query: string) => {
      const response = await fetch(`${server.getBaseUrl()}/files?purpose=fine-tune&${query}`);
      return (await response.json()) as {
        data: { id: string }[];
        has_more: boolean;
        last_id?: string;
      };
    };

    const all = await list('order=asc');
    const first = await list('order=asc&limit=2');
    const rest = await list(`order=asc&limit=2&after=${first.last_id}`);
    const bad = await fetch(`${server.getBaseUrl()}/files?limit=0`);

    expect(all.data.map((f) => f.id).sort()).toEqual(uploaded.map((f) => f.id).sort());
    expect(first.data).toHaveLength(2);
    expect(first.has_more).toBe(true);
    expect([...first.data, ...rest.data].map((f) => f.id)).toEqual(all.data.map((f) => f.id));
    expect(rest.has_more).toBe(false);
    expect(bad.status).toBe(400);
  });
});

describe('OpenAIServer configuration', () => {
  it('keeps /health public when API keys are configured', async () => {
    const server = new OpenAIServer(cogitator, {
      port: 0,
      host: '127.0.0.1',
      apiKeys: ['sk-test'],
    });
    await server.start();
    try {
      const health = await fetch(`${server.getUrl()}/health`);
      const denied = await fetch(`${server.getBaseUrl()}/models`);
      const allowed = await fetch(`${server.getBaseUrl()}/models`, {
        headers: { Authorization: 'Bearer sk-test' },
      });

      expect(health.status).toBe(200);
      expect(denied.status).toBe(401);
      expect(allowed.status).toBe(200);
    } finally {
      await server.stop();
    }
  });

  it('starts with logging enabled without optional pretty-print transports', async () => {
    const server = new OpenAIServer(cogitator, { port: 0, host: '127.0.0.1', logging: true });
    await expect(server.start()).resolves.toBeUndefined();
    await server.stop();
  });

  it("fails runs on the 'cogitator' model when no defaultModel is configured", async () => {
    const server = new OpenAIServer(cogitator, { port: 0, host: '127.0.0.1' });
    await server.start();
    try {
      const client = new OpenAI({ baseURL: server.getBaseUrl(), apiKey: 'x', maxRetries: 0 });
      const assistant = await client.beta.assistants.create({ model: 'cogitator' });
      const thread = await client.beta.threads.create({
        messages: [{ role: 'user', content: 'hi' }],
      });
      const run = await client.beta.threads.runs.createAndPoll(
        thread.id,
        { assistant_id: assistant.id },
        POLL
      );

      expect(run.status).toBe('failed');
      expect(run.last_error?.message).toContain('defaultModel');
    } finally {
      await server.stop();
    }
  });
});
