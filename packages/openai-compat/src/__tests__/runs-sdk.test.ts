import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest';
import OpenAI from 'openai';
import type { Cogitator } from '@cogitator-ai/core';
import {
  CogitatorError,
  ErrorCode,
  type Agent,
  type RunOptions,
  type RunResult,
} from '@cogitator-ai/types';
import { OpenAIServer } from '../server/api-server';
import { ThreadManager } from '../client/thread-manager';
import type { RunStep } from '../types/openai-types';

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

  it('ends a run cut by max_completion_tokens incomplete, with the message incomplete', async () => {
    handler = async () => ({ output: '{"answer": "the quick brown', truncated: true });
    const thread = await client.beta.threads.create({
      messages: [{ role: 'user', content: 'Answer in JSON' }],
    });

    const run = await client.beta.threads.runs.createAndPoll(
      thread.id,
      { assistant_id: assistantId, max_completion_tokens: 8 },
      POLL
    );
    const messages = await client.beta.threads.messages.list(thread.id);

    expect(run.status).toBe('incomplete');
    expect(run.incomplete_details).toEqual({ reason: 'max_completion_tokens' });
    expect(run.completed_at).toBeNull();
    expect(run.usage?.total_tokens).toBe(8);
    expect(messages.data[0]).toMatchObject({
      role: 'assistant',
      status: 'incomplete',
      incomplete_details: { reason: 'max_tokens' },
      completed_at: null,
    });
    expect(messages.data[0].incomplete_at).toEqual(expect.any(Number));
    expect(messages.data[0].content[0]).toMatchObject({
      text: { value: '{"answer": "the quick brown' },
    });
  });

  it('streams thread.message.incomplete and thread.run.incomplete for a truncated run', async () => {
    handler = async () => ({ output: 'cut off', truncated: true });
    const thread = await client.beta.threads.create({
      messages: [{ role: 'user', content: 'hi' }],
    });

    const events: string[] = [];
    const stream = client.beta.threads.runs.stream(thread.id, { assistant_id: assistantId });
    for await (const event of stream) events.push(event.event);

    expect(events).toContain('thread.message.incomplete');
    expect(events).not.toContain('thread.message.completed');
    expect(events).toContain('thread.run.incomplete');
    expect(events).not.toContain('thread.run.completed');
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

  describe('a model turn that writes text and then calls a tool', () => {
    const lookupCall = { id: 'call_1', name: 'lookup', arguments: { order: 'A-1' } };

    function textThenTool(finish: (options: RunOptions) => Promise<Partial<RunResult>>) {
      handler = async (_agent, options) => {
        options.onToken?.('Let me ');
        options.onToken?.('check.');
        options.onToolCall?.(lookupCall);
        options.onToolResult?.({ callId: 'call_1', name: 'lookup', result: { status: 'shipped' } });
        return finish(options);
      };
    }

    async function stepsOf(threadId: string, runId: string): Promise<RunStep[]> {
      const page = await client.beta.threads.runs.steps.list(runId, {
        thread_id: threadId,
        order: 'asc',
      });
      return page.data as RunStep[];
    }

    function messageIdOf(step: RunStep): string | undefined {
      return step.step_details.type === 'message_creation'
        ? step.step_details.message_creation.message_id
        : undefined;
    }

    it('streams one message per text turn and strictly sequential steps', async () => {
      textThenTool(async (options) => {
        options.onToken?.('Shipped.');
        return { output: 'Shipped.' };
      });
      const thread = await client.beta.threads.create({
        messages: [{ role: 'user', content: 'Where is A-1?' }],
      });

      const done: RunStep[] = [];
      const texts = new Map<string, string>();
      const stream = client.beta.threads.runs
        .stream(thread.id, { assistant_id: assistantId })
        .on('runStepDone', (step) => done.push(step as RunStep))
        .on('textDone', (text, message) => texts.set(message.id, text.value));
      const finalRun = await stream.finalRun();
      const streamedMessages = await stream.finalMessages();

      const stored = await client.beta.threads.messages.list(thread.id, {
        order: 'asc',
        run_id: finalRun.id,
      });
      const steps = await stepsOf(thread.id, finalRun.id);

      expect(finalRun.status).toBe('completed');
      expect(stored.data.map((m) => m.content[0])).toMatchObject([
        { text: { value: 'Let me check.' } },
        { text: { value: 'Shipped.' } },
      ]);
      expect(stored.data.map((m) => m.status)).toEqual(['completed', 'completed']);
      expect(streamedMessages.map((m) => m.id)).toEqual(stored.data.map((m) => m.id));
      expect([...texts.entries()]).toEqual([
        [stored.data[0].id, 'Let me check.'],
        [stored.data[1].id, 'Shipped.'],
      ]);
      expect(steps.map((step) => [step.type, step.status])).toEqual([
        ['message_creation', 'completed'],
        ['tool_calls', 'completed'],
        ['message_creation', 'completed'],
      ]);
      expect(steps.map(messageIdOf)).toEqual([stored.data[0].id, undefined, stored.data[1].id]);
      expect(done.map((step) => step.id)).toEqual(steps.map((step) => step.id));
      expect(done[1].step_details).toMatchObject({
        tool_calls: [{ id: 'call_1', function: { output: '{"status":"shipped"}' } }],
      });
    });

    it('keeps the finished turn and the partial one when the run fails later', async () => {
      textThenTool(async (options) => {
        options.onToken?.('Ship');
        throw new Error('boom');
      });
      const thread = await client.beta.threads.create({
        messages: [{ role: 'user', content: 'Where is A-1?' }],
      });

      const events: string[] = [];
      const stream = client.beta.threads.runs
        .stream(thread.id, { assistant_id: assistantId })
        .on('event', (event) => events.push(event.event));
      const finalRun = await stream.finalRun();
      const stored = await client.beta.threads.messages.list(thread.id, {
        order: 'asc',
        run_id: finalRun.id,
      });
      const steps = await stepsOf(thread.id, finalRun.id);

      expect(finalRun.status).toBe('failed');
      expect(stored.data).toHaveLength(2);
      expect(stored.data[0]).toMatchObject({
        status: 'completed',
        content: [{ text: { value: 'Let me check.' } }],
      });
      expect(stored.data[1]).toMatchObject({
        status: 'incomplete',
        incomplete_details: { reason: 'run_failed' },
        content: [{ text: { value: 'Ship' } }],
      });
      expect(steps.map((step) => [step.type, step.status])).toEqual([
        ['message_creation', 'completed'],
        ['tool_calls', 'completed'],
        ['message_creation', 'failed'],
      ]);
      expect(steps.map(messageIdOf)).toEqual([stored.data[0].id, undefined, stored.data[1].id]);
      expect(events.slice(-3)).toEqual([
        'thread.message.incomplete',
        'thread.run.step.failed',
        'thread.run.failed',
      ]);
    });

    it('keeps the finished turn when the run is cancelled during the tool call', async () => {
      handler = (_agent, options) =>
        new Promise((_resolve, reject) => {
          options.onToken?.('Let me check.');
          options.onToolCall?.(lookupCall);
          options.signal?.addEventListener('abort', () => reject(new Error('aborted')));
        });
      const thread = await client.beta.threads.create({
        messages: [{ role: 'user', content: 'Where is A-1?' }],
      });
      const run = await client.beta.threads.runs.create(thread.id, { assistant_id: assistantId });
      await vi.waitFor(async () => expect(await stepsOf(thread.id, run.id)).toHaveLength(2));

      await client.beta.threads.runs.cancel(run.id, { thread_id: thread.id });
      const final = await client.beta.threads.runs.poll(run.id, { thread_id: thread.id }, POLL);
      const stored = await client.beta.threads.messages.list(thread.id, { run_id: run.id });
      const steps = await stepsOf(thread.id, run.id);

      expect(final.status).toBe('cancelled');
      expect(stored.data).toHaveLength(1);
      expect(stored.data[0]).toMatchObject({
        status: 'completed',
        content: [{ text: { value: 'Let me check.' } }],
      });
      expect(steps.map((step) => [step.type, step.status])).toEqual([
        ['message_creation', 'completed'],
        ['tool_calls', 'cancelled'],
      ]);
      expect(messageIdOf(steps[0])).toBe(stored.data[0].id);
    });
  });

  describe('before cursors', () => {
    type Page = { data: { id: string }[]; has_more: boolean; first_id?: string; last_id?: string };

    async function page(path: string): Promise<Page> {
      return (await (await fetch(`${server.getBaseUrl()}${path}`)).json()) as Page;
    }

    it('give the items right before the cursor for messages', async () => {
      const thread = await client.beta.threads.create({
        messages: ['m1', 'm2', 'm3', 'm4', 'm5'].map((content) => ({
          role: 'user' as const,
          content,
        })),
      });
      const all = await page(`/threads/${thread.id}/messages?order=asc`);
      const [m1, m2, m3, m4, m5] = all.data.map((m) => m.id);

      const asc = await page(`/threads/${thread.id}/messages?order=asc&limit=2&before=${m5}`);
      const desc = await page(`/threads/${thread.id}/messages?limit=2&before=${m1}`);
      const nearStart = await page(`/threads/${thread.id}/messages?order=asc&limit=2&before=${m3}`);

      expect(asc.data.map((m) => m.id)).toEqual([m3, m4]);
      expect(asc.has_more).toBe(true);
      expect(desc.data.map((m) => m.id)).toEqual([m3, m2]);
      expect(desc.has_more).toBe(true);
      expect(nearStart.data.map((m) => m.id)).toEqual([m1, m2]);
      expect(nearStart.has_more).toBe(false);

      const manager = server.getAdapter().getThreadManager();
      const direct = await manager.listMessages(thread.id, { order: 'asc', limit: 2, before: m5 });
      expect(direct.map((m) => m.id)).toEqual([m3, m4]);
    });

    it('give the items right before the cursor for runs and steps', async () => {
      handler = async (_agent, options) => {
        for (const id of ['c1', 'c2', 'c3']) {
          options.onToolCall?.({ id, name: 'lookup', arguments: {} });
          options.onToolResult?.({ callId: id, name: 'lookup', result: id });
        }
        return { output: 'done' };
      };
      const thread = await client.beta.threads.create({
        messages: [{ role: 'user', content: 'go' }],
      });
      const runs: string[] = [];
      for (let i = 0; i < 4; i++) {
        const run = await client.beta.threads.runs.createAndPoll(
          thread.id,
          { assistant_id: assistantId },
          POLL
        );
        runs.push(run.id);
      }

      const runPage = await page(`/threads/${thread.id}/runs?order=asc&limit=2&before=${runs[3]}`);
      expect(runPage.data.map((r) => r.id)).toEqual([runs[1], runs[2]]);
      expect(runPage.has_more).toBe(true);

      const stepsPath = `/threads/${thread.id}/runs/${runs[3]}/steps`;
      const steps = (await page(`${stepsPath}?order=asc`)).data.map((step) => step.id);
      expect(steps).toHaveLength(4);
      const ascSteps = await page(`${stepsPath}?order=asc&limit=2&before=${steps[3]}`);
      const descSteps = await page(`${stepsPath}?limit=2&before=${steps[0]}`);

      expect(ascSteps.data.map((step) => step.id)).toEqual([steps[1], steps[2]]);
      expect(ascSteps.has_more).toBe(true);
      expect(descSteps.data.map((step) => step.id)).toEqual([steps[2], steps[1]]);
      expect(descSteps.has_more).toBe(true);
    });
  });
});

