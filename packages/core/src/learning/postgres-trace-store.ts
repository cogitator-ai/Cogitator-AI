import type {
  ExecutionTrace,
  TraceQuery,
  TraceStoreStats,
  CapturedPrompt,
  PromptQuery,
  ABTest,
  ABTestStatus,
  ABTestVariant,
  ABTestResults,
  InstructionVersion,
  InstructionVersionMetrics,
  CombinedPersistentStore,
  ToolCall,
} from '@cogitator-ai/types';
import { nanoid } from 'nanoid';

type Pool = {
  query(text: string, values?: unknown[]): Promise<{ rows: Record<string, unknown>[] }>;
  connect(): Promise<{ release(): void }>;
  end(): Promise<void>;
};

export interface PostgresTraceStoreConfig {
  connectionString: string;
  schema?: string;
  poolSize?: number;
}

export class PostgresTraceStore implements CombinedPersistentStore {
  private pool: Pool | null = null;
  private config: PostgresTraceStoreConfig;
  private schema: string;

  constructor(config: PostgresTraceStoreConfig) {
    this.config = config;
    const schema = config.schema ?? 'cogitator';
    if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(schema)) {
      throw new Error(
        `Invalid schema name: "${schema}". Must be a valid SQL identifier (alphanumeric and underscores only).`
      );
    }
    this.schema = schema;
  }

  async connect(): Promise<void> {
    const pg = await import('pg');
    const { Pool } = pg.default ?? pg;

    this.pool = new Pool({
      connectionString: this.config.connectionString,
      max: this.config.poolSize ?? 10,
    }) as Pool;

    const client = await this.pool.connect();
    client.release();

    await this.initSchema();
  }

  async disconnect(): Promise<void> {
    if (this.pool) {
      await this.pool.end();
      this.pool = null;
    }
  }

  private async initSchema(): Promise<void> {
    if (!this.pool) return;

    await this.pool.query(`CREATE SCHEMA IF NOT EXISTS ${this.schema}`);

    await this.pool.query(`
      CREATE TABLE IF NOT EXISTS ${this.schema}.traces (
        id TEXT PRIMARY KEY,
        run_id TEXT NOT NULL,
        agent_id TEXT NOT NULL,
        thread_id TEXT NOT NULL,
        input TEXT NOT NULL,
        output TEXT NOT NULL,
        context JSONB,
        steps JSONB NOT NULL,
        tool_calls JSONB NOT NULL,
        reflections JSONB,
        metrics JSONB NOT NULL,
        score REAL NOT NULL,
        model TEXT NOT NULL,
        duration INTEGER NOT NULL,
        usage JSONB NOT NULL,
        labels TEXT[],
        is_demo BOOLEAN DEFAULT FALSE,
        expected JSONB,
        created_at TIMESTAMPTZ DEFAULT NOW()
      )
    `);

    await this.pool.query(`
      CREATE TABLE IF NOT EXISTS ${this.schema}.prompts (
        id TEXT PRIMARY KEY,
        run_id TEXT NOT NULL,
        agent_id TEXT NOT NULL,
        thread_id TEXT NOT NULL,
        model TEXT NOT NULL,
        provider TEXT NOT NULL,
        system_prompt TEXT NOT NULL,
        messages JSONB NOT NULL,
        tools JSONB,
        injected_demos TEXT,
        injected_insights TEXT,
        temperature REAL,
        top_p REAL,
        max_tokens INTEGER,
        prompt_tokens INTEGER NOT NULL,
        response_content TEXT,
        response_tool_calls JSONB,
        completion_tokens INTEGER,
        finish_reason TEXT,
        latency_ms INTEGER,
        metadata JSONB,
        created_at TIMESTAMPTZ DEFAULT NOW()
      )
    `);

    await this.pool.query(`
      CREATE TABLE IF NOT EXISTS ${this.schema}.ab_tests (
        id TEXT PRIMARY KEY,
        agent_id TEXT NOT NULL,
        name TEXT NOT NULL,
        description TEXT,
        status TEXT NOT NULL,
        control_instructions TEXT NOT NULL,
        treatment_instructions TEXT NOT NULL,
        treatment_allocation REAL NOT NULL,
        min_sample_size INTEGER NOT NULL,
        max_duration BIGINT NOT NULL,
        confidence_level REAL NOT NULL,
        metric_to_optimize TEXT NOT NULL,
        control_results JSONB NOT NULL DEFAULT '{"sampleSize":0,"successRate":0,"avgScore":0,"avgLatency":0,"totalCost":0,"scores":[]}',
        treatment_results JSONB NOT NULL DEFAULT '{"sampleSize":0,"successRate":0,"avgScore":0,"avgLatency":0,"totalCost":0,"scores":[]}',
        created_at TIMESTAMPTZ DEFAULT NOW(),
        started_at TIMESTAMPTZ,
        completed_at TIMESTAMPTZ
      )
    `);

    await this.pool.query(`
      CREATE TABLE IF NOT EXISTS ${this.schema}.instruction_versions (
        id TEXT PRIMARY KEY,
        agent_id TEXT NOT NULL,
        version INTEGER NOT NULL,
        instructions TEXT NOT NULL,
        source TEXT NOT NULL,
        source_id TEXT,
        deployed_at TIMESTAMPTZ NOT NULL,
        retired_at TIMESTAMPTZ,
        run_count INTEGER DEFAULT 0,
        avg_score REAL DEFAULT 0,
        success_rate REAL DEFAULT 0,
        avg_latency REAL DEFAULT 0,
        total_cost REAL DEFAULT 0,
        parent_version_id TEXT
      )
    `);

    await this.pool.query(`
      CREATE INDEX IF NOT EXISTS idx_traces_agent_id
      ON ${this.schema}.traces(agent_id, created_at)
    `);
    await this.pool.query(`
      CREATE INDEX IF NOT EXISTS idx_traces_score
      ON ${this.schema}.traces(agent_id, score)
    `);
    await this.pool.query(`
      CREATE INDEX IF NOT EXISTS idx_traces_is_demo
      ON ${this.schema}.traces(agent_id, is_demo) WHERE is_demo = TRUE
    `);
    await this.pool.query(`
      CREATE INDEX IF NOT EXISTS idx_prompts_agent_id
      ON ${this.schema}.prompts(agent_id, created_at)
    `);
    await this.pool.query(`
      CREATE INDEX IF NOT EXISTS idx_prompts_run_id
      ON ${this.schema}.prompts(run_id)
    `);
    await this.pool.query(`
      CREATE INDEX IF NOT EXISTS idx_ab_tests_agent_id
      ON ${this.schema}.ab_tests(agent_id, status)
    `);
    await this.pool.query(`
      CREATE INDEX IF NOT EXISTS idx_instruction_versions_agent
      ON ${this.schema}.instruction_versions(agent_id, version DESC)
    `);
  }

  private generateId(prefix: string): string {
    return `${prefix}_${nanoid(12)}`;
  }

  async storeTrace(trace: ExecutionTrace): Promise<void> {
    if (!this.pool) throw new Error('Not connected');

    await this.pool.query(
      `INSERT INTO ${this.schema}.traces
       (id, run_id, agent_id, thread_id, input, output, context, steps, tool_calls, reflections, metrics, score, model, duration, usage, labels, is_demo, expected, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19)`,
      [
        trace.id,
        trace.runId,
        trace.agentId,
        trace.threadId,
        trace.input,
        trace.output,
        trace.context ?? null,
        trace.steps,
        trace.toolCalls,
        trace.reflections ?? null,
        trace.metrics,
        trace.score,
        trace.model,
        trace.duration,
        trace.usage,
        trace.labels ?? [],
        trace.isDemo,
        trace.expected ?? null,
        trace.createdAt,
      ]
    );
  }

  async storeTraceMany(traces: ExecutionTrace[]): Promise<void> {
    for (const trace of traces) {
      await this.storeTrace(trace);
    }
  }

  async getTrace(id: string): Promise<ExecutionTrace | null> {
    if (!this.pool) throw new Error('Not connected');

    const result = await this.pool.query(`SELECT * FROM ${this.schema}.traces WHERE id = $1`, [id]);

    if (result.rows.length === 0) return null;

    return this.rowToTrace(result.rows[0]);
  }

  async getTraceByRunId(runId: string): Promise<ExecutionTrace | null> {
    if (!this.pool) throw new Error('Not connected');

    const result = await this.pool.query(`SELECT * FROM ${this.schema}.traces WHERE run_id = $1`, [
      runId,
    ]);

    if (result.rows.length === 0) return null;

    return this.rowToTrace(result.rows[0]);
  }

  async queryTraces(query: TraceQuery): Promise<ExecutionTrace[]> {
    if (!this.pool) throw new Error('Not connected');

    let sql = `SELECT * FROM ${this.schema}.traces WHERE 1=1`;
    const params: unknown[] = [];
    let paramIndex = 1;

    if (query.agentId) {
      sql += ` AND agent_id = $${paramIndex++}`;
      params.push(query.agentId);
    }
    if (query.minScore !== undefined) {
      sql += ` AND score >= $${paramIndex++}`;
      params.push(query.minScore);
    }
    if (query.isDemo !== undefined) {
      sql += ` AND is_demo = $${paramIndex++}`;
      params.push(query.isDemo);
    }
    if (query.labels && query.labels.length > 0) {
      sql += ` AND labels && $${paramIndex++}`;
      params.push(query.labels);
    }
    if (query.fromDate) {
      sql += ` AND created_at >= $${paramIndex++}`;
      params.push(query.fromDate);
    }
    if (query.toDate) {
      sql += ` AND created_at <= $${paramIndex++}`;
      params.push(query.toDate);
    }

    sql += ' ORDER BY created_at DESC';

    if (query.limit) {
      sql += ` LIMIT $${paramIndex++}`;
      params.push(query.limit);
    }

    const result = await this.pool.query(sql, params);

    return result.rows.map((row) => this.rowToTrace(row));
  }

  async getAllTraces(agentId: string): Promise<ExecutionTrace[]> {
    if (!this.pool) throw new Error('Not connected');

    const result = await this.pool.query(
      `SELECT * FROM ${this.schema}.traces WHERE agent_id = $1 ORDER BY created_at DESC`,
      [agentId]
    );

    return result.rows.map((row) => this.rowToTrace(row));
  }

  async getDemos(agentId: string, limit = 10): Promise<ExecutionTrace[]> {
    if (!this.pool) throw new Error('Not connected');

    const result = await this.pool.query(
      `SELECT * FROM ${this.schema}.traces WHERE agent_id = $1 AND is_demo = TRUE ORDER BY score DESC LIMIT $2`,
      [agentId, limit]
    );

    return result.rows.map((row) => this.rowToTrace(row));
  }

  async markAsDemo(id: string): Promise<void> {
    if (!this.pool) throw new Error('Not connected');

    await this.pool.query(`UPDATE ${this.schema}.traces SET is_demo = TRUE WHERE id = $1`, [id]);
  }

  async unmarkAsDemo(id: string): Promise<void> {
    if (!this.pool) throw new Error('Not connected');

    await this.pool.query(`UPDATE ${this.schema}.traces SET is_demo = FALSE WHERE id = $1`, [id]);
  }

  async deleteTrace(id: string): Promise<boolean> {
    if (!this.pool) throw new Error('Not connected');

    const result = await this.pool.query(`DELETE FROM ${this.schema}.traces WHERE id = $1`, [id]);

    return (result as unknown as { rowCount: number }).rowCount > 0;
  }

  async pruneTraces(agentId: string, maxTraces: number): Promise<number> {
    if (!this.pool) throw new Error('Not connected');

    const result = await this.pool.query(
      `DELETE FROM ${this.schema}.traces
       WHERE id IN (
         SELECT id FROM ${this.schema}.traces
         WHERE agent_id = $1 AND is_demo = FALSE
         ORDER BY created_at DESC
         OFFSET $2
       )`,
      [agentId, maxTraces]
    );

    return (result as unknown as { rowCount: number }).rowCount;
  }

  async clearTraces(agentId: string): Promise<void> {
    if (!this.pool) throw new Error('Not connected');

    await this.pool.query(`DELETE FROM ${this.schema}.traces WHERE agent_id = $1`, [agentId]);
  }

  async getTraceStats(agentId: string): Promise<TraceStoreStats> {
    if (!this.pool) throw new Error('Not connected');

    const countResult = await this.pool.query(
      `SELECT COUNT(*) as total, COUNT(*) FILTER (WHERE is_demo) as demos, AVG(score) as avg_score
       FROM ${this.schema}.traces WHERE agent_id = $1`,
      [agentId]
    );

    const row = countResult.rows[0];

    return {
      totalTraces: parseInt(row.total as string, 10),
      demoCount: parseInt(row.demos as string, 10),
      averageScore: parseFloat(row.avg_score as string) || 0,
      scoreDistribution: [],
      topPerformers: [],
    };
  }

  private rowToTrace(row: Record<string, unknown>): ExecutionTrace {
    return {
      id: row.id as string,
      runId: row.run_id as string,
      agentId: row.agent_id as string,
      threadId: row.thread_id as string,
      input: row.input as string,
      output: row.output as string,
      context: row.context as Record<string, unknown> | undefined,
      steps: row.steps as ExecutionTrace['steps'],
      toolCalls: row.tool_calls as ExecutionTrace['toolCalls'],
      reflections: row.reflections as ExecutionTrace['reflections'],
      metrics: row.metrics as ExecutionTrace['metrics'],
      score: row.score as number,
      model: row.model as string,
      duration: row.duration as number,
      usage: row.usage as ExecutionTrace['usage'],
      labels: row.labels as string[] | undefined,
      isDemo: row.is_demo as boolean,
      expected: row.expected as unknown,
      createdAt: new Date(row.created_at as string),
    };
  }

  async capture(prompt: CapturedPrompt): Promise<void> {
    if (!this.pool) throw new Error('Not connected');

    await this.pool.query(
      `INSERT INTO ${this.schema}.prompts
       (id, run_id, agent_id, thread_id, model, provider, system_prompt, messages, tools, injected_demos, injected_insights, temperature, top_p, max_tokens, prompt_tokens, response_content, response_tool_calls, completion_tokens, finish_reason, latency_ms, metadata, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20, $21, $22)`,
      [
        prompt.id,
        prompt.runId,
        prompt.agentId,
        prompt.threadId,
        prompt.model,
        prompt.provider,
        prompt.systemPrompt,
        prompt.messages,
        prompt.tools ?? null,
        prompt.injectedDemos ?? null,
        prompt.injectedInsights ?? null,
        prompt.temperature ?? null,
        prompt.topP ?? null,
        prompt.maxTokens ?? null,
        prompt.promptTokens,
        prompt.response?.content ?? null,
        prompt.response?.toolCalls ?? null,
        prompt.response?.completionTokens ?? null,
        prompt.response?.finishReason ?? null,
        prompt.response?.latencyMs ?? null,
        prompt.metadata ?? null,
        prompt.timestamp,
      ]
    );
  }

  async getPrompt(id: string): Promise<CapturedPrompt | null> {
    if (!this.pool) throw new Error('Not connected');

    const result = await this.pool.query(`SELECT * FROM ${this.schema}.prompts WHERE id = $1`, [
      id,
    ]);

    if (result.rows.length === 0) return null;

    return this.rowToPrompt(result.rows[0]);
  }

  async getByRun(runId: string): Promise<CapturedPrompt[]> {
    if (!this.pool) throw new Error('Not connected');

    const result = await this.pool.query(
      `SELECT * FROM ${this.schema}.prompts WHERE run_id = $1 ORDER BY created_at ASC`,
      [runId]
    );

    return result.rows.map((row) => this.rowToPrompt(row));
  }

  async query(query: PromptQuery): Promise<CapturedPrompt[]> {
    if (!this.pool) throw new Error('Not connected');

    let sql = `SELECT * FROM ${this.schema}.prompts WHERE 1=1`;
    const params: unknown[] = [];
    let paramIndex = 1;

    if (query.agentId) {
      sql += ` AND agent_id = $${paramIndex++}`;
      params.push(query.agentId);
    }
    if (query.model) {
      sql += ` AND model = $${paramIndex++}`;
      params.push(query.model);
    }
    if (query.fromDate) {
      sql += ` AND created_at >= $${paramIndex++}`;
      params.push(query.fromDate);
    }
    if (query.toDate) {
      sql += ` AND created_at <= $${paramIndex++}`;
      params.push(query.toDate);
    }
    if (query.minLatency !== undefined) {
      sql += ` AND latency_ms >= $${paramIndex++}`;
      params.push(query.minLatency);
    }
    if (query.maxLatency !== undefined) {
      sql += ` AND latency_ms <= $${paramIndex++}`;
      params.push(query.maxLatency);
    }

    sql += ' ORDER BY created_at DESC';

    if (query.limit) {
      sql += ` LIMIT $${paramIndex++}`;
      params.push(query.limit);
    }
    if (query.offset) {
      sql += ` OFFSET $${paramIndex++}`;
      params.push(query.offset);
    }

    const result = await this.pool.query(sql, params);

    return result.rows.map((row) => this.rowToPrompt(row));
  }

  async deletePrompt(id: string): Promise<boolean> {
    if (!this.pool) throw new Error('Not connected');

    const result = await this.pool.query(`DELETE FROM ${this.schema}.prompts WHERE id = $1`, [id]);

    return (result as unknown as { rowCount: number }).rowCount > 0;
  }

  async prune(beforeDate: Date): Promise<number> {
    if (!this.pool) throw new Error('Not connected');

    const result = await this.pool.query(
      `DELETE FROM ${this.schema}.prompts WHERE created_at < $1`,
      [beforeDate]
    );

    return (result as unknown as { rowCount: number }).rowCount;
  }

  private rowToPrompt(row: Record<string, unknown>): CapturedPrompt {
    const response = row.response_content
      ? {
          content: row.response_content as string,
          toolCalls: row.response_tool_calls as ToolCall[] | undefined,
          completionTokens: row.completion_tokens as number,
          finishReason: row.finish_reason as string,
          latencyMs: row.latency_ms as number,
        }
      : undefined;

    return {
      id: row.id as string,
      runId: row.run_id as string,
      agentId: row.agent_id as string,
      threadId: row.thread_id as string,
      model: row.model as string,
      provider: row.provider as string,
      timestamp: new Date(row.created_at as string),
      systemPrompt: row.system_prompt as string,
      messages: row.messages as CapturedPrompt['messages'],
      tools: row.tools as CapturedPrompt['tools'],
      injectedDemos: row.injected_demos as string | undefined,
      injectedInsights: row.injected_insights as string | undefined,
      temperature: row.temperature as number | undefined,
      topP: row.top_p as number | undefined,
      maxTokens: row.max_tokens as number | undefined,
      promptTokens: row.prompt_tokens as number,
      response: response as CapturedPrompt['response'],
      metadata: row.metadata as Record<string, unknown> | undefined,
    };
  }

  async create(test: Omit<ABTest, 'id' | 'createdAt'>): Promise<ABTest> {
    if (!this.pool) throw new Error('Not connected');

    const id = this.generateId('abtest');
    const now = new Date();

    await this.pool.query(
      `INSERT INTO ${this.schema}.ab_tests
       (id, agent_id, name, description, status, control_instructions, treatment_instructions, treatment_allocation, min_sample_size, max_duration, confidence_level, metric_to_optimize, control_results, treatment_results, created_at, started_at, completed_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17)`,
      [
        id,
        test.agentId,
        test.name,
        test.description ?? null,
        test.status,
        test.controlInstructions,
        test.treatmentInstructions,
        test.treatmentAllocation,
        test.minSampleSize,
        test.maxDuration,
        test.confidenceLevel,
        test.metricToOptimize,
        test.controlResults,
        test.treatmentResults,
        now,
        test.startedAt ?? null,
        test.completedAt ?? null,
      ]
    );

    return { ...test, id, createdAt: now };
  }

  async getABTest(id: string): Promise<ABTest | null> {
    if (!this.pool) throw new Error('Not connected');

    const result = await this.pool.query(`SELECT * FROM ${this.schema}.ab_tests WHERE id = $1`, [
      id,
    ]);

    if (result.rows.length === 0) return null;

    return this.rowToABTest(result.rows[0]);
  }

  async getActive(agentId: string): Promise<ABTest | null> {
    if (!this.pool) throw new Error('Not connected');

    const result = await this.pool.query(
      `SELECT * FROM ${this.schema}.ab_tests WHERE agent_id = $1 AND status = 'running' LIMIT 1`,
      [agentId]
    );

    if (result.rows.length === 0) return null;

    return this.rowToABTest(result.rows[0]);
  }

  async update(id: string, updates: Partial<ABTest>): Promise<ABTest> {
    if (!this.pool) throw new Error('Not connected');

    const setClauses: string[] = [];
    const params: unknown[] = [];
    let paramIndex = 1;

    if (updates.status !== undefined) {
      setClauses.push(`status = $${paramIndex++}`);
      params.push(updates.status);
    }
    if (updates.startedAt !== undefined) {
      setClauses.push(`started_at = $${paramIndex++}`);
      params.push(updates.startedAt);
    }
    if (updates.completedAt !== undefined) {
      setClauses.push(`completed_at = $${paramIndex++}`);
      params.push(updates.completedAt);
    }
    if (updates.controlResults !== undefined) {
      setClauses.push(`control_results = $${paramIndex++}`);
      params.push(updates.controlResults);
    }
    if (updates.treatmentResults !== undefined) {
      setClauses.push(`treatment_results = $${paramIndex++}`);
      params.push(updates.treatmentResults);
    }

    if (setClauses.length === 0) {
      const existing = await this.getABTest(id);
      if (!existing) throw new Error(`AB test not found: ${id}`);
      return existing;
    }

    params.push(id);

    const result = await this.pool.query(
      `UPDATE ${this.schema}.ab_tests SET ${setClauses.join(', ')} WHERE id = $${paramIndex} RETURNING *`,
      params
    );

    return this.rowToABTest(result.rows[0]);
  }

  async recordResult(
    testId: string,
    variant: ABTestVariant,
    score: number,
    latency: number,
    cost: number
  ): Promise<void> {
    if (!this.pool) throw new Error('Not connected');

    const test = await this.getABTest(testId);
    if (!test) return;

    const results = variant === 'control' ? test.controlResults : test.treatmentResults;
    const newResults: ABTestResults = {
      sampleSize: results.sampleSize + 1,
      successRate:
        (results.successRate * results.sampleSize + (score >= 0.5 ? 1 : 0)) /
        (results.sampleSize + 1),
      avgScore: (results.avgScore * results.sampleSize + score) / (results.sampleSize + 1),
      avgLatency: (results.avgLatency * results.sampleSize + latency) / (results.sampleSize + 1),
      totalCost: results.totalCost + cost,
      scores: [...results.scores, score],
    };

    const column = variant === 'control' ? 'control_results' : 'treatment_results';
    await this.pool.query(`UPDATE ${this.schema}.ab_tests SET ${column} = $1 WHERE id = $2`, [
      newResults,
      testId,
    ]);
  }

  async list(agentId?: string, status?: ABTestStatus): Promise<ABTest[]> {
    if (!this.pool) throw new Error('Not connected');

    let sql = `SELECT * FROM ${this.schema}.ab_tests WHERE 1=1`;
    const params: unknown[] = [];
    let paramIndex = 1;

    if (agentId) {
      sql += ` AND agent_id = $${paramIndex++}`;
      params.push(agentId);
    }
    if (status) {
      sql += ` AND status = $${paramIndex++}`;
      params.push(status);
    }

    sql += ' ORDER BY created_at DESC';

    const result = await this.pool.query(sql, params);

    return result.rows.map((row) => this.rowToABTest(row));
  }

  async deleteABTest(id: string): Promise<boolean> {
    if (!this.pool) throw new Error('Not connected');

    const result = await this.pool.query(`DELETE FROM ${this.schema}.ab_tests WHERE id = $1`, [id]);

    return (result as unknown as { rowCount: number }).rowCount > 0;
  }

  private rowToABTest(row: Record<string, unknown>): ABTest {
    return {
      id: row.id as string,
      agentId: row.agent_id as string,
      name: row.name as string,
      description: row.description as string | undefined,
      status: row.status as ABTestStatus,
      controlInstructions: row.control_instructions as string,
      treatmentInstructions: row.treatment_instructions as string,
      treatmentAllocation: row.treatment_allocation as number,
      minSampleSize: row.min_sample_size as number,
      maxDuration: parseInt(row.max_duration as string, 10),
      confidenceLevel: row.confidence_level as number,
      metricToOptimize: row.metric_to_optimize as string,
      controlResults: row.control_results as ABTestResults,
      treatmentResults: row.treatment_results as ABTestResults,
      createdAt: new Date(row.created_at as string),
      startedAt: row.started_at ? new Date(row.started_at as string) : undefined,
      completedAt: row.completed_at ? new Date(row.completed_at as string) : undefined,
    };
  }

  async save(version: Omit<InstructionVersion, 'id'>): Promise<InstructionVersion> {
    if (!this.pool) throw new Error('Not connected');

    const id = this.generateId('ver');

    await this.pool.query(
      `INSERT INTO ${this.schema}.instruction_versions
       (id, agent_id, version, instructions, source, source_id, deployed_at, retired_at, run_count, avg_score, success_rate, avg_latency, total_cost, parent_version_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)`,
      [
        id,
        version.agentId,
        version.version,
        version.instructions,
        version.source,
        version.sourceId ?? null,
        version.deployedAt,
        version.retiredAt ?? null,
        version.metrics.runCount,
        version.metrics.avgScore,
        version.metrics.successRate,
        version.metrics.avgLatency,
        version.metrics.totalCost,
        version.parentVersionId ?? null,
      ]
    );

    return { ...version, id };
  }

  async getVersion(id: string): Promise<InstructionVersion | null> {
    if (!this.pool) throw new Error('Not connected');

    const result = await this.pool.query(
      `SELECT * FROM ${this.schema}.instruction_versions WHERE id = $1`,
      [id]
    );

    if (result.rows.length === 0) return null;

    return this.rowToVersion(result.rows[0]);
  }

  async getCurrent(agentId: string): Promise<InstructionVersion | null> {
    if (!this.pool) throw new Error('Not connected');

    const result = await this.pool.query(
      `SELECT * FROM ${this.schema}.instruction_versions
       WHERE agent_id = $1 AND retired_at IS NULL
       ORDER BY version DESC LIMIT 1`,
      [agentId]
    );

    if (result.rows.length === 0) return null;

    return this.rowToVersion(result.rows[0]);
  }

  async getHistory(agentId: string, limit = 10): Promise<InstructionVersion[]> {
    if (!this.pool) throw new Error('Not connected');

    const result = await this.pool.query(
      `SELECT * FROM ${this.schema}.instruction_versions
       WHERE agent_id = $1
       ORDER BY version DESC LIMIT $2`,
      [agentId, limit]
    );

    return result.rows.map((row) => this.rowToVersion(row));
  }

  async retire(id: string): Promise<void> {
    if (!this.pool) throw new Error('Not connected');

    await this.pool.query(
      `UPDATE ${this.schema}.instruction_versions SET retired_at = NOW() WHERE id = $1`,
      [id]
    );
  }

  async updateMetrics(id: string, metrics: Partial<InstructionVersionMetrics>): Promise<void> {
    if (!this.pool) throw new Error('Not connected');

    const setClauses: string[] = [];
    const params: unknown[] = [];
    let paramIndex = 1;

    if (metrics.runCount !== undefined) {
      setClauses.push(`run_count = $${paramIndex++}`);
      params.push(metrics.runCount);
    }
    if (metrics.avgScore !== undefined) {
      setClauses.push(`avg_score = $${paramIndex++}`);
      params.push(metrics.avgScore);
    }
    if (metrics.successRate !== undefined) {
      setClauses.push(`success_rate = $${paramIndex++}`);
      params.push(metrics.successRate);
    }
    if (metrics.avgLatency !== undefined) {
      setClauses.push(`avg_latency = $${paramIndex++}`);
      params.push(metrics.avgLatency);
    }
    if (metrics.totalCost !== undefined) {
      setClauses.push(`total_cost = $${paramIndex++}`);
      params.push(metrics.totalCost);
    }

    if (setClauses.length === 0) return;

    params.push(id);

    await this.pool.query(
      `UPDATE ${this.schema}.instruction_versions SET ${setClauses.join(', ')} WHERE id = $${paramIndex}`,
      params
    );
  }

  private rowToVersion(row: Record<string, unknown>): InstructionVersion {
    return {
      id: row.id as string,
      agentId: row.agent_id as string,
      version: row.version as number,
      instructions: row.instructions as string,
      source: row.source as InstructionVersion['source'],
      sourceId: row.source_id as string | undefined,
      deployedAt: new Date(row.deployed_at as string),
      retiredAt: row.retired_at ? new Date(row.retired_at as string) : undefined,
      metrics: {
        runCount: row.run_count as number,
        avgScore: row.avg_score as number,
        successRate: row.success_rate as number,
        avgLatency: row.avg_latency as number,
        totalCost: row.total_cost as number,
      },
      parentVersionId: row.parent_version_id as string | undefined,
    };
  }
}
