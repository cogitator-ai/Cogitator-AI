import { afterEach, beforeEach, describe, it, expect, vi } from 'vitest';
import { z } from 'zod';
import { tool } from '@cogitator-ai/core';
import type { ToolContext } from '@cogitator-ai/types';
import * as ai4 from 'ai-v4';
import { MockLanguageModelV1 } from 'ai-v4/test';
import * as ai5 from 'ai-v5';
import { MockLanguageModelV2 } from 'ai-v5/test';
import * as ai6 from 'ai-v6';
import { MockLanguageModelV3 } from 'ai-v6/test';
import * as ai7 from 'ai';
import { MockLanguageModelV4 } from 'ai/test';
import { cogitatorModel, convertToolsToAISDK, fromAISDK } from '../index';
import type { CogitatorSpecificationVersion } from '../types';
import { collectAsync, createAgent, createFakeCogitator, type FakeRunScript } from './helpers';

const detection = vi.hoisted(() => ({ version: 'v2' as CogitatorSpecificationVersion }));

vi.mock('../ai-version', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../ai-version')>()),
  defaultSpecificationVersion: () => detection.version,
}));

const searchTool = tool({
  name: 'search',
  description: 'Search the web',
  parameters: z.object({ q: z.string() }),
  execute: async ({ q }) => ({ hits: [q] }),
});

const agentToolScript: FakeRunScript = {
  tokens: ['Found', ' cats'],
  toolSteps: [
    {
      call: { id: 'call_1', name: 'search', arguments: { q: 'cats' } },
      result: { hits: ['cats'] },
    },
  ],
};

function cogitatorTool() {
  const execute = vi.fn(async (params: { input: string; count: number }, _ctx: ToolContext) => ({
    echoed: params.input.repeat(params.count),
  }));
  const cogTool = tool({
    name: 'echo',
    description: 'Echo the input',
    parameters: z.object({ input: z.string(), count: z.number().default(2) }),
    execute,
  });
  return { cogTool, execute };
}

const loggedWarnings: unknown[] = [];

beforeEach(() => {
  loggedWarnings.length = 0;
  Object.assign(globalThis, {
    AI_SDK_LOG_WARNINGS: (options: { warnings: unknown[] }) => {
      loggedWarnings.push(...options.warnings);
    },
  });
});

afterEach(() => {
  Object.assign(globalThis, { AI_SDK_LOG_WARNINGS: undefined });
});

function compatibilityWarnings() {
  return loggedWarnings.filter(
    (warning) => (warning as { feature?: string }).feature === 'specificationVersion'
  );
}

