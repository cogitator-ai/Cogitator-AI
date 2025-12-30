import { execute, query, queryOne } from '../db/index';
import { nanoid } from 'nanoid';

export type AuditAction =
  | 'auth.login'
  | 'auth.logout'
  | 'auth.login_failed'
  | 'user.create'
  | 'user.update'
  | 'user.delete'
  | 'agent.create'
  | 'agent.update'
  | 'agent.delete'
  | 'agent.run'
  | 'workflow.create'
  | 'workflow.update'
  | 'workflow.delete'
  | 'workflow.run'
  | 'swarm.create'
  | 'swarm.update'
  | 'swarm.delete'
  | 'swarm.run'
  | 'config.update'
  | 'api_key.update';

export interface AuditEntry {
  id: string;
  action: AuditAction;
  userId?: string;
  userEmail?: string;
  resourceType?: string;
  resourceId?: string;
  details?: Record<string, unknown>;
  ipAddress?: string;
  userAgent?: string;
  createdAt: string;
}

interface AuditRow {
  id: string;
  action: string;
  user_id: string | null;
  user_email: string | null;
  resource_type: string | null;
  resource_id: string | null;
  details: Record<string, unknown> | null;
  ip_address: string | null;
  user_agent: string | null;
  created_at: Date;
}

export async function initializeAuditSchema(): Promise<void> {
  await execute(`
    CREATE TABLE IF NOT EXISTS cogitator_audit_log (
      id TEXT PRIMARY KEY,
      action TEXT NOT NULL,
      user_id TEXT,
      user_email TEXT,
      resource_type TEXT,
      resource_id TEXT,
      details JSONB,
      ip_address TEXT,
      user_agent TEXT,
      created_at TIMESTAMPTZ DEFAULT NOW()
    );

    CREATE INDEX IF NOT EXISTS idx_audit_action ON cogitator_audit_log(action);
    CREATE INDEX IF NOT EXISTS idx_audit_user ON cogitator_audit_log(user_id);
    CREATE INDEX IF NOT EXISTS idx_audit_resource ON cogitator_audit_log(resource_type, resource_id);
    CREATE INDEX IF NOT EXISTS idx_audit_created ON cogitator_audit_log(created_at DESC);
  `);
}

export async function logAudit(entry: {
  action: AuditAction;
  userId?: string;
  userEmail?: string;
  resourceType?: string;
  resourceId?: string;
  details?: Record<string, unknown>;
  ipAddress?: string;
  userAgent?: string;
}): Promise<void> {
  const id = `audit_${nanoid(12)}`;

  await execute(
    `INSERT INTO cogitator_audit_log
     (id, action, user_id, user_email, resource_type, resource_id, details, ip_address, user_agent)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
    [
      id,
      entry.action,
      entry.userId || null,
      entry.userEmail || null,
      entry.resourceType || null,
      entry.resourceId || null,
      entry.details ? JSON.stringify(entry.details) : null,
      entry.ipAddress || null,
      entry.userAgent || null,
    ]
  );
}

function rowToEntry(row: AuditRow): AuditEntry {
  return {
    id: row.id,
    action: row.action as AuditAction,
    userId: row.user_id || undefined,
    userEmail: row.user_email || undefined,
    resourceType: row.resource_type || undefined,
    resourceId: row.resource_id || undefined,
    details: row.details || undefined,
    ipAddress: row.ip_address || undefined,
    userAgent: row.user_agent || undefined,
    createdAt: row.created_at.toISOString(),
  };
}

export async function getAuditLogs(options?: {
  action?: AuditAction;
  userId?: string;
  resourceType?: string;
  resourceId?: string;
  startDate?: Date;
  endDate?: Date;
  limit?: number;
  offset?: number;
}): Promise<AuditEntry[]> {
  const conditions: string[] = [];
  const params: unknown[] = [];
  let idx = 1;

  if (options?.action) {
    conditions.push(`action = $${idx++}`);
    params.push(options.action);
  }
  if (options?.userId) {
    conditions.push(`user_id = $${idx++}`);
    params.push(options.userId);
  }
  if (options?.resourceType) {
    conditions.push(`resource_type = $${idx++}`);
    params.push(options.resourceType);
  }
  if (options?.resourceId) {
    conditions.push(`resource_id = $${idx++}`);
    params.push(options.resourceId);
  }
  if (options?.startDate) {
    conditions.push(`created_at >= $${idx++}`);
    params.push(options.startDate);
  }
  if (options?.endDate) {
    conditions.push(`created_at <= $${idx++}`);
    params.push(options.endDate);
  }

  const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
  const limit = options?.limit || 100;
  const offset = options?.offset || 0;

  params.push(limit, offset);

  const rows = await query<AuditRow>(
    `SELECT * FROM cogitator_audit_log ${where}
     ORDER BY created_at DESC
     LIMIT $${idx++} OFFSET $${idx}`,
    params
  );

  return rows.map(rowToEntry);
}

export async function getAuditLogCount(options?: {
  action?: AuditAction;
  userId?: string;
  resourceType?: string;
}): Promise<number> {
  const conditions: string[] = [];
  const params: unknown[] = [];
  let idx = 1;

  if (options?.action) {
    conditions.push(`action = $${idx++}`);
    params.push(options.action);
  }
  if (options?.userId) {
    conditions.push(`user_id = $${idx++}`);
    params.push(options.userId);
  }
  if (options?.resourceType) {
    conditions.push(`resource_type = $${idx++}`);
    params.push(options.resourceType);
  }

  const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';

  const result = await queryOne<{ count: string }>(
    `SELECT COUNT(*) as count FROM cogitator_audit_log ${where}`,
    params
  );

  return parseInt(result?.count || '0');
}

export function getRequestMeta(request: Request): {
  ipAddress?: string;
  userAgent?: string;
} {
  return {
    ipAddress:
      request.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ||
      request.headers.get('x-real-ip') ||
      undefined,
    userAgent: request.headers.get('user-agent') || undefined,
  };
}
