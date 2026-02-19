# Disaster Recovery Playbook

This document provides procedures for recovering Cogitator from various failure scenarios.

## Overview

Cogitator's architecture is designed for resilience with stateless workers and persistent backing stores. This playbook covers recovery procedures for common failure scenarios.

### Recovery Time Objectives (RTO)

| Scenario                 | Target RTO   | Priority |
| ------------------------ | ------------ | -------- |
| Single worker failure    | < 1 minute   | Low      |
| Redis failure            | < 5 minutes  | High     |
| Postgres failure         | < 15 minutes | Critical |
| Complete cluster failure | < 30 minutes | Critical |
| Data corruption          | < 1 hour     | Critical |

### Recovery Point Objectives (RPO)

| Data Type                | Target RPO    | Backup Frequency |
| ------------------------ | ------------- | ---------------- |
| Agent runs (in-progress) | 0 (real-time) | Continuous       |
| Agent definitions        | < 5 minutes   | Every 5 min      |
| Memory store             | < 1 hour      | Hourly           |
| Vector embeddings        | < 24 hours    | Daily            |
| Audit logs               | 0 (real-time) | Continuous       |

---

## Backup Procedures

### PostgreSQL Backups

#### Automated Daily Backups

```bash
#!/bin/bash
# /opt/cogitator/scripts/backup-postgres.sh

BACKUP_DIR="/var/backups/cogitator/postgres"
TIMESTAMP=$(date +%Y%m%d_%H%M%S)
RETENTION_DAYS=30

# Create backup
pg_dump -h localhost -U cogitator -Fc cogitator > "${BACKUP_DIR}/cogitator_${TIMESTAMP}.dump"

# Upload to S3 (optional)
aws s3 cp "${BACKUP_DIR}/cogitator_${TIMESTAMP}.dump" \
  "s3://cogitator-backups/postgres/cogitator_${TIMESTAMP}.dump"

# Cleanup old backups
find "${BACKUP_DIR}" -name "*.dump" -mtime +${RETENTION_DAYS} -delete
```

#### Point-in-Time Recovery Setup

```sql
-- Enable WAL archiving in postgresql.conf
-- wal_level = replica
-- archive_mode = on
-- archive_command = 'cp %p /var/lib/postgresql/wal_archive/%f'
```

### Redis Backups

#### RDB Snapshots

```bash
#!/bin/bash
# /opt/cogitator/scripts/backup-redis.sh

BACKUP_DIR="/var/backups/cogitator/redis"
TIMESTAMP=$(date +%Y%m%d_%H%M%S)

# Trigger RDB save
redis-cli BGSAVE
sleep 5

# Copy dump file
cp /var/lib/redis/dump.rdb "${BACKUP_DIR}/dump_${TIMESTAMP}.rdb"

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

### Configuration Backups

```bash
#!/bin/bash
# Backup all configuration files

BACKUP_DIR="/var/backups/cogitator/config"
TIMESTAMP=$(date +%Y%m%d_%H%M%S)

tar -czf "${BACKUP_DIR}/config_${TIMESTAMP}.tar.gz" \
  /opt/cogitator/config/ \
  /opt/cogitator/.env \
  /etc/cogitator/

aws s3 cp "${BACKUP_DIR}/config_${TIMESTAMP}.tar.gz" \
  "s3://cogitator-backups/config/config_${TIMESTAMP}.tar.gz"
```

---

## Recovery Procedures

### Scenario 1: Single Worker Failure

**Symptoms:**

- Worker process exits unexpectedly
- Health check fails for one instance
- Load balancer removes instance from pool

**Recovery Steps:**

1. **Automatic recovery** (Kubernetes/systemd)
   - Kubernetes will restart the pod automatically
   - systemd will restart the service if configured with `Restart=always`

2. **Manual verification**

   ```bash
   # Check worker status
   kubectl get pods -l app=cogitator-worker

   # Check logs for failure cause
   kubectl logs <pod-name> --previous

   # Verify worker rejoined cluster
   curl http://localhost:3000/health
   ```

3. **In-progress runs**
   - Runs assigned to failed worker will timeout
   - BullMQ will retry failed jobs automatically
   - No data loss for completed steps

### Scenario 2: Redis Failure

**Symptoms:**

- Connection refused to Redis
- Memory operations failing
- Job queue stalled

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
   ```

3. **Restore from backup (if data lost)**

   ```bash
   # Stop Redis
   systemctl stop redis

   # Restore RDB file
   cp /var/backups/cogitator/redis/dump_latest.rdb /var/lib/redis/dump.rdb
   chown redis:redis /var/lib/redis/dump.rdb

   # Start Redis
   systemctl start redis
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
   # Workers will auto-reconnect, but force restart if needed
   kubectl rollout restart deployment/cogitator-worker
   ```

### Scenario 3: PostgreSQL Failure

**Symptoms:**

- Database connection errors
- Agent definitions not loading
- Long-term memory unavailable

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

   ```bash
   # Stop Postgres
   systemctl stop postgresql

   # Restore from dump
   pg_restore -h localhost -U cogitator -d cogitator \
     /var/backups/cogitator/postgres/cogitator_latest.dump

   # Start Postgres
   systemctl start postgresql
   ```