describe('ai@4 (LanguageModelV1)', () => {
  it('uses the detected v1 spec when no specificationVersion is given', async () => {
    detection.version = 'v1';
    const { cogitator } = createFakeCogitator({ output: 'Hello world' });
    const model = cogitatorModel(cogitator, createAgent());

    const result = await ai4.generateText({
      model: model as unknown as ai4.LanguageModelV1,
      prompt: 'Hi',
    });

    expect(model.specificationVersion).toBe('v1');
    expect(result.text).toBe('Hello world');
  });

  it('generateText runs the agent', async () => {
    const { cogitator } = createFakeCogitator({ output: 'Hello world' });
    const model = cogitatorModel(cogitator, createAgent(), { specificationVersion: 'v1' });

    const result = await ai4.generateText({ model, prompt: 'Hi' });

    expect(result.text).toBe('Hello world');
    expect(result.finishReason).toBe('stop');
    expect(result.usage).toEqual({ promptTokens: 10, completionTokens: 20, totalTokens: 30 });
    expect(result.response.id).toBe('run_1');
  });

  it('generateText keeps agent tool calls out of the ai@4 tool loop', async () => {
    const { cogitator } = createFakeCogitator({ ...agentToolScript, output: 'Found cats' });
    const model = cogitatorModel(cogitator, createAgent('a', [searchTool]), {
      specificationVersion: 'v1',
    });

    const result = await ai4.generateText({ model, prompt: 'Find cats', maxSteps: 3 });

    expect(result.text).toBe('Found cats');
    expect(result.toolCalls).toEqual([]);
    expect(result.steps).toHaveLength(1);
    expect(result.providerMetadata?.cogitator.toolCalls).toEqual([
      expect.objectContaining({ name: 'search', result: { hits: ['cats'] } }),
    ]);
  });

  it('streamText streams agent tokens', async () => {
    const { cogitator } = createFakeCogitator({ tokens: ['Hel', 'lo'] });
    const model = cogitatorModel(cogitator, createAgent(), { specificationVersion: 'v1' });

    const result = ai4.streamText({ model, prompt: 'Hi' });

    expect((await collectAsync(result.textStream)).join('')).toBe('Hello');
    expect(await result.finishReason).toBe('stop');
  });

  it('generateObject parses the agent JSON output', async () => {
    const { cogitator, run } = createFakeCogitator({ output: '{"name":"Ada"}' });
    const model = cogitatorModel(cogitator, createAgent(), { specificationVersion: 'v1' });

    const result = await ai4.generateObject({
      model,
      schema: ai4.jsonSchema<{ name: string }>({
        type: 'object',
        properties: { name: { type: 'string' } },
        required: ['name'],
      }),
      prompt: 'Who wrote the first program?',
    });

    expect(result.object).toEqual({ name: 'Ada' });
    expect(run.mock.calls[0][0].config.responseFormat).toEqual({ type: 'json' });
  });

  it('executes Cogitator tools converted with toAISDKTool', async () => {
    const { cogTool, execute } = cogitatorTool();
    let step = 0;
    const calls: ai4.LanguageModelV1CallOptions[] = [];
    const model = new MockLanguageModelV1({
      doGenerate: async (options) =>
        calls.push(options) && step++ === 0
          ? {
              rawCall: { rawPrompt: null, rawSettings: {} },
              finishReason: 'tool-calls',
              usage: { promptTokens: 1, completionTokens: 1 },
              toolCalls: [
                {
                  toolCallType: 'function',
                  toolCallId: 'tc1',
                  toolName: 'echo',
                  args: '{"input":"ab"}',
                },
              ],
            }
          : {
              rawCall: { rawPrompt: null, rawSettings: {} },
              finishReason: 'stop',
              usage: { promptTokens: 1, completionTokens: 1 },
              text: 'done',
            },
    });

    const result = await ai4.generateText({
      model,
      tools: convertToolsToAISDK([cogTool]),
      maxSteps: 2,
      prompt: 'echo ab',
    });

    expect(result.text).toBe('done');
    expect(execute).toHaveBeenCalledWith(
      { input: 'ab', count: 2 },
      expect.objectContaining({ runId: 'tc1' })
    );
    expect(result.steps[0].toolResults[0].result).toEqual({ echoed: 'abab' });
    const toolDefinition = calls[0].mode;
    expect(toolDefinition).toMatchObject({
      type: 'regular',
      tools: [{ name: 'echo', parameters: { properties: { input: { type: 'string' } } } }],
    });
  });

  it('fromAISDK wraps a MockLanguageModelV1', async () => {
    const backend = fromAISDK(
      new MockLanguageModelV1({
        doGenerate: async () => ({
          rawCall: { rawPrompt: null, rawSettings: {} },
          finishReason: 'stop',
          usage: { promptTokens: 2, completionTokens: 3 },
          text: 'from v1',
        }),
        doStream: async () => ({
          rawCall: { rawPrompt: null, rawSettings: {} },
          stream: ai4.simulateReadableStream({
            chunks: [
              { type: 'text-delta' as const, textDelta: 'from ' },
              { type: 'text-delta' as const, textDelta: 'v1' },
              {
                type: 'finish' as const,
                finishReason: 'stop' as const,
                usage: { promptTokens: 2, completionTokens: 3 },
              },
            ],
          }),
        }),
      })
    );

    const response = await backend.chat({
      model: 'x',
      messages: [{ role: 'user', content: 'hi' }],
    });
    const chunks = await collectAsync(
      backend.chatStream({ model: 'x', messages: [{ role: 'user', content: 'hi' }] })
    );

    expect(response).toMatchObject({ content: 'from v1', finishReason: 'stop' });
    expect(chunks.map((chunk) => chunk.delta.content ?? '').join('')).toBe('from v1');
  });
});

