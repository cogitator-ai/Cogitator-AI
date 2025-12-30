/**
 * Tests for InMemoryBlackboard
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { InMemoryBlackboard } from '../communication/blackboard';

describe('InMemoryBlackboard', () => {
  let blackboard: InMemoryBlackboard;

  beforeEach(() => {
    blackboard = new InMemoryBlackboard({
      enabled: true,
      sections: {},
      trackHistory: true,
    });
  });

  describe('read/write', () => {
    it('should write and read data', () => {
      blackboard.write('test', { value: 42 }, 'agent1');
      const result = blackboard.read<{ value: number }>('test');
      expect(result.value).toBe(42);
    });

    it('should overwrite existing section', () => {
      blackboard.write('test', { value: 1 }, 'agent1');
      blackboard.write('test', { value: 2 }, 'agent2');
      const result = blackboard.read<{ value: number }>('test');
      expect(result.value).toBe(2);
    });

    it('should throw when reading non-existent section', () => {
      expect(() => blackboard.read('nonexistent')).toThrow(
        "Blackboard section 'nonexistent' not found"
      );
    });

    it('should throw when disabled', () => {
      const disabled = new InMemoryBlackboard({
        enabled: false,
        sections: {},
      });
      expect(() => disabled.write('test', {}, 'agent')).toThrow(
        'Blackboard is not enabled'
      );
    });
  });

  describe('append', () => {
    it('should create array section if not exists', () => {
      blackboard.append('list', 'item1', 'agent1');
      const result = blackboard.read<string[]>('list');
      expect(result).toEqual(['item1']);
    });

    it('should append to existing array', () => {
      blackboard.write('list', ['a', 'b'], 'agent1');
      blackboard.append('list', 'c', 'agent2');
      const result = blackboard.read<string[]>('list');
      expect(result).toEqual(['a', 'b', 'c']);
    });

    it('should throw when appending to non-array', () => {
      blackboard.write('obj', { key: 'value' }, 'agent1');
      expect(() => blackboard.append('obj', 'item', 'agent2')).toThrow(
        "Section 'obj' is not an array, cannot append"
      );
    });
  });

  describe('has/delete', () => {
    it('should check if section exists', () => {
      expect(blackboard.has('test')).toBe(false);
      blackboard.write('test', {}, 'agent1');
      expect(blackboard.has('test')).toBe(true);
    });

    it('should delete section', () => {
      blackboard.write('test', {}, 'agent1');
      blackboard.delete('test');
      expect(blackboard.has('test')).toBe(false);
    });
  });

  describe('subscriptions', () => {
    it('should notify subscribers on write', () => {
      const received: unknown[] = [];
      blackboard.subscribe('test', (data) => {
        received.push(data);
      });

      blackboard.write('test', { a: 1 }, 'agent1');
      blackboard.write('test', { b: 2 }, 'agent2');

      expect(received).toHaveLength(2);
      expect(received[0]).toEqual({ a: 1 });
      expect(received[1]).toEqual({ b: 2 });
    });

    it('should allow unsubscription', () => {
      const received: unknown[] = [];
      const unsub = blackboard.subscribe('test', (data) => {
        received.push(data);
      });

      blackboard.write('test', { a: 1 }, 'agent1');
      unsub();
      blackboard.write('test', { b: 2 }, 'agent2');

      expect(received).toHaveLength(1);
    });
  });

  describe('sections', () => {
    it('should return all section names', () => {
      blackboard.write('a', {}, 'agent');
      blackboard.write('b', {}, 'agent');
      blackboard.write('c', {}, 'agent');

      const sections = blackboard.getSections();
      expect(sections).toContain('a');
      expect(sections).toContain('b');
      expect(sections).toContain('c');
    });

    it('should return section with metadata', () => {
      blackboard.write('test', { key: 'value' }, 'agent1');
      const section = blackboard.getSection('test');

      expect(section).toBeDefined();
      expect(section!.name).toBe('test');
      expect(section!.data).toEqual({ key: 'value' });
      expect(section!.modifiedBy).toBe('agent1');
      expect(section!.version).toBe(1);
    });
  });

  describe('history', () => {
    it('should track history when enabled', () => {
      blackboard.write('test', { v: 1 }, 'agent1');
      blackboard.write('test', { v: 2 }, 'agent2');
      blackboard.write('test', { v: 3 }, 'agent3');

      const history = blackboard.getHistory('test');
      expect(history).toHaveLength(3);
      expect(history[0].version).toBe(1);
      expect(history[1].version).toBe(2);
      expect(history[2].version).toBe(3);
    });

    it('should not track history when disabled', () => {
      const noHistory = new InMemoryBlackboard({
        enabled: true,
        sections: {},
        trackHistory: false,
      });

      noHistory.write('test', { v: 1 }, 'agent1');
      noHistory.write('test', { v: 2 }, 'agent2');

      const history = noHistory.getHistory('test');
      expect(history).toHaveLength(0);
    });
  });

  describe('clear', () => {
    it('should remove all sections', () => {
      blackboard.write('a', {}, 'agent');
      blackboard.write('b', {}, 'agent');
      blackboard.clear();

      expect(blackboard.getSections()).toHaveLength(0);
    });
  });

  describe('initial sections', () => {
    it('should initialize with provided sections', () => {
      const withSections = new InMemoryBlackboard({
        enabled: true,
        sections: {
          tasks: [],
          config: { maxRetries: 3 },
        },
        trackHistory: true,
      });

      expect(withSections.read<unknown[]>('tasks')).toEqual([]);
      expect(withSections.read<{ maxRetries: number }>('config').maxRetries).toBe(3);
    });
  });
});
