import { describe, it, expect, vi } from 'vitest';
import type {
  LanguageModelV2CallOptions,
  LanguageModelV2StreamPart,
  LanguageModelV3CallOptions,
  LanguageModelV4CallOptions,
} from '@ai-sdk/provider';
import { tool, type Agent, type Cogitator } from '@cogitator-ai/core';
import type { RunOptions, RunResult } from '@cogitator-ai/types';
import { z } from 'zod';
import { createCogitatorProvider, cogitatorModel } from '../provider';
import type { LanguageModelV1CallOptions } from '../v1-types';
import { collect, createAgent, createFakeCogitator, modelOf } from './helpers';

const searchTool = tool({
  name: 'search',
  description: 'Search the web',
  parameters: z.object({ q: z.string() }),
  execute: async ({ q }) => ({ hits: [q] }),
});

function v2Call(overrides: Partial<LanguageModelV2CallOptions> = {}): LanguageModelV2CallOptions {
  return {
    prompt: [{ role: 'user', content: [{ type: 'text', text: 'Hi' }] }],
    ...overrides,
  };
}

function v1Call(overrides: Partial<LanguageModelV1CallOptions> = {}): LanguageModelV1CallOptions {
  return {
    inputFormat: 'prompt',
    mode: { type: 'regular' },
    prompt: [{ role: 'user', content: [{ type: 'text', text: 'Hi' }] }],
    ...overrides,
  };
}

const V2 = { specificationVersion: 'v2' } as const;

const searchDefinition = { type: 'function' as const, name: 'search', inputSchema: {} };

const searchStep = {
  call: { id: 'call_1', name: 'search', arguments: { q: 'cats' } },
  result: { hits: ['cats'] },
};

describe('createCogitatorProvider', () => {
  it('resolves agents from an array, a Map and a Record', () => {
    const { cogitator } = createFakeCogitator();
    const agent = createAgent('writer');

    for (const agents of [[agent], new Map([['writer', agent]]), { writer: agent }]) {
      const provider = createCogitatorProvider(cogitator, { agents });
      const model = provider('writer');
      expect(model.modelId).toBe('writer');
      expect(model.provider).toBe('cogitator');
      expect(model.specificationVersion).toBe('v4');
    }
  });

  it('exposes languageModel() as the provider itself', () => {
    const { cogitator } = createFakeCogitator();
    const provider = createCogitatorProvider(cogitator, { agents: [createAgent('writer')] });
    expect(provider.languageModel).toBe(provider);
  });

  it('throws for an unknown agent and lists the available ones', () => {
    const { cogitator } = createFakeCogitator();
    const provider = createCogitatorProvider(cogitator, {
      agents: [createAgent('alpha'), createAgent('beta')],
    });
    expect(() => provider('gamma')).toThrow(
      'Agent "gamma" not found. Available agents: alpha, beta'
    );
  });

  it('defaults to the specification of the installed ai package', () => {
    const { cogitator } = createFakeCogitator();
    const agent = createAgent('writer');

    expect(cogitatorModel(cogitator, agent).specificationVersion).toBe('v4');
    expect(cogitatorModel(cogitator, agent, { temperature: 0.2 }).specificationVersion).toBe('v4');
  });

  it('creates models of the configured specification version', () => {
    const { cogitator } = createFakeCogitator();
    const agents = [createAgent('writer')];

    expect(
      createCogitatorProvider(cogitator, { agents, specificationVersion: 'v1' })('writer')
        .specificationVersion
    ).toBe('v1');
    expect(
      createCogitatorProvider(cogitator, { agents, specificationVersion: 'v3' })('writer')
        .specificationVersion
    ).toBe('v3');
    expect(
      createCogitatorProvider(cogitator, { agents, specificationVersion: 'v4' })('writer')
        .specificationVersion
    ).toBe('v4');
  });
});

