import { NextResponse } from 'next/server';
import { getPool } from '@/lib/db';

/**
 * Readiness probe endpoint for Kubernetes.
 * Returns 200 if the application is ready to receive traffic.
 * Checks critical dependencies (database) before accepting traffic.
 */
export async function GET() {
  const ready: {
    status: 'ready' | 'not_ready';
    checks: {
      database: boolean;
    };
    timestamp: string;
  } = {
    status: 'not_ready',
    checks: {
      database: false,
    },
    timestamp: new Date().toISOString(),
  };

  try {
    const pool = getPool();
    await pool.query('SELECT 1');
    ready.checks.database = true;
  } catch {
    ready.checks.database = false;
  }

  if (ready.checks.database) {
    ready.status = 'ready';
  }

  const statusCode = ready.status === 'ready' ? 200 : 503;
  return NextResponse.json(ready, { status: statusCode });
}
