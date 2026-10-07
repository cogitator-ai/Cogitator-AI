import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { ChatRequest, Message, ToolCall } from '@cogitator-ai/types';
import { AnthropicBackend } from '../llm/anthropic';
import { claudeThinkingParams } from '../llm/anthropic-thinking';

const mockCreate = vi.fn();
const mockStream = vi.fn();

vi.mock('@anthropic-ai/sdk', () => {
  class MockAnthropic {
    messages = { create: mockCreate, stream: mockStream };
  }
  return { default: MockAnthropic };
});

class SignatureError extends Error {
  status = 400;
}

const usage = {
  input_tokens: 100,
  output_tokens: 40,
  cache_read_input_tokens: 900,
  cache_creation_input_tokens: 0,
};

function toolTurn() {
  return {
    id: 'msg_1',
    stop_reason: 'tool_use',
    usage,
    content: [
      { type: 'thinking', thinking: 'Need the weather first.', signature: 'sig-1' },
      { type: 'text', text: 'Checking.' },
      { type: 'tool_use', id: 'call_1', name: 'weather', input: { city: 'Oslo' } },
      { type: 'redacted_thinking', data: 'enc-2' },
      { type: 'tool_use', id: 'call_2', name: 'time', input: { city: 'Oslo' } },
    ],
  };
}

const params = () => mockCreate.mock.calls.at(-1)?.[0] as Record<string, unknown>;

describe('claudeThinkingParams', () => {
  it.each([
    ['claude-opus-5-5', { effort: 'high' }, { type: 'adaptive', display: 'omitted' }, 'high'],
    ['claude-opus-5-5', { effort: 'none' }, undefined, 'low'],
    ['claude-sonnet-5-5', { effort: 'none' }, { type: 'between_tools' }, undefined],
    ['claude-opus-4-8', { effort: 'none' }, { type: 'disabled' }, undefined],
    ['claude-opus-4-6', { effort: 'xhigh' }, { type: 'adaptive', display: 'omitted' }, 'high'],
    [
      'claude-fable-5-1',
      { effort: 'minimal', summary: true },
      { type: 'adaptive', display: 'summarized' },
      'low',
    ],
    ['claude-opus-4-5', { effort: 'max' }, { type: 'enabled', budget_tokens: 32768 }, undefined],
  ] as const)('%s with %j', (model, reasoning, thinking, effort) => {
    const result = claudeThinkingParams(model, reasoning, 4096);

    expect(result.thinking).toEqual(thinking);
    expect(result.effort).toBe(effort);
  });

  it('adds a thinking budget on top of the answer tokens on older models', () => {
    expect(claudeThinkingParams('claude-haiku-4-5', { budgetTokens: 3000 }, 2000)).toEqual({
      thinking: { type: 'enabled', budget_tokens: 3000 },
      maxTokens: 5000,
      budgetThinking: true,
    });
    expect(claudeThinkingParams('claude-haiku-4-5', { effort: 'none' }, 2000).thinking).toBe(
      undefined
    );
    expect(claudeThinkingParams('claude-3-5-sonnet-20241022', { effort: 'high' }, 2000)).toEqual({
      maxTokens: 2000,
      budgetThinking: false,
    });
  });
});

