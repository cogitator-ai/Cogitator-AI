import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { ChatStreamChunk, Message, ToolCall } from '@cogitator-ai/types';
import { ErrorCode } from '@cogitator-ai/types';
import { OpenAIBackend } from '../llm/openai';
import { DEFAULT_OPENAI_MODEL, isOpenAIReasoningModel } from '../llm/openai-responses';
import { LLMError } from '../llm/errors';

const mockResponsesCreate = vi.fn();
const mockChatCreate = vi.fn();

class MockAPIError extends Error {
  status: number;
  constructor(message: string, status: number) {
    super(message);
    this.status = status;
    this.name = 'APIError';
  }
}

vi.mock('openai', () => {
  class MockOpenAI {
    responses = { create: mockResponsesCreate };
    chat = { completions: { create: mockChatCreate } };
    baseURL = 'https://api.openai.com/v1';
  }
  return { default: MockOpenAI };
});

const usage = {
  input_tokens: 1200,
  input_tokens_details: { cached_tokens: 1024 },
  output_tokens: 300,
  output_tokens_details: { reasoning_tokens: 256 },
  total_tokens: 1500,
};

function response(overrides: Record<string, unknown> = {}) {
  return {
    id: 'resp_67ccd2bed1ec8190b14f964abc054267',
    object: 'response',
    created_at: 1741476542,
    status: 'completed',
    error: null,
    incomplete_details: null,
    model: 'gpt-6.1-sol',
    output: [],
    parallel_tool_calls: true,
    store: false,
    usage,
    ...overrides,
  };
}

const reasoningItem = {
  id: 'rs_6876cf02e0bc8192b74af0fb64b715ff',
  type: 'reasoning',
  summary: [{ type: 'summary_text', text: 'Need the weather first.' }],
  encrypted_content: 'gAAAAABodmJ4-encrypted-blob',
  status: 'completed',
};

const weatherCall = {
  id: 'fc_6876cf05ba5c8192a0f6d7e4b3a2c1d0',
  type: 'function_call',
  status: 'completed',
  call_id: 'call_ZSdKQt2a5xG7BzzAqLrUFm1e',
  name: 'get_weather',
  arguments: '{"city":"Paris"}',
};

const textMessage = (text: string, id = 'msg_67ccd2bf17f0819081ff3bb2cf6508e6') => ({
  id,
  type: 'message',
  role: 'assistant',
  status: 'completed',
  content: [{ type: 'output_text', text, annotations: [] }],
});

async function* streamOf(events: Record<string, unknown>[]) {
  let sequence = 0;
  for (const event of events) {
    yield { sequence_number: sequence++, ...event };
  }
}

async function collect(stream: AsyncGenerator<ChatStreamChunk>): Promise<ChatStreamChunk[]> {
  const chunks: ChatStreamChunk[] = [];
  for await (const chunk of stream) chunks.push(chunk);
  return chunks;
}

const weatherTool = {
  name: 'get_weather',
  description: 'Get the weather for a city',
  parameters: {
    type: 'object' as const,
    properties: { city: { type: 'string' } },
    required: ['city'],
  },
};

function lastParams(): Record<string, unknown> {
  return mockResponsesCreate.mock.calls.at(-1)![0] as Record<string, unknown>;
}

