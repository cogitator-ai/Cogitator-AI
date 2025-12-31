'use client';

import { useState, useEffect, useMemo } from 'react';
import Link from 'next/link';
import { Card, CardHeader, CardTitle } from '@/components/ui/Card';
import { Button } from '@/components/ui/Button';
import { Badge } from '@/components/ui/Badge';
import { cn } from '@/lib/cn';
import {
  ArrowLeft,
  Bot,
  Play,
  Settings,
  Zap,
  DollarSign,
  Activity,
  Clock,
  TrendingUp,
  AlertCircle,
} from 'lucide-react';
import {
  AreaChart,
  Area,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ResponsiveContainer,
} from 'recharts';
import { format, subDays, startOfDay } from 'date-fns';

interface AgentDetailProps {
  agentId: string;
}

interface Run {
  id: string;
  status: 'running' | 'completed' | 'failed' | 'cancelled';
  input: string;
  total_tokens: number;
  duration: number | null;
  started_at: string;
}

interface Agent {
  id: string;
  name: string;
  model: string;
  description: string | null;
  instructions: string;
  total_runs: number;
  total_tokens: number;
  total_cost: number;
  last_run_at: string | null;
  recentRuns: Run[];
}

function getAgentStatus(agent: Agent): 'online' | 'busy' | 'offline' {
  if (!agent.last_run_at) return 'offline';
  const lastRun = new Date(agent.last_run_at);
  const minutesAgo = (Date.now() - lastRun.getTime()) / 1000 / 60;
  if (minutesAgo < 1) return 'busy';
  if (minutesAgo < 30) return 'online';
  return 'offline';
}

function computeUsageData(runs: Run[]) {
  const days = 7;
  const data: { date: string; runs: number; tokens: number }[] = [];

  for (let i = days - 1; i >= 0; i--) {
    const day = startOfDay(subDays(new Date(), i));
    const dayStr = format(day, 'EEE');
    const dayStart = day.getTime();
    const dayEnd = dayStart + 24 * 60 * 60 * 1000;

    const dayRuns = runs.filter((r) => {
      const runTime = new Date(r.started_at).getTime();
      return runTime >= dayStart && runTime < dayEnd;
    });

    data.push({
      date: dayStr,
      runs: dayRuns.length,
      tokens: dayRuns.reduce((sum, r) => sum + r.total_tokens, 0),
    });
  }

  return data;
}

function AgentDetailSkeleton() {
  return (
    <div className="space-y-6 animate-pulse">
      <div className="h-8 w-32 bg-bg-elevated rounded" />
      <div className="flex items-center gap-4">
        <div className="w-16 h-16 rounded-xl bg-bg-elevated" />
        <div>
          <div className="h-6 w-48 bg-bg-elevated rounded mb-2" />
          <div className="h-4 w-24 bg-bg-elevated rounded" />
        </div>
      </div>
      <div className="grid grid-cols-5 gap-4">
        {[1, 2, 3, 4, 5].map((i) => (
          <div key={i} className="h-24 bg-bg-elevated rounded-lg" />
        ))}
      </div>
      <div className="h-64 bg-bg-elevated rounded-lg" />
    </div>
  );
}

