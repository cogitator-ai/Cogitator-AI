import { describe, it, expect, expectTypeOf, vi } from 'vitest';
import type {
  AgentErrorEvent,
  ApprovalResolvedEvent,
  ChannelMessage,
  MessageHookEvent,
  MessageReceivedEvent,
  Session,
} from '@cogitator-ai/types';
import { createHookRegistry, type HookHandler, type HookName } from '../hooks';

const msg: ChannelMessage = {
  id: 'm1',
  channelType: 'telegram',
  channelId: 'c1',
  userId: 'u1',
  text: 'hello',
  raw: {},
};
const base: MessageHookEvent = { msg, threadId: 'telegram:u1' };
const session: Session = {
  id: 's1',
  userId: 'u1',
  channelType: 'telegram',
  channelId: 'c1',
  agentId: 'bot',
  status: 'active',
  messageCount: 0,
  metadata: {},
  lastActiveAt: new Date(0),
  createdAt: new Date(0),
};

describe('HookRegistry', () => {
  it('emits to registered handler', async () => {
    const registry = createHookRegistry();
    const handler = vi.fn();

    registry.on('message:received', handler);
    const event: MessageReceivedEvent = { ...base, user: { id: 'u1', channelType: 'telegram' } };
    await registry.emit('message:received', event);

    expect(handler).toHaveBeenCalledWith(event);
  });

  it('supports multiple handlers for the same hook', async () => {
    const registry = createHookRegistry();
    const h1 = vi.fn();
    const h2 = vi.fn();

    registry.on('agent:before_run', h1);
    registry.on('agent:before_run', h2);
    await registry.emit('agent:before_run', { ...base, agent: 'test' });

    expect(h1).toHaveBeenCalled();
    expect(h2).toHaveBeenCalled();
  });

  it('fires handlers in registration order', async () => {
    const registry = createHookRegistry();
    const order: number[] = [];

    registry.on('stream:started', () => {
      order.push(1);
    });
    registry.on('stream:started', () => {
      order.push(2);
    });
    registry.on('stream:started', () => {
      order.push(3);
    });

    await registry.emit('stream:started', base);

    expect(order).toEqual([1, 2, 3]);
  });

  it('supports async handlers', async () => {
    const registry = createHookRegistry();
    const results: string[] = [];

    registry.on('agent:after_run', async () => {
      await new Promise((r) => setTimeout(r, 10));
      results.push('async done');
    });

    await registry.emit('agent:after_run', { ...base, output: 'done' });

    expect(results).toEqual(['async done']);
  });

  it('isolates errors — one failing handler does not break others', async () => {
    const registry = createHookRegistry();
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const h1 = vi.fn();
    const h2 = vi.fn(() => {
      throw new Error('boom');
    });
    const h3 = vi.fn();

    registry.on('message:sent', h1);
    registry.on('message:sent', h2);
    registry.on('message:sent', h3);

    await registry.emit('message:sent', { ...base, text: 'hi', messageId: '1' });

    expect(h1).toHaveBeenCalled();
    expect(h2).toHaveBeenCalled();
    expect(h3).toHaveBeenCalled();
    expect(spy).toHaveBeenCalledWith(expect.stringContaining('"message:sent"'), expect.any(Error));

    spy.mockRestore();
  });

  it('isolates async errors', async () => {
    const registry = createHookRegistry();
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const after = vi.fn();

    registry.on('agent:error', async () => {
      throw new Error('async boom');
    });
    registry.on('agent:error', after);

    await registry.emit('agent:error', { ...base, error: new Error('run failed') });

    expect(after).toHaveBeenCalled();
    expect(spy).toHaveBeenCalled();

    spy.mockRestore();
  });

  it('off removes a handler', async () => {
    const registry = createHookRegistry();
    const handler = vi.fn();

    registry.on('session:created', handler);
    registry.off('session:created', handler);
    await registry.emit('session:created', { session, threadId: 'telegram:u1' });

    expect(handler).not.toHaveBeenCalled();
  });

  it('emit with no handlers does nothing', async () => {
    const registry = createHookRegistry();
    await registry.emit('session:compacted', {
      threadId: 'x',
      result: { sessionId: 's1', originalMessages: 2, compactedMessages: 2, summaryTokens: 0 },
    });
  });

  it('off on unregistered hook does not throw', () => {
    const registry = createHookRegistry();
    const handler = vi.fn();
    expect(() => registry.off('stream:finished', handler)).not.toThrow();
  });

  it('same handler registered twice fires once', async () => {
    const registry = createHookRegistry();
    const handler = vi.fn();

    registry.on('message:sending', handler);
    registry.on('message:sending', handler);
    await registry.emit('message:sending', { ...base, text: 'hi', channelId: 'c1' });

    expect(handler).toHaveBeenCalledTimes(1);
  });

  it('types each handler with the payload of its hook', async () => {
    const registry = createHookRegistry();
    const errors: string[] = [];

    registry.on('agent:error', (event) => {
      expectTypeOf(event).toEqualTypeOf<AgentErrorEvent>();
      errors.push(event.error.message);
    });
    registry.on('approval:resolved', (event) => {
      expectTypeOf(event).toEqualTypeOf<ApprovalResolvedEvent>();
    });
    await registry.emit('agent:error', { ...base, error: new Error('run failed') });

    expect(errors).toEqual(['run failed']);
  });

  it('still accepts handlers typed with an unknown payload', async () => {
    const registry = createHookRegistry();
    const seen: unknown[] = [];
    const legacy: HookHandler = (event) => {
      seen.push(event);
    };
    const hooks: HookName[] = ['stream:started', 'agent:after_run'];

    for (const hook of hooks) registry.on(hook, legacy);
    await registry.emit('stream:started', base);
    for (const hook of hooks) registry.off(hook, legacy);
    await registry.emit('stream:started', base);

    expect(seen).toEqual([base]);
  });
});
