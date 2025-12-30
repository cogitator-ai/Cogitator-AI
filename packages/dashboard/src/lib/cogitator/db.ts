/**
 * Extended Database Schema and Queries for Cogitator Dashboard
 *
 * Adds tables for:
 * - agents (with full config)
 * - threads (memory)
 * - workflows
 * - swarms
 */

import { query, queryOne, execute, getPool } from '../db/index';
import { nanoid } from 'nanoid';
import type { AgentConfig, Tool } from '@cogitator/types';


export async function initializeExtendedSchema(): Promise<void> {
  const pool = getPool();

  await pool.query(`
    -- Extended agents table with full config
    CREATE TABLE IF NOT EXISTS cogitator_agents (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      description TEXT,
      model TEXT NOT NULL,
      instructions TEXT NOT NULL,
      temperature DECIMAL(3, 2) DEFAULT 0.7,
      top_p DECIMAL(3, 2) DEFAULT 1.0,
      max_tokens INTEGER,
      tools TEXT[] DEFAULT '{}',
      memory_enabled BOOLEAN DEFAULT true,
      max_iterations INTEGER DEFAULT 10,
      timeout INTEGER DEFAULT 300000,
      response_format JSONB,
      config JSONB DEFAULT '{}',
      total_runs INTEGER DEFAULT 0,
      total_tokens BIGINT DEFAULT 0,
      total_cost DECIMAL(12, 6) DEFAULT 0,
      last_run_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ DEFAULT NOW(),
      updated_at TIMESTAMPTZ DEFAULT NOW()
    );

    -- Threads table for conversation memory
    CREATE TABLE IF NOT EXISTS cogitator_threads (
      id TEXT PRIMARY KEY,
      agent_id TEXT REFERENCES cogitator_agents(id) ON DELETE SET NULL,
      title TEXT,
      metadata JSONB DEFAULT '{}',
      message_count INTEGER DEFAULT 0,
      last_message_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ DEFAULT NOW(),
      updated_at TIMESTAMPTZ DEFAULT NOW()
    );

    -- Thread messages table
    CREATE TABLE IF NOT EXISTS cogitator_messages (
      id TEXT PRIMARY KEY,
      thread_id TEXT NOT NULL REFERENCES cogitator_threads(id) ON DELETE CASCADE,
      run_id TEXT,
      role TEXT NOT NULL CHECK (role IN ('user', 'assistant', 'system', 'tool')),
      content TEXT NOT NULL,
      tool_calls JSONB,
      tool_results JSONB,
      token_count INTEGER DEFAULT 0,
      created_at TIMESTAMPTZ DEFAULT NOW()
    );

    -- Runs table for execution history
    CREATE TABLE IF NOT EXISTS cogitator_runs (
      id TEXT PRIMARY KEY,
      agent_id TEXT REFERENCES cogitator_agents(id) ON DELETE SET NULL,
      thread_id TEXT REFERENCES cogitator_threads(id) ON DELETE SET NULL,
      status TEXT DEFAULT 'running' CHECK (status IN ('running', 'completed', 'failed', 'cancelled')),
      input TEXT NOT NULL,
      output TEXT,
      input_tokens INTEGER DEFAULT 0,
      output_tokens INTEGER DEFAULT 0,
      total_tokens INTEGER DEFAULT 0,
      cost DECIMAL(12, 6) DEFAULT 0,
      duration INTEGER,
      iterations INTEGER DEFAULT 0,
      error TEXT,
      trace JSONB,
      started_at TIMESTAMPTZ DEFAULT NOW(),
      completed_at TIMESTAMPTZ
    );

    -- Tool calls within runs
    CREATE TABLE IF NOT EXISTS cogitator_tool_calls (
      id TEXT PRIMARY KEY,
      run_id TEXT NOT NULL REFERENCES cogitator_runs(id) ON DELETE CASCADE,
      name TEXT NOT NULL,
      arguments JSONB,
      result JSONB,
      error TEXT,
      duration INTEGER,
      started_at TIMESTAMPTZ DEFAULT NOW(),
      completed_at TIMESTAMPTZ
    );

    -- Workflows table
    CREATE TABLE IF NOT EXISTS cogitator_workflows (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      description TEXT,
      definition JSONB NOT NULL,
      initial_state JSONB DEFAULT '{}',
      triggers JSONB DEFAULT '[]',
      total_runs INTEGER DEFAULT 0,
      last_run_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ DEFAULT NOW(),
      updated_at TIMESTAMPTZ DEFAULT NOW()
    );

    -- Workflow runs table
    CREATE TABLE IF NOT EXISTS cogitator_workflow_runs (
      id TEXT PRIMARY KEY,
      workflow_id TEXT NOT NULL REFERENCES cogitator_workflows(id) ON DELETE CASCADE,
      status TEXT DEFAULT 'running' CHECK (status IN ('pending', 'running', 'completed', 'failed', 'cancelled', 'paused')),
      input JSONB,
      output JSONB,
      state JSONB DEFAULT '{}',
      current_node TEXT,
      checkpoint_id TEXT,
      error TEXT,
      started_at TIMESTAMPTZ DEFAULT NOW(),
      completed_at TIMESTAMPTZ
    );

    -- Human approvals for workflows
    CREATE TABLE IF NOT EXISTS cogitator_approvals (
      id TEXT PRIMARY KEY,
      workflow_run_id TEXT NOT NULL REFERENCES cogitator_workflow_runs(id) ON DELETE CASCADE,
      node_name TEXT NOT NULL,
      type TEXT NOT NULL CHECK (type IN ('approve', 'reject', 'multi-choice', 'free-form')),
      prompt TEXT NOT NULL,
      options JSONB,
      response JSONB,
      status TEXT DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'rejected', 'expired')),
      expires_at TIMESTAMPTZ,
      responded_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ DEFAULT NOW()
    );

    -- Swarms table
    CREATE TABLE IF NOT EXISTS cogitator_swarms (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      description TEXT,
      strategy TEXT NOT NULL CHECK (strategy IN ('hierarchical', 'round-robin', 'consensus', 'auction', 'pipeline', 'debate')),
      config JSONB NOT NULL,
      agent_ids TEXT[] DEFAULT '{}',
      total_runs INTEGER DEFAULT 0,
      last_run_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ DEFAULT NOW(),
      updated_at TIMESTAMPTZ DEFAULT NOW()
    );

    -- Swarm runs table
    CREATE TABLE IF NOT EXISTS cogitator_swarm_runs (
      id TEXT PRIMARY KEY,
      swarm_id TEXT NOT NULL REFERENCES cogitator_swarms(id) ON DELETE CASCADE,
      status TEXT DEFAULT 'running' CHECK (status IN ('running', 'completed', 'failed', 'cancelled')),
      input TEXT NOT NULL,
      output TEXT,
      blackboard JSONB DEFAULT '{}',
      messages JSONB DEFAULT '[]',
      total_tokens BIGINT DEFAULT 0,
      total_cost DECIMAL(12, 6) DEFAULT 0,
      duration INTEGER,
      error TEXT,
      started_at TIMESTAMPTZ DEFAULT NOW(),
      completed_at TIMESTAMPTZ
    );

    -- Provider API keys (encrypted)
    CREATE TABLE IF NOT EXISTS cogitator_providers (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      api_key_encrypted TEXT,
      base_url TEXT,
      is_configured BOOLEAN DEFAULT false,
      last_verified_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ DEFAULT NOW(),
      updated_at TIMESTAMPTZ DEFAULT NOW()
    );

    -- Indexes
    CREATE INDEX IF NOT EXISTS idx_cogitator_threads_agent ON cogitator_threads(agent_id);
    CREATE INDEX IF NOT EXISTS idx_cogitator_messages_thread ON cogitator_messages(thread_id);
    CREATE INDEX IF NOT EXISTS idx_cogitator_messages_created ON cogitator_messages(created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_cogitator_runs_agent ON cogitator_runs(agent_id);
    CREATE INDEX IF NOT EXISTS idx_cogitator_runs_thread ON cogitator_runs(thread_id);
    CREATE INDEX IF NOT EXISTS idx_cogitator_runs_status ON cogitator_runs(status);
    CREATE INDEX IF NOT EXISTS idx_cogitator_runs_started ON cogitator_runs(started_at DESC);
    CREATE INDEX IF NOT EXISTS idx_cogitator_tool_calls_run ON cogitator_tool_calls(run_id);
    CREATE INDEX IF NOT EXISTS idx_cogitator_workflow_runs_workflow ON cogitator_workflow_runs(workflow_id);
    CREATE INDEX IF NOT EXISTS idx_cogitator_approvals_run ON cogitator_approvals(workflow_run_id);
    CREATE INDEX IF NOT EXISTS idx_cogitator_approvals_status ON cogitator_approvals(status);
    CREATE INDEX IF NOT EXISTS idx_cogitator_swarm_runs_swarm ON cogitator_swarm_runs(swarm_id);
  `);

  console.log('[db] Extended schema initialized');
}


