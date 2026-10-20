import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { ChatRequest, ChatStreamChunk } from '@cogitator-ai/types';
import { OpenAIBackend } from '../llm/openai';
import { buildResponsesParams } from '../llm/openai-responses';
import {
  OPENAI_COMPATIBLE_PROFILES,
  reasoningEffortFor,
  resolveOpenAICompatibleProfile,
} from '../llm/openai-profiles';

const mockCreate = vi.fn();
const clientOptions = vi.fn();

vi.mock('openai', () => {
  class MockOpenAI {
    chat = { completions: { create: mockCreate } };
    baseURL = 'https://server.example.com/v1';
    constructor(options: unknown) {
      clientOptions(options);
    }
  }
  return { default: MockOpenAI };
});

const completion = {
  id: 'c1',
  choices: [{ index: 0, message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }],
  usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
};

async function* chunks(): AsyncGenerator<unknown> {
  yield { id: 'c1', choices: [{ index: 0, delta: { content: 'ok' }, finish_reason: 'stop' }] };
}

const request = (extra: Partial<ChatRequest> = {}): ChatRequest => ({
  model: 'some-model',
  messages: [{ role: 'user', content: 'Hi' }],
  maxTokens: 100,
  ...extra,
});

async function sentStream(backend: OpenAIBackend, extra?: Partial<ChatRequest>) {
  mockCreate.mockResolvedValueOnce(chunks());
  const seen: ChatStreamChunk[] = [];
  for await (const chunk of backend.chatStream(request(extra))) seen.push(chunk);
  return mockCreate.mock.calls.at(-1)?.[0] as Record<string, unknown>;
}

async function sentChat(backend: OpenAIBackend, extra?: Partial<ChatRequest>) {
  mockCreate.mockResolvedValueOnce(completion);
  await backend.chat(request(extra));
  return mockCreate.mock.calls.at(-1)?.[0] as Record<string, unknown>;
}

const server = (
  provider: string,
  profile?: ConstructorParameters<typeof OpenAIBackend>[0]['profile']
) =>
  new OpenAIBackend({
    apiKey: 'k',
    baseUrl: 'https://server.example.com/v1',
    provider,
    ...(profile && { profile }),
  });

describe('OpenAI-compatible server profiles', () => {
  beforeEach(() => {
    mockCreate.mockReset();
    clientOptions.mockReset();
  });

  it('asks a generic server for stream usage and sends max_tokens and the effort as they are', async () => {
    const backend = server('openai');

    const params = await sentStream(backend, { reasoning: { effort: 'max' } });

    expect(params).toMatchObject({
      max_tokens: 100,
      stream_options: { include_usage: true },
      reasoning_effort: 'max',
    });
    expect(params).not.toHaveProperty('max_completion_tokens');
  });

  it('sends Mistral no stream_options and only efforts it takes, since it rejects unknown fields', async () => {
    const backend = server('mistral');

    const params = await sentStream(backend, { reasoning: { effort: 'xhigh' } });

    expect(params).not.toHaveProperty('stream_options');
    expect(params).toMatchObject({ max_tokens: 100, reasoning_effort: 'high' });
  });

  it('sends DeepSeek the nearest effort it takes', async () => {
    const backend = server('deepseek');

    expect(await sentChat(backend, { reasoning: { effort: 'medium' } })).toMatchObject({
      reasoning_effort: 'high',
    });
    expect(await sentChat(backend, { reasoning: { effort: 'minimal' } })).toMatchObject({
      reasoning_effort: 'low',
    });
  });

  it('sends Groq max_completion_tokens', async () => {
    expect(await sentChat(server('groq'))).toMatchObject({ max_completion_tokens: 100 });
  });

  it('lets a profile name pick the preset of the server behind a custom base URL', async () => {
    const params = await sentStream(server('openai', 'together'));

    expect(params).not.toHaveProperty('stream_options');
  });

  it('lets profile fields override the preset one by one', async () => {
    const backend = server('vllm', {
      maxTokensField: 'max_completion_tokens',
      reasoningEffort: false,
    });

    const params = await sentStream(backend, { reasoning: { effort: 'high' } });

    expect(params).toMatchObject({
      max_completion_tokens: 100,
      stream_options: { include_usage: true },
    });
    expect(params).not.toHaveProperty('reasoning_effort');
  });

  it('passes headers to the SDK', () => {
    new OpenAIBackend({ apiKey: 'k', headers: { 'X-Title': 'My app' } });
    expect(clientOptions.mock.calls[0][0]).toMatchObject({
      defaultHeaders: { 'X-Title': 'My app' },
    });
  });
});

describe('reasoningEffortFor', () => {
  const only = (...efforts: ('none' | 'low' | 'medium' | 'high' | 'max')[]) =>
    resolveOpenAICompatibleProfile('generic', { reasoningEffort: efforts });

  it('takes the higher of two efforts as near', () => {
    expect(reasoningEffortFor(only('low', 'high'), 'medium')).toBe('high');
  });

  it('takes the nearest effort below when there is none above', () => {
    expect(reasoningEffortFor(only('low', 'medium'), 'max')).toBe('medium');
  });

  it('sends nothing without an effort or when the server takes none', () => {
    expect(reasoningEffortFor(OPENAI_COMPATIBLE_PROFILES.generic, undefined)).toBeUndefined();
    expect(
      reasoningEffortFor(
        resolveOpenAICompatibleProfile('generic', { reasoningEffort: false }),
        'low'
      )
    ).toBeUndefined();
  });

  it('sends the official OpenAI API every effort as it is', () => {
    expect(reasoningEffortFor(OPENAI_COMPATIBLE_PROFILES.openai, 'none')).toBe('none');
    expect(reasoningEffortFor(OPENAI_COMPATIBLE_PROFILES.openai, 'max')).toBe('max');
  });
});

describe('the Responses API and server profiles', () => {
  it('sends the reasoning effort the profile allows, nothing when it allows none', () => {
    const request = {
      model: 'gpt-5',
      messages: [{ role: 'user' as const, content: 'Hi' }],
      reasoning: { effort: 'max' as const },
    };

    expect(buildResponsesParams(request, 'gpt-5').reasoning).toEqual({ effort: 'max' });
    expect(
      buildResponsesParams(
        request,
        'gpt-5',
        resolveOpenAICompatibleProfile('openai', { reasoningEffort: false })
      ).reasoning
    ).toEqual({});
    expect(
      buildResponsesParams(
        request,
        'gpt-5',
        resolveOpenAICompatibleProfile('openai', { reasoningEffort: ['low', 'high'] })
      ).reasoning
    ).toEqual({ effort: 'high' });
  });
});