describe('LanguageModelV2', () => {
  it('doGenerate runs the agent and returns text content with v2 usage', async () => {
    const { cogitator, run } = createFakeCogitator({ output: 'hello world' });
    const agent = createAgent('test');
    const model = cogitatorModel(cogitator, agent, V2);

    const result = await model.doGenerate(v2Call());

    expect(result.content).toEqual([{ type: 'text', text: 'hello world' }]);
    expect(result.finishReason).toBe('stop');
    expect(result.usage).toEqual({ inputTokens: 10, outputTokens: 20, totalTokens: 30 });
    expect(result.warnings).toEqual([]);
    expect(result.response?.id).toBe('run_1');
    expect(result.providerMetadata?.cogitator).toMatchObject({
      runId: 'run_1',
      threadId: 'thread_1',
    });
    expect(run).toHaveBeenCalledWith(
      agent,
      expect.objectContaining({ input: 'Hi', stream: false })
    );
  });

  it('keeps agent tool calls of undeclared tools in provider metadata only', async () => {
    const { cogitator } = createFakeCogitator({ output: 'Found cats', toolSteps: [searchStep] });
    const model = cogitatorModel(cogitator, createAgent('test', [searchTool]), V2);

    const result = await model.doGenerate(v2Call());

    expect(result.content).toEqual([{ type: 'text', text: 'Found cats' }]);
    expect(result.providerMetadata?.cogitator.toolCalls).toEqual([
      {
        id: 'call_1',
        name: 'search',
        arguments: { q: 'cats' },
        result: { hits: ['cats'] },
        isError: false,
      },
    ]);
  });

  it('reports agent tool calls of declared tools as provider-executed calls with results', async () => {
    const { cogitator } = createFakeCogitator({ output: 'Found cats', toolSteps: [searchStep] });
    const model = cogitatorModel(cogitator, createAgent('test', [searchTool]), V2);

    const result = await model.doGenerate(v2Call({ tools: [searchDefinition] }));

    expect(result.finishReason).toBe('stop');
    expect(result.content).toEqual([
      {
        type: 'tool-call',
        toolCallId: 'call_1',
        toolName: 'search',
        input: '{"q":"cats"}',
        providerExecuted: true,
        dynamic: true,
      },
      {
        type: 'tool-result',
        toolCallId: 'call_1',
        toolName: 'search',
        result: { hits: ['cats'] },
        isError: false,
        providerExecuted: true,
        dynamic: true,
      },
      { type: 'text', text: 'Found cats' },
    ]);
  });

  it('marks failed agent tool calls as error results', async () => {
    const { cogitator } = createFakeCogitator({
      toolSteps: [{ call: searchStep.call, error: 'boom' }],
    });
    const model = cogitatorModel(cogitator, createAgent('test', [searchTool]), V2);

    const result = await model.doGenerate(v2Call({ tools: [searchDefinition] }));

    expect(result.content[1]).toMatchObject({ type: 'tool-result', result: 'boom', isError: true });
  });

  it('turns a multi-turn prompt into a labelled transcript and ignores system messages', async () => {
    const { cogitator, run } = createFakeCogitator();
    const model = cogitatorModel(cogitator, createAgent('test'), V2);

    const result = await model.doGenerate(
      v2Call({
        prompt: [
          { role: 'system', content: 'Be brief' },
          { role: 'user', content: [{ type: 'text', text: 'What is 2+2?' }] },
          { role: 'assistant', content: [{ type: 'text', text: '4' }] },
          { role: 'user', content: [{ type: 'text', text: 'And 3+3?' }] },
        ],
      })
    );

    expect(run.mock.calls[0][1].input).toBe('User: What is 2+2?\n\nAssistant: 4\n\nUser: And 3+3?');
    expect(result.warnings).toEqual([
      { type: 'other', message: expect.stringContaining('System messages are not forwarded') },
    ]);
  });

  it('warns about dropped non-text user content', async () => {
    const { cogitator, run } = createFakeCogitator();
    const model = cogitatorModel(cogitator, createAgent('test'), V2);

    const result = await model.doGenerate(
      v2Call({
        prompt: [
          {
            role: 'user',
            content: [
              { type: 'text', text: 'Describe' },
              { type: 'file', data: 'aGVsbG8=', mediaType: 'image/png' },
            ],
          },
        ],
      })
    );

    expect(run.mock.calls[0][1].input).toBe('Describe');
    expect(result.warnings).toEqual([
      { type: 'other', message: expect.stringContaining('dropped file content') },
    ]);
  });

  it('applies call settings over provider options and agent config', async () => {
    const { cogitator, run } = createFakeCogitator();
    const agent = createAgent('test');
    const clone = vi.spyOn(agent, 'clone');
    const model = cogitatorModel(cogitator, agent, {
      ...V2,
      temperature: 0.1,
      maxTokens: 500,
      topP: 0.5,
    });

    await model.doGenerate(v2Call({ temperature: 0.9, stopSequences: ['END'] }));

    expect(clone).toHaveBeenCalledWith({
      temperature: 0.9,
      topP: 0.5,
      maxTokens: 500,
      stopSequences: ['END'],
    });
    expect(run.mock.calls[0][0]).not.toBe(agent);
  });

  it('does not clone the agent without overrides', async () => {
    const { cogitator } = createFakeCogitator();
    const agent = createAgent('test');
    const clone = vi.spyOn(agent, 'clone');

    await cogitatorModel(cogitator, agent, V2).doGenerate(v2Call());

    expect(clone).not.toHaveBeenCalled();
  });

  it('maps a JSON response format to agent JSON mode with schema instructions', async () => {
    const { cogitator, run } = createFakeCogitator();
    const agent = createAgent('test');
    const clone = vi.spyOn(agent, 'clone');

    await cogitatorModel(cogitator, agent, V2).doGenerate(
      v2Call({ responseFormat: { type: 'json', schema: { type: 'object' } } })
    );

    expect(clone).toHaveBeenCalledWith({ responseFormat: { type: 'json' } });
    expect(run.mock.calls[0][1].input).toContain('{"type":"object"}');
  });

  it('warns about unsupported settings and foreign tools', async () => {
    const { cogitator } = createFakeCogitator();
    const model = cogitatorModel(cogitator, createAgent('test', [searchTool]), V2);
    const foreignTool = { type: 'function' as const, name: 'weather', inputSchema: {} };

    const result = await model.doGenerate(
      v2Call({
        topK: 3,
        seed: 1,
        tools: [{ type: 'function', name: 'search', inputSchema: {} }, foreignTool],
      })
    );

    expect(result.warnings).toEqual([
      { type: 'unsupported-setting', setting: 'topK', details: undefined },
      { type: 'unsupported-setting', setting: 'seed', details: undefined },
      { type: 'other', message: expect.stringContaining('Unsupported tool "weather"') },
    ]);
  });

  it('forwards the abort signal to the run', async () => {
    const { cogitator, run } = createFakeCogitator();
    const controller = new AbortController();

    await cogitatorModel(cogitator, createAgent('test'), V2).doGenerate(
      v2Call({ abortSignal: controller.signal })
    );

    expect(run.mock.calls[0][1].signal).toBe(controller.signal);
  });

  it('doStream emits v2 stream parts in order', async () => {
    const { cogitator } = createFakeCogitator({
      tokens: ['Hel', 'lo'],
      toolSteps: [searchStep],
    });
    const model = cogitatorModel(cogitator, createAgent('test', [searchTool]), V2);

    const { stream } = await model.doStream(v2Call({ tools: [searchDefinition] }));
    const parts: LanguageModelV2StreamPart[] = await collect(stream);

    expect(parts.map((part) => part.type)).toEqual([
      'stream-start',
      'response-metadata',
      'tool-input-start',
      'tool-input-delta',
      'tool-input-end',
      'tool-call',
      'tool-result',
      'text-start',
      'text-delta',
      'text-delta',
      'text-end',
      'finish',
    ]);
    expect(parts.filter((part) => part.type === 'text-delta')).toEqual([
      { type: 'text-delta', id: 'text-0', delta: 'Hel' },
      { type: 'text-delta', id: 'text-0', delta: 'lo' },
    ]);
    expect(parts.at(-1)).toEqual({
      type: 'finish',
      finishReason: 'stop',
      usage: { inputTokens: 10, outputTokens: 20, totalTokens: 30 },
      providerMetadata: { cogitator: expect.objectContaining({ runId: 'run_1' }) },
    });
  });

  it('doStream emits an error part when the run fails', async () => {
    const { cogitator } = createFakeCogitator({ error: new Error('LLM timeout') });
    const model = cogitatorModel(cogitator, createAgent('test'), V2);

    const { stream } = await model.doStream(v2Call());
    const parts = await collect(stream);

    expect(parts.at(-1)).toEqual({ type: 'error', error: new Error('LLM timeout') });
  });

  it('aborts the run when the stream is cancelled', async () => {
    let runSignal: AbortSignal | undefined;
    const pendingCogitator = {
      run: (_agent: Agent, options: RunOptions) =>
        new Promise<RunResult>((_resolve, reject) => {
          runSignal = options.signal;
          options.signal?.addEventListener('abort', () => reject(new Error('aborted')));
        }),
      resolveModel: modelOf,
    } as unknown as Cogitator;

    const { stream } = await cogitatorModel(pendingCogitator, createAgent('test'), V2).doStream(
      v2Call()
    );
    await stream.cancel();

    expect(runSignal?.aborted).toBe(true);
  });
});

