import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  TokenBucket,
  type RateLimiter,
  SlidingWindowRateLimiter,
  createRateLimiter,
  CronTriggerExecutor,
  createCronTrigger,
  validateCronTriggerConfig,
  WebhookTriggerExecutor,
  createWebhookTrigger,
  validateWebhookTriggerConfig,
  type DefaultTriggerManager,
  createTriggerManager,
  cronTrigger,
  webhookTrigger,
  eventTrigger,
} from '../triggers/index';
import type { CronTriggerConfig, WebhookTriggerConfig, TriggerContext } from '@cogitator-ai/types';

describe('Triggers', () => {
  describe('Rate Limiter', () => {
    describe('TokenBucket', () => {
      it('allows requests within capacity', () => {
        const bucket = new TokenBucket({
          capacity: 10,
          window: 1000,
        });

        for (let i = 0; i < 10; i++) {
          const result = bucket.consume();
          expect(result.allowed).toBe(true);
          expect(result.remaining).toBe(9 - i);
        }
      });

      it('rejects requests when exhausted', () => {
        const bucket = new TokenBucket({
          capacity: 3,
          window: 1000,
        });

        bucket.consume();
        bucket.consume();
        bucket.consume();

        const result = bucket.consume();
        expect(result.allowed).toBe(false);
        expect(result.retryAfter).toBeDefined();
      });

      it('refills over time', async () => {
        const bucket = new TokenBucket({
          capacity: 2,
          window: 100,
        });

        bucket.consume();
        bucket.consume();

        await new Promise(resolve => setTimeout(resolve, 150));

        const result = bucket.consume();
        expect(result.allowed).toBe(true);
      });

      it('respects burst limit', () => {
        const bucket = new TokenBucket({
          capacity: 10,
          window: 1000,
          burstLimit: 3,
        });

        const result = bucket.consume(5);
        expect(result.allowed).toBe(false);
      });
    });

    describe('RateLimiter', () => {
      let limiter: RateLimiter;

      beforeEach(() => {
        limiter = createRateLimiter({
          capacity: 5,
          window: 1000,
        });
      });

      afterEach(() => {
        limiter.dispose();
      });

      it('tracks separate buckets per key', () => {
        for (let i = 0; i < 5; i++) {
          limiter.consume('client-a');
        }

        expect(limiter.consume('client-a').allowed).toBe(false);

        expect(limiter.consume('client-b').allowed).toBe(true);
      });

      it('resets specific keys', () => {
        for (let i = 0; i < 5; i++) {
          limiter.consume('client');
        }

        expect(limiter.consume('client').allowed).toBe(false);

        limiter.reset('client');

        expect(limiter.consume('client').allowed).toBe(true);
      });
    });

    describe('SlidingWindowRateLimiter', () => {
      let limiter: SlidingWindowRateLimiter;

      beforeEach(() => {
        limiter = new SlidingWindowRateLimiter(3, 100);
      });

      afterEach(() => {
        limiter.dispose();
      });

      it('limits requests per window', () => {
        expect(limiter.consume('key').allowed).toBe(true);
        expect(limiter.consume('key').allowed).toBe(true);
        expect(limiter.consume('key').allowed).toBe(true);
        expect(limiter.consume('key').allowed).toBe(false);
      });

      it('allows requests after window expires', async () => {
        limiter.consume('key');
        limiter.consume('key');
        limiter.consume('key');

        await new Promise(resolve => setTimeout(resolve, 150));

        expect(limiter.consume('key').allowed).toBe(true);
      });
    });
  });

  describe('Cron Trigger', () => {
    let executor: CronTriggerExecutor;

    beforeEach(() => {
      executor = createCronTrigger();
    });

    afterEach(() => {
      executor.dispose();
    });

    it('validates cron configs', () => {
      const valid: CronTriggerConfig = {
        expression: '* * * * *',
        enabled: true,
      };
      expect(validateCronTriggerConfig(valid)).toHaveLength(0);

      const invalid: CronTriggerConfig = {
        expression: 'invalid',
        enabled: true,
      };
      expect(validateCronTriggerConfig(invalid).length).toBeGreaterThan(0);
    });

    it('registers and unregisters triggers', () => {
      const id = executor.register('test-workflow', {
        expression: '* * * * *',
        enabled: true,
      });

      expect(executor.getState(id)).toBeDefined();

      executor.unregister(id);

      expect(executor.getState(id)).toBeUndefined();
    });

    it('enables and disables triggers', () => {
      const id = executor.register('test-workflow', {
        expression: '* * * * *',
        enabled: false,
      });

      expect(executor.getState(id)?.enabled).toBe(false);

      executor.enable(id);
      expect(executor.getState(id)?.enabled).toBe(true);

      executor.disable(id);
      expect(executor.getState(id)?.enabled).toBe(false);
    });

    it('fires triggers and tracks count', async () => {
      const onFire = vi.fn().mockResolvedValue('run-123');
      const execWithFire = new CronTriggerExecutor({ onFire });

      const id = execWithFire.register('test-workflow', {
        expression: '* * * * *',
        enabled: true,
      });

      await execWithFire.fire(id);

      expect(onFire).toHaveBeenCalled();
      expect(execWithFire.getState(id)?.runCount).toBe(1);

      execWithFire.dispose();
    });

    it('respects condition', async () => {
      const onFire = vi.fn().mockResolvedValue('run-123');
      const execWithFire = new CronTriggerExecutor({ onFire });

      const id = execWithFire.register('test-workflow', {
        expression: '* * * * *',
        enabled: true,
        condition: () => false,
      });

      const result = await execWithFire.fire(id);

      expect(result.skipped).toBe(true);
      expect(onFire).not.toHaveBeenCalled();

      execWithFire.dispose();
    });

    it('respects maxConcurrent', async () => {
      const onFire = vi.fn(async () => {
        await new Promise(resolve => setTimeout(resolve, 100));
        return 'run-id';
      });
      const execWithFire = new CronTriggerExecutor({ onFire });

      const id = execWithFire.register('test-workflow', {
        expression: '* * * * *',
        enabled: true,
        maxConcurrent: 1,
      });

      const fire1 = execWithFire.fire(id);

      const result2 = await execWithFire.fire(id);

      expect(result2.skipped).toBe(true);
      expect(result2.reason).toContain('Max concurrent');

      await fire1;
      execWithFire.dispose();
    });
  });

  describe('Webhook Trigger', () => {
    let executor: WebhookTriggerExecutor;

    beforeEach(() => {
      executor = createWebhookTrigger();
    });

    afterEach(() => {
      executor.dispose();
    });

    it('validates webhook configs', () => {
      const valid: WebhookTriggerConfig = {
        path: '/webhook',
        method: 'POST',
      };
      expect(validateWebhookTriggerConfig(valid)).toHaveLength(0);

      const invalid: WebhookTriggerConfig = {
        path: 'no-slash',
        method: 'POST',
      };
      expect(validateWebhookTriggerConfig(invalid).length).toBeGreaterThan(0);
    });

    it('registers webhooks and handles requests', async () => {
      const onFire = vi.fn().mockResolvedValue('run-123');
      const exec = new WebhookTriggerExecutor({ onFire });

      exec.register('test-workflow', {
        path: '/test',
        method: 'POST',
      });

      const result = await exec.handle({
        method: 'POST',
        path: '/test',
        headers: {},
        body: { data: 'test' },
      });

      expect(result?.triggered).toBe(true);
      expect(result?.response.status).toBe(202);
      expect(onFire).toHaveBeenCalled();

      exec.dispose();
    });

    it('returns null for unregistered paths', async () => {
      const result = await executor.handle({
        method: 'POST',
        path: '/unknown',
        headers: {},
      });

      expect(result).toBeNull();
    });

    it('authenticates with bearer token', async () => {
      const exec = createWebhookTrigger();

      exec.register('test-workflow', {
        path: '/secure',
        method: 'POST',
        auth: {
          type: 'bearer',
          secret: 'my-secret-token',
        },
      });

      const noAuth = await exec.handle({
        method: 'POST',
        path: '/secure',
        headers: {},
      });
      expect(noAuth?.response.status).toBe(401);

      const wrongToken = await exec.handle({
        method: 'POST',
        path: '/secure',
        headers: { authorization: 'Bearer wrong-token' },
      });
      expect(wrongToken?.response.status).toBe(401);

      const correct = await exec.handle({
        method: 'POST',
        path: '/secure',
        headers: { authorization: 'Bearer my-secret-token' },
      });
      expect(correct?.response.status).toBe(202);

      exec.dispose();
    });

    it('authenticates with API key', async () => {
      const exec = createWebhookTrigger();

      exec.register('test-workflow', {
        path: '/api-secure',
        method: 'POST',
        auth: {
          type: 'api-key',
          secret: 'api-key-123',
          headerName: 'x-api-key',
        },
      });

      const result = await exec.handle({
        method: 'POST',
        path: '/api-secure',
        headers: { 'x-api-key': 'api-key-123' },
      });

      expect(result?.response.status).toBe(202);

      exec.dispose();
    });

    it('applies rate limiting', async () => {
      const exec = createWebhookTrigger();

      exec.register('test-workflow', {
        path: '/limited',
        method: 'POST',
        rateLimit: {
          requests: 2,
          window: 1000,
        },
      });

      await exec.handle({ method: 'POST', path: '/limited', headers: {}, ip: 'client1' });
      await exec.handle({ method: 'POST', path: '/limited', headers: {}, ip: 'client1' });

      const result = await exec.handle({
        method: 'POST',
        path: '/limited',
        headers: {},
        ip: 'client1',
      });

      expect(result?.response.status).toBe(429);

      exec.dispose();
    });

    it('deduplicates requests', async () => {
      const onFire = vi.fn().mockResolvedValue('run-123');
      const exec = new WebhookTriggerExecutor({ onFire });

      exec.register('test-workflow', {
        path: '/dedup',
        method: 'POST',
        deduplicationKey: (payload: unknown) => (payload as { id: string }).id,
        deduplicationWindow: 1000,
      });

      await exec.handle({
        method: 'POST',
        path: '/dedup',
        headers: {},
        body: { id: 'same-id', data: 'first' },
      });

      const result = await exec.handle({
        method: 'POST',
        path: '/dedup',
        headers: {},
        body: { id: 'same-id', data: 'second' },
      });

      expect(result?.triggered).toBe(false);
      expect(onFire).toHaveBeenCalledTimes(1);

      exec.dispose();
    });

    it('validates payload', async () => {
      const exec = createWebhookTrigger();

      exec.register('test-workflow', {
        path: '/validated',
        method: 'POST',
        validatePayload: (payload) => {
          const p = payload as { required?: string };
          return typeof p?.required === 'string';
        },
      });

      const invalid = await exec.handle({
        method: 'POST',
        path: '/validated',
        headers: {},
        body: { wrong: 'field' },
      });
      expect(invalid?.response.status).toBe(400);

      const valid = await exec.handle({
        method: 'POST',
        path: '/validated',
        headers: {},
        body: { required: 'value' },
      });
      expect(valid?.response.status).toBe(202);

      exec.dispose();
    });

    it('transforms payload', async () => {
      const onFire = vi.fn().mockResolvedValue('run-123');
      const exec = new WebhookTriggerExecutor({ onFire });

      exec.register('test-workflow', {
        path: '/transform',
        method: 'POST',
        transformPayload: (payload) => ({
          transformed: true,
          original: payload,
        }),
      });

      await exec.handle({
        method: 'POST',
        path: '/transform',
        headers: {},
        body: { data: 'original' },
      });

      const context = onFire.mock.calls[0][1] as TriggerContext;
      expect(context.payload).toEqual({
        transformed: true,
        original: { data: 'original' },
      });

      exec.dispose();
    });
  });

  describe('Trigger Manager', () => {
    let manager: DefaultTriggerManager;

    beforeEach(() => {
      manager = createTriggerManager();
      manager.start();
    });

    afterEach(() => {
      manager.dispose();
    });

    it('registers and lists triggers', async () => {
      const id = await manager.register({
        workflowName: 'test-workflow',
        type: 'cron',
        config: cronTrigger('* * * * *'),
        enabled: true,
      });

      const triggers = await manager.list();
      expect(triggers).toHaveLength(1);
      expect(triggers[0].id).toBe(id);
    });

    it('enables and disables triggers', async () => {
      const id = await manager.register({
        workflowName: 'test-workflow',
        type: 'cron',
        config: cronTrigger('* * * * *'),
        enabled: true,
      });

      await manager.disable(id);
      let trigger = await manager.get(id);
      expect(trigger?.enabled).toBe(false);

      await manager.enable(id);
      trigger = await manager.get(id);
      expect(trigger?.enabled).toBe(true);
    });

    it('unregisters triggers', async () => {
      const id = await manager.register({
        workflowName: 'test-workflow',
        type: 'webhook',
        config: webhookTrigger('/test'),
        enabled: true,
      });

      await manager.unregister(id);

      const trigger = await manager.get(id);
      expect(trigger).toBeNull();
    });

    it('fires triggers manually', async () => {
      const callback = vi.fn();
      manager.onTrigger(callback);

      const id = await manager.register({
        workflowName: 'test-workflow',
        type: 'cron',
        config: cronTrigger('* * * * *'),
        enabled: true,
      });

      await manager.fire(id);

      expect(callback).toHaveBeenCalled();
      const [trigger, context] = callback.mock.calls[0];
      expect(trigger.id).toBe(id);
      expect(context.triggerType).toBe('manual');
    });

    it('handles webhook requests', async () => {
      await manager.register({
        workflowName: 'test-workflow',
        type: 'webhook',
        config: webhookTrigger('/api/webhook', 'POST'),
        enabled: true,
      });

      const result = await manager.handleWebhook({
        method: 'POST',
        path: '/api/webhook',
        headers: {},
        body: { test: true },
      });

      expect(result?.triggered).toBe(true);
    });

    it('emits events for event triggers', async () => {
      const callback = vi.fn();
      manager.onTrigger(callback);

      await manager.register({
        workflowName: 'test-workflow',
        type: 'event',
        config: eventTrigger('user.created'),
        enabled: true,
      });

      manager.emitEvent('user.created', { userId: '123' });

      await new Promise(resolve => setTimeout(resolve, 50));

      expect(callback).toHaveBeenCalled();
    });

    it('filters events by source', async () => {
      const callback = vi.fn();
      manager.onTrigger(callback);

      await manager.register({
        workflowName: 'test-workflow',
        type: 'event',
        config: eventTrigger('user.created', { source: 'api' }),
        enabled: true,
      });

      manager.emitEvent('user.created', { source: 'webhook', userId: '123' });

      await new Promise(resolve => setTimeout(resolve, 50));
      expect(callback).not.toHaveBeenCalled();

      manager.emitEvent('user.created', { source: 'api', userId: '456' });

      await new Promise(resolve => setTimeout(resolve, 50));
      expect(callback).toHaveBeenCalled();
    });

    it('provides stats', async () => {
      await manager.register({
        workflowName: 'wf1',
        type: 'cron',
        config: cronTrigger('* * * * *'),
        enabled: true,
      });

      await manager.register({
        workflowName: 'wf2',
        type: 'webhook',
        config: webhookTrigger('/test'),
        enabled: false,
      });

      const stats = await manager.getStats();

      expect(stats.total).toBe(2);
      expect(stats.enabled).toBe(1);
      expect(stats.byType.cron).toBe(1);
      expect(stats.byType.webhook).toBe(1);
    });

    it('exposes isRunning status', () => {
      expect(manager.isRunning).toBe(true);

      manager.stop();
      expect(manager.isRunning).toBe(false);
    });
  });

  describe('Trigger Config Helpers', () => {
    it('creates cron trigger config', () => {
      const config = cronTrigger('0 9 * * 1-5', { timezone: 'America/New_York' });

      expect(config.expression).toBe('0 9 * * 1-5');
      expect(config.timezone).toBe('America/New_York');
      expect(config.enabled).toBe(true);
    });

    it('creates webhook trigger config', () => {
      const config = webhookTrigger('/api/hook', 'POST', {
        auth: { type: 'bearer', secret: 'test' },
      });

      expect(config.path).toBe('/api/hook');
      expect(config.method).toBe('POST');
      expect(config.auth?.type).toBe('bearer');
    });

    it('creates event trigger config', () => {
      const config = eventTrigger('order.created', { source: 'api' });

      expect(config.eventType).toBe('order.created');
      expect(config.source).toBe('api');
    });
  });
});