describe('ai@5 (LanguageModelV2)', () => {
  it('uses the detected v2 spec when no specificationVersion is given', async () => {
    detection.version = 'v2';
    const { cogitator } = createFakeCogitator({ output: 'Hello world' });
    const model = cogitatorModel(cogitator, createAgent());

    const result = await ai5.generateText({
      model: model as unknown as ai5.LanguageModel,
      prompt: 'Hi',
    });

    expect(model.specificationVersion).toBe('v2');
    expect(result.text).toBe('Hello world');
  });

  it('generateText runs the agent without compatibility warnings', async () => {
    const { cogitator } = createFakeCogitator({ output: 'Hello world' });

    const result = await ai5.generateText({
      model: cogitatorModel(cogitator, createAgent(), { specificationVersion: 'v2' }),
      prompt: 'Hi',
    });

    expect(result.text).toBe('Hello world');
    expect(result.finishReason).toBe('stop');
    expect(result.usage).toMatchObject({ inputTokens: 10, outputTokens: 20, totalTokens: 30 });
    expect(result.response.id).toBe('run_1');
    expect(result.providerMetadata?.cogitator).toMatchObject({ runId: 'run_1' });
    expect(loggedWarnings).toEqual([]);
  });

  it('generateText keeps undeclared agent tool calls in provider metadata', async () => {
    const { cogitator } = createFakeCogitator({ ...agentToolScript, output: 'Found cats' });

    const result = await ai5.generateText({
      model: cogitatorModel(cogitator, createAgent('a', [searchTool]), {
        specificationVersion: 'v2',
      }),
      prompt: 'Find cats',
    });

    expect(result.text).toBe('Found cats');
    expect(result.toolCalls).toEqual([]);
    expect(result.providerMetadata?.cogitator.toolCalls).toEqual([
      expect.objectContaining({ name: 'search', result: { hits: ['cats'] } }),
    ]);
  });

  it('generateText exposes declared agent tool calls as provider-executed results', async () => {
    const { cogitator } = createFakeCogitator({ ...agentToolScript, output: 'Found cats' });

    const result = await ai5.generateText({
      model: cogitatorModel(cogitator, createAgent('a', [searchTool]), {
        specificationVersion: 'v2',
      }),
      tools: convertToolsToAISDK([searchTool]),
      prompt: 'Find cats',
      stopWhen: ai5.stepCountIs(3),
    });

    expect(result.text).toBe('Found cats');
    expect(result.steps).toHaveLength(1);
    expect(result.toolCalls).toEqual([
      expect.objectContaining({ toolName: 'search', input: { q: 'cats' }, providerExecuted: true }),
    ]);
    expect(result.toolResults).toEqual([
      expect.objectContaining({ toolName: 'search', output: { hits: ['cats'] } }),
    ]);
  });

  it('streamText streams tokens and tool parts', async () => {
    const { cogitator } = createFakeCogitator(agentToolScript);

    const result = ai5.streamText({
      model: cogitatorModel(cogitator, createAgent('a', [searchTool]), {
        specificationVersion: 'v2',
      }),
      tools: convertToolsToAISDK([searchTool]),
      prompt: 'Find cats',
    });
    const types = (await collectAsync(result.fullStream)).map((part) => part.type);

    expect(await result.text).toBe('Found cats');
    expect(types).toEqual(expect.arrayContaining(['tool-call', 'tool-result', 'text-delta']));
    expect(await result.finishReason).toBe('stop');
  });

  it('generateObject parses the agent JSON output', async () => {
    const { cogitator } = createFakeCogitator({ output: '{"name":"Ada"}' });

    const result = await ai5.generateObject({
      model: cogitatorModel(cogitator, createAgent(), { specificationVersion: 'v2' }),
      schema: z.object({ name: z.string() }),
      prompt: 'Who wrote the first program?',
    });

    expect(result.object).toEqual({ name: 'Ada' });
  });

  it('executes Cogitator tools converted with toAISDKTool', async () => {
    const { cogTool, execute } = cogitatorTool();
    let step = 0;
    const model = new MockLanguageModelV2({
      doGenerate: async () =>
        step++ === 0
          ? {
              content: [
                { type: 'tool-call', toolCallId: 'tc1', toolName: 'echo', input: '{"input":"ab"}' },
              ],
              finishReason: 'tool-calls',
              usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
              warnings: [],
            }
          : {
              content: [{ type: 'text', text: 'done' }],
              finishReason: 'stop',
              usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
              warnings: [],
            },
    });

    const result = await ai5.generateText({
      model,
      tools: convertToolsToAISDK([cogTool]),
      stopWhen: ai5.stepCountIs(2),
      prompt: 'echo ab',
      experimental_context: { userId: 'u1' },
    });

    expect(result.text).toBe('done');
    expect(execute).toHaveBeenCalledWith(
      { input: 'ab', count: 2 },
      expect.objectContaining({ runId: 'tc1', userId: 'u1' })
    );
    expect(result.steps[0].toolResults[0].output).toEqual({ echoed: 'abab' });
    expect(model.doGenerateCalls[0].tools).toEqual([
      expect.objectContaining({
        name: 'echo',
        inputSchema: expect.objectContaining({ required: ['input'] }),
      }),
    ]);
  });

  it('fromAISDK wraps a MockLanguageModelV2', async () => {
    const backend = fromAISDK(
      new MockLanguageModelV2({
        doGenerate: async () => ({
          content: [{ type: 'text', text: 'from v2' }],
          finishReason: 'stop',
          usage: { inputTokens: 2, outputTokens: 3, totalTokens: 5 },
          warnings: [],
        }),
      })
    );

    const response = await backend.chat({
      model: 'x',
      messages: [{ role: 'user', content: 'hi' }],
    });

    expect(response).toMatchObject({
      content: 'from v2',
      finishReason: 'stop',
      usage: { inputTokens: 2, outputTokens: 3, totalTokens: 5 },
    });
  });
});

