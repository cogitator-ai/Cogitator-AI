import { query, queryOne, execute } from './index';
import { nanoid } from 'nanoid';
import type { LogEntry } from '@/types';

interface LogRow {
  id: string;
  timestamp: Date;
  level: 'debug' | 'info' | 'warn' | 'error';
  message: string;
  source: string | null;
  agent_id: string | null;
  run_id: string | null;
  metadata: Record<string, unknown> | null;
}

function rowToLog(row: LogRow): LogEntry {
  return {
    id: row.id,
    timestamp: row.timestamp.toISOString(),
    level: row.level,
    message: row.message,
    source: row.source || undefined,
    agentId: row.agent_id || undefined,
    runId: row.run_id || undefined,
    metadata: row.metadata || undefined,
  };
}

export async function getAllLogs(options?: {
  limit?: number;
  offset?: number;
  level?: string;
  source?: string;
  runId?: string;
  since?: Date;
}): Promise<LogEntry[]> {
  let sql = 'SELECT * FROM dashboard_logs WHERE 1=1';
  const params: unknown[] = [];
  let paramIndex = 1;

  if (options?.level) {
    sql += ` AND level = $${paramIndex++}`;
    params.push(options.level);
  }
  if (options?.source) {
    sql += ` AND source = $${paramIndex++}`;
    params.push(options.source);
  }
  if (options?.runId) {
    sql += ` AND run_id = $${paramIndex++}`;
    params.push(options.runId);
  }
  if (options?.since) {
    sql += ` AND timestamp >= $${paramIndex++}`;
    params.push(options.since.toISOString());
  }

  sql += ' ORDER BY timestamp DESC';

  if (options?.limit) {
    sql += ` LIMIT $${paramIndex++}`;
    params.push(options.limit);
  }
  if (options?.offset) {
    sql += ` OFFSET $${paramIndex}`;
    params.push(options.offset);
  }

  const rows = await query<LogRow>(sql, params);
  return rows.map(rowToLog);
}

export async function createLog(data: {
  level: 'debug' | 'info' | 'warn' | 'error';
  message: string;
  source?: string;
  agentId?: string;
  runId?: string;
  metadata?: Record<string, unknown>;
}): Promise<LogEntry> {
  const id = `log_${nanoid(12)}`;

  await execute(
    `INSERT INTO dashboard_logs (id, level, message, source, agent_id, run_id, metadata)
     VALUES ($1, $2, $3, $4, $5, $6, $7)`,
    [
      id,
      data.level,
      data.message,
      data.source || null,
      data.agentId || null,
      data.runId || null,
      data.metadata ? JSON.stringify(data.metadata) : null,
    ]
  );

  const row = await queryOne<LogRow>('SELECT * FROM dashboard_logs WHERE id = $1', [id]);

  return rowToLog(row!);
}

export async function getLogCount(level?: string): Promise<number> {
  let sql = 'SELECT COUNT(*) as count FROM dashboard_logs';
  const params: unknown[] = [];

  if (level) {
    sql += ' WHERE level = $1';
    params.push(level);
  }

  const result = await queryOne<{ count: string }>(sql, params);
  return parseInt(result?.count || '0');
}

export async function getRecentLogs(limit = 100): Promise<LogEntry[]> {
  return getAllLogs({ limit });
}

export async function clearOldLogs(olderThan: Date): Promise<number> {
  return execute('DELETE FROM dashboard_logs WHERE timestamp < $1', [olderThan.toISOString()]);
}

export async function getLogStats(): Promise<{
  total: number;
  debug: number;
  info: number;
  warn: number;
  error: number;
}> {
  const result = await queryOne<{
    total: string;
    debug: string;
    info: string;
    warn: string;
    error: string;
  }>(`
    SELECT
      COUNT(*) as total,
      SUM(CASE WHEN level = 'debug' THEN 1 ELSE 0 END) as debug,
      SUM(CASE WHEN level = 'info' THEN 1 ELSE 0 END) as info,
      SUM(CASE WHEN level = 'warn' THEN 1 ELSE 0 END) as warn,
      SUM(CASE WHEN level = 'error' THEN 1 ELSE 0 END) as error
    FROM dashboard_logs
    WHERE timestamp >= NOW() - INTERVAL '24 hours'
  `);

  return {
    total: parseInt(result?.total || '0'),
    debug: parseInt(result?.debug || '0'),
    info: parseInt(result?.info || '0'),
    warn: parseInt(result?.warn || '0'),
    error: parseInt(result?.error || '0'),
  };
}
