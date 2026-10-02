import { query, queryOne, execute } from './index';
import { nanoid } from 'nanoid';
import type { Run, ToolCall, Message } from '@/types';

interface RunRow {
  id: string;
  agent_id: string;
  thread_id: string | null;
  status: 'running' | 'completed' | 'failed' | 'cancelled';
  input: string;
  output: string | null;
  started_at: Date;
  completed_at: Date | null;
  duration: number | null;
  input_tokens: number;
  output_tokens: number;
  total_tokens: number;
  cost: string;
  error: string | null;
  agent_name?: string;
  agent_model?: string;
}

interface ToolCallRow {
  id: string;
  run_id: string;
  name: string;
  arguments: Record<string, unknown> | null;
  result: unknown;
  status: 'pending' | 'success' | 'error';
  duration: number | null;
  started_at: Date;
  completed_at: Date | null;
  error: string | null;
}

interface MessageRow {
  id: string;
  run_id: string;
  role: 'user' | 'assistant' | 'system' | 'tool';
  content: string;
  tool_call_id: string | null;
  created_at: Date;
}

function rowToRun(row: RunRow): Run {
  return {
    id: row.id,
    agentId: row.agent_id,
    agentName: row.agent_name,
    model: row.agent_model,
    status: row.status,
    input: row.input,
    output: row.output || undefined,
    startedAt: row.started_at.toISOString(),
    completedAt: row.completed_at?.toISOString(),
    duration: row.duration || undefined,
    inputTokens: row.input_tokens,
    outputTokens: row.output_tokens,
    totalTokens: row.total_tokens,
    cost: parseFloat(row.cost) || 0,
    error: row.error || undefined,
  };
}

function rowToToolCall(row: ToolCallRow): ToolCall {
  return {
    id: row.id,
    name: row.name,
    arguments: row.arguments || {},
    result: row.result,
    status: row.status,
    duration: row.duration || undefined,
    error: row.error || undefined,
  };
}

function rowToMessage(row: MessageRow): Message {
  return {
    id: row.id,
    role: row.role,
    content: row.content,
    toolCallId: row.tool_call_id || undefined,
    createdAt: row.created_at.toISOString(),
  };
}

export async function getAllRuns(options?: {
  limit?: number;
  offset?: number;
  status?: string;
  agentId?: string;
}): Promise<Run[]> {
  let sql = `
    SELECT r.*, a.name as agent_name, a.model as agent_model
    FROM dashboard_runs r
    LEFT JOIN dashboard_agents a ON r.agent_id = a.id
    WHERE 1=1
  `;
  const params: unknown[] = [];
  let paramIndex = 1;

  if (options?.status) {
    sql += ` AND r.status = $${paramIndex++}`;
    params.push(options.status);
  }
  if (options?.agentId) {
    sql += ` AND r.agent_id = $${paramIndex++}`;
    params.push(options.agentId);
  }

  sql += ' ORDER BY r.started_at DESC';

  if (options?.limit) {
    sql += ` LIMIT $${paramIndex++}`;
    params.push(options.limit);
  }
  if (options?.offset) {
    sql += ` OFFSET $${paramIndex}`;
    params.push(options.offset);
  }

  const rows = await query<RunRow>(sql, params);
  return rows.map(rowToRun);
}

export async function getRunById(id: string): Promise<Run | null> {
  const row = await queryOne<RunRow>(
    `SELECT r.*, a.name as agent_name, a.model as agent_model
     FROM dashboard_runs r
     LEFT JOIN dashboard_agents a ON r.agent_id = a.id
     WHERE r.id = $1`,
    [id]
  );
  return row ? rowToRun(row) : null;
}

export async function getRunToolCalls(runId: string): Promise<ToolCall[]> {
  const rows = await query<ToolCallRow>(
    'SELECT * FROM dashboard_tool_calls WHERE run_id = $1 ORDER BY started_at',
    [runId]
  );
  return rows.map(rowToToolCall);
}

export async function getRunMessages(runId: string): Promise<Message[]> {
  const rows = await query<MessageRow>(
    'SELECT * FROM dashboard_messages WHERE run_id = $1 ORDER BY created_at',
    [runId]
  );
  return rows.map(rowToMessage);
}

export async function createRun(data: {
  agentId: string;
  threadId?: string;
  input: string;
}): Promise<Run> {
  const id = `run_${nanoid(12)}`;

  await execute(
    `INSERT INTO dashboard_runs (id, agent_id, thread_id, input, status)
     VALUES ($1, $2, $3, $4, 'running')`,
    [id, data.agentId, data.threadId || null, data.input]
  );

  const run = await getRunById(id);
  return run!;
}

