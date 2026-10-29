/**
 * 01 — Unit-test an agent with MockLLMBackend (no API keys, no Ollama)
 *
 * Shows how to script LLM responses, run an agent against a mock backend,
 * assert on tool calls and final output, and inspect requests via getCalls().
 *
 * Run:
 *   npx tsx examples/testing/01-mock-llm-agent.ts
 */

import assert from 'node:assert/strict';

import { header, section } from '../_shared/setup.js';
import { MockLLMBackend, createToolCall } from '@cogitator-ai/test-utils';
import { Agent, Cogitator, tool } from '@cogitator-ai/core';
import { z } from 'zod';

const getWeather = tool({
  name: 'get_weather',
  description: 'Get the current weather for a city',
  parameters: z.object({
    city: z.string().describe('City name'),
  }),
  execute: async ({ city }) => {
    return { city, temperatureC: 22, condition: 'sunny' };
  },
});

const WEATHER_TOOL_RESULT = JSON.stringify({
  city: 'Tokyo',
  temperatureC: 22,
  condition: 'sunny',
});

async function main() {
  header('01 — MockLLMBackend agent unit test (no API keys)');

  const backend = new MockLLMBackend();
  const tokyoWeatherCall = createToolCall('get_weather', { city: 'Tokyo' });
  backend.setToolCallResponse([tokyoWeatherCall]);
  backend.setResponses([
    { toolCalls: [tokyoWeatherCall], finishReason: 'tool_calls' },
    { content: 'The weather in Tokyo is sunny and 22°C.' },
  ]);

  const cog = new Cogitator({
    llm: {
      backends: { mock: backend },
      retry: false,
      pricing: { 'mock/test-model': { input: 0, output: 0 } },
    },
  });

  const agent = new Agent({
    name: 'weather-tester',
    model: 'mock/test-model',
    instructions: 'Use get_weather when asked about weather. Be concise.',
    tools: [getWeather],
  });

  section('1. Run agent (scripted tool call + final answer)');
  const result = await cog.run(agent, { input: 'What is the weather in Tokyo?' });

  console.log('Output:', result.output);
  console.log(
    'Tool calls:',
    result.toolCalls.map((t) => t.name)
  );

  assert.equal(result.toolCalls.length, 1);
  assert.equal(result.toolCalls[0]?.name, 'get_weather');
  assert.deepEqual(result.toolCalls[0]?.arguments, { city: 'Tokyo' });
  assert.equal(result.output, 'The weather in Tokyo is sunny and 22°C.');

  section('2. Inspect what was sent to the model');
  console.log('getCallCount():', backend.getCallCount());
  console.log('getLastCall() message count:', backend.getLastCall()?.messages.length);
  console.log(
    'getCalls() models:',
    backend.getCalls().map((c) => c.model)
  );
  console.log(
    'wasCalledWith test-model:',
    backend.wasCalledWith((req) => req.model === 'test-model')
  );

  assert.ok(backend.getCallCount() >= 2);

  const firstRequest = backend.getCalls()[0];
  assert.ok(firstRequest?.tools?.some((t) => t.name === 'get_weather'));

  const lastMessage = backend.getLastCall()?.messages.at(-1);
  assert.deepEqual(lastMessage, {
    role: 'tool',
    content: WEATHER_TOOL_RESULT,
    toolCallId: tokyoWeatherCall.id,
    name: 'get_weather',
  });

  assert.ok(backend.wasCalledWith((req) => req.model === 'test-model'));

  await cog.close();
  console.log('\nDone. Example ran green with no API keys and no Ollama.');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
