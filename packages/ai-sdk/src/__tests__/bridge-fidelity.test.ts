import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { z } from 'zod';
import { Agent, Cogitator, tool, toolContent } from '@cogitator-ai/core';
import type {
  LanguageModelV2,
  LanguageModelV2CallOptions,
  LanguageModelV3,
  LanguageModelV3CallOptions,
  LanguageModelV4,
  LanguageModelV4CallOptions,
  LanguageModelV4StreamPart,
} from '@ai-sdk/provider';
import type {
  ChatRequest,
  ChatResponse,
  ChatStreamChunk,
  LLMBackend,
  Message,
  ToolCall,
  ToolContext,
} from '@cogitator-ai/types';
import * as ai7 from 'ai';
import { MockLanguageModelV4 } from 'ai/test';
import { cogitatorModel, fromAISDK, fromAISDKTool, toAISDKTool } from '../index';
import { AISDKBackend } from '../model-wrapper';
import type { LanguageModelV1, LanguageModelV1CallOptions } from '../v1-types';
import { collect } from './helpers';

const PNG =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';

const lookupCall: ToolCall = { id: 'call_1', name: 'lookup', arguments: { q: 'orders' } };

/** A backend that calls `lookup` once, after a preamble, then answers with `final`. */
function scriptedBackend(final: string, overrides: Partial<ChatResponse> = {}) {
  const requests: ChatRequest[] = [];
  const answer = (request: ChatRequest): ChatResponse => {
    requests.push(request);
    const answered = request.messages.some((m) => m.role === 'tool');
    return answered || !request.tools?.length
      ? {
          id: 'r2',
          content: final,
          finishReason: 'stop',
          usage: { inputTokens: 2, outputTokens: 2, totalTokens: 4 },
          ...overrides,
        }
      : {
          id: 'r1',
          content: 'Checking. ',
          toolCalls: [lookupCall],
          finishReason: 'tool_calls',
          usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
        };
  };
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
  return { backend, requests };
}

const lookup = tool({
  name: 'lookup',
  description: 'Look something up',
  parameters: z.object({ q: z.string() }),
  execute: async () => ({ count: 3 }),
});

const agent = new Agent({
  name: 'clerk',
  model: 'mock/m',
  instructions: 'Answer.',
  tools: [lookup],
});

let cogitator: Cogitator;
afterEach(async () => {
  await cogitator?.close();
});

function modelWith(final: string, overrides: Partial<ChatResponse> = {}, agentOverride = agent) {
  const scripted = scriptedBackend(final, overrides);
  cogitator = new Cogitator({ llm: { backends: { mock: scripted.backend } } });
  return {
    model: cogitatorModel(cogitator, agentOverride, { specificationVersion: 'v4' }),
    requests: scripted.requests,
  };
}

const prompt = [{ role: 'user' as const, content: [{ type: 'text' as const, text: 'How many?' }] }];

function streamedText(parts: { type: string; delta?: string }[]): string {
  return parts
    .filter((part) => part.type === 'text-delta')
    .map((part) => part.delta)
    .join('');
}

function generatedText(content: readonly { type: string; text?: string }[]): string {
  return content
    .filter((part) => part.type === 'text')
    .map((part) => part.text)
    .join('');
}

describe('doGenerate and doStream agree', () => {
  it('carry the text the agent wrote before a tool call, in order', async () => {
    const { model } = modelWith('There are 3.');
    const generated = await model.doGenerate({ prompt });
    const { stream } = await modelWith('There are 3.').model.doStream({ prompt });
    const streamed = await collect(stream);

    expect(generated.content.map((part) => part.type)).toEqual([
      'text',
      'tool-call',
      'tool-result',
      'text',
    ]);
    expect(generatedText(generated.content)).toBe('Checking. There are 3.');
    expect(streamedText(streamed)).toBe(generatedText(generated.content));
  });

  it('answer only with the final JSON in JSON mode', async () => {
    const responseFormat = { type: 'json' as const };
    const generated = await modelWith('{"count":3}').model.doGenerate({ prompt, responseFormat });
    const { stream } = await modelWith('{"count":3}').model.doStream({ prompt, responseFormat });

    expect(generatedText(generated.content)).toBe('{"count":3}');
    expect(streamedText(await collect(stream))).toBe('{"count":3}');
  });

  it('let ai@7 parse structured output from a stream', async () => {
    const { model } = modelWith('{"count":3}');
    const result = ai7.streamText({
      model,
      prompt: 'How many?',
      output: ai7.Output.object({ schema: z.object({ count: z.number() }) }),
    });

    expect(await result.output).toEqual({ count: 3 });
  });
});

