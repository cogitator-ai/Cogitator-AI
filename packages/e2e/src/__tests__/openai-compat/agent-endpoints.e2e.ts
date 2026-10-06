import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import OpenAI from 'openai';
import type { Cogitator } from '@cogitator-ai/core';
import { createOpenAIServer, type OpenAIServer } from '@cogitator-ai/openai-compat';
import {
  createTestAgent,
  createTestCogitator,
  getTestModel,
  isOllamaRunning,
} from '../../helpers/setup';

const describeOllama = process.env.TEST_OLLAMA === 'true' ? describe : describe.skip;

const POLL = { pollIntervalMs: 200 };

const getWeather: OpenAI.ChatCompletionTool = {
  type: 'function',
  function: {
    name: 'get_weather',
    description: 'Get the current weather of a city. Always use it for weather questions.',
    parameters: {
      type: 'object',
      properties: { city: { type: 'string' } },
      required: ['city'],
    },
  },
};

describeOllama('Chat Completions and Responses over a registered agent', () => {
  let cogitator: Cogitator;
  let server: OpenAIServer;
  let client: OpenAI;

  beforeAll(async () => {
    if (!(await isOllamaRunning())) throw new Error('Ollama not running');
    cogitator = createTestCogitator();
    server = createOpenAIServer(cogitator, {
      port: 0,
      host: '127.0.0.1',
      agents: {
        helper: createTestAgent({
          name: 'helper',
          instructions: 'You are a helpful assistant. Keep answers very brief.',
        }),
      },
      defaultModel: `ollama/${getTestModel()}`,
    });
    await server.start();
    client = new OpenAI({ baseURL: server.getBaseUrl(), apiKey: 'unused', maxRetries: 0 });
  });

  afterAll(async () => {
    await server?.stop();
    await cogitator?.close();
  });

  it('lists the agent as a model', async () => {
    const models = await client.models.list();
    expect(models.data.map((model) => model.id)).toContain('helper');
  });

  it('answers a chat completion with usage', async () => {
    const completion = await client.chat.completions.create({
      model: 'helper',
      messages: [{ role: 'user', content: 'What is 2 + 2? Reply with just the number.' }],
    });
    expect(completion.choices[0].message.content).toContain('4');
    expect(completion.choices[0].finish_reason).toBe('stop');
    expect(completion.usage?.total_tokens).toBeGreaterThan(0);
  });

  it('streams a chat completion', async () => {
    const stream = await client.chat.completions.create({
      model: 'helper',
      messages: [{ role: 'user', content: 'Name a primary color. One word.' }],
      stream: true,
      stream_options: { include_usage: true },
    });
    let text = '';
    let usage = 0;
    for await (const chunk of stream) {
      text += chunk.choices[0]?.delta.content ?? '';
      usage = chunk.usage?.total_tokens ?? usage;
    }
    expect(text.trim().length).toBeGreaterThan(0);
    expect(usage).toBeGreaterThan(0);
  });

  it('round-trips a client function call', async () => {
    const messages: OpenAI.ChatCompletionMessageParam[] = [
      { role: 'user', content: 'What is the weather in Paris right now?' },
    ];
    const first = await client.chat.completions.create({
      model: 'helper',
      messages,
      tools: [getWeather],
    });
    const call = first.choices[0].message.tool_calls?.[0];
    expect(first.choices[0].finish_reason).toBe('tool_calls');
    if (call?.type !== 'function') throw new Error('expected a function call');
    expect(call.function.name).toBe('get_weather');

    const second = await client.chat.completions.create({
      model: 'helper',
      tools: [getWeather],
      messages: [
        ...messages,
        first.choices[0].message,
        { role: 'tool', tool_call_id: call.id, content: '{"temperature_c": 31, "sky": "clear"}' },
      ],
    });
    expect(second.choices[0].finish_reason).toBe('stop');
    expect(second.choices[0].message.content).toMatch(/31/);
  });

  it('carries a Responses conversation on with previous_response_id', async () => {
    const first = await client.responses.create({
      model: 'helper',
      input: 'My favourite number is 47. Just say OK.',
    });
    expect(first.status).toBe('completed');

    const stream = client.responses.stream({
      model: 'helper',
      previous_response_id: first.id,
      input: 'What is my favourite number? Reply with just the number.',
    });
    const final = await stream.finalResponse();
    expect(final.output_text).toContain('47');
  });

  it('reports a cut-off answer as incomplete, not completed', async () => {
    const response = await client.responses.create({
      model: 'helper',
      input: 'Write a long story about a lighthouse keeper.',
      max_output_tokens: 16,
    });
    expect(response.status).toBe('incomplete');
    expect(response.incomplete_details?.reason).toBe('max_output_tokens');

    const assistant = await client.beta.assistants.create({ model: 'cogitator' });
    const thread = await client.beta.threads.create({
      messages: [{ role: 'user', content: 'Write a long story about a lighthouse keeper.' }],
    });
    const run = await client.beta.threads.runs.createAndPoll(
      thread.id,
      { assistant_id: assistant.id, max_completion_tokens: 16 },
      POLL
    );
    expect(run.status).toBe('incomplete');
    expect(run.incomplete_details?.reason).toBe('max_completion_tokens');
  });
});
