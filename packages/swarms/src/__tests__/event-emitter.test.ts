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

      emitter.on('agent:start', () => {
        count++;
      });
      emitter.on('agent:start', () => {
        count++;
      });
      emitter.on('agent:start', () => {
        count++;
      });

      emitter.emit('agent:start');

      expect(count).toBe(3);
    });

    it('should return unsubscribe function', () => {
      let count = 0;

      const unsub = emitter.on('swarm:paused', () => {
        count++;
      });

      emitter.emit('swarm:paused');
      unsub();
      emitter.emit('swarm:paused');

      expect(count).toBe(1);
    });
  });

  describe('once', () => {
    it('should only fire once', () => {
      let count = 0;

      emitter.once('swarm:reset', () => {
        count++;
      });

      emitter.emit('swarm:reset');
      emitter.emit('swarm:reset');
      emitter.emit('swarm:reset');

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
      emitter.emit('debate:turn');

      expect(events).toHaveLength(3);
    });
  });

  describe('off', () => {
    it('should remove specific handler', () => {
      let count = 0;
      const handler = () => {
        count++;
      };

      emitter.on('swarm:paused', handler);
      emitter.emit('swarm:paused');

      emitter.off('swarm:paused', handler);
      emitter.emit('swarm:paused');

      expect(count).toBe(1);
    });
  });

  describe('removeAllListeners', () => {
    it('should remove all handlers for event', () => {
      let count = 0;

      emitter.on('swarm:paused', () => {
        count++;
      });
      emitter.on('swarm:paused', () => {
        count++;
      });
      emitter.on('swarm:resumed', () => {
        count++;
      });

      emitter.removeAllListeners('swarm:paused');

      emitter.emit('swarm:paused');
      emitter.emit('swarm:resumed');

      expect(count).toBe(1);
    });

    it('should remove all handlers when no event specified', () => {
      let count = 0;

      emitter.on('auction:start', () => {
        count++;
      });
      emitter.on('auction:bid', () => {
        count++;
      });
      emitter.on('auction:winner', () => {
        count++;
      });

      emitter.removeAllListeners();

      emitter.emit('auction:start');
      emitter.emit('auction:bid');
      emitter.emit('auction:winner');

      expect(count).toBe(0);
    });
  });

  describe('getEvents', () => {
    it('should return event history', () => {
      emitter.emit('consensus:round', { data: 1 });
      emitter.emit('consensus:vote', { data: 2 });
      emitter.emit('consensus:reached', { data: 3 });

      const events = emitter.getEvents();

      expect(events).toHaveLength(3);
      expect(events[0].type).toBe('consensus:round');
      expect(events[2].type).toBe('consensus:reached');
    });

    it('should include agent name in event', () => {
      emitter.emit('agent:start', { input: 'test' }, 'agent1');

      const events = emitter.getEvents();
      expect(events[0].agentName).toBe('agent1');
    });
  });

  describe('clearEvents', () => {
    it('should clear event history', () => {
      emitter.emit('consensus:round');
      emitter.emit('consensus:vote');

      emitter.clearEvents();

      expect(emitter.getEvents()).toHaveLength(0);
    });
  });
});