describe('LanguageModelV3 and LanguageModelV4', () => {
  it('v3 returns structured finish reason, usage and warnings', async () => {
    const { cogitator } = createFakeCogitator({ output: 'ok' });
    const model = cogitatorModel(cogitator, createAgent('test'), { specificationVersion: 'v3' });
    const options: LanguageModelV3CallOptions = {
      prompt: [{ role: 'user', content: [{ type: 'text', text: 'Hi' }] }],
      topK: 2,
    };

    const result = await model.doGenerate(options);

    expect(model.specificationVersion).toBe('v3');
    expect(result.finishReason).toEqual({ unified: 'stop', raw: 'stop' });
    expect(result.usage).toEqual({
      inputTokens: { total: 10, noCache: undefined, cacheRead: undefined, cacheWrite: undefined },
      outputTokens: { total: 20, text: undefined, reasoning: undefined },
    });
    expect(result.warnings).toEqual([{ type: 'unsupported', feature: 'topK', details: undefined }]);
  });

  it('v4 warns about an explicit reasoning effort and streams', async () => {
    const { cogitator } = createFakeCogitator({ tokens: ['a', 'b'] });
    const model = cogitatorModel(cogitator, createAgent('test'), { specificationVersion: 'v4' });
    const options: LanguageModelV4CallOptions = {
      prompt: [{ role: 'user', content: [{ type: 'text', text: 'Hi' }] }],
      reasoning: 'high',
    };

    const { stream } = await model.doStream(options);
    const parts = await collect(stream);

    expect(model.specificationVersion).toBe('v4');
    expect(parts[0]).toEqual({
      type: 'stream-start',
      warnings: [{ type: 'unsupported', feature: 'reasoning', details: undefined }],
    });
    expect(parts.at(-1)).toMatchObject({
      type: 'finish',
      finishReason: { unified: 'stop', raw: 'stop' },
    });
  });
});

