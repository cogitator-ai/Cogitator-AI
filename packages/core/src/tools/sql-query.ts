import { z } from 'zod';
import { tool } from '../tool';

const sqlQueryParams = z.object({
  query: z.string().min(1).describe('SQL query to execute'),
  database: z
    .enum(['postgres', 'sqlite'])
    .optional()
    .describe('Database type (auto-detects from connection string if not specified)'),
  connectionString: z
    .string()
    .optional()
    .describe(
      'Connection string. For PostgreSQL: postgres://user:pass@host:port/db. For SQLite: file path. Defaults to DATABASE_URL env var.'
    ),
  params: z
    .array(z.unknown())
    .optional()
    .describe('Query parameters for parameterized queries (prevents SQL injection)'),
  maxRows: z
    .number()
    .int()
    .min(1)
    .max(1000)
    .optional()
    .describe('Maximum rows to return (default: 100, max: 1000)'),
  readOnly: z.boolean().optional().describe('Only allow SELECT queries (default: true for safety)'),
});

export interface QueryResult {
  rows: Record<string, unknown>[];
  rowCount: number;
  truncated: boolean;
  database: string;
  executionTime: number;
}

function isReadOnlyQuery(query: string): boolean {
  const normalized = query.trim().toUpperCase();
  const allowedPrefixes = ['SELECT', 'WITH', 'SHOW', 'DESCRIBE', 'EXPLAIN'];
  return allowedPrefixes.some((prefix) => normalized.startsWith(prefix));
}

async function queryPostgres(
  connectionString: string,
  query: string,
  params: unknown[],
  maxRows: number
): Promise<QueryResult> {
  let pg: typeof import('pg');
  try {
    pg = await import('pg');
  } catch {
    throw new Error('pg package not installed. Run: pnpm add pg');
  }

  const client = new pg.default.Client({ connectionString });
  const start = Date.now();

  try {
    await client.connect();

    const limitedQuery = query.includes('LIMIT')
      ? query
      : `${query.replace(/;?\s*$/, '')} LIMIT ${maxRows + 1}`;

    const result = await client.query(limitedQuery, params);
    const executionTime = Date.now() - start;

    const truncated = result.rows.length > maxRows;
    const rows = truncated ? result.rows.slice(0, maxRows) : result.rows;

    return {
      rows: rows as Record<string, unknown>[],
      rowCount: rows.length,
      truncated,
      database: 'postgres',
      executionTime,
    };
  } finally {
    await client.end();
  }
}

async function querySqlite(
  filePath: string,
  query: string,
  params: unknown[],
  maxRows: number
): Promise<QueryResult> {
  let Database: typeof import('better-sqlite3').default;

  try {
    const betterSqlite = await import('better-sqlite3');
    Database = betterSqlite.default;
  } catch {
    throw new Error('better-sqlite3 package not installed. Run: pnpm add better-sqlite3');
  }

  const db = new Database(filePath, { readonly: true });
  const start = Date.now();

  try {
    const limitedQuery = query.includes('LIMIT')
      ? query
      : `${query.replace(/;?\s*$/, '')} LIMIT ${maxRows + 1}`;

    const stmt = db.prepare(limitedQuery);
    const rows = stmt.all(...params) as Record<string, unknown>[];
    const executionTime = Date.now() - start;

    const truncated = rows.length > maxRows;
    const resultRows = truncated ? rows.slice(0, maxRows) : rows;

    return {
      rows: resultRows,
      rowCount: resultRows.length,
      truncated,
      database: 'sqlite',
      executionTime,
    };
  } finally {
    db.close();
  }
}

function detectDatabase(connectionString: string): 'postgres' | 'sqlite' {
  if (connectionString.startsWith('postgres://') || connectionString.startsWith('postgresql://')) {
    return 'postgres';
  }

  if (
    connectionString.endsWith('.db') ||
    connectionString.endsWith('.sqlite') ||
    connectionString.endsWith('.sqlite3') ||
    connectionString.includes('.db') ||
    connectionString === ':memory:'
  ) {
    return 'sqlite';
  }

  return 'postgres';
}

export const sqlQuery = tool({
  name: 'sql_query',
  description:
    'Execute SQL queries against PostgreSQL or SQLite databases. Supports parameterized queries for safety. By default, only SELECT queries are allowed.',
  parameters: sqlQueryParams,
  category: 'database',
  tags: ['sql', 'database', 'postgres', 'sqlite', 'query'],
  execute: async ({
    query,
    database,
    connectionString,
    params = [],
    maxRows = 100,
    readOnly = true,
  }) => {
    const connStr = connectionString ?? process.env.DATABASE_URL;

    if (!connStr) {
      return {
        error:
          'No connection string provided. Set DATABASE_URL environment variable or pass connectionString parameter.',
      };
    }

    if (readOnly && !isReadOnlyQuery(query)) {
      return {
        error:
          'Only SELECT queries are allowed when readOnly=true. Set readOnly=false to allow mutations.',
      };
    }

    const db = database ?? detectDatabase(connStr);

    try {
      switch (db) {
        case 'postgres':
          return await queryPostgres(connStr, query, params, maxRows);
        case 'sqlite':
          return await querySqlite(connStr, query, params, maxRows);
        default:
          return { error: `Unsupported database type: ${db as string}` };
      }
    } catch (err) {
      return { error: (err as Error).message, database: db };
    }
  },
});