describe('OpenAIBackend (Responses API)', () => {
  let backend: OpenAIBackend;

  beforeEach(() => {
    mockResponsesCreate.mockReset();
    mockChatCreate.mockReset();
    backend = new OpenAIBackend({ apiKey: 'sk-test' });
  });

  describe('wire API selection', () => {
    it('uses the Responses API for the official endpoint', () => {
      expect(backend.api).toBe('responses');
      expect(new OpenAIBackend({ apiKey: 'k', baseUrl: 'https://api.openai.com/v1' }).api).toBe(
        'responses'
      );
    });

    it('keeps OpenAI-compatible servers on Chat Completions', () => {
      expect(new OpenAIBackend({ apiKey: 'k', baseUrl: 'https://openrouter.ai/api/v1' }).api).toBe(
        'chat-completions'
      );
      for (const provider of ['groq', 'deepseek', 'mistral', 'together', 'vllm'] as const) {
        expect(
          new OpenAIBackend({ apiKey: 'k', baseUrl: 'https://api.openai.com/v1', provider }).api
        ).toBe('chat-completions');
      }
    });

    it('honours an explicit api override', () => {
      expect(new OpenAIBackend({ apiKey: 'k', api: 'chat-completions' }).api).toBe(
        'chat-completions'
      );
      expect(
        new OpenAIBackend({ apiKey: 'k', baseUrl: 'https://gateway.example/v1', api: 'responses' })
          .api
      ).toBe('responses');
    });

    it('routes OpenAI-compatible providers through chat.completions', async () => {
      const groq = new OpenAIBackend({
        apiKey: 'k',
        baseUrl: 'https://api.groq.com/openai/v1',
        provider: 'groq',
      });
      mockChatCreate.mockResolvedValueOnce({
        id: 'chatcmpl-1',
        choices: [{ message: { role: 'assistant', content: 'hi' }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
      });

      await groq.chat({ model: 'llama-3.3-70b', messages: [{ role: 'user', content: 'hi' }] });

      expect(mockChatCreate).toHaveBeenCalledTimes(1);
      expect(mockResponsesCreate).not.toHaveBeenCalled();
    });

    it('falls back to Chat Completions when stop sequences are requested', async () => {
      mockChatCreate.mockResolvedValueOnce({
        id: 'chatcmpl-1',
        choices: [{ message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
      });

      await backend.chat({
        model: 'gpt-4.1',
        messages: [{ role: 'user', content: 'Count' }],
        stop: ['END'],
      });

      expect(mockResponsesCreate).not.toHaveBeenCalled();
      expect(mockChatCreate.mock.calls[0][0]).toMatchObject({ stop: ['END'] });
    });
  });

  describe('request mapping', () => {
    it('sends system prompts as instructions and stays stateless', async () => {
      mockResponsesCreate.mockResolvedValueOnce(response({ output: [textMessage('Hello!')] }));

      await backend.chat({
        model: 'gpt-6.1-sol',
        messages: [
          { role: 'system', content: 'You are helpful.' },
          { role: 'user', content: 'Hello' },
        ],
      });

      expect(mockResponsesCreate).toHaveBeenCalledWith({
        model: 'gpt-6.1-sol',
        instructions: 'You are helpful.',
        input: [{ type: 'message', role: 'user', content: 'Hello' }],
        tools: undefined,
        tool_choice: undefined,
        max_output_tokens: undefined,
        text: undefined,
        store: false,
        include: ['reasoning.encrypted_content'],
        stream: false,
      });
    });

    it('asks reasoning models for the effort and a reasoning summary', async () => {
      mockResponsesCreate.mockResolvedValue(response({ output: [textMessage('ok')] }));

      await backend.chat({
        model: 'gpt-6.1-sol',
        messages: [{ role: 'user', content: 'Hi' }],
        reasoning: { effort: 'xhigh', summary: true },
      });
      expect(lastParams()).toMatchObject({ reasoning: { effort: 'xhigh', summary: 'auto' } });

      await backend.chat({
        model: 'gpt-4.1',
        messages: [{ role: 'user', content: 'Hi' }],
        reasoning: { effort: 'high' },
      });
      expect(lastParams()).not.toHaveProperty('reasoning');
    });

    it('keeps later system messages in place', async () => {
      mockResponsesCreate.mockResolvedValueOnce(response({ output: [textMessage('ok')] }));

      await backend.chat({
        model: 'gpt-6.1-sol',
        messages: [
          { role: 'system', content: 'Base.' },
          { role: 'user', content: 'a' },
          { role: 'system', content: 'Summary of earlier turns.' },
          { role: 'user', content: 'b' },
        ],
      });

      expect(lastParams().input).toEqual([
        { type: 'message', role: 'user', content: 'a' },
        { type: 'message', role: 'system', content: 'Summary of earlier turns.' },
        { type: 'message', role: 'user', content: 'b' },
      ]);
    });

    it('falls back to the GPT-6 default model when none is given', async () => {
      mockResponsesCreate.mockResolvedValueOnce(response({ output: [textMessage('ok')] }));

      await backend.chat({ model: '', messages: [{ role: 'user', content: 'Hi' }] });

      expect(DEFAULT_OPENAI_MODEL).toBe('gpt-6.1-sol');
      expect(lastParams().model).toBe('gpt-6.1-sol');
    });

    it('never sends sampling parameters to reasoning models', async () => {
      mockResponsesCreate.mockResolvedValueOnce(response({ output: [textMessage('ok')] }));

      await backend.chat({
        model: 'gpt-6.1-sol',
        messages: [{ role: 'user', content: 'Hi' }],
        temperature: 0.7,
        topP: 0.9,
        maxTokens: 2048,
      });

      const params = lastParams();
      expect(params).not.toHaveProperty('temperature');
      expect(params).not.toHaveProperty('top_p');
      expect(params.max_output_tokens).toBe(2048);
      expect(params.include).toEqual(['reasoning.encrypted_content']);
    });

    it('still sends sampling parameters to non-reasoning models', async () => {
      mockResponsesCreate.mockResolvedValueOnce(response({ output: [textMessage('ok')] }));

      await backend.chat({
        model: 'gpt-4o',
        messages: [{ role: 'user', content: 'Hi' }],
        temperature: 0.2,
        topP: 0.5,
      });

      const params = lastParams();
      expect(params.temperature).toBe(0.2);
      expect(params.top_p).toBe(0.5);
      expect(params).not.toHaveProperty('include');
      expect(params.store).toBe(false);
    });

    it('classifies reasoning models', () => {
      for (const id of ['gpt-6.1-sol', 'gpt-6-astra', 'gpt-6-luna', 'gpt-5.6-terra', 'gpt-5']) {
        expect(isOpenAIReasoningModel(id)).toBe(true);
      }
      for (const id of ['o1', 'o3-mini', 'o4-mini', 'ft:gpt-6-luna:org::abc']) {
        expect(isOpenAIReasoningModel(id)).toBe(true);
      }
      for (const id of ['gpt-4o', 'gpt-4o-mini', 'gpt-4.1', 'gpt-4.1-nano', 'gpt-5-chat-latest']) {
        expect(isOpenAIReasoningModel(id)).toBe(false);
      }
    });

    it('maps function tools without strict mode and tool choice', async () => {
      mockResponsesCreate.mockResolvedValue(response({ output: [textMessage('ok')] }));

      await backend.chat({
        model: 'gpt-6.1-sol',
        messages: [{ role: 'user', content: 'Weather?' }],
        tools: [weatherTool],
        toolChoice: { type: 'function', function: { name: 'get_weather' } },
      });
      expect(lastParams().tools).toEqual([
        {
          type: 'function',
          name: 'get_weather',
          description: 'Get the weather for a city',
          parameters: weatherTool.parameters,
          strict: false,
        },
      ]);
      expect(lastParams().tool_choice).toEqual({ type: 'function', name: 'get_weather' });

      await backend.chat({
        model: 'gpt-6.1-sol',
        messages: [{ role: 'user', content: 'Weather?' }],
        tools: [weatherTool],
        toolChoice: 'required',
      });
      expect(lastParams().tool_choice).toBe('required');
    });

    it('omits an empty tool list', async () => {
      mockResponsesCreate.mockResolvedValueOnce(response({ output: [textMessage('ok')] }));

      await backend.chat({
        model: 'gpt-6.1-sol',
        messages: [{ role: 'user', content: 'x' }],
        tools: [],
      });

      expect(lastParams().tools).toBeUndefined();
    });

    it('maps structured output formats to text.format', async () => {
      mockResponsesCreate.mockResolvedValue(response({ output: [textMessage('{"name":"Ada"}')] }));
      const schema = {
        type: 'object',
        properties: { name: { type: 'string' } },
        required: ['name'],
        additionalProperties: false,
      };

      const result = await backend.chat({
        model: 'gpt-6.1-sol',
        messages: [{ role: 'user', content: 'Who wrote the first program?' }],
        responseFormat: {
          type: 'json_schema',
          jsonSchema: { name: 'person', description: 'A person', schema },
        },
      });
      expect(lastParams().text).toEqual({
        format: {
          type: 'json_schema',
          name: 'person',
          description: 'A person',
          schema,
          strict: true,
        },
      });
      expect(JSON.parse(result.content)).toEqual({ name: 'Ada' });

      await backend.chat({
        model: 'gpt-6.1-sol',
        messages: [{ role: 'user', content: 'JSON please' }],
        responseFormat: { type: 'json_object' },
      });
      expect(lastParams().text).toEqual({ format: { type: 'json_object' } });
    });

    it('maps image input parts', async () => {
      mockResponsesCreate.mockResolvedValueOnce(response({ output: [textMessage('A cat.')] }));

      await backend.chat({
        model: 'gpt-6.1-sol',
        messages: [
          {
            role: 'user',
            content: [
              { type: 'text', text: 'What is in these images?' },
              {
                type: 'image_url',
                image_url: { url: 'https://example.com/cat.png', detail: 'high' },
              },
              { type: 'image_url', image_url: { url: 'https://example.com/dog.png' } },
              {
                type: 'image_base64',
                image_base64: { data: 'iVBORw0KGgo=', media_type: 'image/png' },
              },
            ],
          },
        ],
      });

      expect(lastParams().input).toEqual([
        {
          type: 'message',
          role: 'user',
          content: [
            { type: 'input_text', text: 'What is in these images?' },
            { type: 'input_image', image_url: 'https://example.com/cat.png', detail: 'high' },
            { type: 'input_image', image_url: 'https://example.com/dog.png', detail: 'auto' },
            {
              type: 'input_image',
              image_url: 'data:image/png;base64,iVBORw0KGgo=',
              detail: 'auto',
            },
          ],
        },
      ]);
    });

    it('passes the abort signal to the SDK', async () => {
      mockResponsesCreate.mockResolvedValueOnce(response({ output: [textMessage('ok')] }));
      const controller = new AbortController();

      await backend.chat({
        model: 'gpt-6.1-sol',
        messages: [{ role: 'user', content: 'Hi' }],
        signal: controller.signal,
      });

      expect(mockResponsesCreate).toHaveBeenCalledWith(expect.any(Object), {
        signal: controller.signal,
      });
    });
  });

  describe('response parsing', () => {
    it('returns text, id, finish reason and detailed usage', async () => {
      mockResponsesCreate.mockResolvedValueOnce(
        response({ output: [reasoningItem, textMessage('The answer is 42.')] })
      );

      const result = await backend.chat({
        model: 'gpt-6.1-sol',
        messages: [{ role: 'user', content: 'Answer?' }],
      });

      expect(result).toEqual({
        id: 'resp_67ccd2bed1ec8190b14f964abc054267',
        content: 'The answer is 42.',
        toolCalls: undefined,
        finishReason: 'stop',
        usage: {
          inputTokens: 1200,
          outputTokens: 300,
          totalTokens: 1500,
          cachedInputTokens: 1024,
          reasoningTokens: 256,
        },
        reasoning: 'Need the weather first.',
      });
    });

    it('surfaces refusals as content', async () => {
      mockResponsesCreate.mockResolvedValueOnce(
        response({
          output: [
            {
              id: 'msg_1',
              type: 'message',
              role: 'assistant',
              status: 'completed',
              content: [{ type: 'refusal', refusal: 'I can’t help with that.' }],
            },
          ],
        })
      );

      const result = await backend.chat({
        model: 'gpt-6.1-sol',
        messages: [{ role: 'user', content: 'x' }],
      });

      expect(result.content).toBe('I can’t help with that.');
    });

    it('maps incomplete responses', async () => {
      mockResponsesCreate.mockResolvedValueOnce(
        response({
          status: 'incomplete',
          incomplete_details: { reason: 'max_output_tokens' },
          output: [
            reasoningItem,
            textMessage('Partial'),
            { ...weatherCall, status: 'incomplete', arguments: '{"ci' },
          ],
        })
      );
      const truncated = await backend.chat({
        model: 'gpt-6.1-sol',
        messages: [{ role: 'user', content: 'x' }],
      });
      expect(truncated.finishReason).toBe('length');
      expect(truncated.content).toBe('Partial');
      expect(truncated.toolCalls).toBeUndefined();

      mockResponsesCreate.mockResolvedValueOnce(
        response({ status: 'incomplete', incomplete_details: { reason: 'content_filter' } })
      );
      const filtered = await backend.chat({
        model: 'gpt-6.1-sol',
        messages: [{ role: 'user', content: 'x' }],
      });
      expect(filtered.finishReason).toBe('error');
    });

    it('throws a typed error for failed responses', async () => {
      mockResponsesCreate.mockResolvedValueOnce(
        response({
          status: 'failed',
          error: { code: 'rate_limit_exceeded', message: 'Slow down' },
        })
      );

      const error = await backend
        .chat({ model: 'gpt-6.1-sol', messages: [{ role: 'user', content: 'x' }] })
        .catch((e: unknown) => e);

      expect(error).toBeInstanceOf(LLMError);
      expect((error as LLMError).code).toBe(ErrorCode.LLM_RATE_LIMITED);
      expect((error as LLMError).retryable).toBe(true);
    });

    it('wraps SDK API errors', async () => {
      mockResponsesCreate.mockRejectedValueOnce(new MockAPIError('Rate limit exceeded', 429));
      await expect(
        backend.chat({ model: 'gpt-6.1-sol', messages: [{ role: 'user', content: 'x' }] })
      ).rejects.toMatchObject({ code: ErrorCode.LLM_RATE_LIMITED, provider: 'openai' });

      mockResponsesCreate.mockRejectedValueOnce(new MockAPIError('Invalid API key', 401));
      await expect(
        backend.chat({ model: 'gpt-6.1-sol', messages: [{ role: 'user', content: 'x' }] })
      ).rejects.toThrow('Authentication failed');

      mockResponsesCreate.mockRejectedValueOnce(new MockAPIError('Internal error', 500));
      await expect(
        backend.chat({ model: 'gpt-6.1-sol', messages: [{ role: 'user', content: 'x' }] })
      ).rejects.toMatchObject({ code: ErrorCode.LLM_UNAVAILABLE, retryable: true });
    });

    it('rejects non-object tool arguments', async () => {
      mockResponsesCreate.mockResolvedValueOnce(
        response({ output: [{ ...weatherCall, arguments: '"Paris"' }] })
      );

      await expect(
        backend.chat({ model: 'gpt-6.1-sol', messages: [{ role: 'user', content: 'x' }] })
      ).rejects.toThrow('Tool call arguments must be a JSON object');
    });
  });

  describe('tool calling with reasoning round-trip', () => {
    it('returns tool calls carrying their reasoning and replays them on the next turn', async () => {
      mockResponsesCreate.mockResolvedValueOnce(response({ output: [reasoningItem, weatherCall] }));

      const first = await backend.chat({
        model: 'gpt-6.1-sol',
        messages: [
          { role: 'system', content: 'Use tools.' },
          { role: 'user', content: 'Weather in Paris?' },
        ],
        tools: [weatherTool],
      });

      expect(first.finishReason).toBe('tool_calls');
      expect(first.toolCalls).toEqual([
        {
          id: 'call_ZSdKQt2a5xG7BzzAqLrUFm1e',
          name: 'get_weather',
          arguments: { city: 'Paris' },
          replay: {
            itemId: 'fc_6876cf05ba5c8192a0f6d7e4b3a2c1d0',
            precedingItems: [
              {
                type: 'reasoning',
                id: 'rs_6876cf02e0bc8192b74af0fb64b715ff',
                summary: [{ type: 'summary_text', text: 'Need the weather first.' }],
                encrypted_content: 'gAAAAABodmJ4-encrypted-blob',
              },
            ],
          },
        },
      ]);

      const history: Message[] = [
        { role: 'system', content: 'Use tools.' },
        { role: 'user', content: 'Weather in Paris?' },
        { role: 'assistant', content: first.content, toolCalls: first.toolCalls } as Message,
        {
          role: 'tool',
          content: '{"temp":18}',
          toolCallId: first.toolCalls![0].id,
          name: 'get_weather',
        },
      ];
      const persisted = JSON.parse(JSON.stringify(history)) as Message[];

      mockResponsesCreate.mockResolvedValueOnce(
        response({ output: [textMessage('It is 18°C in Paris.')] })
      );
      const second = await backend.chat({
        model: 'gpt-6.1-sol',
        messages: persisted,
        tools: [weatherTool],
      });

      expect(second.content).toBe('It is 18°C in Paris.');
      expect(lastParams().input).toEqual([
        { type: 'message', role: 'user', content: 'Weather in Paris?' },
        {
          type: 'reasoning',
          id: 'rs_6876cf02e0bc8192b74af0fb64b715ff',
          summary: [{ type: 'summary_text', text: 'Need the weather first.' }],
          encrypted_content: 'gAAAAABodmJ4-encrypted-blob',
        },
        {
          type: 'function_call',
          id: 'fc_6876cf05ba5c8192a0f6d7e4b3a2c1d0',
          call_id: 'call_ZSdKQt2a5xG7BzzAqLrUFm1e',
          name: 'get_weather',
          arguments: '{"city":"Paris"}',
        },
        {
          type: 'function_call_output',
          call_id: 'call_ZSdKQt2a5xG7BzzAqLrUFm1e',
          output: '{"temp":18}',
        },
      ]);
    });

    it('handles parallel tool calls', async () => {
      const tokyoCall = {
        ...weatherCall,
        id: 'fc_tokyo',
        call_id: 'call_tokyo',
        arguments: '{"city":"Tokyo"}',
      };
      mockResponsesCreate.mockResolvedValueOnce(
        response({ output: [reasoningItem, weatherCall, tokyoCall] })
      );

      const first = await backend.chat({
        model: 'gpt-6.1-sol',
        messages: [{ role: 'user', content: 'Paris and Tokyo?' }],
        tools: [weatherTool],
      });

      expect(first.toolCalls?.map((tc) => tc.arguments)).toEqual([
        { city: 'Paris' },
        { city: 'Tokyo' },
      ]);
      expect(first.toolCalls?.[1].replay).toEqual({ itemId: 'fc_tokyo' });

      mockResponsesCreate.mockResolvedValueOnce(response({ output: [textMessage('Done')] }));
      await backend.chat({
        model: 'gpt-6.1-sol',
        messages: [
          { role: 'user', content: 'Paris and Tokyo?' },
          { role: 'assistant', content: '', toolCalls: first.toolCalls } as Message,
          { role: 'tool', content: '18', toolCallId: 'call_ZSdKQt2a5xG7BzzAqLrUFm1e' },
          { role: 'tool', content: '25', toolCallId: 'call_tokyo' },
        ],
      });

      expect((lastParams().input as { type: string }[]).map((item) => item.type)).toEqual([
        'message',
        'reasoning',
        'function_call',
        'function_call',
        'function_call_output',
        'function_call_output',
      ]);
    });

    it('replays preamble messages verbatim without duplicating the text', async () => {
      mockResponsesCreate.mockResolvedValueOnce(
        response({
          output: [reasoningItem, textMessage('Let me check.', 'msg_preamble'), weatherCall],
        })
      );

      const first = await backend.chat({
        model: 'gpt-6.1-sol',
        messages: [{ role: 'user', content: 'Weather?' }],
        tools: [weatherTool],
      });
      expect(first.content).toBe('Let me check.');

      mockResponsesCreate.mockResolvedValueOnce(response({ output: [textMessage('Sunny')] }));
      await backend.chat({
        model: 'gpt-6.1-sol',
        messages: [
          { role: 'user', content: 'Weather?' },
          { role: 'assistant', content: first.content, toolCalls: first.toolCalls } as Message,
          { role: 'tool', content: 'sunny', toolCallId: weatherCall.call_id },
        ],
      });

      const input = lastParams().input as Record<string, unknown>[];
      expect(input.map((item) => item.type)).toEqual([
        'message',
        'reasoning',
        'message',
        'function_call',
        'function_call_output',
      ]);
      expect(input[2]).toEqual({
        type: 'message',
        id: 'msg_preamble',
        role: 'assistant',
        status: 'completed',
        content: [{ type: 'output_text', text: 'Let me check.', annotations: [] }],
      });
    });

    it('sends plain assistant text and calls from other providers', async () => {
      mockResponsesCreate.mockResolvedValueOnce(response({ output: [textMessage('ok')] }));
      const foreignCall: ToolCall = {
        id: 'toolu_01',
        name: 'get_weather',
        arguments: { city: 'Oslo' },
      };

      await backend.chat({
        model: 'gpt-6.1-sol',
        messages: [
          { role: 'user', content: 'Oslo?' },
          { role: 'assistant', content: 'Checking Oslo.', toolCalls: [foreignCall] } as Message,
          { role: 'tool', content: '3', toolCallId: 'toolu_01' },
          { role: 'assistant', content: 'It is 3°C.' },
          { role: 'user', content: 'Thanks' },
        ],
      });

      expect(lastParams().input).toEqual([
        { type: 'message', role: 'user', content: 'Oslo?' },
        { type: 'message', role: 'assistant', content: 'Checking Oslo.' },
        {
          type: 'function_call',
          call_id: 'toolu_01',
          name: 'get_weather',
          arguments: '{"city":"Oslo"}',
        },
        { type: 'function_call_output', call_id: 'toolu_01', output: '3' },
        { type: 'message', role: 'assistant', content: 'It is 3°C.' },
        { type: 'message', role: 'user', content: 'Thanks' },
      ]);
    });

    it('does not replay reasoning to non-reasoning models and skips malformed items', async () => {
      mockResponsesCreate.mockResolvedValueOnce(response({ output: [textMessage('ok')] }));
      const call: ToolCall = {
        id: 'call_1',
        name: 'get_weather',
        arguments: {},
        replay: {
          itemId: 'fc_1',
          precedingItems: [
            { type: 'reasoning', id: 'rs_1', summary: [], encrypted_content: 'enc' },
            { type: 'reasoning', id: 'rs_2', summary: [] },
            { type: 'web_search_call', id: 'ws_1' },
          ],
        },
      };

      await backend.chat({
        model: 'gpt-4o',
        messages: [
          { role: 'assistant', content: '', toolCalls: [call] } as Message,
          { role: 'tool', content: 'x', toolCallId: 'call_1' },
        ],
      });
      expect((lastParams().input as { type: string }[]).map((item) => item.type)).toEqual([
        'function_call',
        'function_call_output',
      ]);

      mockResponsesCreate.mockResolvedValueOnce(response({ output: [textMessage('ok')] }));
      await backend.chat({
        model: 'gpt-6.1-sol',
        messages: [
          { role: 'assistant', content: '', toolCalls: [call] } as Message,
          { role: 'tool', content: 'x', toolCallId: 'call_1' },
        ],
      });
      expect(lastParams().input).toEqual([
        { type: 'reasoning', id: 'rs_1', summary: [], encrypted_content: 'enc' },
        {
          type: 'function_call',
          id: 'fc_1',
          call_id: 'call_1',
          name: 'get_weather',
          arguments: '{}',
        },
        { type: 'function_call_output', call_id: 'call_1', output: 'x' },
      ]);
    });

    it('does not capture reasoning without encrypted content', async () => {
      mockResponsesCreate.mockResolvedValueOnce(
        response({ output: [{ ...reasoningItem, encrypted_content: null }, weatherCall] })
      );

      const result = await backend.chat({
        model: 'gpt-6.1-sol',
        messages: [{ role: 'user', content: 'x' }],
      });

      expect(result.toolCalls?.[0].replay).toEqual({ itemId: weatherCall.id });
    });
  });

  describe('chatStream', () => {
    const created = {
      type: 'response.created',
      response: response({ status: 'in_progress', output: [], usage: null }),
    };

    it('streams text deltas and finishes with usage', async () => {
      const message = textMessage('Hello world');
      mockResponsesCreate.mockResolvedValueOnce(
        streamOf([
          created,
          {
            type: 'response.output_item.added',
            output_index: 0,
            item: { ...message, content: [], status: 'in_progress' },
          },
          {
            type: 'response.output_text.delta',
            item_id: message.id,
            output_index: 0,
            content_index: 0,
            delta: 'Hello',
            logprobs: [],
          },
          {
            type: 'response.output_text.delta',
            item_id: message.id,
            output_index: 0,
            content_index: 0,
            delta: ' world',
            logprobs: [],
          },
          {
            type: 'response.output_text.done',
            item_id: message.id,
            output_index: 0,
            content_index: 0,
            text: 'Hello world',
            logprobs: [],
          },
          { type: 'response.output_item.done', output_index: 0, item: message },
          { type: 'response.completed', response: response({ output: [message] }) },
        ])
      );

      const chunks = await collect(
        backend.chatStream({ model: 'gpt-6.1-sol', messages: [{ role: 'user', content: 'Hi' }] })
      );

      expect(chunks.map((c) => c.delta.content).filter(Boolean)).toEqual(['Hello', ' world']);
      expect(chunks.at(-1)).toEqual({
        id: 'resp_67ccd2bed1ec8190b14f964abc054267',
        delta: {},
        finishReason: 'stop',
        usage: {
          inputTokens: 1200,
          outputTokens: 300,
          totalTokens: 1500,
          cachedInputTokens: 1024,
          reasoningTokens: 256,
        },
      });
      expect(lastParams()).toMatchObject({ stream: true, store: false });
    });

    it('streams the reasoning summary', async () => {
      mockResponsesCreate.mockResolvedValueOnce(
        streamOf([
          created,
          {
            type: 'response.reasoning_summary_text.delta',
            item_id: 'rs_1',
            output_index: 0,
            summary_index: 0,
            delta: 'Weighing ',
          },
          {
            type: 'response.reasoning_summary_text.delta',
            item_id: 'rs_1',
            output_index: 0,
            summary_index: 0,
            delta: 'options.',
          },
          { type: 'response.completed', response: response({ output: [textMessage('ok')] }) },
        ])
      );

      const chunks = await collect(
        backend.chatStream({ model: 'gpt-6.1-sol', messages: [{ role: 'user', content: 'Hi' }] })
      );

      expect(chunks.map((c) => c.delta.reasoning).filter(Boolean)).toEqual([
        'Weighing ',
        'options.',
      ]);
    });

    it('assembles streamed function call arguments', async () => {
      mockResponsesCreate.mockResolvedValueOnce(
        streamOf([
          created,
          {
            type: 'response.output_item.added',
            output_index: 0,
            item: { ...reasoningItem, status: 'in_progress', encrypted_content: null },
          },
          { type: 'response.output_item.done', output_index: 0, item: reasoningItem },
          {
            type: 'response.output_item.added',
            output_index: 1,
            item: { ...weatherCall, status: 'in_progress', arguments: '' },
          },
          {
            type: 'response.function_call_arguments.delta',
            item_id: weatherCall.id,
            output_index: 1,
            delta: '{"ci',
          },
          {
            type: 'response.function_call_arguments.delta',
            item_id: weatherCall.id,
            output_index: 1,
            delta: 'ty":"Paris"}',
          },
          {
            type: 'response.function_call_arguments.done',
            item_id: weatherCall.id,
            output_index: 1,
            name: 'get_weather',
            arguments: '{"city":"Paris"}',
          },
          { type: 'response.completed', response: response({ output: [] }) },
        ])
      );

      const chunks = await collect(
        backend.chatStream({
          model: 'gpt-6.1-sol',
          messages: [{ role: 'user', content: 'Weather?' }],
          tools: [weatherTool],
        })
      );

      const final = chunks.at(-1)!;
      expect(final.finishReason).toBe('tool_calls');
      expect(final.delta.toolCalls).toEqual([
        {
          id: weatherCall.call_id,
          name: 'get_weather',
          arguments: { city: 'Paris' },
          replay: {
            itemId: weatherCall.id,
            precedingItems: [
              {
                type: 'reasoning',
                id: reasoningItem.id,
                summary: reasoningItem.summary,
                encrypted_content: reasoningItem.encrypted_content,
              },
            ],
          },
        },
      ]);
    });

    it('prefers the completed response output for tool calls', async () => {
      mockResponsesCreate.mockResolvedValueOnce(
        streamOf([
          created,
          {
            type: 'response.function_call_arguments.delta',
            item_id: 'unknown',
            output_index: 5,
            delta: '{',
          },
          {
            type: 'response.completed',
            response: response({ output: [reasoningItem, weatherCall] }),
          },
        ])
      );

      const chunks = await collect(
        backend.chatStream({ model: 'gpt-6.1-sol', messages: [{ role: 'user', content: 'x' }] })
      );

      expect(chunks).toHaveLength(1);
      expect(chunks[0].delta.toolCalls?.[0]).toMatchObject({
        id: weatherCall.call_id,
        arguments: { city: 'Paris' },
      });
    });

    it('reports incomplete streams as length', async () => {
      mockResponsesCreate.mockResolvedValueOnce(
        streamOf([
          created,
          {
            type: 'response.output_text.delta',
            item_id: 'msg_1',
            output_index: 0,
            content_index: 0,
            delta: 'Part',
            logprobs: [],
          },
          {
            type: 'response.incomplete',
            response: response({
              status: 'incomplete',
              incomplete_details: { reason: 'max_output_tokens' },
              output: [textMessage('Part')],
            }),
          },
        ])
      );

      const chunks = await collect(
        backend.chatStream({ model: 'gpt-6.1-sol', messages: [{ role: 'user', content: 'x' }] })
      );

      expect(chunks.at(-1)?.finishReason).toBe('length');
    });

    it('throws on response.failed and error events', async () => {
      mockResponsesCreate.mockResolvedValueOnce(
        streamOf([
          created,
          {
            type: 'response.failed',
            response: response({
              status: 'failed',
              error: { code: 'server_error', message: 'boom' },
            }),
          },
        ])
      );
      await expect(
        collect(
          backend.chatStream({ model: 'gpt-6.1-sol', messages: [{ role: 'user', content: 'x' }] })
        )
      ).rejects.toMatchObject({ code: ErrorCode.LLM_UNAVAILABLE, retryable: true });

      mockResponsesCreate.mockResolvedValueOnce(
        streamOf([
          created,
          {
            type: 'error',
            code: 'context_length_exceeded',
            message: 'Your input exceeds the context window of this model.',
            param: 'input',
          },
        ])
      );
      await expect(
        collect(
          backend.chatStream({ model: 'gpt-6.1-sol', messages: [{ role: 'user', content: 'x' }] })
        )
      ).rejects.toMatchObject({ code: ErrorCode.LLM_CONTEXT_LENGTH_EXCEEDED });
    });

    it('throws when the stream ends without a terminal event', async () => {
      mockResponsesCreate.mockResolvedValueOnce(streamOf([created]));

      await expect(
        collect(
          backend.chatStream({ model: 'gpt-6.1-sol', messages: [{ role: 'user', content: 'x' }] })
        )
      ).rejects.toThrow('Response stream ended before a terminal event');
    });

    it('wraps errors raised when opening the stream and forwards the abort signal', async () => {
      const controller = new AbortController();
      mockResponsesCreate.mockRejectedValueOnce(new MockAPIError('Rate limit exceeded', 429));

      await expect(
        collect(
          backend.chatStream({
            model: 'gpt-6.1-sol',
            messages: [{ role: 'user', content: 'x' }],
            signal: controller.signal,
          })
        )
      ).rejects.toThrow('Rate limit exceeded');
      expect(mockResponsesCreate).toHaveBeenCalledWith(expect.objectContaining({ stream: true }), {
        signal: controller.signal,
      });
    });
  });
});