export async function updateRun(
  id: string,
  data: Partial<{
    status: 'running' | 'completed' | 'failed' | 'cancelled';
    output: string;
    duration: number;
    inputTokens: number;
    outputTokens: number;
    totalTokens: number;
    cost: number;
    error: string;
  }>
): Promise<Run | null> {
  const updates: string[] = [];
  const values: unknown[] = [];
  let paramIndex = 1;

  if (data.status !== undefined) {
    updates.push(`status = $${paramIndex++}`);
    values.push(data.status);
    if (data.status === 'completed' || data.status === 'failed' || data.status === 'cancelled') {
      updates.push(`completed_at = NOW()`);
    }
  }
  if (data.output !== undefined) {
    updates.push(`output = $${paramIndex++}`);
    values.push(data.output);
  }
  if (data.duration !== undefined) {
    updates.push(`duration = $${paramIndex++}`);
    values.push(data.duration);
  }
  if (data.inputTokens !== undefined) {
    updates.push(`input_tokens = $${paramIndex++}`);
    values.push(data.inputTokens);
  }
  if (data.outputTokens !== undefined) {
    updates.push(`output_tokens = $${paramIndex++}`);
    values.push(data.outputTokens);
  }
  if (data.totalTokens !== undefined) {
    updates.push(`total_tokens = $${paramIndex++}`);
    values.push(data.totalTokens);
  }
  if (data.cost !== undefined) {
    updates.push(`cost = $${paramIndex++}`);
    values.push(data.cost);
  }
  if (data.error !== undefined) {
    updates.push(`error = $${paramIndex++}`);
    values.push(data.error);
  }

  if (updates.length === 0) return getRunById(id);

  values.push(id);
  await execute(
    `UPDATE dashboard_runs SET ${updates.join(', ')} WHERE id = $${paramIndex}`,
    values
  );

  return getRunById(id);
}

export async function addToolCall(data: {
  runId: string;
  name: string;
  arguments?: Record<string, unknown>;
}): Promise<string> {
  const id = `tc_${nanoid(12)}`;

  await execute(
    `INSERT INTO dashboard_tool_calls (id, run_id, name, arguments)
     VALUES ($1, $2, $3, $4)`,
    [id, data.runId, data.name, JSON.stringify(data.arguments || {})]
  );

  return id;
}

export async function updateToolCall(
  id: string,
  data: {
    status: 'success' | 'error';
    result?: unknown;
    duration?: number;
    error?: string;
  }
): Promise<void> {
  await execute(
    `UPDATE dashboard_tool_calls
     SET status = $1, result = $2, duration = $3, error = $4, completed_at = NOW()
     WHERE id = $5`,
    [data.status, JSON.stringify(data.result), data.duration || null, data.error || null, id]
  );
}

export async function addMessage(data: {
  runId: string;
  role: 'user' | 'assistant' | 'system' | 'tool';
  content: string;
  toolCallId?: string;
}): Promise<string> {
  const id = `msg_${nanoid(12)}`;

  await execute(
    `INSERT INTO dashboard_messages (id, run_id, role, content, tool_call_id)
     VALUES ($1, $2, $3, $4, $5)`,
    [id, data.runId, data.role, data.content, data.toolCallId || null]
  );

  return id;
}

export async function getRunCount(status?: string): Promise<number> {
  let sql = 'SELECT COUNT(*) as count FROM dashboard_runs';
  const params: unknown[] = [];

  if (status) {
    sql += ' WHERE status = $1';
    params.push(status);
  }

  const result = await queryOne<{ count: string }>(sql, params);
  return parseInt(result?.count || '0');
}

export async function getRecentRuns(limit = 10): Promise<Run[]> {
  return getAllRuns({ limit });
}

export async function getRunningRuns(): Promise<Run[]> {
  return getAllRuns({ status: 'running' });
}

export async function getRunStats(period: 'day' | 'week' | 'month' = 'day'): Promise<{
  totalRuns: number;
  completedRuns: number;
  failedRuns: number;
  totalTokens: number;
  totalCost: number;
}> {
  const intervals = {
    day: "NOW() - INTERVAL '1 day'",
    week: "NOW() - INTERVAL '7 days'",
    month: "NOW() - INTERVAL '30 days'",
  };

  const result = await queryOne<{
    total_runs: string;
    completed_runs: string;
    failed_runs: string;
    total_tokens: string;
    total_cost: string;
  }>(`
    SELECT
      COUNT(*) as total_runs,
      SUM(CASE WHEN status = 'completed' THEN 1 ELSE 0 END) as completed_runs,
      SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END) as failed_runs,
      COALESCE(SUM(total_tokens), 0) as total_tokens,
      COALESCE(SUM(cost), 0) as total_cost
    FROM dashboard_runs
    WHERE started_at >= ${intervals[period]}
  `);

  return {
    totalRuns: parseInt(result?.total_runs || '0'),
    completedRuns: parseInt(result?.completed_runs || '0'),
    failedRuns: parseInt(result?.failed_runs || '0'),
    totalTokens: parseInt(result?.total_tokens || '0'),
    totalCost: parseFloat(result?.total_cost || '0'),
  };
}
