import { describe, it, expect, vi } from 'vitest';
import { SelfModifyingEventEmitter } from '../events';
import type { SelfModifyingEvent } from '@cogitator-ai/types';

function makeEvent(type: string): SelfModifyingEvent {
  return { type, runId: 'test', timestamp: new Date(), data: {} } as SelfModifyingEvent;
}

describe('SelfModifyingEventEmitter', () => {
  it('emits to specific type handlers', async () => {
    const emitter = new SelfModifyingEventEmitter();
    const handler = vi.fn();

    emitter.on('run_started', handler);
    await emitter.emit(makeEvent('run_started'));

    expect(handler).toHaveBeenCalledOnce();
  });

  it('emits to wildcard handlers', async () => {
    const emitter = new SelfModifyingEventEmitter();
    const handler = vi.fn();

    emitter.on('*', handler);
    await emitter.emit(makeEvent('run_started'));
    await emitter.emit(makeEvent('run_completed'));

    expect(handler).toHaveBeenCalledTimes(2);
  });

  it('does not call handlers for different event types', async () => {
    const emitter = new SelfModifyingEventEmitter();
    const handler = vi.fn();

    emitter.on('run_started', handler);
    await emitter.emit(makeEvent('run_completed'));

    expect(handler).not.toHaveBeenCalled();
  });

  it('removes handler with off()', async () => {
    const emitter = new SelfModifyingEventEmitter();
    const handler = vi.fn();

    emitter.on('run_started', handler);
    emitter.off('run_started', handler);
    await emitter.emit(makeEvent('run_started'));

    expect(handler).not.toHaveBeenCalled();
  });

  it('returns unsubscribe function from on()', async () => {
    const emitter = new SelfModifyingEventEmitter();
    const handler = vi.fn();

    const unsub = emitter.on('run_started', handler);
    unsub();
    await emitter.emit(makeEvent('run_started'));

    expect(handler).not.toHaveBeenCalled();
  });

  it('survives handler errors with Promise.allSettled', async () => {
    const emitter = new SelfModifyingEventEmitter();
    const goodHandler = vi.fn();
    const badHandler = vi.fn(() => {
      throw new Error('boom');
    });

    emitter.on('run_started', badHandler);
    emitter.on('run_started', goodHandler);

    await emitter.emit(makeEvent('run_started'));

    expect(badHandler).toHaveBeenCalled();
    expect(goodHandler).toHaveBeenCalled();
  });

  it('removeAllListeners clears specific event', () => {
    const emitter = new SelfModifyingEventEmitter();
    emitter.on('run_started', vi.fn());
    emitter.on('run_completed', vi.fn());

    emitter.removeAllListeners('run_started');

    expect(emitter.listenerCount('run_started')).toBe(0);
    expect(emitter.listenerCount('run_completed')).toBe(1);
  });

  it('removeAllListeners clears all events', () => {
    const emitter = new SelfModifyingEventEmitter();
    emitter.on('run_started', vi.fn());
    emitter.on('run_completed', vi.fn());
    emitter.on('*', vi.fn());

    emitter.removeAllListeners();

    expect(emitter.listenerCount('run_started')).toBe(0);
    expect(emitter.listenerCount('run_completed')).toBe(0);
    expect(emitter.listenerCount('*')).toBe(0);
  });

  it('listenerCount returns correct count', () => {
    const emitter = new SelfModifyingEventEmitter();
    expect(emitter.listenerCount('run_started')).toBe(0);

    emitter.on('run_started', vi.fn());
    emitter.on('run_started', vi.fn());

    expect(emitter.listenerCount('run_started')).toBe(2);
  });
});
