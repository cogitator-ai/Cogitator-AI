'use client';

import { useEffect, useState } from 'react';
import { Sidebar } from '@/components/layout/Sidebar';
import { Header } from '@/components/layout/Header';
import { Card } from '@/components/ui/Card';
import { Button } from '@/components/ui/Button';
import { Skeleton } from '@/components/ui/Skeleton';
import {
  AreaChart,
  Area,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ResponsiveContainer,
  PieChart,
  Pie,
  Cell,
  BarChart,
  Bar,
} from 'recharts';
import { format, parseISO } from 'date-fns';
import { TrendingUp, DollarSign, Zap, Activity } from 'lucide-react';

interface AnalyticsData {
  hourly: Array<{ hour: string; runs: number; tokens: number; cost: number }>;
  models: Array<{ model: string; runs: number; tokens: number; cost: number }>;
  topAgents: Array<{
    id: string;
    name: string;
    model: string;
    runs: number;
    tokens: number;
    cost: number;
    avgDuration: number;
    successRate: number;
  }>;
  dashboard: {
    totalRuns: number;
    activeAgents: number;
    totalTokens: number;
    totalCost: number;
  };
}

const COLORS = ['#00ff88', '#a855f7', '#3b82f6', '#f59e0b', '#ef4444', '#06b6d4'];

