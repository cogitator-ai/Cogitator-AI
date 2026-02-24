import { describe, it, expect } from 'vitest';
import { PostgresTraceStore } from '../learning/postgres-trace-store';

describe('PostgresTraceStore', () => {
  describe('schema validation', () => {
    it('accepts valid schema names', () => {
      expect(
        () =>
          new PostgresTraceStore({
            connectionString: 'postgres://localhost/db',
            schema: 'cogitator',
          })
      ).not.toThrow();

      expect(
        () =>
          new PostgresTraceStore({
            connectionString: 'postgres://localhost/db',
            schema: '_private',
          })
      ).not.toThrow();

      expect(
        () =>
          new PostgresTraceStore({
            connectionString: 'postgres://localhost/db',
            schema: 'my_schema_v2',
          })
      ).not.toThrow();
    });

    it('uses default schema when not provided', () => {
      expect(
        () =>
          new PostgresTraceStore({
            connectionString: 'postgres://localhost/db',
          })
      ).not.toThrow();
    });

    it('rejects SQL injection via schema name', () => {
      expect(
        () =>
          new PostgresTraceStore({
            connectionString: 'postgres://localhost/db',
            schema: 'public; DROP TABLE users--',
          })
      ).toThrow('Invalid schema name');
    });

    it('rejects schema with spaces', () => {
      expect(
        () =>
          new PostgresTraceStore({
            connectionString: 'postgres://localhost/db',
            schema: 'my schema',
          })
      ).toThrow('Invalid schema name');
    });

    it('rejects schema starting with number', () => {
      expect(
        () =>
          new PostgresTraceStore({
            connectionString: 'postgres://localhost/db',
            schema: '123abc',
          })
      ).toThrow('Invalid schema name');
    });

    it('rejects schema with special characters', () => {
      expect(
        () =>
          new PostgresTraceStore({
            connectionString: 'postgres://localhost/db',
            schema: 'schema$name',
          })
      ).toThrow('Invalid schema name');
    });

    it('rejects empty schema', () => {
      expect(
        () =>
          new PostgresTraceStore({
            connectionString: 'postgres://localhost/db',
            schema: '',
          })
      ).toThrow('Invalid schema name');
    });
  });
});
