'use client';

import { useEffect, useState } from 'react';
import { Sidebar } from '@/components/layout/Sidebar';
import { Header } from '@/components/layout/Header';
import { StatCard } from '@/components/dashboard/StatCard';
import { ActivityChart } from '@/components/dashboard/ActivityChart';
import { RecentRuns } from '@/components/dashboard/RecentRuns';
import { ActiveAgents } from '@/components/dashboard/ActiveAgents';
import { SystemHealth } from '@/components/dashboard/SystemHealth';
import { Activity, Cpu, DollarSign, Zap } from 'lucide-react';

interface DashboardData {
  stats: {
    totalRuns: number;
    activeAgents: number;
    totalTokens: number;
    totalCost: number;
  };
  hourly: Array<{ hour: string; runs: number; tokens: number }>;
}

export default function DashboardPage() {
  const [data, setData] = useState<DashboardData | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    async function fetchData() {
      try {
        const response = await fetch('/api/analytics');
        if (response.ok) {
          const result = await response.json();
          setData({
            stats: result.dashboard,
            hourly: result.hourly,
          });
        }
      } catch (error) {
        console.error('Failed to fetch dashboard data:', error);
      } finally {
        setLoading(false);
      }
    }

    fetchData();
    const interval = setInterval(fetchData, 30000);
    return () => clearInterval(interval);
  }, []);

  return (
    <div className="flex h-screen overflow-hidden">
      <Sidebar />
      <div className="flex-1 flex flex-col overflow-hidden">
        <Header />
        <main className="flex-1 overflow-auto p-6 bg-bg-primary bg-noise">
          <div className="max-w-7xl mx-auto space-y-6">
            {/* Welcome */}
            <div className="animate-fade-in">
              <h1 className="text-2xl font-semibold text-text-primary">
                Welcome back
              </h1>
              <p className="text-text-secondary mt-1">
                Here&apos;s what&apos;s happening with your agents
              </p>
            </div>

            {/* Stats Grid */}
            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4">
              <StatCard
                title="Total Runs (24h)"
                value={data?.stats.totalRuns ?? 0}
                loading={loading}
                icon={<Activity className="w-5 h-5" />}
                delay={0}
              />
              <StatCard
                title="Tokens Used"
                value={data?.stats.totalTokens ?? 0}
                format="compact"
                loading={loading}
                icon={<Zap className="w-5 h-5" />}
                delay={1}
              />
              <StatCard
                title="Total Cost"
                value={data?.stats.totalCost ?? 0}
                format="currency"
                loading={loading}
                icon={<DollarSign className="w-5 h-5" />}
                delay={2}
              />
              <StatCard
                title="Active Agents"
                value={data?.stats.activeAgents ?? 0}
                loading={loading}
                icon={<Cpu className="w-5 h-5" />}
                delay={3}
              />
            </div>

            {/* Activity Chart */}
            <div
              className="animate-fade-in"
              style={{ animationDelay: '200ms' }}
            >
              <ActivityChart data={data?.hourly} loading={loading} />
            </div>

            {/* Bottom Grid */}
            <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
              <div
                className="lg:col-span-2 animate-fade-in"
                style={{ animationDelay: '300ms' }}
              >
                <RecentRuns />
              </div>
              <div className="space-y-6">
                <div
                  className="animate-fade-in"
                  style={{ animationDelay: '400ms' }}
                >
                  <ActiveAgents />
                </div>
                <div
                  className="animate-fade-in"
                  style={{ animationDelay: '500ms' }}
                >
                  <SystemHealth />
                </div>
              </div>
            </div>
          </div>
        </main>
      </div>
    </div>
  );
}
