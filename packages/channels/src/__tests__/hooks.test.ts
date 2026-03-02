import { describe, it, expect, vi } from 'vitest';
import { createHookRegistry } from '../hooks';

describe('HookRegistry', () => {
  it('emits to registered handler', async () => {
    const registry = createHookRegistry();
    const handler = vi.fn();

    registry.on('message:received', handler);
    await registry.emit('message:received', { text: 'hello' });

    expect(handler).toHaveBeenCalledWith({ text: 'hello' });
  });

  it('supports multiple handlers for the same hook', async () => {
    const registry = createHookRegistry();
    const h1 = vi.fn();
    const h2 = vi.fn();

    registry.on('agent:before_run', h1);
    registry.on('agent:before_run', h2);
    await registry.emit('agent:before_run', { agent: 'test' });

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

    await registry.emit('stream:started', {});

    expect(order).toEqual([1, 2, 3]);
  });

  it('supports async handlers', async () => {
    const registry = createHookRegistry();
    const results: string[] = [];

    registry.on('agent:after_run', async () => {
      await new Promise((r) => setTimeout(r, 10));
      results.push('async done');
    });

    await registry.emit('agent:after_run', {});

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

    await registry.emit('message:sent', { id: '1' });

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

    await registry.emit('agent:error', {});

    expect(after).toHaveBeenCalled();
    expect(spy).toHaveBeenCalled();

    spy.mockRestore();
  });

  it('off removes a handler', async () => {
    const registry = createHookRegistry();
    const handler = vi.fn();

    registry.on('session:created', handler);
    registry.off('session:created', handler);
    await registry.emit('session:created', {});

    expect(handler).not.toHaveBeenCalled();
  });

  it('emit with no handlers does nothing', async () => {
    const registry = createHookRegistry();
    await registry.emit('session:compacted', { threadId: 'x' });
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
    await registry.emit('message:sending', {});

    expect(handler).toHaveBeenCalledTimes(1);
  });
});
