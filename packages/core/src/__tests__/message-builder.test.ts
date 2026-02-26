import { describe, it, expect, vi } from 'vitest';
import type { Message, ContentPart, AgentContext } from '@cogitator-ai/types';
import { enrichMessagesWithInsights, addContextToMessages } from '../cogitator/message-builder';
import type { ReflectionEngine } from '../reflection/index';

function createMockReflectionEngine(insights: { content: string }[]): ReflectionEngine {
  return {
    getRelevantInsights: vi.fn().mockResolvedValue(insights),
  } as unknown as ReflectionEngine;
}

const agentContext: AgentContext = {
  agentId: 'agent_1',
  runId: 'run_1',
  threadId: 'thread_1',
  currentInput: 'test input',
};

describe('enrichMessagesWithInsights', () => {
  it('appends suffix when system message content is a string', async () => {
    const messages: Message[] = [
      { role: 'system', content: 'You are helpful.' },
      { role: 'user', content: 'Hi' },
    ];
    const engine = createMockReflectionEngine([{ content: 'be concise' }]);

    await enrichMessagesWithInsights(messages, engine, agentContext);

    expect(typeof messages[0].content).toBe('string');
    expect(messages[0].content).toContain('You are helpful.');
    expect(messages[0].content).toContain('Past learnings');
    expect(messages[0].content).toContain('be concise');
  });

  it('appends text part when system message content is ContentPart[]', async () => {
    const messages: Message[] = [
      { role: 'system', content: [{ type: 'text', text: 'System prompt' }] as ContentPart[] },
      { role: 'user', content: 'Hi' },
    ];
    const engine = createMockReflectionEngine([{ content: 'use examples' }]);

    await enrichMessagesWithInsights(messages, engine, agentContext);

    const content = messages[0].content as ContentPart[];
    expect(Array.isArray(content)).toBe(true);
    expect(content).toHaveLength(2);
    expect(content[0]).toEqual({ type: 'text', text: 'System prompt' });
    expect(content[1].type).toBe('text');
    expect((content[1] as { type: 'text'; text: string }).text).toContain('use examples');
  });

  it('sets suffix as content when system message content is null/undefined', async () => {
    const messages: Message[] = [
      { role: 'system', content: null as unknown as string },
      { role: 'user', content: 'Hi' },
    ];
    const engine = createMockReflectionEngine([{ content: 'stay focused' }]);

    await enrichMessagesWithInsights(messages, engine, agentContext);

    expect(typeof messages[0].content).toBe('string');
    expect(messages[0].content).toContain('Past learnings');
    expect(messages[0].content).toContain('stay focused');
  });

  it('does nothing when there are no insights', async () => {
    const messages: Message[] = [
      { role: 'system', content: 'Original content' },
      { role: 'user', content: 'Hi' },
    ];
    const engine = createMockReflectionEngine([]);

    await enrichMessagesWithInsights(messages, engine, agentContext);

    expect(messages[0].content).toBe('Original content');
  });

  it('does nothing when first message is not system role', async () => {
    const messages: Message[] = [{ role: 'user', content: 'Hi' }];
    const engine = createMockReflectionEngine([{ content: 'insight' }]);

    await enrichMessagesWithInsights(messages, engine, agentContext);

    expect(messages[0].content).toBe('Hi');
  });
});

describe('addContextToMessages', () => {
  it('appends context suffix when system message content is a string', () => {
    const messages: Message[] = [
      { role: 'system', content: 'You are helpful.' },
      { role: 'user', content: 'Hi' },
    ];

    addContextToMessages(messages, { userId: 'u1', lang: 'en' });

    expect(typeof messages[0].content).toBe('string');
    expect(messages[0].content).toContain('You are helpful.');
    expect(messages[0].content).toContain('Context:');
    expect(messages[0].content).toContain('userId');
    expect(messages[0].content).toContain('lang');
  });

  it('appends text part when system message content is ContentPart[]', () => {
    const messages: Message[] = [
      { role: 'system', content: [{ type: 'text', text: 'Prompt' }] as ContentPart[] },
      { role: 'user', content: 'Hi' },
    ];

    addContextToMessages(messages, { mode: 'debug' });

    const content = messages[0].content as ContentPart[];
    expect(Array.isArray(content)).toBe(true);
    expect(content).toHaveLength(2);
    expect(content[0]).toEqual({ type: 'text', text: 'Prompt' });
    expect(content[1].type).toBe('text');
    expect((content[1] as { type: 'text'; text: string }).text).toContain('mode');
  });

  it('sets suffix as content when system message content is null/undefined', () => {
    const messages: Message[] = [
      { role: 'system', content: null as unknown as string },
      { role: 'user', content: 'Hi' },
    ];

    addContextToMessages(messages, { key: 'value' });

    expect(typeof messages[0].content).toBe('string');
    expect(messages[0].content).toContain('Context:');
    expect(messages[0].content).toContain('key');
  });

  it('does nothing when messages array is empty', () => {
    const messages: Message[] = [];
    addContextToMessages(messages, { foo: 'bar' });
    expect(messages).toHaveLength(0);
  });

  it('does nothing when first message is not system role', () => {
    const messages: Message[] = [{ role: 'user', content: 'Hi' }];
    addContextToMessages(messages, { foo: 'bar' });
    expect(messages[0].content).toBe('Hi');
  });
});

describe('buildUserContent', () => {
  it('returns string when no images provided', async () => {
    const { buildInitialMessages } = await import('../cogitator/message-builder');

    const messages = await buildInitialMessages(
      { id: 'a1', instructions: 'sys' } as never,
      { input: 'hello' },
      'thread_1',
      undefined,
      undefined
    );

    const userMsg = messages.find((m) => m.role === 'user')!;
    expect(typeof userMsg.content).toBe('string');
    expect(userMsg.content).toBe('hello');
  });

  it('returns ContentPart[] with image_url for string images', async () => {
    const { buildInitialMessages } = await import('../cogitator/message-builder');

    const messages = await buildInitialMessages(
      { id: 'a1', instructions: 'sys' } as never,
      { input: 'describe this', images: ['https://example.com/img.png'] },
      'thread_1',
      undefined,
      undefined
    );

    const userMsg = messages.find((m) => m.role === 'user')!;
    const content = userMsg.content as ContentPart[];
    expect(Array.isArray(content)).toBe(true);
    expect(content[0]).toEqual({ type: 'text', text: 'describe this' });
    expect(content[1]).toEqual({
      type: 'image_url',
      image_url: { url: 'https://example.com/img.png', detail: 'auto' },
    });
  });

  it('returns ContentPart[] with image_base64 for object images', async () => {
    const { buildInitialMessages } = await import('../cogitator/message-builder');

    const messages = await buildInitialMessages(
      { id: 'a1', instructions: 'sys' } as never,
      {
        input: 'what is this',
        images: [{ data: 'base64data', mimeType: 'image/png' as const }],
      },
      'thread_1',
      undefined,
      undefined
    );

    const userMsg = messages.find((m) => m.role === 'user')!;
    const content = userMsg.content as ContentPart[];
    expect(Array.isArray(content)).toBe(true);
    expect(content[0]).toEqual({ type: 'text', text: 'what is this' });
    expect(content[1]).toEqual({
      type: 'image_base64',
      image_base64: { data: 'base64data', media_type: 'image/png' },
    });
  });
});
