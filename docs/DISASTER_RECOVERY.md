# Disaster Recovery Playbook

This document provides procedures for recovering a Cogitator deployment from common failure scenarios.

## Overview

Cogitator is a library: the processes you run (an API server built on a server adapter, `WorkerPool` workers, schedulers) keep no state of their own beyond in-process caches. Durable state lives in the backing stores you configure — PostgreSQL, Redis, SQLite, MongoDB or Qdrant. Recovery therefore means restoring those stores and restarting your processes.

Cogitator ships no Kubernetes manifests or Helm chart. The `kubectl` and `systemctl` commands below use example names (`cogitator-worker`, `redis`, `postgres`); substitute your own.

### What Cogitator Stores

| Store      | Data                                                                                                                                             | Written by                                                                                   |
| ---------- | ------------------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------- |
| PostgreSQL | Schema `cogitator`: `threads`, `entries`, `facts`, `embeddings` (`vector(768)` by default)                                                       | `PostgresAdapter` (`@cogitator-ai/memory`)                                                   |
| PostgreSQL | Schema `cogitator`: `graph_nodes`, `graph_edges`                                                                                                 | `PostgresGraphAdapter`                                                                       |
| PostgreSQL | Schema `cogitator`: `traces`, `prompts`, `ab_tests`, `instruction_versions`                                                                      | `PostgresTraceStore` (`@cogitator-ai/core` learning)                                         |
| PostgreSQL | `cogitator_workflow_runs`, `cogitator_workflow_checkpoints`, `cogitator_workflow_timers`, `cogitator_workflow_approvals_requests` / `_responses` | `PostgresRunStore`, `PostgresCheckpointStore`, `PostgresTimerStore`, `PostgresApprovalStore` |
| Redis      | `cogitator:*` memory keys                                                                                                                        | `RedisAdapter` (`@cogitator-ai/memory`)                                                      |
| Redis      | `cogitator:workflow-runs`, `cogitator:workflow-checkpoints`, `cogitator:workflow-timers`, `cogitator:workflow-approvals` prefixes                | `RedisRunStore`, `RedisCheckpointStore`, `RedisTimerStore`, `RedisApprovalStore`             |
| Redis      | BullMQ queue `cogitator-jobs` (key prefix `cogitator`, `{cogitator}` in cluster mode)                                                            | `JobQueue` / `WorkerPool` (`@cogitator-ai/worker`)                                           |
| SQLite     | The database file you pass as `path` (the CLI assistant defaults to `~/.cogitator/memory.db`)                                                    | `SQLiteAdapter`                                                                              |

Every schema, table name and key prefix above is a default and can be overridden (`schema`, `table`, `tablePrefix`, `keyPrefix`). Tables are created on first use, so a fresh database needs no migrations.

### Recovery Time Objectives (RTO)

Example targets — adjust them to your service level.

| Scenario                 | Target RTO   | Priority |
| ------------------------ | ------------ | -------- |
| Single worker failure    | < 1 minute   | Low      |
| Redis failure            | < 5 minutes  | High     |
| Postgres failure         | < 15 minutes | Critical |
| Complete cluster failure | < 30 minutes | Critical |
| Data corruption          | < 1 hour     | Critical |

### Recovery Point Objectives (RPO)

| Data Type                                  | Target RPO               | Backup Method                      |
| ------------------------------------------ | ------------------------ | ---------------------------------- |
| Queued jobs, workflow timers and approvals | < 1 second               | Redis AOF (`appendfsync everysec`) |
| Workflow runs and checkpoints              | Point-in-time            | Postgres WAL archiving             |
| Conversation memory and facts              | < 1 hour                 | Hourly `pg_dump` or WAL archiving  |
| Vector embeddings                          | < 24 hours (rebuildable) | Daily `pg_dump`                    |

---

## Backup Procedures

### PostgreSQL Backups

#### Automated Daily Backups