describe('finish reasons', () => {
  it('report an answer cut at the token limit as length', async () => {
    const { model } = modelWith('There are', { finishReason: 'length' });
    const result = await model.doGenerate({ prompt });
    expect(result.finishReason).toEqual({ unified: 'length', raw: 'length' });
    expect(result.providerMetadata.cogitator.truncated).toBe(true);
  });

  it('report a filtered or refused answer as content-filter', async () => {
    const filtered = await modelWith('', { finishReason: 'content_filter' }).model.doGenerate({
      prompt,
    });
    const refused = await modelWith('I cannot help.', { finishReason: 'refusal' }).model.doGenerate(
      { prompt }
    );

    expect(filtered.finishReason).toEqual({ unified: 'content-filter', raw: 'content_filter' });
    expect(refused.finishReason).toEqual({ unified: 'content-filter', raw: 'refusal' });
  });

  it('report a run that used up its iterations as other', async () => {
    const limited = agent.clone({ maxIterations: 1, onIterationLimit: 'stop' });
    const { model } = modelWith('unused', {}, limited);
    const { stream } = await model.doStream({ prompt });
    const finish = (await collect(stream)).find((part) => part.type === 'finish');

    expect(finish).toMatchObject({ finishReason: { unified: 'other', raw: 'iteration-limit' } });
  });

  it('give v2 models the same reasons in their form', async () => {
    const scripted = scriptedBackend('There are', { finishReason: 'length' });
    cogitator = new Cogitator({ llm: { backends: { mock: scripted.backend } } });
    const model = cogitatorModel(cogitator, agent, { specificationVersion: 'v2' });

    expect((await model.doGenerate({ prompt })).finishReason).toBe('length');
  });
});

describe('toolChoice', () => {
  it('runs the agent without tools for toolChoice none', async () => {
    const { model, requests } = modelWith('Just text.');
    const result = await model.doGenerate({ prompt, toolChoice: { type: 'none' } });

    expect(requests.every((request) => !request.tools?.length)).toBe(true);
    expect(generatedText(result.content)).toBe('Just text.');
    expect(result.warnings).toEqual([]);
  });

  it('warns that a forced tool choice is not supported', async () => {
    const { model } = modelWith('There are 3.');
    const result = await model.doGenerate({
      prompt,
      toolChoice: { type: 'tool', toolName: 'lookup' },
    });

    expect(result.warnings).toContainEqual(
      expect.objectContaining({ type: 'unsupported', feature: 'toolChoice' })
    );
  });
});

describe('conversation history', () => {
  it('passes tool calls and results of earlier turns to the agent', async () => {
    const { model, requests } = modelWith('It found 3 orders.');
    await model.doGenerate({
      prompt: [
        { role: 'user', content: [{ type: 'text', text: 'Find my orders' }] },
        {
          role: 'assistant',
          content: [
            {
              type: 'tool-call',
              toolCallId: 'old_1',
              toolName: 'search',
              input: { q: 'orders' },
              providerExecuted: true,
            },
            {
              type: 'tool-result',
              toolCallId: 'old_1',
              toolName: 'search',
              output: { type: 'json', value: { ids: ['A-1', 'A-2', 'A-3'] } },
            },
            { type: 'text', text: 'Found it.' },
          ],
        },
        {
          role: 'tool',
          content: [
            {
              type: 'tool-result',
              toolCallId: 'old_2',
              toolName: 'count',
              output: { type: 'error-text', value: 'quota exceeded' },
            },
          ],
        },
        { role: 'user', content: [{ type: 'text', text: 'What exactly did the search return?' }] },
      ],
    });

    const input = requests[0].messages.filter((m) => m.role === 'user').at(-1)?.content;
    expect(input).toContain('[called tool search with {"q":"orders"}]');
    expect(input).toContain('[tool search returned: {"ids":["A-1","A-2","A-3"]}]');
    expect(input).toContain('Found it.');
    expect(input).toContain('Tool: [tool count failed: quota exceeded]');
    expect(input).toContain('User: What exactly did the search return?');
  });
});

