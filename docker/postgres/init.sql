-- Cogitator database bootstrap
--
-- Runs once, when the Postgres container starts on an empty data volume, and
-- only enables extensions. Every Cogitator store creates its own tables on
-- first use: PostgresAdapter and PostgresGraphAdapter (@cogitator-ai/memory),
-- PostgresTraceStore (@cogitator-ai/core), PostgresRunStore,
-- PostgresCheckpointStore, PostgresTimerStore and PostgresApprovalStore
-- (@cogitator-ai/workflows), PostgresThreadStorage (@cogitator-ai/openai-compat).
-- Declaring those tables here as well would shadow the stores' own schema.

CREATE EXTENSION IF NOT EXISTS vector;
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";
