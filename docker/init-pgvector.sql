-- Initialize pgvector extension for Cogitator
-- This runs automatically when Postgres container starts

CREATE EXTENSION IF NOT EXISTS vector;

-- Verify extension is installed
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'vector') THEN
    RAISE EXCEPTION 'pgvector extension not installed';
  END IF;
  RAISE NOTICE 'pgvector extension ready';
END $$;