export interface AgentRow {
  id: string;
  name: string;
  description: string | null;
  model: string;
  instructions: string;
  temperature: string;
  top_p: string;
  max_tokens: number | null;
  tools: string[];
  memory_enabled: boolean;
  max_iterations: number;
  timeout: number;
  response_format: unknown;
  config: Record<string, unknown>;
  total_runs: number;
  total_tokens: string;
  total_cost: string;
  last_run_at: Date | null;
  created_at: Date;
  updated_at: Date;
}

export interface AgentData {
  id: string;
  name: string;
  description?: string;
  model: string;
  instructions: string;
  temperature: number;
  topP: number;
  maxTokens?: number;
  tools: string[];
  memoryEnabled: boolean;
  maxIterations: number;
  timeout: number;
  responseFormat?: unknown;
  totalRuns: number;
  totalTokens: number;
  totalCost: number;
  lastRunAt?: string;
  createdAt: string;
  updatedAt: string;
}

function rowToAgentData(row: AgentRow): AgentData {
  return {
    id: row.id,
    name: row.name,
    description: row.description || undefined,
    model: row.model,
    instructions: row.instructions,
    temperature: parseFloat(row.temperature) || 0.7,
    topP: parseFloat(row.top_p) || 1.0,
    maxTokens: row.max_tokens || undefined,
    tools: row.tools || [],
    memoryEnabled: row.memory_enabled,
    maxIterations: row.max_iterations,
    timeout: row.timeout,
    responseFormat: row.response_format,
    totalRuns: row.total_runs,
    totalTokens: parseInt(row.total_tokens) || 0,
    totalCost: parseFloat(row.total_cost) || 0,
    lastRunAt: row.last_run_at?.toISOString(),
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
  };
}

