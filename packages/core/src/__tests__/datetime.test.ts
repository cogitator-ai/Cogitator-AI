import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { datetime } from '../tools/datetime.js';

const mockContext = {
  agentId: 'agent_test',
  runId: 'run_test',
  signal: new AbortController().signal,
};

describe('datetime tool', () => {
  beforeEach(() => {
    // Mock Date to return a consistent time
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2024-12-30T15:30:45.000Z'));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  describe('default format (iso)', () => {
    it('returns ISO format by default', async () => {
      const result = (await datetime.execute({}, mockContext)) as {
        datetime: string;
        timezone: string;
        format: string;
      };
      expect(result.datetime).toBe('2024-12-30T15:30:45.000Z');
      expect(result.format).toBe('iso');
    });

    it('includes timezone in response', async () => {
      const result = (await datetime.execute({}, mockContext)) as {
        datetime: string;
        timezone: string;
        format: string;
      };
      expect(result.timezone).toBeDefined();
      expect(typeof result.timezone).toBe('string');
    });
  });

  describe('unix format', () => {
    it('returns unix timestamp', async () => {
      const result = (await datetime.execute({ format: 'unix' }, mockContext)) as {
        datetime: string;
        timezone: string;
        format: string;
      };
      expect(result.datetime).toBe('1735572645');
      expect(result.format).toBe('unix');
    });
  });

  describe('readable format', () => {
    it('returns human-readable format', async () => {
      const result = (await datetime.execute({ format: 'readable' }, mockContext)) as {
        datetime: string;
        timezone: string;
        format: string;
      };
      expect(result.datetime).toContain('2024');
      expect(result.datetime).toContain('December');
      expect(result.format).toBe('readable');
    });
  });

  describe('date format', () => {
    it('returns date only', async () => {
      const result = (await datetime.execute({ format: 'date' }, mockContext)) as {
        datetime: string;
        timezone: string;
        format: string;
      };
      expect(result.datetime).toMatch(/\d{2}\/\d{2}\/\d{4}/);
      expect(result.format).toBe('date');
    });
  });

  describe('time format', () => {
    it('returns time only', async () => {
      const result = (await datetime.execute({ format: 'time' }, mockContext)) as {
        datetime: string;
        timezone: string;
        format: string;
      };
      expect(result.datetime).toMatch(/\d{2}:\d{2}:\d{2}/);
      expect(result.format).toBe('time');
    });
  });

  describe('timezone support', () => {
    it('accepts valid timezone', async () => {
      const result = (await datetime.execute({ timezone: 'America/New_York' }, mockContext)) as {
        datetime: string;
        timezone: string;
        format: string;
      };
      expect(result.timezone).toBe('America/New_York');
    });

    it('returns error for invalid timezone', async () => {
      const result = (await datetime.execute({ timezone: 'Invalid/Timezone' }, mockContext)) as {
        error: string;
        timezone: string;
      };
      expect(result.error).toContain('Invalid timezone');
    });

    it('formats time in specified timezone', async () => {
      const utcResult = (await datetime.execute({ timezone: 'UTC', format: 'iso' }, mockContext)) as {
        datetime: string;
        timezone: string;
        format: string;
      };
      expect(utcResult.datetime).toContain('15:30:45');
    });
  });

  describe('tool metadata', () => {
    it('has correct name', () => {
      expect(datetime.name).toBe('datetime');
    });

    it('has description', () => {
      expect(datetime.description).toContain('current date and time');
    });

    it('returns valid JSON schema', () => {
      const schema = datetime.toJSON();
      expect(schema.name).toBe('datetime');
      expect(schema.parameters.type).toBe('object');
      expect(schema.parameters.properties).toHaveProperty('timezone');
      expect(schema.parameters.properties).toHaveProperty('format');
    });
  });
});
