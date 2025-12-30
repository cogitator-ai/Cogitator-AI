/**
 * Tests for SwarmEventEmitterImpl
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { SwarmEventEmitterImpl } from '../communication/event-emitter';

describe('SwarmEventEmitterImpl', () => {
  let emitter: SwarmEventEmitterImpl;

  beforeEach(() => {
    emitter = new SwarmEventEmitterImpl();
  });

  describe('on', () => {
    it('should register handler and receive events', () => {
      const events: string[] = [];

      emitter.on('swarm:start', (e) => {
        events.push(e.type);
      });

      emitter.emit('swarm:start', { name: 'test' });

      expect(events).toContain('swarm:start');
    });

    it('should support multiple handlers', () => {
      let count = 0;

      emitter.on('agent:start', () => count++);
      emitter.on('agent:start', () => count++);
      emitter.on('agent:start', () => count++);

      emitter.emit('agent:start');

      expect(count).toBe(3);
    });

    it('should return unsubscribe function', () => {
      let count = 0;

      const unsub = emitter.on('test', () => count++);

      emitter.emit('test');
      unsub();
      emitter.emit('test');

      expect(count).toBe(1);
    });
  });

  describe('once', () => {
    it('should only fire once', () => {
      let count = 0;

      emitter.once('once:event', () => count++);

      emitter.emit('once:event');
      emitter.emit('once:event');
      emitter.emit('once:event');

      expect(count).toBe(1);
    });
  });

  describe('wildcard', () => {
    it('should receive all events with *', () => {
      const events: string[] = [];

      emitter.on('*', (e) => {
        events.push(e.type);
      });

      emitter.emit('swarm:start');
      emitter.emit('agent:complete');
      emitter.emit('custom:event');

      expect(events).toHaveLength(3);
    });
  });

  describe('off', () => {
    it('should remove specific handler', () => {
      let count = 0;
      const handler = () => count++;

      emitter.on('test', handler);
      emitter.emit('test');

      emitter.off('test', handler);
      emitter.emit('test');

      expect(count).toBe(1);
    });
  });

  describe('removeAllListeners', () => {
    it('should remove all handlers for event', () => {
      let count = 0;

      emitter.on('test', () => count++);
      emitter.on('test', () => count++);
      emitter.on('other', () => count++);

      emitter.removeAllListeners('test');

      emitter.emit('test');
      emitter.emit('other');

      expect(count).toBe(1);
    });

    it('should remove all handlers when no event specified', () => {
      let count = 0;

      emitter.on('a', () => count++);
      emitter.on('b', () => count++);
      emitter.on('c', () => count++);

      emitter.removeAllListeners();

      emitter.emit('a');
      emitter.emit('b');
      emitter.emit('c');

      expect(count).toBe(0);
    });
  });

  describe('getEvents', () => {
    it('should return event history', () => {
      emitter.emit('event1', { data: 1 });
      emitter.emit('event2', { data: 2 });
      emitter.emit('event3', { data: 3 });

      const events = emitter.getEvents();

      expect(events).toHaveLength(3);
      expect(events[0].type).toBe('event1');
      expect(events[2].type).toBe('event3');
    });

    it('should include agent name in event', () => {
      emitter.emit('agent:start', { input: 'test' }, 'agent1');

      const events = emitter.getEvents();
      expect(events[0].agentName).toBe('agent1');
    });
  });

  describe('clearEvents', () => {
    it('should clear event history', () => {
      emitter.emit('event1');
      emitter.emit('event2');

      emitter.clearEvents();

      expect(emitter.getEvents()).toHaveLength(0);
    });
  });
});