export async function getAgents(): Promise<AgentData[]> {
  const rows = await query<AgentRow>(
    'SELECT * FROM cogitator_agents ORDER BY created_at DESC'
  );
  return rows.map(rowToAgentData);
}

export async function getAgent(id: string): Promise<AgentData | null> {
  const row = await queryOne<AgentRow>(
    'SELECT * FROM cogitator_agents WHERE id = $1',
    [id]
  );
  return row ? rowToAgentData(row) : null;
}

export async function createAgent(data: {
  name: string;
  model: string;
  instructions: string;
  description?: string;
  temperature?: number;
  topP?: number;
  maxTokens?: number;
  tools?: string[];
  memoryEnabled?: boolean;
  maxIterations?: number;
  timeout?: number;
  responseFormat?: unknown;
}): Promise<AgentData> {
  const id = `agent_${nanoid(12)}`;

  await execute(
    `INSERT INTO cogitator_agents (
      id, name, description, model, instructions,
      temperature, top_p, max_tokens, tools,
      memory_enabled, max_iterations, timeout, response_format
    ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)`,
    [
      id,
      data.name,
      data.description || null,
      data.model,
      data.instructions,
      data.temperature ?? 0.7,
      data.topP ?? 1.0,
      data.maxTokens || null,
      data.tools || [],
      data.memoryEnabled ?? true,
      data.maxIterations ?? 10,
      data.timeout ?? 300000,
      data.responseFormat ? JSON.stringify(data.responseFormat) : null,
    ]
  );

  return (await getAgent(id))!;
}

export async function updateAgent(
  id: string,
  data: Partial<{
    name: string;
    description: string;
    model: string;
    instructions: string;
    temperature: number;
    topP: number;
    maxTokens: number;
    tools: string[];
    memoryEnabled: boolean;
    maxIterations: number;
    timeout: number;
    responseFormat: unknown;
  }>
): Promise<AgentData | null> {
  const updates: string[] = [];
  const values: unknown[] = [];
  let idx = 1;

  const fieldMap: Record<string, string> = {
    name: 'name',
    description: 'description',
    model: 'model',
    instructions: 'instructions',
    temperature: 'temperature',
    topP: 'top_p',
    maxTokens: 'max_tokens',
    tools: 'tools',
    memoryEnabled: 'memory_enabled',
    maxIterations: 'max_iterations',
    timeout: 'timeout',
    responseFormat: 'response_format',
  };

  for (const [key, col] of Object.entries(fieldMap)) {
    if (data[key as keyof typeof data] !== undefined) {
      updates.push(`${col} = $${idx++}`);
      const val = data[key as keyof typeof data];
      values.push(key === 'responseFormat' ? JSON.stringify(val) : val);
    }
  }

  if (updates.length === 0) return getAgent(id);

  updates.push('updated_at = NOW()');
  values.push(id);

  await execute(
    `UPDATE cogitator_agents SET ${updates.join(', ')} WHERE id = $${idx}`,
    values
  );

  return getAgent(id);
}

export async function deleteAgent(id: string): Promise<boolean> {
  const count = await execute('DELETE FROM cogitator_agents WHERE id = $1', [id]);
  return count > 0;
}

export async function incrementAgentStats(
  id: string,
  tokens: number,
  cost: number
): Promise<void> {
  await execute(
    `UPDATE cogitator_agents 
     SET total_runs = total_runs + 1,
         total_tokens = total_tokens + $1,
         total_cost = total_cost + $2,
         last_run_at = NOW(),
         updated_at = NOW()
     WHERE id = $3`,
    [tokens, cost, id]
  );
}