4. **Point-in-time recovery**

   ```bash
   # Create recovery.conf
   cat > /var/lib/postgresql/data/recovery.conf << EOF
   restore_command = 'cp /var/lib/postgresql/wal_archive/%f %p'
   recovery_target_time = '2024-12-15 14:30:00'
   EOF

   # Start Postgres in recovery mode
   systemctl start postgresql
   ```

5. **Verify data integrity**

   ```bash
   # Check tables
   psql -c "SELECT table_name FROM information_schema.tables WHERE table_schema = 'public';"

   # Verify agent count
   psql -c "SELECT COUNT(*) FROM agents;"

   # Check for orphaned records
   psql -c "SELECT COUNT(*) FROM runs WHERE status = 'running' AND updated_at < NOW() - INTERVAL '1 hour';"
   ```

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
   # Terraform/Pulumi rebuild
   cd infrastructure/
   terraform apply

   # Or restore from IaC
   pulumi up
   ```

3. **Restore data stores first**

   ```bash
   # 1. Restore PostgreSQL
   ./scripts/restore-postgres.sh latest

   # 2. Restore Redis
   ./scripts/restore-redis.sh latest
   ```

4. **Deploy application**

   ```bash
   # Apply Kubernetes manifests
   kubectl apply -f k8s/

   # Or use Helm
   helm upgrade --install cogitator ./charts/cogitator
   ```

5. **Verify recovery**

   ```bash
   # Check all pods running
   kubectl get pods

   # Run health checks
   curl http://api.cogitator.dev/health

   # Test agent execution
   curl -X POST http://api.cogitator.dev/api/runs \
     -H "Content-Type: application/json" \
     -d '{"agentId": "test-agent", "input": "hello"}'
   ```

### Scenario 5: Data Corruption

**Symptoms:**

- JSON parse errors from database
- Inconsistent agent state
- Vector search returning invalid results

**Recovery Steps:**

1. **Identify corruption scope**

   ```bash
   # Check for invalid JSON in runs
   psql -c "SELECT id FROM runs WHERE NOT (result IS NULL OR result::text <> '');"

   # Check vector dimensions
   psql -c "SELECT id FROM memory_vectors WHERE array_length(embedding, 1) != 1536;"
   ```

2. **Isolate affected data**

   ```bash
   # Mark corrupted runs
   psql -c "UPDATE runs SET status = 'corrupted' WHERE id IN (SELECT id FROM corrupted_runs_view);"

   # Disable affected agents
   psql -c "UPDATE agents SET enabled = false WHERE id IN (SELECT DISTINCT agent_id FROM corrupted_runs_view);"
   ```

3. **Restore from known good backup**

   ```bash
   # Find last good backup
   aws s3 ls s3://cogitator-backups/postgres/ | tail -10

   # Restore specific tables
   pg_restore -h localhost -U cogitator -d cogitator \
     --table=runs --table=memory_vectors \
     /var/backups/cogitator/postgres/cogitator_20241214.dump
   ```

4. **Reindex vectors**
   ```bash
   # Rebuild vector index
   psql -c "REINDEX INDEX memory_vectors_embedding_idx;"
   ```

---

## Sandbox Recovery

### Docker Sandbox Failures

**Container stuck or unresponsive:**

```bash
# List stuck containers
docker ps --filter "label=cogitator.sandbox=true" --filter "status=running"

# Force cleanup
docker rm -f $(docker ps -q --filter "label=cogitator.sandbox=true")

# Clear container pool
curl -X POST http://localhost:3000/admin/sandbox/reset
```

**Image corruption:**

```bash
# Remove and repull sandbox image
docker rmi cogitator/sandbox:latest
docker pull cogitator/sandbox:latest
```

### WASM Sandbox Failures

**Plugin cache corruption:**

```bash
# Clear WASM plugin cache
rm -rf /var/cache/cogitator/wasm/*

# Restart workers to rebuild cache
kubectl rollout restart deployment/cogitator-worker
```

**Extism runtime issues:**

```bash
# Check Extism version
node -e "console.log(require('@extism/extism').version)"

# Reinstall if needed
pnpm install @extism/extism@latest
```

---

## Monitoring and Alerts

### Critical Alerts

Configure alerts for:

```yaml
# alertmanager.yml
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
        expr: sum(cogitator_workers_active) == 0
        for: 2m
        labels:
          severity: critical

      - alert: HighErrorRate
        expr: rate(cogitator_runs_failed_total[5m]) > 0.1
        for: 5m
        labels:
          severity: warning
```

### Health Check Endpoints

| Endpoint        | Purpose                 | Expected Response |
| --------------- | ----------------------- | ----------------- |
| `/health`       | Overall health          | `200 OK`          |
| `/health/ready` | Ready to accept traffic | `200 OK`          |
| `/health/live`  | Process is alive        | `200 OK`          |
| `/health/db`    | Database connectivity   | `200 OK`          |
| `/health/redis` | Redis connectivity      | `200 OK`          |

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

| Role             | Contact                | Escalation Path           |
| ---------------- | ---------------------- | ------------------------- |
| On-call Engineer | PagerDuty              | Auto-escalate after 15m   |
| Platform Lead    | @platform-lead         | If P1 not resolved in 30m |
| Security         | security@cogitator.dev | Any security incident     |

---

## Runbook Maintenance

This document should be:

- Reviewed quarterly
- Updated after each incident
- Tested via disaster recovery drills (quarterly)

Last updated: December 2024
