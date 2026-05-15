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

function stripSqlLiteralsAndComments(query: string): string {
  let output = '';
  let index = 0;

  while (index < query.length) {
    const char = query[index];
    const next = query[index + 1];

    if (char === '-' && next === '-') {
      output += '  ';
      index += 2;
      while (index < query.length && query[index] !== '\n') {
        output += ' ';
        index++;
      }
      continue;
    }

    if (char === '/' && next === '*') {
      output += '  ';
      index += 2;
      while (index < query.length && !(query[index] === '*' && query[index + 1] === '/')) {
        output += ' ';
        index++;
      }
      if (index < query.length) {
        output += '  ';
        index += 2;
      }
      continue;
    }

    const dollarQuote = /^\$[A-Za-z_][A-Za-z0-9_]*\$|^\$\$/.exec(query.slice(index));
    if (dollarQuote) {
      const tag = dollarQuote[0];
      output += ' '.repeat(tag.length);
      index += tag.length;
      const end = query.indexOf(tag, index);
      const contentEnd = end === -1 ? query.length : end;
      output += ' '.repeat(contentEnd - index);
      index = contentEnd;
      if (end !== -1) {
        output += ' '.repeat(tag.length);
        index += tag.length;
      }
      continue;
    }

    if (char === "'") {
      output += ' ';
      index++;
      while (index < query.length) {
        output += ' ';
        if (query[index] === "'" && query[index + 1] === "'") {
          output += ' ';
          index += 2;
          continue;
        }
        if (query[index] === "'") {
          index++;
          break;
        }
        index++;
      }
      continue;
    }

    if (char === '"') {
      output += ' ';
      index++;
      while (index < query.length) {
        output += ' ';
        if (query[index] === '"' && query[index + 1] === '"') {
          output += ' ';
          index += 2;
          continue;
        }
        if (query[index] === '"') {
          index++;
          break;
        }
        index++;
      }
      continue;
    }

    output += char;
    index++;
  }

  return output;
}

function firstSqlKeyword(query: string): string | undefined {
  return /^[A-Z]+/.exec(stripSqlLiteralsAndComments(query).trim().toUpperCase())?.[0];
}

function hasMultipleStatements(query: string): boolean {
  const statements = stripSqlLiteralsAndComments(query)
    .split(';')
    .filter((statement) => statement.trim().length > 0);
  return statements.length > 1;
}

function hasTopLevelKeyword(query: string, keyword: string): boolean {
  const normalized = stripSqlLiteralsAndComments(query).toUpperCase();
  let depth = 0;

  for (let index = 0; index < normalized.length; index++) {
    const char = normalized[index];

    if (char === '(') {
      depth++;
      continue;
    }

    if (char === ')') {
      depth = Math.max(0, depth - 1);
      continue;
    }

    if (
      depth === 0 &&
      normalized.startsWith(keyword, index) &&
      !/[A-Z0-9_]/.test(normalized[index - 1] ?? '') &&
      !/[A-Z0-9_]/.test(normalized[index + keyword.length] ?? '')
    ) {
      return true;
    }
  }

  return false;
}

function trimTrailingSqlTerminator(query: string): string {
  const stripped = stripSqlLiteralsAndComments(query);
  let index = stripped.length - 1;

  while (index >= 0 && /\s/.test(stripped[index])) {
    index--;
  }

  if (stripped[index] !== ';') {
    return query.replace(/\s*$/, '');
  }

  return `${query.slice(0, index)}${query.slice(index + 1)}`.replace(/\s*$/, '');
}

function isReadOnlyQuery(query: string): boolean {
  const normalized = stripSqlLiteralsAndComments(query).trim().toUpperCase();
  const firstKeyword = firstSqlKeyword(query);
  const allowedPrefixes = ['SELECT', 'WITH', 'SHOW', 'DESCRIBE', 'EXPLAIN'];
  if (!firstKeyword || !allowedPrefixes.includes(firstKeyword)) {
    return false;
  }
  const dangerousKeywords = [
    'INSERT',
    'UPDATE',
    'DELETE',
    'DROP',
    'ALTER',
    'CREATE',
    'TRUNCATE',
    'GRANT',
    'REVOKE',
    'EXEC',
    'EXECUTE',
    'CALL',
  ];
  if (hasMultipleStatements(query)) return false;
  for (const keyword of dangerousKeywords) {
    const regex = new RegExp(`\\b${keyword}\\b`);
    if (regex.test(normalized)) return false;
  }
  if (/\bFOR\s+(NO\s+KEY\s+)?UPDATE\b/.test(normalized)) return false;
  if (/\bFOR\s+(KEY\s+)?SHARE\b/.test(normalized)) return false;
  return true;
}

function withRowLimit(query: string, maxRows: number): string {
  const firstKeyword = firstSqlKeyword(query);
  if (firstKeyword !== 'SELECT' && firstKeyword !== 'WITH') {
    return query;
  }

  if (hasTopLevelKeyword(query, 'LIMIT') || hasTopLevelKeyword(query, 'FETCH')) {
    return query;
  }

  return `${trimTrailingSqlTerminator(query)}\nLIMIT ${maxRows + 1}`;
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

    const limitedQuery = withRowLimit(query, maxRows);

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
  maxRows: number,
  readOnly = true
): Promise<QueryResult> {
  let Database: typeof import('better-sqlite3').default;

  try {
    const betterSqlite = await import('better-sqlite3');
    Database = betterSqlite.default;
  } catch {
    throw new Error('better-sqlite3 package not installed. Run: pnpm add better-sqlite3');
  }

  const db = new Database(filePath, { readonly: readOnly });
  const start = Date.now();

  try {
    const limitedQuery = withRowLimit(query, maxRows);

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
          return await querySqlite(connStr, query, params, maxRows, readOnly);
        default:
          return { error: `Unsupported database type: ${db as string}` };
      }
    } catch (err) {
      return { error: (err as Error).message, database: db };
    }
  },
});