export interface RunRow {
  id: string;
  agent_id: string | null;
  thread_id: string | null;
  status: 'running' | 'completed' | 'failed' | 'cancelled';
  input: string;
  output: string | null;
  input_tokens: number;
  output_tokens: number;
  total_tokens: number;
  cost: string;
  duration: number | null;
  iterations: number;
  error: string | null;
  trace: unknown;
  started_at: Date;
  completed_at: Date | null;
}

export interface RunData {
  id: string;
  agentId?: string;
  threadId?: string;
  status: 'running' | 'completed' | 'failed' | 'cancelled';
  input: string;
  output?: string;
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  cost: number;
  duration?: number;
  iterations: number;
  error?: string;
  trace?: unknown;
  startedAt: string;
  completedAt?: string;
}

function rowToRunData(row: RunRow): RunData {
  return {
    id: row.id,
    agentId: row.agent_id || undefined,
    threadId: row.thread_id || undefined,
    status: row.status,
    input: row.input,
    output: row.output || undefined,
    inputTokens: row.input_tokens,
    outputTokens: row.output_tokens,
    totalTokens: row.total_tokens,
    cost: parseFloat(row.cost) || 0,
    duration: row.duration || undefined,
    iterations: row.iterations,
    error: row.error || undefined,
    trace: row.trace,
    startedAt: row.started_at.toISOString(),
    completedAt: row.completed_at?.toISOString(),
  };
}

export async function getRuns(options?: {
  agentId?: string;
  status?: string;
  limit?: number;
  offset?: number;
}): Promise<RunData[]> {
  const conditions: string[] = [];
  const params: unknown[] = [];
  let idx = 1;

  if (options?.agentId) {
    conditions.push(`agent_id = $${idx++}`);
    params.push(options.agentId);
  }
  if (options?.status) {
    conditions.push(`status = $${idx++}`);
    params.push(options.status);
  }

  const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
  const limit = options?.limit || 50;
  const offset = options?.offset || 0;

  params.push(limit, offset);

  const rows = await query<RunRow>(
    `SELECT * FROM cogitator_runs ${where} ORDER BY started_at DESC LIMIT $${idx++} OFFSET $${idx}`,
    params
  );

  return rows.map(rowToRunData);
}

export async function getRun(id: string): Promise<RunData | null> {
  const row = await queryOne<RunRow>(
    'SELECT * FROM cogitator_runs WHERE id = $1',
    [id]
  );
  return row ? rowToRunData(row) : null;
}

export async function createRun(data: {
  id: string;
  agentId: string;
  threadId: string;
  input: string;
}): Promise<RunData> {
  await execute(
    `INSERT INTO cogitator_runs (id, agent_id, thread_id, input, status)
     VALUES ($1, $2, $3, $4, 'running')`,
    [data.id, data.agentId, data.threadId, data.input]
  );

  return (await getRun(data.id))!;
}

export async function completeRun(
  id: string,
  data: {
    status: 'completed' | 'failed' | 'cancelled';
    output?: string;
    inputTokens: number;
    outputTokens: number;
    cost: number;
    duration: number;
    iterations: number;
    error?: string;
    trace?: unknown;
  }
): Promise<RunData | null> {
  await execute(
    `UPDATE cogitator_runs SET
      status = $1,
      output = $2,
      input_tokens = $3,
      output_tokens = $4,
      total_tokens = $5,
      cost = $6,
      duration = $7,
      iterations = $8,
      error = $9,
      trace = $10,
      completed_at = NOW()
     WHERE id = $11`,
    [
      data.status,
      data.output || null,
      data.inputTokens,
      data.outputTokens,
      data.inputTokens + data.outputTokens,
      data.cost,
      data.duration,
      data.iterations,
      data.error || null,
      data.trace ? JSON.stringify(data.trace) : null,
      id,
    ]
  );

  return getRun(id);
}


export interface ThreadRow {
  id: string;
  agent_id: string | null;
  title: string | null;
  metadata: Record<string, unknown>;
  message_count: number;
  last_message_at: Date | null;
  created_at: Date;
  updated_at: Date;
}

export interface ThreadData {
  id: string;
  agentId?: string;
  title?: string;
  metadata: Record<string, unknown>;
  messageCount: number;
  lastMessageAt?: string;
  createdAt: string;
  updatedAt: string;
}

function rowToThreadData(row: ThreadRow): ThreadData {
  return {
    id: row.id,
    agentId: row.agent_id || undefined,
    title: row.title || undefined,
    metadata: row.metadata,
    messageCount: row.message_count,
    lastMessageAt: row.last_message_at?.toISOString(),
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
  };
}

