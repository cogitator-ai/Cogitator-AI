'use client';

import { useEffect, useState, useCallback } from 'react';
import { Sidebar } from '@/components/layout/Sidebar';
import { Header } from '@/components/layout/Header';
import { Card } from '@/components/ui/Card';
import { Badge } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import { Input } from '@/components/ui/Input';
import { Skeleton } from '@/components/ui/Skeleton';
import {
  Play,
  Search,
  CheckCircle,
  XCircle,
  Clock,
  Loader2,
  Wifi,
  WifiOff,
} from 'lucide-react';
import Link from 'next/link';
import { formatDistanceToNow } from 'date-fns';
import { useEvents } from '@/hooks/useEvents';

interface Run {
  id: string;
  agentId: string;
  agentName?: string;
  model?: string;
  status: 'running' | 'completed' | 'failed' | 'cancelled';
  input: string;
  output?: string;
  startedAt: string;
  completedAt?: string;
  duration?: number;
  totalTokens: number;
  cost: number;
}

interface RunEvent {
  runId: string;
  agentId: string;
  type?: 'started' | 'completed' | 'failed' | 'toolCall';
  status?: string;
  input?: string;
  output?: string;
  threadId?: string;
  usage?: { totalTokens: number; cost: number; duration: number };
  toolCalls?: number;
  timestamp: number;
}

const statusConfig = {
  running: {
    icon: Loader2,
    variant: 'info' as const,
    label: 'Running',
    iconClass: 'animate-spin',
  },
  completed: {
    icon: CheckCircle,
    variant: 'success' as const,
    label: 'Completed',
    iconClass: '',
  },
  failed: {
    icon: XCircle,
    variant: 'error' as const,
    label: 'Failed',
    iconClass: '',
  },
  cancelled: {
    icon: Clock,
    variant: 'warning' as const,
    label: 'Cancelled',
    iconClass: '',
  },
};