describe('OpenAIServer exposure', () => {
  it('listens on loopback by default', async () => {
    const server = new OpenAIServer(cogitator, { port: 0 });
    await server.start();
    try {
      expect(server.getUrl()).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
    } finally {
      await server.stop();
    }
  });

  it.each(['0.0.0.0', '::', '192.168.1.20'])(
    'refuses to serve %s without API keys',
    async (host) => {
      const server = new OpenAIServer(cogitator, { port: 0, host });
      await expect(server.start()).rejects.toThrow(/without apiKeys/);
    }
  );

  it('serves a public host with API keys, or when told a gateway authenticates', async () => {
    for (const config of [{ apiKeys: ['sk-test'] }, { allowUnauthenticatedPublicAccess: true }]) {
      const server = new OpenAIServer(cogitator, { port: 0, host: '0.0.0.0', ...config });
      await expect(server.start()).resolves.toBeUndefined();
      await server.stop();
    }
  });

  it('answers no cross-origin request unless CORS origins are configured', async () => {
    const closed = new OpenAIServer(cogitator, { port: 0 });
    const open = new OpenAIServer(cogitator, {
      port: 0,
      cors: { origin: ['https://app.example'] },
    });
    await closed.start();
    await open.start();
    try {
      const headers = { Origin: 'https://evil.example' };
      const refused = await fetch(`${closed.getBaseUrl()}/models`, { headers });
      const allowed = await fetch(`${open.getBaseUrl()}/models`, {
        headers: { Origin: 'https://app.example' },
      });

      expect(refused.headers.get('access-control-allow-origin')).toBeNull();
      expect(allowed.headers.get('access-control-allow-origin')).toBe('https://app.example');
    } finally {
      await closed.stop();
      await open.stop();
    }
  });
});

describe('OpenAIServer run stream heartbeat', () => {
  it('writes comments while a run is silent, so proxies do not cut the stream', async () => {
    const server = new OpenAIServer(cogitator, {
      port: 0,
      defaultModel: 'ollama/test-model',
      sseHeartbeatMs: 20,
    });
    await server.start();
    try {
      handler = () => new Promise((resolve) => setTimeout(() => resolve({ output: 'late' }), 150));
      const base = server.getBaseUrl();
      const post = (path: string, body: unknown) =>
        fetch(`${base}${path}`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        }).then((res) => res.json() as Promise<{ id: string }>);
      const assistant = await post('/assistants', { model: 'cogitator' });
      const thread = await post('/threads', { messages: [{ role: 'user', content: 'hi' }] });

      const res = await fetch(`${base}/threads/${thread.id}/runs`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ assistant_id: assistant.id, stream: true }),
      });
      const text = await res.text();

      expect(text.match(/^: keep-alive$/gm)?.length).toBeGreaterThanOrEqual(3);
      expect(text).toContain('event: done');
    } finally {
      handler = async () => ({ output: 'ok' });
      await server.stop();
    }
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