function v4Recorder(content: Awaited<ReturnType<LanguageModelV4['doGenerate']>>['content']) {
  const calls: LanguageModelV4CallOptions[] = [];
  const model: LanguageModelV4 = {
    specificationVersion: 'v4',
    provider: 'anthropic.messages',
    modelId: 'claude',
    supportedUrls: {},
    doGenerate: async (options) => {
      calls.push(options);
      return {
        content,
        finishReason: { unified: 'tool-calls', raw: 'tool_use' },
        usage: {
          inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 },
          outputTokens: { total: 1, text: 1, reasoning: 0 },
        },
        warnings: [],
      };
    },
    doStream: async (options) => {
      calls.push(options);
      const parts: LanguageModelV4StreamPart[] = [
        { type: 'reasoning-start', id: 'r1' },
        { type: 'reasoning-delta', id: 'r1', delta: 'Need the ' },
        { type: 'reasoning-delta', id: 'r1', delta: 'weather.' },
        {
          type: 'reasoning-delta',
          id: 'r1',
          delta: '',
          providerMetadata: { anthropic: { signature: 'sig-stream' } },
        },
        { type: 'reasoning-end', id: 'r1' },
        { type: 'tool-call', toolCallId: 'tc1', toolName: 'weather', input: '{"city":"Oslo"}' },
        {
          type: 'finish',
          finishReason: { unified: 'tool-calls', raw: 'tool_use' },
          usage: {
            inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 },
            outputTokens: { total: 1, text: 1, reasoning: 0 },
          },
        },
      ];
      return {
        stream: new ReadableStream<LanguageModelV4StreamPart>({
          start(controller) {
            for (const part of parts) controller.enqueue(part);
            controller.close();
          },
        }),
      };
    },
  };
  return { model, calls };
}

function followUp(call: ToolCall, toolMessage: Partial<Message> = {}): ChatRequest {
  return {
    model: 'claude',
    messages: [
      { role: 'user', content: 'Weather in Oslo?' },
      { role: 'assistant', content: '', toolCalls: [call] } as Message,
      {
        role: 'tool',
        content: '{"temp":4}',
        toolCallId: call.id,
        name: call.name,
        ...toolMessage,
      } as Message,
    ],
  };
}

describe('fromAISDK replays reasoning with tool calls', () => {
  it('sends generated reasoning and the call metadata back before the call', async () => {
    const { model, calls } = v4Recorder([
      {
        type: 'reasoning',
        text: 'Need the weather.',
        providerMetadata: { anthropic: { signature: 'sig-1' } },
      },
      {
        type: 'tool-call',
        toolCallId: 'tc1',
        toolName: 'weather',
        input: '{"city":"Oslo"}',
        providerMetadata: { anthropic: { caller: 'direct' } },
      },
    ]);
    const backend = new AISDKBackend(model);

    const first = await backend.chat({
      model: 'claude',
      messages: [{ role: 'user', content: 'Hi' }],
    });
    await backend.chat(followUp(first.toolCalls![0]));

    const assistant = calls[1].prompt.find((message) => message.role === 'assistant');
    expect(assistant?.content).toEqual([
      {
        type: 'reasoning',
        text: 'Need the weather.',
        providerOptions: { anthropic: { signature: 'sig-1' } },
      },
      {
        type: 'tool-call',
        toolCallId: 'tc1',
        toolName: 'weather',
        input: { city: 'Oslo' },
        providerOptions: { anthropic: { caller: 'direct' } },
      },
    ]);
  });

  it('keeps the signature of streamed reasoning', async () => {
    const { model, calls } = v4Recorder([]);
    const backend = new AISDKBackend(model);

    const chunks: ChatStreamChunk[] = [];
    for await (const chunk of backend.chatStream({
      model: 'claude',
      messages: [{ role: 'user', content: 'Hi' }],
    })) {
      chunks.push(chunk);
    }
    const call = chunks.flatMap((chunk) => chunk.delta.toolCalls ?? [])[0] as ToolCall;
    await backend.chat(followUp(call));

    const assistant = calls[1].prompt.find((message) => message.role === 'assistant');
    expect(assistant?.content[0]).toEqual({
      type: 'reasoning',
      text: 'Need the weather.',
      providerOptions: { anthropic: { signature: 'sig-stream' } },
    });
  });
});