export default function RunsPage() {
  const [runs, setRuns] = useState<Run[]>([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState('');
  const [statusFilter, setStatusFilter] = useState<string | null>(null);

  const { connected, subscribe } = useEvents({ autoConnect: true });

  const fetchRuns = useCallback(async () => {
    try {
      let url = '/api/runs?limit=100';
      if (statusFilter) url += `&status=${statusFilter}`;

      const response = await fetch(url);
      if (response.ok) {
        const data = await response.json();
        setRuns(data.runs || []);
      }
    } catch (error) {
      console.error('Failed to fetch runs:', error);
    } finally {
      setLoading(false);
    }
  }, [statusFilter]);

  useEffect(() => {
    fetchRuns();
    const interval = setInterval(fetchRuns, 30000);
    return () => clearInterval(interval);
  }, [fetchRuns]);

  useEffect(() => {
    const unsubscribe = subscribe('run', (data: unknown) => {
      const event = data as RunEvent;

      if (event.type === 'started') {
        const newRun: Run = {
          id: event.runId,
          agentId: event.agentId,
          status: 'running',
          input: event.input || '',
          startedAt: new Date(event.timestamp).toISOString(),
          totalTokens: 0,
          cost: 0,
        };

        setRuns((prev) => {
          if (prev.some((r) => r.id === newRun.id)) return prev;
          return [newRun, ...prev];
        });
      } else if (event.type === 'completed') {
        setRuns((prev) =>
          prev.map((run) =>
            run.id === event.runId
              ? {
                  ...run,
                  status: 'completed' as const,
                  output: event.output,
                  completedAt: new Date(event.timestamp).toISOString(),
                  totalTokens: event.usage?.totalTokens ?? run.totalTokens,
                  cost: event.usage?.cost ?? run.cost,
                  duration: event.usage?.duration ?? run.duration,
                }
              : run
          )
        );
      } else if (event.type === 'failed') {
        setRuns((prev) =>
          prev.map((run) =>
            run.id === event.runId
              ? {
                  ...run,
                  status: 'failed' as const,
                  completedAt: new Date(event.timestamp).toISOString(),
                }
              : run
          )
        );
      }
    });

    return unsubscribe;
  }, [subscribe]);

  const filteredRuns = runs.filter(
    (run) =>
      run.input.toLowerCase().includes(search.toLowerCase()) ||
      run.agentName?.toLowerCase().includes(search.toLowerCase()) ||
      run.id.toLowerCase().includes(search.toLowerCase())
  );

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
                  Runs
                </h1>
                <p className="text-text-secondary mt-1">
                  View execution history and details
                </p>
              </div>
              <div className="flex items-center gap-2">
                {connected ? (
                  <Badge variant="success" size="sm" className="gap-1">
                    <Wifi className="w-3 h-3" />
                    Live
                  </Badge>
                ) : (
                  <Badge variant="warning" size="sm" className="gap-1">
                    <WifiOff className="w-3 h-3" />
                    Offline
                  </Badge>
                )}
              </div>
            </div>

            {/* Filters */}
            <div
              className="flex flex-col sm:flex-row gap-4 animate-fade-in"
              style={{ animationDelay: '100ms' }}
            >
              <Input
                placeholder="Search runs..."
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                icon={<Search className="w-4 h-4" />}
                className="sm:max-w-md"
              />
              <div className="flex gap-2">
                <Button
                  variant={statusFilter === null ? 'primary' : 'ghost'}
                  size="sm"
                  onClick={() => setStatusFilter(null)}
                >
                  All
                </Button>
                <Button
                  variant={statusFilter === 'running' ? 'primary' : 'ghost'}
                  size="sm"
                  onClick={() => setStatusFilter('running')}
                >
                  Running
                </Button>
                <Button
                  variant={statusFilter === 'completed' ? 'primary' : 'ghost'}
                  size="sm"
                  onClick={() => setStatusFilter('completed')}
                >
                  Completed
                </Button>
                <Button
                  variant={statusFilter === 'failed' ? 'primary' : 'ghost'}
                  size="sm"
                  onClick={() => setStatusFilter('failed')}
                >
                  Failed
                </Button>
              </div>
            </div>

            {/* Runs List */}
            <Card className="animate-fade-in" style={{ animationDelay: '200ms' }}>
              {loading ? (
                <div className="space-y-4">
                  {[...Array(10)].map((_, i) => (
                    <div
                      key={i}
                      className="flex items-center gap-4 p-4 border-b border-border-primary last:border-0"
                    >
                      <Skeleton className="h-10 w-10 rounded-full" />
                      <div className="flex-1 space-y-2">
                        <Skeleton className="h-4 w-1/3" />
                        <Skeleton className="h-3 w-2/3" />
                      </div>
                      <Skeleton className="h-6 w-20" />
                    </div>
                  ))}
                </div>
              ) : filteredRuns.length === 0 ? (
                <div className="py-12 text-center">
                  <Play className="w-12 h-12 mx-auto mb-4 text-text-muted opacity-50" />
                  <h3 className="text-lg font-medium text-text-primary mb-2">
                    {search || statusFilter ? 'No runs found' : 'No runs yet'}
                  </h3>
                  <p className="text-text-secondary">
                    {search || statusFilter
                      ? 'Try different filters'
                      : 'Start an agent to see runs here'}
                  </p>
                </div>
              ) : (
                <div className="divide-y divide-border-primary">
                  {filteredRuns.map((run) => {
                    const config = statusConfig[run.status];
                    const Icon = config.icon;

                    return (
                      <Link
                        key={run.id}
                        href={`/runs/${run.id}`}
                        className="flex items-center gap-4 p-4 hover:bg-bg-tertiary transition-colors"
                      >
                        <div
                          className={`p-2 rounded-full ${
                            run.status === 'running'
                              ? 'bg-info/10 text-info'
                              : run.status === 'completed'
                                ? 'bg-success/10 text-success'
                                : run.status === 'failed'
                                  ? 'bg-error/10 text-error'
                                  : 'bg-warning/10 text-warning'
                          }`}
                        >
                          <Icon className={`w-5 h-5 ${config.iconClass}`} />
                        </div>

                        <div className="flex-1 min-w-0">
                          <div className="flex items-center gap-2">
                            <span className="font-medium text-text-primary">
                              {run.agentName || run.agentId}
                            </span>
                            {run.model && (
                              <span className="text-sm text-text-muted">
                                {run.model}
                              </span>
                            )}
                          </div>
                          <p className="text-sm text-text-secondary truncate">
                            {run.input.slice(0, 100)}
                            {run.input.length > 100 ? '...' : ''}
                          </p>
                          <p className="text-xs text-text-muted mt-1">
                            {run.id}
                          </p>
                        </div>

                        <div className="text-right space-y-1">
                          <Badge variant={config.variant} size="sm">
                            {config.label}
                          </Badge>
                          <p className="text-xs text-text-secondary">
                            {run.totalTokens.toLocaleString()} tokens
                          </p>
                          <p className="text-xs text-text-muted">
                            ${run.cost.toFixed(4)}
                          </p>
                        </div>

                        <div className="text-right text-xs text-text-muted w-24">
                          <p>
                            {formatDistanceToNow(new Date(run.startedAt), {
                              addSuffix: true,
                            })}
                          </p>
                          {run.duration && (
                            <p className="text-text-secondary">
                              {formatDuration(run.duration)}
                            </p>
                          )}
                        </div>
                      </Link>
                    );
                  })}
                </div>
              )}
            </Card>
          </div>
        </main>
      </div>
    </div>
  );
}

function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60000) return `${(ms / 1000).toFixed(1)}s`;
  return `${(ms / 60000).toFixed(1)}m`;
}
