import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Logger, createLogger, createLoggerFromConfig, getLogger, setLogger } from '../logger';
import { Cogitator } from '../cogitator';
import type { LogEntry } from '../logger';

describe('Logger', () => {
  describe('log levels', () => {
    it('respects minimum log level', () => {
      const entries: LogEntry[] = [];
      const logger = createLogger({
        level: 'warn',
        output: (entry) => entries.push(entry),
      });

      logger.debug('debug message');
      logger.info('info message');
      logger.warn('warn message');
      logger.error('error message');

      expect(entries).toHaveLength(2);
      expect(entries[0].level).toBe('warn');
      expect(entries[1].level).toBe('error');
    });

    it('outputs all levels when set to debug', () => {
      const entries: LogEntry[] = [];
      const logger = createLogger({
        level: 'debug',
        output: (entry) => entries.push(entry),
      });

      logger.debug('debug');
      logger.info('info');
      logger.warn('warn');
      logger.error('error');

      expect(entries).toHaveLength(4);
    });

    it('defaults to info level', () => {
      const entries: LogEntry[] = [];
      const logger = createLogger({
        output: (entry) => entries.push(entry),
      });

      logger.debug('debug');
      logger.info('info');

      expect(entries).toHaveLength(1);
      expect(entries[0].level).toBe('info');
    });
  });

  describe('context', () => {
    it('includes context in log entry', () => {
      const entries: LogEntry[] = [];
      const logger = createLogger({
        level: 'debug',
        output: (entry) => entries.push(entry),
      });

      logger.info('test message', { userId: '123', action: 'login' });

      expect(entries[0].context).toEqual({ userId: '123', action: 'login' });
    });

    it('omits empty context', () => {
      const entries: LogEntry[] = [];
      const logger = createLogger({
        level: 'debug',
        output: (entry) => entries.push(entry),
      });

      logger.info('test message');

      expect(entries[0].context).toBeUndefined();
    });
  });

  describe('child logger', () => {
    it('creates child with inherited context', () => {
      const entries: LogEntry[] = [];
      const parentWithContext = new Logger(
        { level: 'debug', output: (entry) => entries.push(entry) },
        { service: 'api' }
      );

      const child = parentWithContext.child({ requestId: 'req-123' });
      child.info('processing request');

      expect(entries[0].context).toEqual({ service: 'api', requestId: 'req-123' });
    });

    it('can add call-time context to child', () => {
      const entries: LogEntry[] = [];
      const parent = new Logger(
        { level: 'debug', output: (entry) => entries.push(entry) },
        { service: 'api' }
      );

      const child = parent.child({ requestId: 'req-123' });
      child.info('operation', { operation: 'fetch' });

      expect(entries[0].context).toEqual({
        service: 'api',
        requestId: 'req-123',
        operation: 'fetch',
      });
    });
  });

  describe('formatting', () => {
    it('outputs JSON format', () => {
      let formatted = '';
      const logger = createLogger({
        level: 'debug',
        format: 'json',
        output: (_, f) => (formatted = f),
      });

      logger.info('test', { key: 'value' });

      const parsed = JSON.parse(formatted) as LogEntry;
      expect(parsed.level).toBe('info');
      expect(parsed.message).toBe('test');
      expect(parsed.context).toEqual({ key: 'value' });
      expect(parsed.timestamp).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    });

    it('outputs pretty format', () => {
      let formatted = '';
      const logger = createLogger({
        level: 'debug',
        format: 'pretty',
        output: (_, f) => (formatted = f),
      });

      logger.info('test message');

      expect(formatted).toContain('INFO');
      expect(formatted).toContain('test message');
    });

    it('includes context in pretty format', () => {
      let formatted = '';
      const logger = createLogger({
        level: 'debug',
        format: 'pretty',
        output: (_, f) => (formatted = f),
      });

      logger.info('test', { userId: '123' });

      expect(formatted).toContain('userId="123"');
    });
  });

  describe('timestamp', () => {
    it('includes ISO timestamp', () => {
      const entries: LogEntry[] = [];
      const logger = createLogger({
        level: 'debug',
        output: (entry) => entries.push(entry),
      });

      logger.info('test');

      expect(entries[0].timestamp).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
    });
  });

  describe('default logger', () => {
    let originalEnv: string | undefined;

    beforeEach(() => {
      originalEnv = process.env.LOG_LEVEL;
    });

    afterEach(() => {
      if (originalEnv !== undefined) {
        process.env.LOG_LEVEL = originalEnv;
      } else {
        process.env.LOG_LEVEL = undefined;
      }
      setLogger(createLogger());
    });

    it('getLogger returns singleton', () => {
      const logger1 = getLogger();
      const logger2 = getLogger();
      expect(logger1).toBe(logger2);
    });

    it('setLogger replaces default', () => {
      const entries: LogEntry[] = [];
      const custom = createLogger({
        level: 'debug',
        output: (entry) => entries.push(entry),
      });

      setLogger(custom);

      const retrieved = getLogger();
      retrieved.info('test');

      expect(entries).toHaveLength(1);
    });
  });

  describe('console output', () => {
    it('uses console.error for error level', () => {
      const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
      const logger = createLogger({ level: 'debug', format: 'pretty' });

      logger.error('error message');

      expect(spy).toHaveBeenCalled();
      spy.mockRestore();
    });

    it('uses console.warn for warn level', () => {
      const spy = vi.spyOn(console, 'warn').mockImplementation(() => {});
      const logger = createLogger({ level: 'debug', format: 'pretty' });

      logger.warn('warning');

      expect(spy).toHaveBeenCalled();
      spy.mockRestore();
    });

    it('uses console.log for info and debug', () => {
      const spy = vi.spyOn(console, 'log').mockImplementation(() => {});
      const logger = createLogger({ level: 'debug', format: 'pretty' });

      logger.info('info');
      logger.debug('debug');

      expect(spy).toHaveBeenCalledTimes(2);
      spy.mockRestore();
    });
  });

  describe('logging config', () => {
    afterEach(() => {
      setLogger(createLogger());
      vi.restoreAllMocks();
    });

    it('outputs nothing at level silent, children included', () => {
      const log = vi.spyOn(console, 'log').mockImplementation(() => {});
      const error = vi.spyOn(console, 'error').mockImplementation(() => {});
      const logger = createLoggerFromConfig({ level: 'silent' });

      logger.error('hidden');
      logger.child({ component: 'x' }).error('hidden');

      expect(log).not.toHaveBeenCalled();
      expect(error).not.toHaveBeenCalled();
    });

    it('appends JSON lines to logging.filePath for the file destination', () => {
      const dir = mkdtempSync(join(tmpdir(), 'cogitator-log-'));
      const filePath = join(dir, 'app.log');
      try {
        const logger = createLoggerFromConfig({ level: 'warn', destination: 'file', filePath });

        logger.info('skipped');
        logger.warn('first', { n: 1 });
        logger.error('second');

        const lines = readFileSync(filePath, 'utf8').trim().split('\n');
        expect(lines.map((line) => (JSON.parse(line) as LogEntry).message)).toEqual([
          'first',
          'second',
        ]);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });

    it('logs to the console and warns when the file destination has no filePath', () => {
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

      createLoggerFromConfig({ destination: 'file' });

      expect(warn).toHaveBeenCalledWith(expect.stringContaining('logging.filePath is not set'));
    });

    it('is applied to the default logger by a Cogitator created with logging', () => {
      const log = vi.spyOn(console, 'log').mockImplementation(() => {});
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

      new Cogitator({ logging: { level: 'warn', format: 'json' } });
      getLogger().info('hidden');
      getLogger().warn('shown');

      expect(log).not.toHaveBeenCalled();
      expect(JSON.parse(String(warn.mock.calls[0][0]))).toMatchObject({
        level: 'warn',
        message: 'shown',
      });
    });
  });
});