describe('AnthropicBackend thinking and caching', () => {
  let backend: AnthropicBackend;

  beforeEach(() => {
    backend = new AnthropicBackend({ apiKey: 'k' });
    mockCreate.mockReset();
    mockStream.mockReset();
  });

  it('sends reasoning and cache settings', async () => {
    mockCreate.mockResolvedValue({ ...toolTurn(), content: [{ type: 'text', text: 'ok' }] });

    await backend.chat({
      model: 'claude-opus-5-5',
      messages: [{ role: 'user', content: 'hi' }],
      reasoning: { effort: 'xhigh', summary: true },
      cache: { ttl: '1h', conversation: true },
      temperature: 0.3,
    });

    expect(params()).toMatchObject({
      thinking: { type: 'adaptive', display: 'summarized' },
      output_config: { effort: 'xhigh' },
      cache_control: { type: 'ephemeral', ttl: '1h' },
    });
    expect(params()).not.toHaveProperty('temperature');
  });

  it('returns the reasoning and keeps thinking blocks with the calls they preceded', async () => {
    mockCreate.mockResolvedValue(toolTurn());

    const response = await backend.chat({
      model: 'claude-opus-5-5',
      messages: [{ role: 'user', content: 'weather?' }],
    });

    expect(response.reasoning).toBe('Need the weather first.');
    expect(response.content).toBe('Checking.');
    expect(response.toolCalls?.map((c) => c.replay?.precedingItems)).toEqual([
      [{ type: 'thinking', thinking: 'Need the weather first.', signature: 'sig-1' }],
      [{ type: 'redacted_thinking', data: 'enc-2' }],
    ]);
    expect(response.usage).toEqual({
      inputTokens: 1000,
      outputTokens: 40,
      totalTokens: 1040,
      cachedInputTokens: 900,
    });
  });

  it('replays thinking blocks within the current tool loop only', async () => {
    mockCreate.mockResolvedValueOnce(toolTurn());
    const first = await backend.chat({
      model: 'claude-opus-5-5',
      messages: [{ role: 'user', content: 'weather?' }],
    });
    const assistant = (calls: ToolCall[]): Message =>
      ({ role: 'assistant', content: 'Checking.', toolCalls: calls }) as Message;
    const earlier = assistant([{ ...first.toolCalls![0], id: 'old_call' }]);
    mockCreate.mockResolvedValue({ ...toolTurn(), content: [{ type: 'text', text: 'Sunny' }] });

    await backend.chat({
      model: 'claude-opus-5-5',
      messages: [
        { role: 'user', content: 'earlier question' },
        earlier,
        { role: 'tool', content: '1', toolCallId: 'old_call', name: 'weather' } as Message,
        { role: 'user', content: 'weather?' },
        assistant(first.toolCalls!),
        { role: 'tool', content: '12C', toolCallId: 'call_1', name: 'weather' } as Message,
        { role: 'tool', content: '14:00', toolCallId: 'call_2', name: 'time' } as Message,
      ],
    });

    const sent = params().messages as Array<{ role: string; content: Array<{ type: string }> }>;
    expect(sent[1].content.map((b) => b.type)).toEqual(['text', 'tool_use']);
    expect(sent[4].content.map((b) => b.type)).toEqual([
      'thinking',
      'text',
      'tool_use',
      'redacted_thinking',
      'tool_use',
    ]);
  });

  it('retries once without thinking blocks the API refuses', async () => {
    mockCreate.mockResolvedValueOnce(toolTurn());
    const first = await backend.chat({
      model: 'claude-opus-5-5',
      messages: [{ role: 'user', content: 'weather?' }],
    });
    mockCreate
      .mockRejectedValueOnce(
        new SignatureError(
          'messages.1.content.0: Invalid `signature` in `thinking` block. The block is bound to a different conversation.'
        )
      )
      .mockResolvedValueOnce({ ...toolTurn(), content: [{ type: 'text', text: 'Sunny' }] });

    const response = await backend.chat({
      model: 'claude-opus-5-5',
      messages: [
        { role: 'user', content: 'weather?' },
        { role: 'assistant', content: '', toolCalls: first.toolCalls } as Message,
        { role: 'tool', content: '12C', toolCallId: 'call_1', name: 'weather' } as Message,
        { role: 'tool', content: '14:00', toolCallId: 'call_2', name: 'time' } as Message,
      ],
    });

    expect(response.content).toBe('Sunny');
    const retried = params().messages as Array<{ content: Array<{ type: string }> }>;
    expect(retried[1].content.map((b) => b.type)).toEqual(['tool_use', 'tool_use']);
  });

  it('turns budget thinking off when a tool is forced and drops sampling with it', async () => {
    mockCreate.mockResolvedValue({ ...toolTurn(), content: [{ type: 'text', text: 'ok' }] });
    const request: ChatRequest = {
      model: 'claude-opus-4-5',
      messages: [{ role: 'user', content: 'hi' }],
      reasoning: { effort: 'low' },
      temperature: 0.2,
    };

    await backend.chat(request);
    expect(params()).toMatchObject({
      thinking: { type: 'enabled', budget_tokens: 2048 },
      max_tokens: 6144,
    });
    expect(params()).not.toHaveProperty('temperature');

    await backend.chat({
      ...request,
      tools: [{ name: 'f', description: 'f', parameters: { type: 'object', properties: {} } }],
      toolChoice: 'required',
    });
    expect(params()).not.toHaveProperty('thinking');
    expect(params()).toMatchObject({ temperature: 0.2, max_tokens: 4096 });
  });

  it('streams reasoning and keeps the signed block for the tool call', async () => {
    const events = [
      { type: 'message_start', message: { usage } },
      {
        type: 'content_block_start',
        content_block: { type: 'thinking', thinking: '', signature: '' },
      },
      { type: 'content_block_delta', delta: { type: 'thinking_delta', thinking: 'Let me ' } },
      { type: 'content_block_delta', delta: { type: 'thinking_delta', thinking: 'check.' } },
      { type: 'content_block_delta', delta: { type: 'signature_delta', signature: 'sig-9' } },
      { type: 'content_block_stop' },
      {
        type: 'content_block_start',
        content_block: { type: 'tool_use', id: 'c1', name: 'weather' },
      },
      {
        type: 'content_block_delta',
        delta: { type: 'input_json_delta', partial_json: '{"city":"Oslo"}' },
      },
      { type: 'content_block_stop' },
      { type: 'message_delta', usage: { output_tokens: 12 }, delta: { stop_reason: 'tool_use' } },
      { type: 'message_stop' },
    ];
    mockStream.mockReturnValue(
      (async function* () {
        yield* events;
      })()
    );

    const chunks = [];
    for await (const chunk of backend.chatStream({
      model: 'claude-opus-5-5',
      messages: [{ role: 'user', content: 'weather?' }],
    })) {
      chunks.push(chunk);
    }

    expect(chunks.map((c) => c.delta.reasoning).filter(Boolean)).toEqual(['Let me ', 'check.']);
    const last = chunks.at(-1)!;
    expect(last.delta.toolCalls?.[0].replay).toEqual({
      precedingItems: [{ type: 'thinking', thinking: 'Let me check.', signature: 'sig-9' }],
    });
    expect(last.usage).toMatchObject({
      inputTokens: 1000,
      cachedInputTokens: 900,
      outputTokens: 12,
    });
  });
});