describe('fromAISDK sends tool images and errors as such', () => {
  const imageMessage: Partial<Message> = {
    content: [
      { type: 'text', text: '{"page":"home","image":"(image attached)"}' },
      { type: 'image_base64', image_base64: { data: PNG, media_type: 'image/png' } },
    ],
  };
  const call: ToolCall = { id: 'tc1', name: 'screenshot', arguments: {} };

  it('v4: a content output with the image as a file part', async () => {
    const { model, calls } = v4Recorder([{ type: 'text', text: 'ok' }]);
    await new AISDKBackend(model).chat(followUp(call, imageMessage));

    const toolMessage = calls[0].prompt.find((message) => message.role === 'tool');
    expect(toolMessage?.content[0]).toMatchObject({
      type: 'tool-result',
      output: {
        type: 'content',
        value: [
          { type: 'text', text: '{"page":"home","image":"(image attached)"}' },
          { type: 'file', data: { type: 'data', data: PNG }, mediaType: 'image/png' },
        ],
      },
    });
  });

  it('v3 and v2: image-data and media parts', async () => {
    const v3Calls: LanguageModelV3CallOptions[] = [];
    const v2Calls: LanguageModelV2CallOptions[] = [];
    const finish = { content: [], warnings: [] };
    const v3: LanguageModelV3 = {
      specificationVersion: 'v3',
      provider: 'p',
      modelId: 'm',
      supportedUrls: {},
      doGenerate: async (options) => {
        v3Calls.push(options);
        return {
          ...finish,
          finishReason: { unified: 'stop', raw: 'stop' },
          usage: {
            inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 },
            outputTokens: { total: 1, text: 1, reasoning: 0 },
          },
        };
      },
      doStream: async () => {
        throw new Error('unused');
      },
    };
    const v2: LanguageModelV2 = {
      specificationVersion: 'v2',
      provider: 'p',
      modelId: 'm',
      supportedUrls: {},
      doGenerate: async (options) => {
        v2Calls.push(options);
        return {
          ...finish,
          finishReason: 'stop',
          usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
        };
      },
      doStream: async () => {
        throw new Error('unused');
      },
    };

    await new AISDKBackend(v3).chat(followUp(call, imageMessage));
    await new AISDKBackend(v2).chat(followUp(call, imageMessage));

    const v3Tool = v3Calls[0].prompt.find((message) => message.role === 'tool');
    const v2Tool = v2Calls[0].prompt.find((message) => message.role === 'tool');
    expect(v3Tool?.content[0]).toMatchObject({
      output: {
        type: 'content',
        value: [{ type: 'text' }, { type: 'image-data', data: PNG, mediaType: 'image/png' }],
      },
    });
    expect(v2Tool?.content[0]).toMatchObject({
      output: {
        type: 'content',
        value: [{ type: 'text' }, { type: 'media', data: PNG, mediaType: 'image/png' }],
      },
    });
  });

  it('v1: the image in the content of the tool result', async () => {
    const v1Calls: LanguageModelV1CallOptions[] = [];
    const v1: LanguageModelV1 = {
      specificationVersion: 'v1',
      provider: 'p',
      modelId: 'm',
      defaultObjectGenerationMode: 'json',
      doGenerate: async (options) => {
        v1Calls.push(options);
        return {
          text: 'ok',
          finishReason: 'stop',
          usage: { promptTokens: 1, completionTokens: 1 },
          rawCall: { rawPrompt: '', rawSettings: {} },
        };
      },
      doStream: async () => {
        throw new Error('unused');
      },
    };

    await new AISDKBackend(v1).chat(followUp(call, imageMessage));

    const toolMessage = v1Calls[0].prompt.find((message) => message.role === 'tool');
    expect(toolMessage?.content[0]).toMatchObject({
      content: [{ type: 'text' }, { type: 'image', data: PNG, mimeType: 'image/png' }],
    });
  });

  it('sends a failed call as error-text', async () => {
    const { model, calls } = v4Recorder([{ type: 'text', text: 'ok' }]);
    await new AISDKBackend(model).chat(
      followUp(call, { content: JSON.stringify({ error: 'Tool not found: screenshot' }) })
    );

    const toolMessage = calls[0].prompt.find((message) => message.role === 'tool');
    expect(toolMessage?.content[0]).toMatchObject({
      output: { type: 'error-text', value: 'Tool not found: screenshot' },
    });
  });

  it('carries a screenshot of a Cogitator run through fromAISDK as an image', async () => {
    const recorder = v4Recorder([]);
    let turn = 0;
    const model = new MockLanguageModelV4({
      doGenerate: async (options) => {
        recorder.calls.push(options);
        turn++;
        return {
          content:
            turn === 1
              ? [{ type: 'tool-call', toolCallId: 'tc1', toolName: 'screenshot', input: '{}' }]
              : [{ type: 'text', text: 'I see a page.' }],
          finishReason: { unified: turn === 1 ? 'tool-calls' : 'stop', raw: 'x' },
          usage: {
            inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 },
            outputTokens: { total: 1, text: 1, reasoning: 0 },
          },
          warnings: [],
        };
      },
    });
    cogitator = new Cogitator({ llm: { backends: { mock: fromAISDK(model) } } });
    const screenshot = tool({
      name: 'screenshot',
      description: 'Screenshot',
      parameters: z.object({}),
      execute: async () => toolContent({ type: 'image', data: PNG, mediaType: 'image/png' }),
    });

    await cogitator.run(
      new Agent({ name: 'eye', model: 'mock/m', instructions: 'Look.', tools: [screenshot] }),
      {
        input: 'What is on the page?',
      }
    );

    const toolMessage = recorder.calls[1].prompt.find((message) => message.role === 'tool');
    expect(toolMessage?.content[0]).toMatchObject({
      output: { type: 'content', value: [{ type: 'file', mediaType: 'image/png' }] },
    });
  });
});

