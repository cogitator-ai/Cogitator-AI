import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import OpenAI from 'openai';
import { z } from 'zod';
import { Cogitator, tool } from '@cogitator-ai/core';
import { createOpenAIServer, type OpenAIServer } from '@cogitator-ai/openai-compat';
import { createTestCogitator, isOllamaRunning, getTestModel } from '../../helpers/setup';

const describeOllama = process.env.TEST_OLLAMA === 'true' ? describe : describe.skip;
const describeHeavy = process.env.OLLAMA_API_KEY ? describe : describe.skip;

const HEAVY_MODEL = 'gpt-oss:20b';
const OLLAMA_CLOUD_URL = process.env.OLLAMA_URL || 'https://ollama.com';
const POLL = { pollIntervalMs: 200 };

async function startServer(
  cogitator: Cogitator,
  defaultModel: string,
  extra?: Parameters<typeof createOpenAIServer>[1]
): Promise<{ server: OpenAIServer; client: OpenAI }> {
  const server = createOpenAIServer(cogitator, {
    port: 0,
    host: '127.0.0.1',
    defaultModel,
    ...extra,
  });
  await server.start();
  const client = new OpenAI({
    baseURL: server.getBaseUrl(),
    apiKey: extra?.apiKeys?.[0] ?? 'unused',
    maxRetries: 0,
  });
  return { server, client };
}

describe('OpenAI SDK against the compat server (no LLM)', () => {
  let cogitator: Cogitator;
  let server: OpenAIServer;
  let client: OpenAI;

  beforeAll(async () => {
    cogitator = new Cogitator();
    ({ server, client } = await startServer(cogitator, 'ollama/unused', {
      apiKeys: ['sk-e2e'],
    }));
  });

  afterAll(async () => {
    await server?.stop();
    await cogitator?.close();
  });

  it('manages assistants, threads, messages and files through the SDK', async () => {
    const assistant = await client.beta.assistants.create({
      model: 'cogitator',
      name: 'sdk',
      description: 'SDK e2e',
      tools: [{ type: 'function', function: { name: 'noop', parameters: { type: 'object' } } }],
    });
    expect(assistant.description).toBe('SDK e2e');

    const updated = await client.beta.assistants.update(assistant.id, { name: 'renamed' });
    expect(updated.name).toBe('renamed');
    expect(updated.description).toBe('SDK e2e');

    const thread = await client.beta.threads.create({
      messages: [
        {
          role: 'user',
          content: [
            { type: 'text', text: 'look' },
            { type: 'image_url', image_url: { url: 'https://example.com/a.png' } },
          ],
        },
      ],
    });
    await client.beta.threads.messages.create(thread.id, { role: 'user', content: 'second' });

    const newestFirst = await client.beta.threads.messages.list(thread.id, { limit: 1 });
    expect(newestFirst.data[0].content[0]).toMatchObject({ text: { value: 'second' } });
    expect(newestFirst.has_more).toBe(true);

    const all = await client.beta.threads.messages.list(thread.id, { order: 'asc' });
    expect(all.data[0].content.map((c) => c.type)).toEqual(['text', 'image_url']);

    const file = await client.files.create({
      file: new File([Buffer.from('hello')], 'notes.txt'),
      purpose: 'assistants',
    });
    const content = await client.files.content(file.id);
    expect(await content.text()).toBe('hello');

    await client.beta.assistants.delete(assistant.id);
    await client.beta.threads.delete(thread.id);
  });

  it('rejects requests with a wrong API key but keeps /health public', async () => {
    const wrong = new OpenAI({ baseURL: server.getBaseUrl(), apiKey: 'nope', maxRetries: 0 });
    await expect(wrong.models.list()).rejects.toBeInstanceOf(OpenAI.AuthenticationError);

    const health = await fetch(`${server.getUrl()}/health`);
    expect(health.status).toBe(200);
  });
});