export async function getThreads(options?: {
  agentId?: string;
  limit?: number;
}): Promise<ThreadData[]> {
  const conditions: string[] = [];
  const params: unknown[] = [];
  let idx = 1;

  if (options?.agentId) {
    conditions.push(`agent_id = $${idx++}`);
    params.push(options.agentId);
  }

  const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
  const limit = options?.limit || 50;
  params.push(limit);

  const rows = await query<ThreadRow>(
    `SELECT * FROM cogitator_threads ${where} ORDER BY updated_at DESC LIMIT $${idx}`,
    params
  );

  return rows.map(rowToThreadData);
}

export async function getThread(id: string): Promise<ThreadData | null> {
  const row = await queryOne<ThreadRow>(
    'SELECT * FROM cogitator_threads WHERE id = $1',
    [id]
  );
  return row ? rowToThreadData(row) : null;
}

export async function createThread(data: {
  id: string;
  agentId?: string;
  title?: string;
}): Promise<ThreadData> {
  await execute(
    `INSERT INTO cogitator_threads (id, agent_id, title)
     VALUES ($1, $2, $3)`,
    [data.id, data.agentId || null, data.title || null]
  );

  return (await getThread(data.id))!;
}

export async function deleteThread(id: string): Promise<boolean> {
  const count = await execute('DELETE FROM cogitator_threads WHERE id = $1', [id]);
  return count > 0;
}


export interface WorkflowRow {
  id: string;
  name: string;
  description: string | null;
  definition: unknown;
  initial_state: unknown;
  triggers: unknown;
  total_runs: number;
  last_run_at: Date | null;
  created_at: Date;
  updated_at: Date;
}

export interface WorkflowData {
  id: string;
  name: string;
  description?: string;
  definition: unknown;
  initialState: unknown;
  triggers: unknown[];
  totalRuns: number;
  lastRunAt?: string;
  createdAt: string;
  updatedAt: string;
}

function rowToWorkflowData(row: WorkflowRow): WorkflowData {
  return {
    id: row.id,
    name: row.name,
    description: row.description || undefined,
    definition: row.definition,
    initialState: row.initial_state,
    triggers: (row.triggers as unknown[]) || [],
    totalRuns: row.total_runs,
    lastRunAt: row.last_run_at?.toISOString(),
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
  };
}

export async function getWorkflows(options?: {
  limit?: number;
  offset?: number;
  search?: string;
}): Promise<{ workflows: WorkflowData[]; total: number }> {
  const limit = options?.limit || 50;
  const offset = options?.offset || 0;

  const conditions: string[] = [];
  const params: unknown[] = [];
  let idx = 1;

  if (options?.search) {
    conditions.push(`(name ILIKE $${idx} OR description ILIKE $${idx})`);
    params.push(`%${options.search}%`);
    idx++;
  }

  const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';

  const [rows, countResult] = await Promise.all([
    query<WorkflowRow>(
      `SELECT * FROM cogitator_workflows ${where} ORDER BY created_at DESC LIMIT $${idx++} OFFSET $${idx}`,
      [...params, limit, offset]
    ),
    queryOne<{ count: string }>(
      `SELECT COUNT(*) as count FROM cogitator_workflows ${where}`,
      params
    ),
  ]);

  return {
    workflows: rows.map(rowToWorkflowData),
    total: parseInt(countResult?.count || '0'),
  };
}

export async function getWorkflow(id: string): Promise<WorkflowData | null> {
  const row = await queryOne<WorkflowRow>(
    'SELECT * FROM cogitator_workflows WHERE id = $1',
    [id]
  );
  return row ? rowToWorkflowData(row) : null;
}

export async function createWorkflow(data: {
  name: string;
  description?: string;
  definition: unknown;
  initialState?: unknown;
  triggers?: unknown[];
}): Promise<WorkflowData> {
  const id = `wf_${nanoid(12)}`;

  await execute(
    `INSERT INTO cogitator_workflows (id, name, description, definition, initial_state, triggers)
     VALUES ($1, $2, $3, $4, $5, $6)`,
    [
      id,
      data.name,
      data.description || null,
      JSON.stringify(data.definition),
      JSON.stringify(data.initialState || {}),
      JSON.stringify(data.triggers || []),
    ]
  );

  return (await getWorkflow(id))!;
}

export async function updateWorkflow(
  id: string,
  data: Partial<{
    name: string;
    description: string;
    definition: unknown;
    initialState: unknown;
    triggers: unknown[];
  }>
): Promise<WorkflowData | null> {
  const updates: string[] = [];
  const values: unknown[] = [];
  let idx = 1;

  if (data.name !== undefined) {
    updates.push(`name = $${idx++}`);
    values.push(data.name);
  }
  if (data.description !== undefined) {
    updates.push(`description = $${idx++}`);
    values.push(data.description);
  }
  if (data.definition !== undefined) {
    updates.push(`definition = $${idx++}`);
    values.push(JSON.stringify(data.definition));
  }
  if (data.initialState !== undefined) {
    updates.push(`initial_state = $${idx++}`);
    values.push(JSON.stringify(data.initialState));
  }
  if (data.triggers !== undefined) {
    updates.push(`triggers = $${idx++}`);
    values.push(JSON.stringify(data.triggers));
  }

  if (updates.length === 0) return getWorkflow(id);

  updates.push('updated_at = NOW()');
  values.push(id);

  await execute(
    `UPDATE cogitator_workflows SET ${updates.join(', ')} WHERE id = $${idx}`,
    values
  );

  return getWorkflow(id);
}

