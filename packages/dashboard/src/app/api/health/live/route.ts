import { NextResponse } from 'next/server';

/**
 * Liveness probe endpoint for Kubernetes.
 * Returns 200 if the application is running.
 * This should be a lightweight check - just verifies the process is alive.
 */
export async function GET() {
  return NextResponse.json({
    status: 'alive',
    timestamp: new Date().toISOString(),
  });
}