describe('AI SDK tool conversion', () => {
  it('gives an AI SDK tool the id of the call it runs for', async () => {
    const execute = vi.fn(async () => 'done');
    const converted = fromAISDKTool(
      ai7.tool({ description: 'Run', inputSchema: z.object({}), execute }),
      'run'
    );
    const signal = new AbortController().signal;

    await converted.execute({}, { agentId: 'a', runId: 'run_1', toolCallId: 'call_7', signal });
    await converted.execute({}, { agentId: 'a', runId: 'run_1', signal });

    const ids = execute.mock.calls.map((call) => (call as unknown[])[1] as { toolCallId: string });
    expect(ids[0].toolCallId).toBe('call_7');
    expect(ids[1].toolCallId).not.toBe('run_1');
  });

  it('passes the AI SDK call id on to a Cogitator tool', async () => {
    const execute = vi.fn(async (_input: unknown, _context: ToolContext) => 'done');
    const converted = toAISDKTool(
      tool({ name: 'run', description: 'Run', parameters: z.object({}), execute })
    );

    await converted.execute({}, { toolCallId: 'call_9', messages: [] });

    expect(execute.mock.calls[0][1]).toMatchObject({ toolCallId: 'call_9' });
  });

  it('keeps $defs of an AI SDK JSON schema', () => {
    const converted = fromAISDKTool(
      ai7.tool({
        description: 'Save a tree',
        inputSchema: ai7.jsonSchema<{ root: unknown }>({
          type: 'object',
          properties: { root: { $ref: '#/$defs/Node' } },
          required: ['root'],
          $defs: {
            Node: {
              type: 'object',
              properties: { children: { type: 'array', items: { $ref: '#/$defs/Node' } } },
            },
          },
        }),
        execute: async () => 'saved',
      }),
      'save_tree'
    );

    const { parameters } = converted.toJSON();
    expect(parameters.properties.root).toEqual({ $ref: '#/$defs/Node' });
    expect(parameters.$defs?.Node).toBeDefined();
  });

  it('shows ai@7 a media result of a Cogitator tool as an image', async () => {
    const screenshot = toAISDKTool(
      tool({
        name: 'screenshot',
        description: 'Screenshot',
        parameters: z.object({}),
        execute: async () =>
          toolContent(
            { type: 'text', text: 'Home page' },
            { type: 'image', data: PNG, mediaType: 'image/png' }
          ),
      })
    );
    let turn = 0;
    const model = new MockLanguageModelV4({
      doGenerate: async () => {
        turn++;
        return {
          content:
            turn === 1
              ? [{ type: 'tool-call', toolCallId: 't1', toolName: 'screenshot', input: '{}' }]
              : [{ type: 'text', text: 'A home page.' }],
          finishReason: { unified: turn === 1 ? 'tool-calls' : 'stop', raw: 'x' },
          usage: {
            inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 },
            outputTokens: { total: 1, text: 1, reasoning: 0 },
          },
          warnings: [],
        };
      },
    });

    await ai7.generateText({
      model,
      prompt: 'Look',
      tools: { screenshot },
      stopWhen: ai7.stepCountIs(2),
    });

    const toolMessage = model.doGenerateCalls[1].prompt.find((message) => message.role === 'tool');
    expect(toolMessage?.content[0]).toMatchObject({
      type: 'tool-result',
      output: {
        type: 'content',
        value: [
          { type: 'text', text: 'Home page' },
          { type: 'file', mediaType: 'image/png' },
        ],
      },
    });
  });
});

beforeEach(() => {
  vi.clearAllMocks();
});