export async function deleteWorkflow(id: string): Promise<boolean> {
  const count = await execute('DELETE FROM cogitator_workflows WHERE id = $1', [id]);
  return count > 0;
}


export interface WorkflowRunRow {
  id: string;
  workflow_id: string;
  input: string;
  output: string | null;
  status: string;
  error: string | null;
  duration: number | null;
  started_at: Date;
  completed_at: Date | null;
}

export interface WorkflowRunData {
  id: string;
  workflowId: string;
  input: string;
  output?: string;
  status: 'pending' | 'running' | 'completed' | 'failed';
  error?: string;
  duration?: number;
  startedAt: string;
  completedAt?: string;
}

function rowToWorkflowRunData(row: WorkflowRunRow): WorkflowRunData {
  return {
    id: row.id,
    workflowId: row.workflow_id,
    input: row.input,
    output: row.output || undefined,
    status: row.status as WorkflowRunData['status'],
    error: row.error || undefined,
    duration: row.duration || undefined,
    startedAt: row.started_at.toISOString(),
    completedAt: row.completed_at?.toISOString(),
  };
}

export async function createWorkflowRun(data: {
  workflowId: string;
  input: string;
}): Promise<WorkflowRunData> {
  const id = `wfrun_${nanoid(12)}`;
  
  const row = await queryOne<WorkflowRunRow>(
    `INSERT INTO cogitator_workflow_runs (id, workflow_id, input, status, started_at)
     VALUES ($1, $2, $3, 'running', NOW())
     RETURNING *`,
    [id, data.workflowId, data.input]
  );

  if (!row) throw new Error('Failed to create workflow run');
  
  await execute(
    'UPDATE cogitator_workflows SET total_runs = total_runs + 1, last_run_at = NOW() WHERE id = $1',
    [data.workflowId]
  );

  return rowToWorkflowRunData(row);
}

export async function updateWorkflowRun(
  id: string,
  data: Partial<{
    status: 'running' | 'completed' | 'failed';
    output: string;
    error: string;
    duration: number;
  }>
): Promise<WorkflowRunData | null> {
  const updates: string[] = [];
  const values: unknown[] = [];
  let paramIndex = 1;

  if (data.status !== undefined) {
    updates.push(`status = $${paramIndex++}`);
    values.push(data.status);
  }
  if (data.output !== undefined) {
    updates.push(`output = $${paramIndex++}`);
    values.push(data.output);
  }
  if (data.error !== undefined) {
    updates.push(`error = $${paramIndex++}`);
    values.push(data.error);
  }
  if (data.duration !== undefined) {
    updates.push(`duration = $${paramIndex++}`);
    values.push(data.duration);
  }
  if (data.status === 'completed' || data.status === 'failed') {
    updates.push(`completed_at = NOW()`);
  }

  if (updates.length === 0) return null;

  values.push(id);
  const row = await queryOne<WorkflowRunRow>(
    `UPDATE cogitator_workflow_runs SET ${updates.join(', ')} WHERE id = $${paramIndex} RETURNING *`,
    values
  );

  return row ? rowToWorkflowRunData(row) : null;
}

export async function getWorkflowRuns(workflowId: string): Promise<WorkflowRunData[]> {
  const rows = await query<WorkflowRunRow>(
    'SELECT * FROM cogitator_workflow_runs WHERE workflow_id = $1 ORDER BY started_at DESC',
    [workflowId]
  );
  return rows.map(rowToWorkflowRunData);
}


export interface SwarmRow {
  id: string;
  name: string;
  description: string | null;
  strategy: string;
  config: unknown;
  agent_ids: string[];
  total_runs: number;
  last_run_at: Date | null;
  created_at: Date;
  updated_at: Date;
}

export interface SwarmData {
  id: string;
  name: string;
  description?: string;
  strategy: string;
  config: unknown;
  agentIds: string[];
  totalRuns: number;
  lastRunAt?: string;
  createdAt: string;
  updatedAt: string;
}

function rowToSwarmData(row: SwarmRow): SwarmData {
  return {
    id: row.id,
    name: row.name,
    description: row.description || undefined,
    strategy: row.strategy,
    config: row.config,
    agentIds: row.agent_ids || [],
    totalRuns: row.total_runs,
    lastRunAt: row.last_run_at?.toISOString(),
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
  };
}