describe('ai@6 (LanguageModelV2 compatibility, LanguageModelV3 native)', () => {
  it('uses the detected v3 spec when no specificationVersion is given', async () => {
    detection.version = 'v3';
    const { cogitator } = createFakeCogitator({ output: 'Hello world' });
    const model = cogitatorModel(cogitator, createAgent());

    const result = await ai6.generateText({
      model: model as unknown as ai6.LanguageModel,
      prompt: 'Hi',
    });

    expect(model.specificationVersion).toBe('v3');
    expect(result.text).toBe('Hello world');
    expect(compatibilityWarnings()).toEqual([]);
  });

  it('generateText accepts the default v2 model in compatibility mode', async () => {
    const { cogitator } = createFakeCogitator({ ...agentToolScript, output: 'Found cats' });

    const result = await ai6.generateText({
      model: cogitatorModel(cogitator, createAgent('a', [searchTool]), {
        specificationVersion: 'v2',
      }),
      tools: convertToolsToAISDK([searchTool]),
      prompt: 'Find cats',
    });

    expect(result.text).toBe('Found cats');
    expect(result.finishReason).toBe('stop');
    expect(result.usage).toMatchObject({ inputTokens: 10, outputTokens: 20, totalTokens: 30 });
    expect(result.toolResults).toEqual([
      expect.objectContaining({ toolName: 'search', output: { hits: ['cats'] } }),
    ]);
    expect(compatibilityWarnings()).toHaveLength(1);
  });

  it('generateText with a v3 model logs no compatibility warning', async () => {
    const { cogitator } = createFakeCogitator({ ...agentToolScript, output: 'Found cats' });

    const result = await ai6.generateText({
      model: cogitatorModel(cogitator, createAgent('a', [searchTool]), {
        specificationVersion: 'v3',
      }),
      prompt: 'Find cats',
    });

    expect(result.text).toBe('Found cats');
    expect(result.toolCalls).toEqual([
      expect.objectContaining({ toolName: 'search', providerExecuted: true, dynamic: true }),
    ]);
    expect(loggedWarnings).toEqual([]);
  });

  it('streamText streams tokens from both v2 and v3 models', async () => {
    for (const specificationVersion of ['v2', 'v3'] as const) {
      const { cogitator } = createFakeCogitator(agentToolScript);
      const result = ai6.streamText({
        model: cogitatorModel(cogitator, createAgent('a', [searchTool]), { specificationVersion }),
        tools: convertToolsToAISDK([searchTool]),
        prompt: 'Find cats',
      });

      expect(await result.text).toBe('Found cats');
      expect(await result.toolResults).toEqual([
        expect.objectContaining({ toolName: 'search', output: { hits: ['cats'] } }),
      ]);
    }
  });

  it('generateText with Output.object parses the agent JSON output', async () => {
    const { cogitator } = createFakeCogitator({ output: '{"name":"Ada"}' });

    const result = await ai6.generateText({
      model: cogitatorModel(cogitator, createAgent(), { specificationVersion: 'v3' }),
      output: ai6.Output.object({ schema: z.object({ name: z.string() }) }),
      prompt: 'Who wrote the first program?',
    });

    expect(result.output).toEqual({ name: 'Ada' });
  });

  it('executes Cogitator tools converted with toAISDKTool', async () => {
    const { cogTool, execute } = cogitatorTool();
    const usage = {
      inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 },
      outputTokens: { total: 1, text: 1, reasoning: 0 },
    };
    let step = 0;
    const model = new MockLanguageModelV3({
      doGenerate: async () =>
        step++ === 0
          ? {
              content: [
                { type: 'tool-call', toolCallId: 'tc1', toolName: 'echo', input: '{"input":"ab"}' },
              ],
              finishReason: { unified: 'tool-calls', raw: undefined },
              usage,
              warnings: [],
            }
          : {
              content: [{ type: 'text', text: 'done' }],
              finishReason: { unified: 'stop', raw: undefined },
              usage,
              warnings: [],
            },
    });

    const result = await ai6.generateText({
      model,
      tools: convertToolsToAISDK([cogTool]),
      stopWhen: ai6.stepCountIs(2),
      prompt: 'echo ab',
      experimental_context: { threadId: 't1' },
    });

    expect(result.text).toBe('done');
    expect(execute).toHaveBeenCalledWith(
      { input: 'ab', count: 2 },
      expect.objectContaining({ runId: 'tc1', threadId: 't1' })
    );
    expect(result.steps[0].toolResults[0].output).toEqual({ echoed: 'abab' });
  });

  it('fromAISDK wraps a MockLanguageModelV3', async () => {
    const backend = fromAISDK(
      new MockLanguageModelV3({
        doGenerate: async () => ({
          content: [{ type: 'text', text: 'from v3' }],
          finishReason: { unified: 'stop', raw: 'STOP' },
          usage: {
            inputTokens: { total: 2, noCache: 2, cacheRead: undefined, cacheWrite: undefined },
            outputTokens: { total: 3, text: 3, reasoning: undefined },
          },
          warnings: [],
        }),
      })
    );

    const response = await backend.chat({
      model: 'x',
      messages: [{ role: 'user', content: 'hi' }],
    });

    expect(response).toMatchObject({
      content: 'from v3',
      finishReason: 'stop',
      usage: { inputTokens: 2, outputTokens: 3, totalTokens: 5 },
    });
  });
});

