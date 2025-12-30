import { NextRequest, NextResponse } from 'next/server';
import {
  getHourlyStats,
  getModelStats,
  getTopAgents,
  getDashboardStats,
} from '@/lib/db/analytics';
import { getAnalytics, initializeExtendedSchema } from '@/lib/cogitator/db';
import { initializeSchema } from '@/lib/db';

let initialized = false;

async function ensureInitialized() {
  if (!initialized) {
    try {
      await initializeSchema();
      await initializeExtendedSchema();
      initialized = true;
    } catch (error) {
      console.error('[api/analytics] Failed to initialize database:', error);
    }
  }
}

export async function GET(request: NextRequest) {
  try {
    await ensureInitialized();

    const searchParams = request.nextUrl.searchParams;
    const period = (searchParams.get('period') || 'day') as 'day' | 'week' | 'month';
    const hours = parseInt(searchParams.get('hours') || '24');
    const days = period === 'day' ? 1 : period === 'week' ? 7 : 30;

    // Fetch both legacy and new analytics
    const [hourlyStats, modelStats, topAgents, dashboardStats, cogitatorAnalytics] =
      await Promise.all([
        getHourlyStats(hours),
        getModelStats(period),
        getTopAgents(10, period),
        getDashboardStats(),
        getAnalytics(days).catch(() => null),
      ]);

    // Merge analytics data
    const analytics = {
      hourly: hourlyStats,
      models: modelStats,
      topAgents,
      dashboard: dashboardStats,
      period,
      // Extended analytics from Cogitator runs
      cogitator: cogitatorAnalytics
        ? {
            totalRuns: cogitatorAnalytics.totalRuns,
            totalTokens: cogitatorAnalytics.totalTokens,
            totalCost: cogitatorAnalytics.totalCost,
            avgDuration: cogitatorAnalytics.avgDuration,
            runsPerDay: cogitatorAnalytics.runsPerDay,
            tokensByModel: cogitatorAnalytics.tokensByModel,
            costByModel: cogitatorAnalytics.costByModel,
          }
        : null,
    };

    return NextResponse.json(analytics);
  } catch (error) {
    console.error('[api/analytics] Failed to fetch analytics:', error);
    return NextResponse.json({ error: 'Failed to fetch analytics' }, { status: 500 });
  }
}