```bash
#!/bin/bash
# /opt/cogitator/scripts/backup-postgres.sh
set -euo pipefail

BACKUP_DIR="/var/backups/cogitator/postgres"
TIMESTAMP=$(date +%Y%m%d_%H%M%S)
RETENTION_DAYS=30

# Create backup (custom format, restorable with pg_restore)
pg_dump -h localhost -U cogitator -Fc cogitator > "${BACKUP_DIR}/cogitator_${TIMESTAMP}.dump"

# Upload to S3 (optional)
aws s3 cp "${BACKUP_DIR}/cogitator_${TIMESTAMP}.dump" \
  "s3://cogitator-backups/postgres/cogitator_${TIMESTAMP}.dump"

# Cleanup old backups
find "${BACKUP_DIR}" -name "*.dump" -mtime +${RETENTION_DAYS} -delete
```

With Docker Compose (the repository's `docker-compose.yml`, or the stack `cogitator deploy --target docker` starts), run `pg_dump` inside the container:

```bash
docker compose exec -T postgres pg_dump -U cogitator -Fc cogitator > cogitator_$(date +%Y%m%d_%H%M%S).dump
```

#### Point-in-Time Recovery Setup

Enable WAL archiving in `postgresql.conf` and take a base backup to replay the archive onto:

```conf
# postgresql.conf
wal_level = replica
archive_mode = on
archive_command = 'test ! -f /var/lib/postgresql/wal_archive/%f && cp %p /var/lib/postgresql/wal_archive/%f'
```

```bash
pg_basebackup -h localhost -U cogitator -D /var/backups/cogitator/base_$(date +%Y%m%d) -Ft -z -P
```

### Redis Backups

Redis holds queued jobs and, if you use the Redis stores, memory and workflow state. If you use Redis only as a cache you can skip these backups.

#### RDB Snapshots

```bash
#!/bin/bash
# /opt/cogitator/scripts/backup-redis.sh
set -euo pipefail

BACKUP_DIR="/var/backups/cogitator/redis"
TIMESTAMP=$(date +%Y%m%d_%H%M%S)
REDIS_DIR=$(redis-cli CONFIG GET dir | tail -1)

# Trigger an RDB save and wait for it to finish
BEFORE=$(redis-cli LASTSAVE)
redis-cli BGSAVE
while [ "$(redis-cli LASTSAVE)" = "$BEFORE" ]; do sleep 1; done

# Copy dump file
cp "${REDIS_DIR}/dump.rdb" "${BACKUP_DIR}/dump_${TIMESTAMP}.rdb"

# Upload to S3
aws s3 cp "${BACKUP_DIR}/dump_${TIMESTAMP}.rdb" \
  "s3://cogitator-backups/redis/dump_${TIMESTAMP}.rdb"
```

#### AOF Persistence

```conf
# redis.conf
appendonly yes
appendfsync everysec
auto-aof-rewrite-percentage 100
auto-aof-rewrite-min-size 64mb
```

The repository's `docker-compose.yml` already starts Redis with `--appendonly yes`.

### SQLite Backups

```bash
sqlite3 ~/.cogitator/memory.db ".backup '/var/backups/cogitator/memory_$(date +%Y%m%d_%H%M%S).db'"
```

### Configuration Backups

```bash
#!/bin/bash
# Backup configuration files (adjust the paths to your deployment)

BACKUP_DIR="/var/backups/cogitator/config"
TIMESTAMP=$(date +%Y%m%d_%H%M%S)

tar -czf "${BACKUP_DIR}/config_${TIMESTAMP}.tar.gz" \
  /opt/cogitator/cogitator.yml \
  /opt/cogitator/.env \
  /opt/cogitator/.cogitator/

aws s3 cp "${BACKUP_DIR}/config_${TIMESTAMP}.tar.gz" \
  "s3://cogitator-backups/config/config_${TIMESTAMP}.tar.gz"
```

`.env` contains provider API keys: encrypt the archive or store it in a secrets manager rather than a plain bucket.

---

## Recovery Procedures

### Scenario 1: Single Worker Failure

**Symptoms:**

- Worker process exits unexpectedly
- Health check fails for one API instance
- `cogitator_workers_total` drops

**Recovery Steps:**

1. **Automatic recovery** (Kubernetes/systemd)
   - Kubernetes restarts the pod automatically
   - systemd restarts the service if configured with `Restart=always`

2. **Manual verification**

   ```bash
   # Check worker status
   kubectl get pods -l app=cogitator-worker

   # Check logs for failure cause
   kubectl logs <pod-name> --previous

   # API servers: Express and Fastify mount their routes under /cogitator by default
   curl http://localhost:3000/cogitator/health

   # Workers: the worker count comes from your /metrics endpoint (see Monitoring)
   curl -s http://localhost:3000/metrics | grep cogitator_workers_total
   ```

3. **In-progress jobs**
   - A job whose worker died keeps its lock until `lockDuration` (default 30 s) expires; the next stalled-job check (`stalledInterval`, default 30 s) moves it back to waiting for another worker (BullMQ does this once; a job that stalls again is failed)
   - Failed jobs are retried with exponential backoff (`attempts: 3` by default)
   - Workflow timers claimed by the dead process become available again when their claim (`claimTtl`) runs out

### Scenario 2: Redis Failure

**Symptoms:**

- Connection refused to Redis
- Memory adapter calls return `{ success: false, error }`
- Job queue stalled (`cogitator_queue_depth` rising, `cogitator_queue_active` at 0)

**Recovery Steps:**

1. **Identify failure type**

   ```bash
   # Check Redis status
   redis-cli ping

   # Check memory usage
   redis-cli INFO memory

   # Check for OOM issues
   journalctl -u redis -n 100
   ```

2. **Restart Redis**

   ```bash
   # Kubernetes
   kubectl rollout restart statefulset/redis

   # Systemd
   systemctl restart redis

   # Docker Compose
   docker compose restart redis
   ```

3. **Restore from backup (if data lost)**

   When AOF is enabled Redis loads the AOF on startup and ignores `dump.rdb`, so start from the RDB with AOF off, then turn AOF back on:

   ```bash
   # Stop Redis
   systemctl stop redis

   # Restore RDB file and move the stale AOF out of the way
   REDIS_DIR=/var/lib/redis
   cp /var/backups/cogitator/redis/dump_<timestamp>.rdb "${REDIS_DIR}/dump.rdb"
   chown redis:redis "${REDIS_DIR}/dump.rdb"
   mv "${REDIS_DIR}/appendonlydir" "${REDIS_DIR}/appendonlydir.bak"

   # Start with AOF disabled (set appendonly no in redis.conf), then rebuild the AOF
   systemctl start redis
   redis-cli CONFIG SET appendonly yes
   # and set appendonly yes in redis.conf again
   ```

4. **Failover to replica (Redis Cluster)**

   ```bash
   # Check cluster status
   redis-cli CLUSTER INFO

   # Force failover if needed
   redis-cli -h <replica-host> CLUSTER FAILOVER TAKEOVER
   ```

5. **Reconnect workers**

   ```bash
   # Workers reconnect automatically, but force a restart if needed
   kubectl rollout restart deployment/cogitator-worker
   ```

### Scenario 3: PostgreSQL Failure

**Symptoms:**

- Database connection errors
- Postgres memory adapter calls return `{ success: false, error }`
- Workflow run, approval or timer store calls throw

**Recovery Steps:**

1. **Check database status**

   ```bash
   # Check if Postgres is running
   pg_isready -h localhost -p 5432

   # Check connection count
   psql -c "SELECT count(*) FROM pg_stat_activity;"

   # Check for locks
   psql -c "SELECT * FROM pg_locks WHERE NOT granted;"
   ```

2. **Restart PostgreSQL**

   ```bash
   # Kubernetes
   kubectl rollout restart statefulset/postgres

   # Systemd
   systemctl restart postgresql
   ```

3. **Recover from backup**

   `pg_restore` needs a running server. Restore into a fresh database (or pass `--clean --if-exists` to replace the objects in place):

   ```bash
   # Stop the applications writing to the database first
   kubectl scale deployment/cogitator-api deployment/cogitator-worker --replicas=0

   dropdb -h localhost -U cogitator cogitator
   createdb -h localhost -U cogitator cogitator
   pg_restore -h localhost -U cogitator -d cogitator \
     /var/backups/cogitator/postgres/cogitator_<timestamp>.dump
   ```

   The dump includes the `vector` extension, so the target server needs pgvector (the `pgvector/pgvector:pg16` image has it).

4. **Point-in-time recovery** (PostgreSQL 12+)

   ```bash
   systemctl stop postgresql

   # Replace the data directory with the base backup
   mv /var/lib/postgresql/16/main /var/lib/postgresql/16/main.broken
   mkdir /var/lib/postgresql/16/main
   tar -xzf /var/backups/cogitator/base_<date>/base.tar.gz -C /var/lib/postgresql/16/main
   chown -R postgres:postgres /var/lib/postgresql/16/main
   chmod 700 /var/lib/postgresql/16/main

   # Recovery settings live in postgresql.conf; recovery.signal starts recovery
   cat >> /etc/postgresql/16/main/postgresql.conf << EOF
   restore_command = 'cp /var/lib/postgresql/wal_archive/%f %p'
   recovery_target_time = '2026-10-01 14:30:00'
   recovery_target_action = 'promote'
   EOF
   touch /var/lib/postgresql/16/main/recovery.signal

   systemctl start postgresql
   ```

   Remove the recovery settings from `postgresql.conf` once the server has promoted.

5. **Verify data integrity**

   ```bash
   # Cogitator tables
   psql -c "SELECT table_schema, table_name FROM information_schema.tables WHERE table_schema = 'cogitator' OR table_name LIKE 'cogitator_workflow_%';"

   # Memory row counts
   psql -c "SELECT (SELECT count(*) FROM cogitator.threads) AS threads, (SELECT count(*) FROM cogitator.entries) AS entries, (SELECT count(*) FROM cogitator.embeddings) AS embeddings;"

   # Workflow runs left 'running' for more than an hour (timestamps are epoch milliseconds)
   psql -c "SELECT id, workflow_name FROM cogitator_workflow_runs WHERE status = 'running' AND started_at < (EXTRACT(EPOCH FROM now()) - 3600) * 1000;"
   ```

   Runs interrupted by the outage are not resumed automatically. Resume them from their last checkpoint with `executor.resume(workflow, checkpointId)` if you run with `checkpoint: true`, or cancel and re-run them with `manager.cancel(runId)` and `manager.retry(runId)`. See [Checkpointing](https://cogitator.app/docs/workflows/execution#checkpointing).

### Scenario 4: Complete Cluster Failure

**Symptoms:**

- All nodes unreachable
- No workers processing requests
- Complete service outage

**Recovery Steps:**

1. **Assess infrastructure status**

   ```bash
   # Check Kubernetes cluster
   kubectl cluster-info
   kubectl get nodes

   # Check cloud provider status
   aws ec2 describe-instances --filters "Name=tag:service,Values=cogitator"
   ```

2. **Restore infrastructure**

   ```bash
   # Rebuild from your infrastructure-as-code
   cd infrastructure/
   terraform apply
   ```

3. **Restore data stores first**
   1. PostgreSQL — Scenario 3, step 3 (or step 4 for point-in-time recovery)
   2. Redis — Scenario 2, step 3

4. **Deploy application**

   ```bash
   # Your own manifests
   kubectl apply -f k8s/

   # Or, for projects deployed with the CLI
   cogitator deploy --target fly
   ```

5. **Verify recovery**

   ```bash
   # Check all pods running
   kubectl get pods

   # Health check (Express adapter, default basePath /cogitator)
   curl https://api.example.com/cogitator/health

   # Test agent execution
   curl -X POST https://api.example.com/cogitator/agents/test-agent/run \
     -H "Content-Type: application/json" \
     -d '{"input": "hello"}'
   ```

### Scenario 5: Data Corruption

**Symptoms:**

- JSON parse errors from the database
- Conversation history missing messages or returning malformed entries
- Vector search returning irrelevant results

**Recovery Steps:**

1. **Identify corruption scope**

   ```bash
   # Memory entries whose message has no role
   psql -c "SELECT id, thread_id FROM cogitator.entries WHERE message->>'role' IS NULL;"

   # Embeddings without a vector
   psql -c "SELECT count(*) FROM cogitator.embeddings WHERE vector IS NULL;"

   # Workflow runs whose indexed status disagrees with the stored run
   psql -c "SELECT id FROM cogitator_workflow_runs WHERE status <> data->>'status';"
   ```

2. **Isolate affected data**

   Stop the processes writing to the affected stores. Do not patch workflow runs with SQL `UPDATE`: the run is stored as JSONB in `data` next to indexed columns, and both must stay in sync. Use `manager.cancel(runId)` and `manager.retry(runId)` instead.

3. **Restore from known good backup**

   Restore the dump into a scratch database and copy back only the rows you need:

   ```bash
   # Find last good backup
   aws s3 ls s3://cogitator-backups/postgres/ | tail -10

   createdb -h localhost -U cogitator cogitator_restore
   pg_restore -h localhost -U cogitator -d cogitator_restore \
     /var/backups/cogitator/postgres/cogitator_<timestamp>.dump

   # Example: replace the entries of one thread with the restored ones
   psql -d cogitator_restore -c "\copy (SELECT * FROM cogitator.entries WHERE thread_id = 'thread_abc') TO 'entries.csv' CSV"
   psql -d cogitator -c "DELETE FROM cogitator.entries WHERE thread_id = 'thread_abc';"
   psql -d cogitator -c "\copy cogitator.entries FROM 'entries.csv' CSV"

   dropdb -h localhost -U cogitator cogitator_restore
   ```

   `cogitator.embeddings` has a generated `content_tsv` column: copy it with an explicit column list that leaves `content_tsv` out.

4. **Reindex vectors**

   After a large restore, rebuild the IVFFlat index so its lists match the data:

   ```bash
   psql -c "REINDEX INDEX cogitator.idx_embeddings_vector;"
   ```

---

## Sandbox Recovery

### Docker Sandbox Failures

Sandbox containers are labelled `ai.cogitator.sandbox=true` and run `sleep infinity` until a command is executed in them. The container pool lives in the process that created it, so containers left behind by a crashed process are never reused.

**Container stuck or orphaned:**

```bash
# List sandbox containers
docker ps -a --filter "label=ai.cogitator.sandbox=true"

# Force cleanup of all sandbox containers
docker rm -f $(docker ps -aq --filter "label=ai.cogitator.sandbox=true")

# Restart workers to reinitialize the container pool
kubectl rollout restart deployment/cogitator-worker
```

**Image corruption:**

The default image is `alpine:3.19`; a tool can choose another with `sandbox.image`, and missing images are pulled on first use.

```bash
# Remove and repull the default sandbox image
docker rmi alpine:3.19
docker pull alpine:3.19

# The built-in exec tool uses cogitator/sandbox:base, built from this repository
docker build -t cogitator/sandbox:base -f docker/sandbox/Dockerfile.base docker/sandbox
```

### WASM Sandbox Failures

Loaded WASM plugins are cached in memory only (`wasm.cacheSize`, default 10); restarting the process clears the cache.

**Extism runtime issues:**

```bash
# Check that the optional Extism package is installed
node -e "import('@extism/extism').then(m => console.log('extism ok:', Object.keys(m)))"

# Reinstall if needed
pnpm add @extism/extism@^2.0.0-rc13
```

---

## Monitoring and Alerts

### Critical Alerts

`pg_up` and `redis_up` come from [postgres_exporter](https://github.com/prometheus-community/postgres_exporter) and [redis_exporter](https://github.com/oliver006/redis_exporter). The `cogitator_*` metrics come from `@cogitator-ai/worker` and are exposed by a `/metrics` route you add with `formatPrometheusMetrics()` or `pool.metrics.format()` — see [Worker Queues](https://cogitator.app/docs/deployment/worker-queues#prometheus-metrics).

```yaml
# cogitator-alerts.yml (Prometheus rule file)
groups:
  - name: cogitator-critical
    rules:
      - alert: PostgresDown
        expr: pg_up == 0
        for: 1m
        labels:
          severity: critical
        annotations:
          summary: 'PostgreSQL is down'

      - alert: RedisDown
        expr: redis_up == 0
        for: 1m
        labels:
          severity: critical

      - alert: AllWorkersDown
        expr: sum(cogitator_workers_total) == 0
        for: 2m
        labels:
          severity: critical

      - alert: QueueBacklog
        expr: sum(cogitator_queue_depth) > 100 and sum(cogitator_queue_active) == 0
        for: 5m
        labels:
          severity: warning

      - alert: JobFailures
        expr: increase(cogitator_queue_failed_total[5m]) > 5
        for: 5m
        labels:
          severity: warning
```

`cogitator_queue_failed_total` is the number of failed jobs BullMQ still retains, not a true counter: once `removeOnFail` (default 500) jobs are kept it stops rising and `JobFailures` goes quiet. Raise `removeOnFail`, or count failures yourself in `WorkerPool`'s `onJobFailed` event.

### Health Check Endpoints

Cogitator has no standalone admin service; health endpoints come from the server adapter you mount. The Express, Fastify, Hono, Koa and Tetsu adapters all register:

| Endpoint  | Response                                    | Use as          |
| --------- | ------------------------------------------- | --------------- |
| `/health` | `200` `{ status: 'ok', uptime, timestamp }` | Liveness probe  |
| `/ready`  | `200` `{ status: 'ok' }`                    | Readiness probe |

The paths are relative to where the routes are mounted: Express (`config.basePath`) and Fastify (`prefix`) default to `/cogitator`, so the probes are `/cogitator/health` and `/cogitator/ready`; Hono, Koa and Tetsu serve them where you mount the app, router or controller. See [Common Endpoints](https://cogitator.app/docs/server-adapters#common-endpoints).

- Both endpoints answer as soon as the process is up; neither checks Postgres, Redis or the LLM provider. Add your own route if readiness should depend on them.
- In Express, Fastify, Hono and Koa the `auth` function also runs for `/health` and `/ready`, and a throw becomes `401`. Let probe requests through, or probes fail. Tetsu leaves both open.
- Projects deployed with `cogitator deploy` should set `deploy.health.path: /cogitator/health` (the default `/health` misses the base path).

---

## Post-Incident Procedures

### Incident Documentation

After recovery, document:

1. **Timeline** - When detected, escalated, resolved
2. **Root cause** - What caused the failure
3. **Impact** - Users affected, data lost
4. **Recovery steps** - What was done to recover
5. **Prevention** - How to prevent recurrence

### Post-Mortem Template

```markdown
# Incident Report: [Title]

**Date:** YYYY-MM-DD
**Duration:** HH:MM - HH:MM (X hours)
**Severity:** P1/P2/P3

## Summary

Brief description of what happened.

## Timeline

- HH:MM - Issue detected
- HH:MM - Team alerted
- HH:MM - Root cause identified
- HH:MM - Recovery started
- HH:MM - Service restored

## Root Cause

Detailed explanation of why this happened.

## Impact

- X runs failed
- Y users affected
- Z minutes of downtime

## Recovery Actions

Steps taken to restore service.

## Prevention

Changes to prevent recurrence.

## Action Items

- [ ] Implement fix for root cause
- [ ] Add monitoring for early detection
- [ ] Update runbooks
```

---

## Emergency Contacts

Fill in your own escalation path:

| Role             | Contact | Escalation Path           |
| ---------------- | ------- | ------------------------- |
| On-call Engineer |         | Auto-escalate after 15m   |
| Platform Lead    |         | If P1 not resolved in 30m |
| Security         |         | Any security incident     |

---

## Runbook Maintenance

This document should be:

- Reviewed quarterly
- Updated after each incident
- Tested via disaster recovery drills (quarterly)

Related: [Docker](https://cogitator.app/docs/deployment/docker), [Redis](https://cogitator.app/docs/deployment/redis), [Worker Queues](https://cogitator.app/docs/deployment/worker-queues), [Observability](https://cogitator.app/docs/deployment/observability), [Deployment guide](./DEPLOY.md).

Last updated: October 2026