export async function getSwarms(options?: {
  limit?: number;
  offset?: number;
  search?: string;
  strategy?: string;
}): Promise<{ swarms: SwarmData[]; total: number }> {
  const limit = options?.limit || 50;
  const offset = options?.offset || 0;

  const conditions: string[] = [];
  const params: unknown[] = [];
  let idx = 1;

  if (options?.search) {
    conditions.push(`(name ILIKE $${idx} OR description ILIKE $${idx})`);
    params.push(`%${options.search}%`);
    idx++;
  }

  if (options?.strategy) {
    conditions.push(`strategy = $${idx++}`);
    params.push(options.strategy);
  }

  const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';

  const [rows, countResult] = await Promise.all([
    query<SwarmRow>(
      `SELECT * FROM cogitator_swarms ${where} ORDER BY created_at DESC LIMIT $${idx++} OFFSET $${idx}`,
      [...params, limit, offset]
    ),
    queryOne<{ count: string }>(
      `SELECT COUNT(*) as count FROM cogitator_swarms ${where}`,
      params
    ),
  ]);

  return {
    swarms: rows.map(rowToSwarmData),
    total: parseInt(countResult?.count || '0'),
  };
}

export async function getSwarm(id: string): Promise<SwarmData | null> {
  const row = await queryOne<SwarmRow>(
    'SELECT * FROM cogitator_swarms WHERE id = $1',
    [id]
  );
  return row ? rowToSwarmData(row) : null;
}

export async function createSwarm(data: {
  name: string;
  description?: string;
  strategy: string;
  config: unknown;
  agentIds?: string[];
}): Promise<SwarmData> {
  const id = `swarm_${nanoid(12)}`;

  await execute(
    `INSERT INTO cogitator_swarms (id, name, description, strategy, config, agent_ids)
     VALUES ($1, $2, $3, $4, $5, $6)`,
    [
      id,
      data.name,
      data.description || null,
      data.strategy,
      JSON.stringify(data.config),
      data.agentIds || [],
    ]
  );

  return (await getSwarm(id))!;
}

export async function updateSwarm(
  id: string,
  data: Partial<{
    name: string;
    description: string;
    strategy: string;
    config: unknown;
    agentIds: string[];
  }>
): Promise<SwarmData | null> {
  const updates: string[] = [];
  const values: unknown[] = [];
  let idx = 1;

  if (data.name !== undefined) {
    updates.push(`name = $${idx++}`);
    values.push(data.name);
  }
  if (data.description !== undefined) {
    updates.push(`description = $${idx++}`);
    values.push(data.description);
  }
  if (data.strategy !== undefined) {
    updates.push(`strategy = $${idx++}`);
    values.push(data.strategy);
  }
  if (data.config !== undefined) {
    updates.push(`config = $${idx++}`);
    values.push(JSON.stringify(data.config));
  }
  if (data.agentIds !== undefined) {
    updates.push(`agent_ids = $${idx++}`);
    values.push(data.agentIds);
  }

  if (updates.length === 0) return getSwarm(id);

  updates.push('updated_at = NOW()');
  values.push(id);

  await execute(
    `UPDATE cogitator_swarms SET ${updates.join(', ')} WHERE id = $${idx}`,
    values
  );

  return getSwarm(id);
}

export async function deleteSwarm(id: string): Promise<boolean> {
  const count = await execute('DELETE FROM cogitator_swarms WHERE id = $1', [id]);
  return count > 0;
}


export interface SwarmRunData {
  id: string;
  swarmId: string;
  input: string;
  output?: string;
  status: 'pending' | 'running' | 'completed' | 'failed';
  error?: string;
  duration?: number;
  tokensUsed?: number;
  startedAt: string;
  completedAt?: string;
}

interface SwarmRunRow {
  id: string;
  swarm_id: string;
  input: string;
  output: string | null;
  status: string;
  error: string | null;
  duration: number | null;
  total_tokens: string | null;
  started_at: Date;
  completed_at: Date | null;
}

function rowToSwarmRun(row: SwarmRunRow): SwarmRunData {
  return {
    id: row.id,
    swarmId: row.swarm_id,
    input: row.input,
    output: row.output || undefined,
    status: row.status as SwarmRunData['status'],
    error: row.error || undefined,
    duration: row.duration || undefined,
    tokensUsed: row.total_tokens ? parseInt(row.total_tokens) : undefined,
    startedAt: row.started_at.toISOString(),
    completedAt: row.completed_at?.toISOString(),
  };
}

export async function createSwarmRun(data: {
  swarmId: string;
  input: string;
  status?: 'pending' | 'running' | 'completed' | 'failed';
}): Promise<SwarmRunData> {
  const id = `swarm_run_${nanoid(12)}`;
  const row = await queryOne<SwarmRunRow>(
    `INSERT INTO cogitator_swarm_runs (id, swarm_id, input, status, started_at)
     VALUES ($1, $2, $3, $4, NOW())
     RETURNING *`,
    [id, data.swarmId, data.input, data.status || 'pending']
  );
  return rowToSwarmRun(row!);
}

