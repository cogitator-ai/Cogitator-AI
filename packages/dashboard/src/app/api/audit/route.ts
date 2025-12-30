import { NextResponse } from 'next/server';
import { withRole, type AuthenticatedRequest } from '@/lib/auth/middleware';
import { getAuditLogs, getAuditLogCount, initializeAuditSchema, type AuditAction } from '@/lib/audit';

let schemaInitialized = false;

async function ensureSchema() {
  if (!schemaInitialized) {
    await initializeAuditSchema();
    schemaInitialized = true;
  }
}

async function handler(request: AuthenticatedRequest) {
  try {
    await ensureSchema();

    const searchParams = request.nextUrl.searchParams;
    const action = searchParams.get('action') || undefined;
    const userId = searchParams.get('userId') || undefined;
    const resourceType = searchParams.get('resourceType') || undefined;
    const resourceId = searchParams.get('resourceId') || undefined;
    const limit = parseInt(searchParams.get('limit') || '100');
    const offset = parseInt(searchParams.get('offset') || '0');

    const [logs, total] = await Promise.all([
      getAuditLogs({
        action: action as AuditAction | undefined,
        userId,
        resourceType,
        resourceId,
        limit,
        offset,
      }),
      getAuditLogCount({ action: action as AuditAction | undefined, userId, resourceType }),
    ]);

    return NextResponse.json({
      logs,
      total,
      limit,
      offset,
    });
  } catch (error) {
    console.error('[audit] Error:', error);
    return NextResponse.json(
      { error: 'Failed to fetch audit logs' },
      { status: 500 }
    );
  }
}

export const GET = withRole(['admin'], handler);
