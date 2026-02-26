-- Cogitator Database Schema
-- PostgreSQL with pgvector for semantic memory

-- Enable pgvector extension for embeddings
CREATE EXTENSION IF NOT EXISTS vector;
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

-- ============================================================================
-- Agents
-- ============================================================================
CREATE TABLE IF NOT EXISTS cogitator_agents (
    id VARCHAR(64) PRIMARY KEY,
    name VARCHAR(255) NOT NULL,
    model VARCHAR(255) NOT NULL,
    instructions TEXT,
    tools JSONB DEFAULT '[]',
    config JSONB DEFAULT '{}',
    status VARCHAR(32) DEFAULT 'offline',
    total_runs INTEGER DEFAULT 0,
    total_tokens BIGINT DEFAULT 0,
    last_run_at TIMESTAMP WITH TIME ZONE,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

CREATE INDEX idx_agents_status ON cogitator_agents(status);
CREATE INDEX idx_agents_model ON cogitator_agents(model);

-- ============================================================================
-- Runs (Agent executions)
-- ============================================================================
CREATE TABLE IF NOT EXISTS cogitator_runs (
    id VARCHAR(64) PRIMARY KEY,
    agent_id VARCHAR(64) REFERENCES cogitator_agents(id) ON DELETE SET NULL,
    thread_id VARCHAR(64),
    status VARCHAR(32) DEFAULT 'pending',
    input TEXT,
    output TEXT,
    error TEXT,
    input_tokens INTEGER DEFAULT 0,
    output_tokens INTEGER DEFAULT 0,
    total_tokens INTEGER DEFAULT 0,
    duration INTEGER, -- milliseconds
    model VARCHAR(255),
    temperature REAL,
    started_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    completed_at TIMESTAMP WITH TIME ZONE,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

CREATE INDEX idx_runs_agent ON cogitator_runs(agent_id);
CREATE INDEX idx_runs_thread ON cogitator_runs(thread_id);
CREATE INDEX idx_runs_status ON cogitator_runs(status);
CREATE INDEX idx_runs_started ON cogitator_runs(started_at DESC);

-- ============================================================================
-- Tool Calls
-- ============================================================================
CREATE TABLE IF NOT EXISTS cogitator_tool_calls (
    id VARCHAR(64) PRIMARY KEY,
    run_id VARCHAR(64) REFERENCES cogitator_runs(id) ON DELETE CASCADE,
    tool_name VARCHAR(255) NOT NULL,
    arguments JSONB DEFAULT '{}',
    result JSONB,
    error TEXT,
    duration INTEGER, -- milliseconds
    status VARCHAR(32) DEFAULT 'pending',
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

CREATE INDEX idx_tool_calls_run ON cogitator_tool_calls(run_id);
CREATE INDEX idx_tool_calls_tool ON cogitator_tool_calls(tool_name);

-- ============================================================================
-- Threads (Conversations)
-- ============================================================================
CREATE TABLE IF NOT EXISTS cogitator_threads (
    id VARCHAR(64) PRIMARY KEY,
    agent_id VARCHAR(64) REFERENCES cogitator_agents(id) ON DELETE SET NULL,
    title VARCHAR(255),
    metadata JSONB DEFAULT '{}',
    message_count INTEGER DEFAULT 0,
    last_message_at TIMESTAMP WITH TIME ZONE,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

CREATE INDEX idx_threads_agent ON cogitator_threads(agent_id);
CREATE INDEX idx_threads_updated ON cogitator_threads(updated_at DESC);

-- ============================================================================
-- Messages
-- ============================================================================
CREATE TABLE IF NOT EXISTS cogitator_messages (
    id VARCHAR(64) PRIMARY KEY,
    thread_id VARCHAR(64) REFERENCES cogitator_threads(id) ON DELETE CASCADE,
    role VARCHAR(32) NOT NULL, -- user, assistant, system, tool
    content TEXT NOT NULL,
    tool_calls JSONB,
    tool_call_id VARCHAR(64),
    tokens INTEGER DEFAULT 0,
    metadata JSONB DEFAULT '{}',
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

CREATE INDEX idx_messages_thread ON cogitator_messages(thread_id);
CREATE INDEX idx_messages_role ON cogitator_messages(role);
CREATE INDEX idx_messages_created ON cogitator_messages(created_at);

-- ============================================================================
-- Memory Entries (with vector embeddings)
-- ============================================================================
CREATE TABLE IF NOT EXISTS cogitator_memory_entries (
    id VARCHAR(64) PRIMARY KEY,
    thread_id VARCHAR(64),
    agent_id VARCHAR(64),
    type VARCHAR(32) NOT NULL, -- message, fact, summary, episodic
    content TEXT NOT NULL,
    embedding vector(768), -- nomic-embed-text-v2-moe uses 768 dimensions
    importance REAL DEFAULT 0.5,
    access_count INTEGER DEFAULT 0,
    last_accessed_at TIMESTAMP WITH TIME ZONE,
    metadata JSONB DEFAULT '{}',
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    expires_at TIMESTAMP WITH TIME ZONE
);

CREATE INDEX idx_memory_thread ON cogitator_memory_entries(thread_id);
CREATE INDEX idx_memory_agent ON cogitator_memory_entries(agent_id);
CREATE INDEX idx_memory_type ON cogitator_memory_entries(type);
CREATE INDEX idx_memory_importance ON cogitator_memory_entries(importance DESC);

-- Vector similarity search index (IVFFlat for large datasets)
CREATE INDEX idx_memory_embedding ON cogitator_memory_entries 
    USING ivfflat (embedding vector_cosine_ops) WITH (lists = 100);

-- ============================================================================
-- Workflows
-- ============================================================================
CREATE TABLE IF NOT EXISTS cogitator_workflows (
    id VARCHAR(64) PRIMARY KEY,
    name VARCHAR(255) NOT NULL,
    description TEXT,
    definition JSONB NOT NULL, -- DAG definition
    initial_state JSONB DEFAULT '{}',
    config JSONB DEFAULT '{}',
    status VARCHAR(32) DEFAULT 'draft',
    total_runs INTEGER DEFAULT 0,
    last_run_at TIMESTAMP WITH TIME ZONE,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

CREATE INDEX idx_workflows_status ON cogitator_workflows(status);

-- ============================================================================
-- Workflow Runs
-- ============================================================================
CREATE TABLE IF NOT EXISTS cogitator_workflow_runs (
    id VARCHAR(64) PRIMARY KEY,
    workflow_id VARCHAR(64) REFERENCES cogitator_workflows(id) ON DELETE SET NULL,
    status VARCHAR(32) DEFAULT 'pending',
    input JSONB,
    output JSONB,
    state JSONB DEFAULT '{}',
    error TEXT,
    duration INTEGER,
    started_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    completed_at TIMESTAMP WITH TIME ZONE
);

CREATE INDEX idx_workflow_runs_workflow ON cogitator_workflow_runs(workflow_id);
CREATE INDEX idx_workflow_runs_status ON cogitator_workflow_runs(status);

-- ============================================================================
-- Swarms
-- ============================================================================
CREATE TABLE IF NOT EXISTS cogitator_swarms (
    id VARCHAR(64) PRIMARY KEY,
    name VARCHAR(255) NOT NULL,
    description TEXT,
    strategy VARCHAR(64) NOT NULL, -- debate, round-robin, hierarchical, etc.
    agent_ids JSONB NOT NULL, -- array of agent IDs
    config JSONB DEFAULT '{}',
    status VARCHAR(32) DEFAULT 'inactive',
    total_runs INTEGER DEFAULT 0,
    last_run_at TIMESTAMP WITH TIME ZONE,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

CREATE INDEX idx_swarms_strategy ON cogitator_swarms(strategy);
CREATE INDEX idx_swarms_status ON cogitator_swarms(status);

-- ============================================================================
-- Swarm Runs
-- ============================================================================
CREATE TABLE IF NOT EXISTS cogitator_swarm_runs (
    id VARCHAR(64) PRIMARY KEY,
    swarm_id VARCHAR(64) REFERENCES cogitator_swarms(id) ON DELETE SET NULL,
    status VARCHAR(32) DEFAULT 'pending',
    input TEXT,
    output TEXT,
    error TEXT,
    duration INTEGER,
    total_tokens BIGINT DEFAULT 0,
    event_log JSONB DEFAULT '[]',
    started_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    completed_at TIMESTAMP WITH TIME ZONE
);

CREATE INDEX idx_swarm_runs_swarm ON cogitator_swarm_runs(swarm_id);
CREATE INDEX idx_swarm_runs_status ON cogitator_swarm_runs(status);

-- ============================================================================
-- Spans (for observability/tracing)
-- ============================================================================
CREATE TABLE IF NOT EXISTS cogitator_spans (
    id VARCHAR(64) PRIMARY KEY,
    trace_id VARCHAR(64) NOT NULL,
    parent_id VARCHAR(64),
    name VARCHAR(255) NOT NULL,
    kind VARCHAR(32), -- llm, tool, agent, workflow, swarm
    status VARCHAR(32) DEFAULT 'ok',
    attributes JSONB DEFAULT '{}',
    events JSONB DEFAULT '[]',
    start_time TIMESTAMP WITH TIME ZONE NOT NULL,
    end_time TIMESTAMP WITH TIME ZONE,
    duration INTEGER
);

CREATE INDEX idx_spans_trace ON cogitator_spans(trace_id);
CREATE INDEX idx_spans_parent ON cogitator_spans(parent_id);
CREATE INDEX idx_spans_kind ON cogitator_spans(kind);
CREATE INDEX idx_spans_start ON cogitator_spans(start_time DESC);

-- ============================================================================
-- Logs
-- ============================================================================
CREATE TABLE IF NOT EXISTS cogitator_logs (
    id VARCHAR(64) PRIMARY KEY,
    level VARCHAR(16) NOT NULL, -- debug, info, warn, error
    message TEXT NOT NULL,
    source VARCHAR(255),
    trace_id VARCHAR(64),
    span_id VARCHAR(64),
    metadata JSONB DEFAULT '{}',
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

CREATE INDEX idx_logs_level ON cogitator_logs(level);
CREATE INDEX idx_logs_source ON cogitator_logs(source);
CREATE INDEX idx_logs_trace ON cogitator_logs(trace_id);
CREATE INDEX idx_logs_created ON cogitator_logs(created_at DESC);

-- ============================================================================
-- Config (key-value store)
-- ============================================================================
CREATE TABLE IF NOT EXISTS cogitator_config (
    key VARCHAR(255) PRIMARY KEY,
    value JSONB NOT NULL,
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- ============================================================================
-- Helper Functions
-- ============================================================================

-- Function to search memory by semantic similarity
CREATE OR REPLACE FUNCTION search_memory_by_embedding(
    query_embedding vector(768),
    match_threshold REAL DEFAULT 0.7,
    match_count INTEGER DEFAULT 10,
    filter_thread_id VARCHAR DEFAULT NULL,
    filter_agent_id VARCHAR DEFAULT NULL
)
RETURNS TABLE (
    id VARCHAR,
    thread_id VARCHAR,
    agent_id VARCHAR,
    type VARCHAR,
    content TEXT,
    similarity REAL,
    importance REAL,
    created_at TIMESTAMP WITH TIME ZONE
) AS $$
BEGIN
    RETURN QUERY
    SELECT 
        m.id,
        m.thread_id,
        m.agent_id,
        m.type,
        m.content,
        1 - (m.embedding <=> query_embedding) AS similarity,
        m.importance,
        m.created_at
    FROM cogitator_memory_entries m
    WHERE 
        (filter_thread_id IS NULL OR m.thread_id = filter_thread_id)
        AND (filter_agent_id IS NULL OR m.agent_id = filter_agent_id)
        AND 1 - (m.embedding <=> query_embedding) > match_threshold
    ORDER BY m.embedding <=> query_embedding
    LIMIT match_count;
END;
$$ LANGUAGE plpgsql;

-- Trigger to update timestamps
CREATE OR REPLACE FUNCTION update_updated_at()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = NOW();
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trigger_agents_updated
    BEFORE UPDATE ON cogitator_agents
    FOR EACH ROW EXECUTE FUNCTION update_updated_at();

CREATE TRIGGER trigger_threads_updated
    BEFORE UPDATE ON cogitator_threads
    FOR EACH ROW EXECUTE FUNCTION update_updated_at();

CREATE TRIGGER trigger_workflows_updated
    BEFORE UPDATE ON cogitator_workflows
    FOR EACH ROW EXECUTE FUNCTION update_updated_at();

CREATE TRIGGER trigger_swarms_updated
    BEFORE UPDATE ON cogitator_swarms
    FOR EACH ROW EXECUTE FUNCTION update_updated_at();

-- ============================================================================
-- Learning: Traces & Prompt Optimization
-- ============================================================================
CREATE SCHEMA IF NOT EXISTS cogitator;

CREATE TABLE IF NOT EXISTS cogitator.traces (
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
);

CREATE INDEX idx_traces_agent_id ON cogitator.traces(agent_id, created_at);
CREATE INDEX idx_traces_score ON cogitator.traces(agent_id, score);
CREATE INDEX idx_traces_is_demo ON cogitator.traces(agent_id, is_demo) WHERE is_demo = TRUE;

CREATE TABLE IF NOT EXISTS cogitator.prompts (
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
);

CREATE INDEX idx_prompts_agent_id ON cogitator.prompts(agent_id, created_at);
CREATE INDEX idx_prompts_run_id ON cogitator.prompts(run_id);

CREATE TABLE IF NOT EXISTS cogitator.ab_tests (
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
);

CREATE INDEX idx_ab_tests_agent_id ON cogitator.ab_tests(agent_id, status);

CREATE TABLE IF NOT EXISTS cogitator.instruction_versions (
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
);

CREATE INDEX idx_instruction_versions_agent ON cogitator.instruction_versions(agent_id, version);

-- ============================================================================
-- Initial Data
-- ============================================================================

-- Insert default config
INSERT INTO cogitator_config (key, value) VALUES 
    ('cogitator_config', '{"llm": {"defaultProvider": "ollama", "defaultModel": "llama3.2:3b"}, "memory": {"adapter": "postgres"}}')
ON CONFLICT (key) DO NOTHING;

-- Done!
SELECT 'Cogitator database initialized successfully!' AS status;