export async function updateSwarmRun(
  id: string,
  data: Partial<{
    output: string;
    status: 'pending' | 'running' | 'completed' | 'failed';
    error: string;
    duration: number;
    tokensUsed: number;
  }>
): Promise<SwarmRunData | null> {
  const updates: string[] = [];
  const values: unknown[] = [];
  let paramIndex = 1;

  if (data.output !== undefined) {
    updates.push(`output = $${paramIndex++}`);
    values.push(data.output);
  }
  if (data.status !== undefined) {
    updates.push(`status = $${paramIndex++}`);
    values.push(data.status);
    if (data.status === 'completed' || data.status === 'failed') {
      updates.push(`completed_at = NOW()`);
    }
  }
  if (data.error !== undefined) {
    updates.push(`error = $${paramIndex++}`);
    values.push(data.error);
  }
  if (data.duration !== undefined) {
    updates.push(`duration = $${paramIndex++}`);
    values.push(data.duration);
  }
  if (data.tokensUsed !== undefined) {
    updates.push(`total_tokens = $${paramIndex++}`);
    values.push(data.tokensUsed);
  }

  if (updates.length === 0) return null;

  values.push(id);
  const row = await queryOne<SwarmRunRow>(
    `UPDATE cogitator_swarm_runs SET ${updates.join(', ')} WHERE id = $${paramIndex} RETURNING *`,
    values
  );

  if (row && data.status === 'completed') {
    await execute(
      `UPDATE cogitator_swarms SET last_run_at = NOW(), total_runs = total_runs + 1 WHERE id = $1`,
      [row.swarm_id]
    );
  }

  return row ? rowToSwarmRun(row) : null;
}


export interface AnalyticsData {
  totalRuns: number;
  totalTokens: number;
  totalCost: number;
  avgDuration: number;
  runsPerDay: Array<{ date: string; count: number }>;
  tokensByModel: Array<{ model: string; tokens: number }>;
  costByModel: Array<{ model: string; cost: number }>;
}

export async function getAnalytics(days: number = 7): Promise<AnalyticsData> {
  const safeDays = Math.max(1, Math.min(365, Math.floor(days)));

  const [totals] = await query<{
    total_runs: string;
    total_tokens: string;
    total_cost: string;
    avg_duration: string;
  }>(
    `SELECT
      COUNT(*) as total_runs,
      COALESCE(SUM(total_tokens), 0) as total_tokens,
      COALESCE(SUM(cost), 0) as total_cost,
      COALESCE(AVG(duration), 0) as avg_duration
    FROM cogitator_runs
    WHERE started_at > NOW() - INTERVAL '1 day' * $1`,
    [safeDays]
  );

  const runsPerDay = await query<{ date: string; count: string }>(
    `SELECT
      DATE(started_at) as date,
      COUNT(*) as count
    FROM cogitator_runs
    WHERE started_at > NOW() - INTERVAL '1 day' * $1
    GROUP BY DATE(started_at)
    ORDER BY date`,
    [safeDays]
  );

  const tokensByAgent = await query<{ model: string; tokens: string }>(
    `SELECT
      a.model,
      COALESCE(SUM(r.total_tokens), 0) as tokens
    FROM cogitator_agents a
    LEFT JOIN cogitator_runs r ON r.agent_id = a.id AND r.started_at > NOW() - INTERVAL '1 day' * $1
    GROUP BY a.model
    ORDER BY tokens DESC
    LIMIT 10`,
    [safeDays]
  );

  const costByAgent = await query<{ model: string; cost: string }>(
    `SELECT
      a.model,
      COALESCE(SUM(r.cost), 0) as cost
    FROM cogitator_agents a
    LEFT JOIN cogitator_runs r ON r.agent_id = a.id AND r.started_at > NOW() - INTERVAL '1 day' * $1
    GROUP BY a.model
    ORDER BY cost DESC
    LIMIT 10`,
    [safeDays]
  );

  return {
    totalRuns: parseInt(totals?.total_runs || '0'),
    totalTokens: parseInt(totals?.total_tokens || '0'),
    totalCost: parseFloat(totals?.total_cost || '0'),
    avgDuration: parseFloat(totals?.avg_duration || '0'),
    runsPerDay: runsPerDay.map((r) => ({ date: r.date, count: parseInt(r.count) })),
    tokensByModel: tokensByAgent.map((r) => ({
      model: r.model,
      tokens: parseInt(r.tokens),
    })),
    costByModel: costByAgent.map((r) => ({
      model: r.model,
      cost: parseFloat(r.cost),
    })),
  };
}

