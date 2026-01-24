import { NextResponse } from 'next/server';
import { withAuth, type AuthenticatedRequest } from '@/lib/auth/middleware';
import { createJob, getJobs, getQueueStats } from '@/lib/worker';
import { z } from 'zod';

const createJobSchema = z.object({
  type: z.enum(['agent', 'workflow', 'swarm']),
  targetId: z.string().min(1),
  input: z.string().min(1),
  metadata: z.record(z.string(), z.unknown()).optional(),
});

export const GET = withAuth(async (request: AuthenticatedRequest) => {
  try {
    const searchParams = request.nextUrl.searchParams;
    const status = searchParams.get('status') as
      | 'pending'
      | 'running'
      | 'completed'
      | 'failed'
      | null;
    const type = searchParams.get('type') as 'agent' | 'workflow' | 'swarm' | null;
    const limit = parseInt(searchParams.get('limit') || '50');
    const offset = parseInt(searchParams.get('offset') || '0');
    const statsOnly = searchParams.get('stats') === 'true';

    if (statsOnly) {
      const stats = await getQueueStats();
      return NextResponse.json(stats);
    }

    const jobs = await getJobs({
      userId: request.user!.id,
      status: status || undefined,
      type: type || undefined,
      limit,
      offset,
    });

    return NextResponse.json(jobs);
  } catch (error) {
    console.error('[api/jobs] Error:', error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Failed to fetch jobs' },
      { status: 500 }
    );
  }
});

export const POST = withAuth(async (request: AuthenticatedRequest) => {
  try {
    const body = await request.json();

    const parsed = createJobSchema.safeParse(body);
    if (!parsed.success) {
      return NextResponse.json(
        {
          error: 'Validation failed',
          details: parsed.error.issues.map((e) => ({
            path: e.path.join('.'),
            message: e.message,
          })),
        },
        { status: 400 }
      );
    }

    const job = await createJob({
      ...parsed.data,
      userId: request.user!.id,
    });

    return NextResponse.json(job, { status: 201 });
  } catch (error) {
    console.error('[api/jobs] Error:', error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Failed to create job' },
      { status: 500 }
    );
  }
});