export function AgentDetail({ agentId }: AgentDetailProps) {
  const [agent, setAgent] = useState<Agent | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    fetch(`/api/agents/${agentId}`)
      .then((res) => {
        if (!res.ok) {
          if (res.status === 404) throw new Error('Agent not found');
          throw new Error('Failed to fetch agent');
        }
        return res.json();
      })
      .then((data) => {
        setAgent(data);
        setLoading(false);
      })
      .catch((err) => {
        setError(err.message);
        setLoading(false);
      });
  }, [agentId]);

  const usageData = useMemo(() => {
    if (!agent?.recentRuns) return [];
    return computeUsageData(agent.recentRuns);
  }, [agent?.recentRuns]);

  const stats = useMemo(() => {
    if (!agent?.recentRuns) return { avgDuration: 0, successRate: 0 };

    const completedRuns = agent.recentRuns.filter((r) => r.status === 'completed');
    const failedRuns = agent.recentRuns.filter((r) => r.status === 'failed');
    const finishedRuns = completedRuns.length + failedRuns.length;

    const avgDuration =
      completedRuns.length > 0
        ? completedRuns.reduce((sum, r) => sum + (r.duration || 0), 0) / completedRuns.length / 1000
        : 0;

    const successRate = finishedRuns > 0 ? (completedRuns.length / finishedRuns) * 100 : 0;

    return { avgDuration, successRate };
  }, [agent?.recentRuns]);

  if (loading) {
    return <AgentDetailSkeleton />;
  }

  if (error || !agent) {
    return (
      <div className="space-y-6">
        <Link href="/dashboard/agents">
          <Button variant="ghost" size="sm" className="gap-2">
            <ArrowLeft className="w-4 h-4" />
            Back to Agents
          </Button>
        </Link>
        <div className="text-center py-12">
          <AlertCircle className="w-12 h-12 text-error mx-auto mb-4" />
          <h3 className="text-lg font-medium text-text-primary mb-2">
            {error || 'Agent not found'}
          </h3>
          <p className="text-text-secondary">
            The agent you're looking for doesn't exist or couldn't be loaded.
          </p>
        </div>
      </div>
    );
  }

  const status = getAgentStatus(agent);

  return (
    <div className="space-y-6">
      <Link href="/dashboard/agents">
        <Button variant="ghost" size="sm" className="gap-2">
          <ArrowLeft className="w-4 h-4" />
          Back to Agents
        </Button>
      </Link>

      <div className="flex items-start justify-between">
        <div className="flex items-center gap-4">
          <div
            className={cn(
              'w-16 h-16 rounded-xl flex items-center justify-center',
              status === 'online' && 'bg-success/10',
              status === 'busy' && 'bg-warning/10',
              status === 'offline' && 'bg-bg-elevated'
            )}
          >
            <Bot
              className={cn(
                'w-8 h-8',
                status === 'online' && 'text-success',
                status === 'busy' && 'text-warning',
                status === 'offline' && 'text-text-tertiary'
              )}
            />
          </div>
          <div>
            <div className="flex items-center gap-3">
              <h1 className="text-2xl font-semibold text-text-primary">{agent.name}</h1>
              <Badge
                variant={status === 'offline' ? 'outline' : 'success'}
                pulse={status === 'busy'}
              >
                {status}
              </Badge>
            </div>
            <p className="text-text-secondary mt-1">{agent.model}</p>
          </div>
        </div>
        <div className="flex items-center gap-2">
          <Button variant="outline" className="gap-2">
            <Settings className="w-4 h-4" />
            Configure
          </Button>
          <Button variant="primary" className="gap-2">
            <Play className="w-4 h-4" />
            Run Agent
          </Button>
        </div>
      </div>

      <div className="grid grid-cols-2 md:grid-cols-5 gap-4">
        <Card className="text-center">
          <Activity className="w-5 h-5 text-accent mx-auto mb-2" />
          <p className="text-2xl font-semibold text-text-primary">{agent.total_runs}</p>
          <p className="text-xs text-text-secondary">Total Runs</p>
        </Card>
        <Card className="text-center">
          <Zap className="w-5 h-5 text-chart-2 mx-auto mb-2" />
          <p className="text-2xl font-semibold text-text-primary">
            {agent.total_tokens >= 1000000
              ? `${(agent.total_tokens / 1000000).toFixed(1)}M`
              : agent.total_tokens >= 1000
                ? `${(agent.total_tokens / 1000).toFixed(0)}K`
                : agent.total_tokens}
          </p>
          <p className="text-xs text-text-secondary">Tokens</p>
        </Card>
        <Card className="text-center">
          <DollarSign className="w-5 h-5 text-chart-4 mx-auto mb-2" />
          <p className="text-2xl font-semibold text-text-primary">
            ${Number(agent.total_cost).toFixed(2)}
          </p>
          <p className="text-xs text-text-secondary">Total Cost</p>
        </Card>
        <Card className="text-center">
          <Clock className="w-5 h-5 text-chart-3 mx-auto mb-2" />
          <p className="text-2xl font-semibold text-text-primary">{stats.avgDuration.toFixed(1)}s</p>
          <p className="text-xs text-text-secondary">Avg Duration</p>
        </Card>
        <Card className="text-center">
          <TrendingUp className="w-5 h-5 text-success mx-auto mb-2" />
          <p className="text-2xl font-semibold text-text-primary">{stats.successRate.toFixed(0)}%</p>
          <p className="text-xs text-text-secondary">Success Rate</p>
        </Card>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        <Card padding="lg" className="lg:col-span-2">
          <CardHeader>
            <CardTitle>Usage (Last 7 days)</CardTitle>
          </CardHeader>
          <div className="h-[250px]">
            {usageData.some((d) => d.runs > 0) ? (
              <ResponsiveContainer width="100%" height="100%">
                <AreaChart data={usageData}>
                  <defs>
                    <linearGradient id="colorRuns2" x1="0" y1="0" x2="0" y2="1">
                      <stop offset="5%" stopColor="#00ff88" stopOpacity={0.3} />
                      <stop offset="95%" stopColor="#00ff88" stopOpacity={0} />
                    </linearGradient>
                  </defs>
                  <CartesianGrid strokeDasharray="3 3" stroke="#262626" vertical={false} />
                  <XAxis
                    dataKey="date"
                    axisLine={false}
                    tickLine={false}
                    tick={{ fill: '#666666', fontSize: 12 }}
                  />
                  <YAxis axisLine={false} tickLine={false} tick={{ fill: '#666666', fontSize: 12 }} />
                  <Tooltip
                    contentStyle={{
                      backgroundColor: '#1a1a1a',
                      border: '1px solid #333333',
                      borderRadius: '8px',
                    }}
                  />
                  <Area
                    type="monotone"
                    dataKey="runs"
                    stroke="#00ff88"
                    strokeWidth={2}
                    fill="url(#colorRuns2)"
                  />
                </AreaChart>
              </ResponsiveContainer>
            ) : (
              <div className="h-full flex items-center justify-center text-text-muted">
                No activity in the last 7 days
              </div>
            )}
          </div>
        </Card>

        <Card padding="lg">
          <CardHeader>
            <CardTitle>About</CardTitle>
          </CardHeader>
          <p className="text-sm text-text-secondary mb-4">
            {agent.description || 'No description'}
          </p>

          <CardTitle className="mb-2">System Instructions</CardTitle>
          <div className="bg-bg-elevated rounded-lg p-3 font-mono text-xs text-text-secondary max-h-32 overflow-auto">
            {agent.instructions}
          </div>
        </Card>
      </div>

      <Card padding="none">
        <CardHeader className="px-4 pt-4">
          <CardTitle>Recent Runs</CardTitle>
          <Link href={`/dashboard/runs?agent=${agentId}`}>
            <Button variant="ghost" size="sm">
              View all
            </Button>
          </Link>
        </CardHeader>
        {agent.recentRuns.length === 0 ? (
          <div className="text-center py-8 text-text-muted">No runs yet</div>
        ) : (
          <div className="divide-y divide-border-subtle">
            {agent.recentRuns.slice(0, 10).map((run) => (
              <Link
                key={run.id}
                href={`/dashboard/runs/${run.id}`}
                className="flex items-center gap-4 px-4 py-3 hover:bg-bg-hover transition-colors"
              >
                <div
                  className={cn(
                    'w-2 h-2 rounded-full',
                    run.status === 'completed' && 'bg-success',
                    run.status === 'failed' && 'bg-error',
                    run.status === 'running' && 'bg-info pulse-live',
                    run.status === 'cancelled' && 'bg-warning'
                  )}
                />
                <p className="flex-1 text-sm text-text-primary truncate">{run.input}</p>
                <div className="flex items-center gap-4 text-xs text-text-tertiary">
                  {run.duration && <span>{(run.duration / 1000).toFixed(1)}s</span>}
                  <span>{run.total_tokens.toLocaleString()} tokens</span>
                </div>
              </Link>
            ))}
          </div>
        )}
      </Card>
    </div>
  );
}