export default function AnalyticsPage() {
  const [data, setData] = useState<AnalyticsData | null>(null);
  const [loading, setLoading] = useState(true);
  const [period, setPeriod] = useState<'day' | 'week' | 'month'>('day');

  useEffect(() => {
    async function fetchAnalytics() {
      try {
        const response = await fetch(`/api/analytics?period=${period}`);
        if (response.ok) {
          const result = await response.json();
          setData(result);
        }
      } catch (error) {
        console.error('Failed to fetch analytics:', error);
      } finally {
        setLoading(false);
      }
    }

    setLoading(true);
    fetchAnalytics();
  }, [period]);

  const hourlyData = data?.hourly.map((item) => ({
    time: format(parseISO(item.hour), 'HH:mm'),
    runs: item.runs,
    tokens: Math.round(item.tokens / 1000),
    cost: item.cost,
  })) || [];

  const modelData = data?.models.map((item, index) => ({
    ...item,
    color: COLORS[index % COLORS.length],
  })) || [];

  const totalModelCost = modelData.reduce((acc, m) => acc + m.cost, 0);

  return (
    <div className="flex h-screen overflow-hidden">
      <Sidebar />
      <div className="flex-1 flex flex-col overflow-hidden">
        <Header />
        <main className="flex-1 overflow-auto p-6 bg-bg-primary bg-noise">
          <div className="max-w-7xl mx-auto space-y-6">
            {/* Header */}
            <div className="flex items-center justify-between animate-fade-in">
              <div>
                <h1 className="text-2xl font-semibold text-text-primary">
                  Analytics
                </h1>
                <p className="text-text-secondary mt-1">
                  Usage statistics and cost breakdown
                </p>
              </div>
              <div className="flex gap-2">
                {(['day', 'week', 'month'] as const).map((p) => (
                  <Button
                    key={p}
                    variant={period === p ? 'primary' : 'ghost'}
                    size="sm"
                    onClick={() => setPeriod(p)}
                  >
                    {p.charAt(0).toUpperCase() + p.slice(1)}
                  </Button>
                ))}
              </div>
            </div>

            {/* Summary Cards */}
            <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
              {[
                { title: 'Total Runs', value: data?.dashboard.totalRuns || 0, icon: Activity, format: 'number' },
                { title: 'Total Tokens', value: data?.dashboard.totalTokens || 0, icon: Zap, format: 'compact' },
                { title: 'Total Cost', value: data?.dashboard.totalCost || 0, icon: DollarSign, format: 'currency' },
                { title: 'Active Agents', value: data?.dashboard.activeAgents || 0, icon: TrendingUp, format: 'number' },
              ].map((item, index) => (
                <Card key={item.title} className="animate-fade-in" style={{ animationDelay: `${index * 50}ms` }}>
                  {loading ? (
                    <div className="space-y-2">
                      <Skeleton className="h-4 w-24" />
                      <Skeleton className="h-8 w-32" />
                    </div>
                  ) : (
                    <div className="flex items-center gap-4">
                      <div className="p-3 bg-accent/10 rounded-xl">
                        <item.icon className="w-5 h-5 text-accent" />
                      </div>
                      <div>
                        <p className="text-sm text-text-secondary">{item.title}</p>
                        <p className="text-2xl font-semibold text-text-primary">
                          {formatValue(item.value, item.format)}
                        </p>
                      </div>
                    </div>
                  )}
                </Card>
              ))}
            </div>

            {/* Charts Row */}
            <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
              {/* Usage Over Time */}
              <Card className="animate-fade-in" style={{ animationDelay: '200ms' }}>
                <h3 className="text-lg font-medium text-text-primary mb-4">
                  Usage Over Time
                </h3>
                {loading ? (
                  <Skeleton className="h-64 w-full" />
                ) : (
                  <div className="h-64">
                    <ResponsiveContainer width="100%" height="100%">
                      <AreaChart data={hourlyData}>
                        <defs>
                          <linearGradient id="colorRuns2" x1="0" y1="0" x2="0" y2="1">
                            <stop offset="5%" stopColor="#00ff88" stopOpacity={0.3} />
                            <stop offset="95%" stopColor="#00ff88" stopOpacity={0} />
                          </linearGradient>
                        </defs>
                        <CartesianGrid strokeDasharray="3 3" stroke="rgba(255,255,255,0.05)" />
                        <XAxis dataKey="time" stroke="#666" fontSize={12} />
                        <YAxis stroke="#666" fontSize={12} />
                        <Tooltip
                          contentStyle={{
                            backgroundColor: '#1a1a1a',
                            border: '1px solid rgba(255,255,255,0.1)',
                            borderRadius: '8px',
                          }}
                        />
                        <Area
                          type="monotone"
                          dataKey="runs"
                          stroke="#00ff88"
                          strokeWidth={2}
                          fillOpacity={1}
                          fill="url(#colorRuns2)"
                        />
                      </AreaChart>
                    </ResponsiveContainer>
                  </div>
                )}
              </Card>

              {/* Cost by Model */}
              <Card className="animate-fade-in" style={{ animationDelay: '250ms' }}>
                <h3 className="text-lg font-medium text-text-primary mb-4">
                  Cost by Model
                </h3>
                {loading ? (
                  <Skeleton className="h-64 w-full" />
                ) : modelData.length === 0 ? (
                  <div className="h-64 flex items-center justify-center text-text-muted">
                    No model data available
                  </div>
                ) : (
                  <div className="h-64 flex items-center">
                    <ResponsiveContainer width="50%" height="100%">
                      <PieChart>
                        <Pie
                          data={modelData}
                          dataKey="cost"
                          nameKey="model"
                          cx="50%"
                          cy="50%"
                          innerRadius={40}
                          outerRadius={80}
                          paddingAngle={2}
                        >
                          {modelData.map((entry, index) => (
                            <Cell key={entry.model} fill={entry.color} />
                          ))}
                        </Pie>
                        <Tooltip
                          contentStyle={{
                            backgroundColor: '#1a1a1a',
                            border: '1px solid rgba(255,255,255,0.1)',
                            borderRadius: '8px',
                          }}
                          formatter={(value: number) => `$${value.toFixed(4)}`}
                        />
                      </PieChart>
                    </ResponsiveContainer>
                    <div className="flex-1 space-y-2">
                      {modelData.map((item) => (
                        <div key={item.model} className="flex items-center gap-2">
                          <div
                            className="w-3 h-3 rounded-full"
                            style={{ backgroundColor: item.color }}
                          />
                          <span className="text-sm text-text-secondary flex-1 truncate">
                            {item.model}
                          </span>
                          <span className="text-sm font-medium text-text-primary">
                            {totalModelCost > 0
                              ? `${((item.cost / totalModelCost) * 100).toFixed(1)}%`
                              : '0%'}
                          </span>
                        </div>
                      ))}
                    </div>
                  </div>
                )}
              </Card>
            </div>

            {/* Top Agents */}
            <Card className="animate-fade-in" style={{ animationDelay: '300ms' }}>
              <h3 className="text-lg font-medium text-text-primary mb-4">
                Top Agents
              </h3>
              {loading ? (
                <div className="space-y-4">
                  {[...Array(5)].map((_, i) => (
                    <div key={i} className="flex items-center gap-4">
                      <Skeleton className="h-8 w-32" />
                      <Skeleton className="h-4 flex-1" />
                      <Skeleton className="h-4 w-20" />
                    </div>
                  ))}
                </div>
              ) : data?.topAgents.length === 0 ? (
                <div className="py-8 text-center text-text-muted">
                  No agent data available
                </div>
              ) : (
                <div className="overflow-x-auto">
                  <table className="w-full">
                    <thead>
                      <tr className="text-left text-sm text-text-muted">
                        <th className="pb-3 font-medium">Agent</th>
                        <th className="pb-3 font-medium">Model</th>
                        <th className="pb-3 font-medium text-right">Runs</th>
                        <th className="pb-3 font-medium text-right">Tokens</th>
                        <th className="pb-3 font-medium text-right">Cost</th>
                        <th className="pb-3 font-medium text-right">Success</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-border-primary">
                      {data?.topAgents.map((agent) => (
                        <tr key={agent.id} className="hover:bg-bg-tertiary">
                          <td className="py-3">
                            <span className="font-medium text-text-primary">
                              {agent.name}
                            </span>
                          </td>
                          <td className="py-3 text-text-secondary">
                            {agent.model}
                          </td>
                          <td className="py-3 text-right text-text-primary">
                            {agent.runs.toLocaleString()}
                          </td>
                          <td className="py-3 text-right text-text-primary">
                            {formatValue(agent.tokens, 'compact')}
                          </td>
                          <td className="py-3 text-right text-text-primary">
                            ${agent.cost.toFixed(4)}
                          </td>
                          <td className="py-3 text-right">
                            <span
                              className={
                                agent.successRate >= 90
                                  ? 'text-success'
                                  : agent.successRate >= 70
                                    ? 'text-warning'
                                    : 'text-error'
                              }
                            >
                              {agent.successRate.toFixed(1)}%
                            </span>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </Card>
          </div>
        </main>
      </div>
    </div>
  );
}

function formatValue(value: number, format: string): string {
  switch (format) {
    case 'currency':
      return new Intl.NumberFormat('en-US', {
        style: 'currency',
        currency: 'USD',
      }).format(value);
    case 'compact':
      return new Intl.NumberFormat('en-US', {
        notation: 'compact',
        maximumFractionDigits: 1,
      }).format(value);
    default:
      return new Intl.NumberFormat('en-US').format(value);
  }
}