describe('LanguageModelV1 (ai@4)', () => {
  it('doGenerate returns text, v1 usage and tool calls in provider metadata', async () => {
    const { cogitator } = createFakeCogitator({ output: 'Found cats', toolSteps: [searchStep] });
    const model = cogitatorModel(cogitator, createAgent('test', [searchTool]), {
      specificationVersion: 'v1',
    });

    const result = await model.doGenerate(v1Call());

    expect(model.specificationVersion).toBe('v1');
    expect(model.defaultObjectGenerationMode).toBe('json');
    expect(result.text).toBe('Found cats');
    expect(result.toolCalls).toBeUndefined();
    expect(result.finishReason).toBe('stop');
    expect(result.usage).toEqual({ promptTokens: 10, completionTokens: 20 });
    expect(result.providerMetadata?.cogitator.toolCalls).toEqual([
      {
        id: 'call_1',
        name: 'search',
        arguments: { q: 'cats' },
        result: { hits: ['cats'] },
        isError: false,
      },
    ]);
  });

  it('honours maxTokens and warns about unsupported v1 settings', async () => {
    const { cogitator } = createFakeCogitator();
    const agent = createAgent('test');
    const clone = vi.spyOn(agent, 'clone');
    const model = cogitatorModel(cogitator, agent, { specificationVersion: 'v1' });

    const result = await model.doGenerate(v1Call({ maxTokens: 64, presencePenalty: 1 }));

    expect(clone).toHaveBeenCalledWith({ maxTokens: 64 });
    expect(result.warnings).toEqual([
      { type: 'unsupported-setting', setting: 'presencePenalty', details: undefined },
    ]);
  });

  it('object-tool mode returns the JSON output as a tool call', async () => {
    const { cogitator, run } = createFakeCogitator({ output: '{"name":"Ada"}' });
    const model = cogitatorModel(cogitator, createAgent('test'), { specificationVersion: 'v1' });

    const result = await model.doGenerate(
      v1Call({
        mode: {
          type: 'object-tool',
          tool: { type: 'function', name: 'json', parameters: { type: 'object' } },
        },
      })
    );

    expect(result.text).toBeUndefined();
    expect(result.toolCalls).toEqual([
      { toolCallType: 'function', toolCallId: 'run_1', toolName: 'json', args: '{"name":"Ada"}' },
    ]);
    expect(run.mock.calls[0][1].input).toContain('JSON schema');
  });

  it('doStream emits text deltas and a finish part', async () => {
    const { cogitator } = createFakeCogitator({ tokens: ['Hel', 'lo'] });
    const model = cogitatorModel(cogitator, createAgent('test'), { specificationVersion: 'v1' });

    const { stream } = await model.doStream(v1Call());
    const parts = await collect(stream);

    expect(parts.map((part) => part.type)).toEqual([
      'response-metadata',
      'text-delta',
      'text-delta',
      'finish',
    ]);
    expect(parts.at(-1)).toMatchObject({
      type: 'finish',
      finishReason: 'stop',
      usage: { promptTokens: 10, completionTokens: 20 },
    });
  });

  it('doStream emits an error part when the run fails', async () => {
    const { cogitator } = createFakeCogitator({ error: new Error('LLM timeout') });
    const model = cogitatorModel(cogitator, createAgent('test'), { specificationVersion: 'v1' });

    const { stream } = await model.doStream(v1Call());
    const parts = await collect(stream);

    expect(parts).toEqual([
      expect.objectContaining({ type: 'response-metadata' }),
      { type: 'error', error: new Error('LLM timeout') },
    ]);
  });
});