describe('ai@7 (LanguageModelV2 compatibility, LanguageModelV3/V4 native)', () => {
  it('uses the detected v4 spec when no specificationVersion is given', async () => {
    detection.version = 'v4';
    const { cogitator } = createFakeCogitator({ output: 'Hello world' });
    const model = cogitatorModel(cogitator, createAgent());

    const result = await ai7.generateText({
      model: model as unknown as ai7.LanguageModel,
      prompt: 'Hi',
    });

    expect(model.specificationVersion).toBe('v4');
    expect(result.text).toBe('Hello world');
    expect(compatibilityWarnings()).toEqual([]);
  });

  it('generateText accepts v2, v3 and v4 models', async () => {
    for (const specificationVersion of ['v2', 'v3', 'v4'] as const) {
      loggedWarnings.length = 0;
      const { cogitator } = createFakeCogitator({ ...agentToolScript, output: 'Found cats' });

      const result = await ai7.generateText({
        model: cogitatorModel(cogitator, createAgent('a', [searchTool]), { specificationVersion }),
        tools: specificationVersion === 'v2' ? convertToolsToAISDK([searchTool]) : undefined,
        prompt: 'Find cats',
      });

      expect(result.text).toBe('Found cats');
      expect(result.finishReason).toBe('stop');
      expect(result.usage).toMatchObject({ inputTokens: 10, outputTokens: 20, totalTokens: 30 });
      expect(result.toolResults).toEqual([
        expect.objectContaining({ toolName: 'search', output: { hits: ['cats'] } }),
      ]);
      expect(compatibilityWarnings()).toHaveLength(specificationVersion === 'v2' ? 1 : 0);
    }
  });

  it('streamText streams tokens and tool parts', async () => {
    const { cogitator } = createFakeCogitator(agentToolScript);

    const result = ai7.streamText({
      model: cogitatorModel(cogitator, createAgent('a', [searchTool]), {
        specificationVersion: 'v4',
      }),
      prompt: 'Find cats',
    });
    const types = (await collectAsync(result.fullStream)).map((part) => part.type);

    expect(await result.text).toBe('Found cats');
    expect(types).toEqual(expect.arrayContaining(['tool-call', 'tool-result', 'text-delta']));
    expect(await result.finishReason).toBe('stop');
  });

  it('streamText works with the default v2 model', async () => {
    const { cogitator } = createFakeCogitator({ tokens: ['Hel', 'lo'] });

    const result = ai7.streamText({
      model: cogitatorModel(cogitator, createAgent(), { specificationVersion: 'v2' }),
      prompt: 'Hi',
    });

    expect((await collectAsync(result.textStream)).join('')).toBe('Hello');
  });

  it('generateText with Output.object parses the agent JSON output', async () => {
    const { cogitator } = createFakeCogitator({ output: '{"name":"Ada"}' });

    const result = await ai7.generateText({
      model: cogitatorModel(cogitator, createAgent(), { specificationVersion: 'v4' }),
      output: ai7.Output.object({ schema: z.object({ name: z.string() }) }),
      prompt: 'Who wrote the first program?',
    });

    expect(result.output).toEqual({ name: 'Ada' });
  });

  it('executes Cogitator tools converted with toAISDKTool', async () => {
    const { cogTool, execute } = cogitatorTool();
    const usage = {
      inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 },
      outputTokens: { total: 1, text: 1, reasoning: 0 },
    };
    let step = 0;
    const model = new MockLanguageModelV4({
      doGenerate: async () =>
        step++ === 0
          ? {
              content: [
                { type: 'tool-call', toolCallId: 'tc1', toolName: 'echo', input: '{"input":"ab"}' },
              ],
              finishReason: { unified: 'tool-calls', raw: undefined },
              usage,
              warnings: [],
            }
          : {
              content: [{ type: 'text', text: 'done' }],
              finishReason: { unified: 'stop', raw: undefined },
              usage,
              warnings: [],
            },
    });

    const result = await ai7.generateText({
      model,
      tools: convertToolsToAISDK([cogTool]),
      stopWhen: ai7.stepCountIs(2),
      prompt: 'echo ab',
    });

    expect(result.text).toBe('done');
    expect(execute).toHaveBeenCalledWith(
      { input: 'ab', count: 2 },
      expect.objectContaining({ runId: 'tc1' })
    );
    expect(result.steps[0].toolResults[0].output).toEqual({ echoed: 'abab' });
  });

  it('fromAISDK wraps a MockLanguageModelV4', async () => {
    const backend = fromAISDK(
      new MockLanguageModelV4({
        doGenerate: async () => ({
          content: [{ type: 'text', text: 'from v4' }],
          finishReason: { unified: 'stop', raw: 'STOP' },
          usage: {
            inputTokens: { total: 2, noCache: 2, cacheRead: undefined, cacheWrite: undefined },
            outputTokens: { total: 3, text: 3, reasoning: undefined },
          },
          warnings: [],
        }),
      })
    );

    const response = await backend.chat({
      model: 'x',
      messages: [{ role: 'user', content: 'hi' }],
    });

    expect(response).toMatchObject({
      content: 'from v4',
      finishReason: 'stop',
      usage: { inputTokens: 2, outputTokens: 3, totalTokens: 5 },
    });
  });
});