describeOllama('OpenAI SDK with a local Ollama model', () => {
  let cogitator: Cogitator;
  let server: OpenAIServer;
  let client: OpenAI;
  let assistantId: string;

  beforeAll(async () => {
    if (!(await isOllamaRunning())) throw new Error('Ollama not running');
    cogitator = createTestCogitator();
    ({ server, client } = await startServer(cogitator, `ollama/${getTestModel()}`));
    const assistant = await client.beta.assistants.create({
      model: 'cogitator',
      instructions: 'You are a helpful assistant. Keep responses very brief.',
    });
    assistantId = assistant.id;
  });

  afterAll(async () => {
    await server?.stop();
    await cogitator?.close();
  });

  it('completes a run with createAndPoll', async () => {
    const thread = await client.beta.threads.create({
      messages: [{ role: 'user', content: 'What is 2 + 2? Reply with just the number.' }],
    });
    const run = await client.beta.threads.runs.createAndPoll(
      thread.id,
      { assistant_id: assistantId },
      POLL
    );
    expect(run.status).toBe('completed');

    const messages = await client.beta.threads.messages.list(thread.id);
    expect(messages.data[0].role).toBe('assistant');
    const first = messages.data[0].content[0];
    expect(first.type === 'text' && first.text.value.length).toBeGreaterThan(0);
  });

  it('streams text deltas that add up to the stored message', async () => {
    const thread = await client.beta.threads.create({
      messages: [{ role: 'user', content: 'Say hello in three words.' }],
    });

    let streamed = '';
    const stream = client.beta.threads.runs
      .stream(thread.id, { assistant_id: assistantId })
      .on('textDelta', (delta) => (streamed += delta.value ?? ''));
    const run = await stream.finalRun();
    const [message] = await stream.finalMessages();

    expect(run.status).toBe('completed');
    expect(message.content).toHaveLength(1);
    const part = message.content[0];
    expect(streamed.trim().length).toBeGreaterThan(0);
    expect(part.type === 'text' && part.text.value.trim()).toBe(streamed.trim());
  });
});

describeHeavy('OpenAI SDK with function calling (heavy model)', () => {
  let cogitator: Cogitator;
  let server: OpenAIServer;
  let client: OpenAI;

  beforeAll(async () => {
    cogitator = new Cogitator({
      llm: {
        defaultModel: `ollama/${HEAVY_MODEL}`,
        providers: {
          ollama: { baseUrl: OLLAMA_CLOUD_URL, apiKey: process.env.OLLAMA_API_KEY },
        },
      },
    });
    const serverTool = tool({
      name: 'company_motto',
      description: 'Returns the company motto.',
      parameters: z.object({}),
      execute: async () => ({ motto: 'Think in swarms' }),
    });
    ({ server, client } = await startServer(cogitator, `ollama/${HEAVY_MODEL}`, {
      tools: [serverTool],
    }));
  });

  afterAll(async () => {
    await server?.stop();
    await cogitator?.close();
  });

  it('pauses for a client function call and uses the submitted output', { retry: 2 }, async () => {
    const assistant = await client.beta.assistants.create({
      model: 'cogitator',
      instructions:
        'You answer stock questions. Always call get_stock_price to get prices; never guess.',
      tools: [
        {
          type: 'function',
          function: {
            name: 'get_stock_price',
            description: 'Get the current price of a stock ticker in USD',
            parameters: {
              type: 'object',
              properties: { ticker: { type: 'string' } },
              required: ['ticker'],
            },
          },
        },
      ],
    });
    const thread = await client.beta.threads.create({
      messages: [{ role: 'user', content: 'What is the price of ZZZX right now?' }],
    });

    let run = await client.beta.threads.runs.createAndPoll(
      thread.id,
      { assistant_id: assistant.id },
      POLL
    );
    expect(run.status).toBe('requires_action');
    const call = run.required_action!.submit_tool_outputs.tool_calls[0];
    expect(call.function.name).toBe('get_stock_price');
    expect(JSON.parse(call.function.arguments).ticker).toBe('ZZZX');

    run = await client.beta.threads.runs.submitToolOutputsAndPoll(
      run.id,
      {
        thread_id: thread.id,
        tool_outputs: [{ tool_call_id: call.id, output: JSON.stringify({ price: 1234.56 }) }],
      },
      POLL
    );
    expect(run.status).toBe('completed');

    const messages = await client.beta.threads.messages.list(thread.id);
    const answer = messages.data[0].content[0];
    expect(answer.type === 'text' && answer.text.value.replace(/,/g, '')).toContain('1234.56');
  });

  it('remembers earlier turns of the thread', async () => {
    const assistant = await client.beta.assistants.create({
      model: 'cogitator',
      instructions: 'Answer in one short sentence.',
    });
    const thread = await client.beta.threads.create({
      messages: [
        { role: 'user', content: 'My favourite fruit is the mangosteen. Acknowledge it.' },
      ],
    });
    await client.beta.threads.runs.createAndPoll(thread.id, { assistant_id: assistant.id }, POLL);

    await client.beta.threads.messages.create(thread.id, {
      role: 'user',
      content: 'Which fruit is my favourite?',
    });
    const run = await client.beta.threads.runs.createAndPoll(
      thread.id,
      { assistant_id: assistant.id },
      POLL
    );
    expect(run.status).toBe('completed');

    const messages = await client.beta.threads.messages.list(thread.id);
    const answer = messages.data[0].content[0];
    expect(answer.type === 'text' && answer.text.value.toLowerCase()).toContain('mangosteen');
  });
});
