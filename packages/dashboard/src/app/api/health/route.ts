import { NextResponse } from 'next/server';
import { getPool } from '@/lib/db';
import { getRedis } from '@/lib/redis';

export async function GET() {
  const health: {
    status: 'healthy' | 'degraded' | 'unhealthy';
    services: {
      database: { status: 'up' | 'down'; latency?: number };
      redis: { status: 'up' | 'down'; latency?: number };
      ollama: { status: 'up' | 'down'; models?: string[] };
    };
    uptime: number;
    timestamp: string;
  } = {
    status: 'healthy',
    services: {
      database: { status: 'down' },
      redis: { status: 'down' },
      ollama: { status: 'down' },
    },
    uptime: process.uptime(),
    timestamp: new Date().toISOString(),
  };

  try {
    const pool = getPool();
    const start = Date.now();
    await pool.query('SELECT 1');
    health.services.database = {
      status: 'up',
      latency: Date.now() - start,
    };
  } catch {
    health.services.database = { status: 'down' };
    health.status = 'degraded';
  }

  try {
    const redis = await getRedis();
    const start = Date.now();
    await redis.ping();
    health.services.redis = {
      status: 'up',
      latency: Date.now() - start,
    };
  } catch {
    health.services.redis = { status: 'down' };
    health.status = 'degraded';
  }

  try {
    const ollamaUrl = process.env.OLLAMA_URL || 'http://localhost:11434';
    const response = await fetch(`${ollamaUrl}/api/tags`, {
      signal: AbortSignal.timeout(5000),
    });
    if (response.ok) {
      const data = await response.json();
      health.services.ollama = {
        status: 'up',
        models: data.models?.map((m: { name: string }) => m.name) || [],
      };
    }
  } catch {
    health.services.ollama = { status: 'down' };
  }

  if (health.services.database.status === 'down') {
    health.status = 'unhealthy';
  }

  const statusCode = health.status === 'healthy' ? 200 : 
                     health.status === 'degraded' ? 200 : 503;

  return NextResponse.json(health, { status: statusCode });
}
