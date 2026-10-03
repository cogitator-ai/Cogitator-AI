import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Message } from '@cogitator-ai/types';

const mockSend = vi.fn();

class MockClient {
  send = mockSend;
}
class MockCommand {
  constructor(readonly input: Record<string, unknown>) {}
}

vi.mock('@aws-sdk/client-bedrock-runtime', () => ({
  BedrockRuntimeClient: MockClient,
  ConverseCommand: MockCommand,
  ConverseStreamCommand: MockCommand,
}));

import { BedrockBackend } from '../llm/bedrock';

const MODEL = 'us.anthropic.claude-opus-4-8-v1:0';
const sent = () => (mockSend.mock.calls.at(-1)?.[0] as MockCommand).input;

const toolTurn = {
  output: {
    message: {
      content: [
        { reasoningContent: { reasoningText: { text: 'Look it up.', signature: 'sig-b' } } },
        { text: 'Checking.' },
        { toolUse: { toolUseId: 't1', name: 'weather', input: { city: 'Oslo' } } },
      ],
    },
  },
  stopReason: 'tool_use',
  usage: {
    inputTokens: 20,
    outputTokens: 10,
    totalTokens: 530,
    cacheReadInputTokens: 500,
    cacheWriteInputTokens: 0,
  },
};

describe('Bedrock thinking and caching', () => {
  let backend: BedrockBackend;

  beforeEach(() => {
    backend = new BedrockBackend({ region: 'us-east-1' });
    mockSend.mockReset();
  });

  it('passes thinking and effort to Claude and marks cache points', async () => {
    mockSend.mockResolvedValue(toolTurn);

    await backend.chat({
      model: MODEL,
      messages: [
        { role: 'system', content: 'Be brief.' },
        { role: 'user', content: 'weather?' },
      ],
      reasoning: { effort: 'high', summary: true },
      cache: {},
      temperature: 0.5,
    });

    expect(sent()).toMatchObject({
      additionalModelRequestFields: {
        thinking: { type: 'adaptive', display: 'summarized' },
        output_config: { effort: 'high' },
      },
      system: [{ text: 'Be brief.' }, { cachePoint: { type: 'default' } }],
      messages: [
        { role: 'user', content: [{ text: 'weather?' }, { cachePoint: { type: 'default' } }] },
      ],
    });
  });

  it('returns reasoning, keeps the signed block and counts cached input', async () => {
    mockSend.mockResolvedValue(toolTurn);

    const response = await backend.chat({
      model: MODEL,
      messages: [{ role: 'user', content: '?' }],
    });

    expect(response.reasoning).toBe('Look it up.');
    expect(response.toolCalls?.[0].replay).toEqual({
      precedingItems: [{ type: 'thinking', thinking: 'Look it up.', signature: 'sig-b' }],
    });
    expect(response.usage).toEqual({
      inputTokens: 520,
      outputTokens: 10,
      totalTokens: 530,
      cachedInputTokens: 500,
    });
  });

  it('replays reasoning blocks in the current tool loop', async () => {
    mockSend.mockResolvedValueOnce(toolTurn);
    const first = await backend.chat({ model: MODEL, messages: [{ role: 'user', content: '?' }] });
    mockSend.mockResolvedValueOnce({
      ...toolTurn,
      output: { message: { content: [{ text: 'Sunny' }] } },
    });

    await backend.chat({
      model: MODEL,
      messages: [
        { role: 'user', content: '?' },
        { role: 'assistant', content: 'Checking.', toolCalls: first.toolCalls } as Message,
        { role: 'tool', content: '12C', toolCallId: 't1', name: 'weather' } as Message,
      ],
    });

    const assistant = (sent().messages as Array<{ content: Record<string, unknown>[] }>)[1];
    expect(assistant.content.map((block) => Object.keys(block)[0])).toEqual([
      'reasoningContent',
      'text',
      'toolUse',
    ]);
  });
});
