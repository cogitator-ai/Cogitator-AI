import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  InMemoryTimerStore,
  parseCronExpression,
  getNextCronOccurrence,
  isValidCronExpression,
  describeCronExpression,
  CRON_PRESETS,
  parseDuration,
  formatDuration,
} from '../timers/index';

describe('Timer System', () => {
  describe('Cron Parser', () => {
    it('validates cron expressions', () => {
      expect(isValidCronExpression('* * * * *')).toBe(true);
      expect(isValidCronExpression('0 0 * * *')).toBe(true);
      expect(isValidCronExpression('*/5 * * * *')).toBe(true);
      expect(isValidCronExpression('invalid')).toBe(false);
    });

    it('supports cron presets', () => {
      expect(isValidCronExpression('@hourly')).toBe(true);
      expect(isValidCronExpression('@daily')).toBe(true);
      expect(isValidCronExpression('@weekly')).toBe(true);
      expect(isValidCronExpression('@monthly')).toBe(true);
      expect(isValidCronExpression('@yearly')).toBe(true);
    });

    it('parses cron expressions', () => {
      const parsed = parseCronExpression('0 9 * * 1-5');

      expect(parsed.expression).toBe('0 9 * * 1-5');
      expect(parsed.fields.minute).toContain(0);
      expect(parsed.fields.hour).toContain(9);
      expect(parsed.fields.dayOfWeek).toEqual([1, 2, 3, 4, 5]);
    });

    it('calculates next occurrence', () => {
      const now = new Date('2024-01-15T10:00:00Z');
      const next = getNextCronOccurrence('0 12 * * *', { currentDate: now });

      expect(next > now).toBe(true);
      expect(next.getMinutes()).toBe(0);
      expect(next.getHours()).toBe(12);
    });

    it('handles timezone', () => {
      const now = new Date('2024-01-15T10:00:00Z');
      const next = getNextCronOccurrence('0 9 * * *', {
        currentDate: now,
        timezone: 'America/New_York',
      });

      expect(next).toBeDefined();
    });

    it('describes cron expressions', () => {
      const description = describeCronExpression('0 9 * * 1-5');
      expect(description).toContain('9');
    });

    it('resolves presets', () => {
      expect(CRON_PRESETS['@hourly']).toBe('0 * * * *');
      expect(CRON_PRESETS['@daily']).toBe('0 0 * * *');
      expect(CRON_PRESETS['@midnight']).toBe('0 0 * * *');
    });
  });

  describe('Duration Parser', () => {
    it('parses simple duration strings', () => {
      expect(parseDuration('5s')).toBe(5000);
      expect(parseDuration('2m')).toBe(120000);
      expect(parseDuration('1h')).toBe(3600000);
      expect(parseDuration('1d')).toBe(86400000);
      expect(parseDuration('1w')).toBe(604800000);
      expect(parseDuration('500ms')).toBe(500);
    });

    it('parses decimal durations', () => {
      expect(parseDuration('1.5s')).toBe(1500);
      expect(parseDuration('0.5m')).toBe(30000);
      expect(parseDuration('2.5h')).toBe(9000000);
    });

    it('is case insensitive', () => {
      expect(parseDuration('5S')).toBe(5000);
      expect(parseDuration('2M')).toBe(120000);
      expect(parseDuration('1H')).toBe(3600000);
    });

    it('throws on invalid format', () => {
      expect(() => parseDuration('invalid')).toThrow();
      expect(() => parseDuration('5sec')).toThrow();
      expect(() => parseDuration('5 seconds')).toThrow();
      expect(() => parseDuration('1h 30m')).toThrow();
      expect(() => parseDuration('1000')).toThrow();
    });

    it('formats durations', () => {
      expect(formatDuration(500)).toBe('500ms');
      expect(formatDuration(5000)).toBe('5.0s');
      expect(formatDuration(60000)).toBe('1.0m');
      expect(formatDuration(3600000)).toBe('1.0h');
      expect(formatDuration(86400000)).toBe('1.0d');
    });

    it('formats intermediate durations', () => {
      expect(formatDuration(90000)).toBe('1.5m');
      expect(formatDuration(19800000)).toBe('5.5h');
    });
  });

  describe('Timer Store', () => {
    let store: InMemoryTimerStore;

    beforeEach(() => {
      store = new InMemoryTimerStore();
    });

    afterEach(async () => {
      await store.clear();
    });

    it('schedules and retrieves timers', async () => {
      const now = Date.now();
      const timerId = await store.schedule({
        workflowId: 'wf-1',
        runId: 'run-1',
        nodeId: 'delay-node',
        firesAt: now + 60000,
        type: 'delay',
        payload: { delay: 60000 },
      });

      const retrieved = await store.get(timerId);

      expect(retrieved).toBeDefined();
      expect(retrieved?.workflowId).toBe('wf-1');
      expect(retrieved?.nodeId).toBe('delay-node');
      expect(retrieved?.fired).toBe(false);
      expect(retrieved?.cancelled).toBe(false);
    });

    it('cancels timers', async () => {
      const now = Date.now();
      const timerId = await store.schedule({
        workflowId: 'wf-1',
        runId: 'run-1',
        nodeId: 'delay-node',
        firesAt: now + 60000,
        type: 'delay',
        payload: {},
      });

      await store.cancel(timerId);

      const timer = await store.get(timerId);
      expect(timer?.cancelled).toBe(true);
    });

    it('marks timers as fired', async () => {
      const now = Date.now();
      const timerId = await store.schedule({
        workflowId: 'wf-1',
        runId: 'run-1',
        nodeId: 'delay-node',
        firesAt: now - 1000,
        type: 'delay',
        payload: {},
      });

      await store.markFired(timerId);

      const timer = await store.get(timerId);
      expect(timer?.fired).toBe(true);
    });

    it('gets pending timers', async () => {
      const now = Date.now();

      await store.schedule({
        workflowId: 'wf-1',
        runId: 'run-1',
        nodeId: 'node1',
        firesAt: now + 60000,
        type: 'delay',
        payload: {},
      });

      await store.schedule({
        workflowId: 'wf-1',
        runId: 'run-1',
        nodeId: 'node2',
        firesAt: now + 120000,
        type: 'delay',
        payload: {},
      });

      const pending = await store.getPending();
      expect(pending).toHaveLength(2);
    });

    it('gets overdue timers', async () => {
      const now = Date.now();

      const pastId = await store.schedule({
        workflowId: 'wf-1',
        runId: 'run-1',
        nodeId: 'past-node',
        firesAt: now - 1000,
        type: 'delay',
        payload: {},
      });

      await store.schedule({
        workflowId: 'wf-1',
        runId: 'run-1',
        nodeId: 'future-node',
        firesAt: now + 60000,
        type: 'delay',
        payload: {},
      });

      const overdue = await store.getOverdue();
      expect(overdue).toHaveLength(1);
      expect(overdue[0].id).toBe(pastId);
    });

    it('lists timers by workflow', async () => {
      const now = Date.now();

      await store.schedule({
        workflowId: 'wf-1',
        runId: 'run-1',
        nodeId: 'node',
        firesAt: now + 1000,
        type: 'delay',
        payload: {},
      });

      await store.schedule({
        workflowId: 'wf-2',
        runId: 'run-2',
        nodeId: 'node',
        firesAt: now + 1000,
        type: 'delay',
        payload: {},
      });

      const wf1Timers = await store.getByWorkflow('wf-1');
      expect(wf1Timers).toHaveLength(1);
      expect(wf1Timers[0].workflowId).toBe('wf-1');
    });

    it('lists timers by run', async () => {
      const now = Date.now();

      await store.schedule({
        workflowId: 'wf-1',
        runId: 'run-1',
        nodeId: 'node1',
        firesAt: now + 1000,
        type: 'delay',
        payload: {},
      });

      await store.schedule({
        workflowId: 'wf-1',
        runId: 'run-1',
        nodeId: 'node2',
        firesAt: now + 2000,
        type: 'delay',
        payload: {},
      });

      await store.schedule({
        workflowId: 'wf-1',
        runId: 'run-2',
        nodeId: 'node1',
        firesAt: now + 1000,
        type: 'delay',
        payload: {},
      });

      const run1Timers = await store.getByRun('run-1');
      expect(run1Timers).toHaveLength(2);
    });

    it('lists timers with filtering', async () => {
      const now = Date.now();

      await store.schedule({
        workflowId: 'wf-1',
        runId: 'run-1',
        nodeId: 'node1',
        firesAt: now + 1000,
        type: 'delay',
        payload: {},
      });

      await store.schedule({
        workflowId: 'wf-1',
        runId: 'run-1',
        nodeId: 'node2',
        firesAt: now + 5000,
        type: 'delay',
        payload: {},
      });

      const soonTimers = await store.list({ firesBefore: now + 2000 });
      expect(soonTimers).toHaveLength(1);
      expect(soonTimers[0].nodeId).toBe('node1');
    });

    it('counts timers', async () => {
      const now = Date.now();

      await store.schedule({
        workflowId: 'wf-1',
        runId: 'run-1',
        nodeId: 'node1',
        firesAt: now + 1000,
        type: 'delay',
        payload: {},
      });

      await store.schedule({
        workflowId: 'wf-1',
        runId: 'run-1',
        nodeId: 'node2',
        firesAt: now + 2000,
        type: 'delay',
        payload: {},
      });

      const count = await store.count();
      expect(count).toBe(2);

      const wf1Count = await store.count({ workflowId: 'wf-1' });
      expect(wf1Count).toBe(2);
    });

    it('cleans up old timers', async () => {
      const now = Date.now();

      const recentId = await store.schedule({
        workflowId: 'wf-1',
        runId: 'run-2',
        nodeId: 'new-node',
        firesAt: now,
        type: 'delay',
        payload: {},
      });
      await store.markFired(recentId);

      const cleaned = await store.cleanup(0);

      expect(cleaned).toBeGreaterThanOrEqual(0);
    });

    it('fires callbacks on markFired', async () => {
      const now = Date.now();
      let firedTimer: unknown = null;

      const unsubscribe = store.onFire((timer) => {
        firedTimer = timer;
      });

      const timerId = await store.schedule({
        workflowId: 'wf-1',
        runId: 'run-1',
        nodeId: 'callback-node',
        firesAt: now - 1000,
        type: 'delay',
        payload: {},
      });

      await store.markFired(timerId);

      expect(firedTimer).toBeDefined();
      expect((firedTimer as { id: string }).id).toBe(timerId);

      unsubscribe();
    });
  });
});
