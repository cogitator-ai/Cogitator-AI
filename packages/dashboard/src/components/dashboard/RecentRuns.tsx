'use client';

import { useEffect, useState } from 'react';
import { Card } from '@/components/ui/Card';
import { Badge } from '@/components/ui/Badge';
import { Skeleton } from '@/components/ui/Skeleton';
import { formatDistanceToNow } from 'date-fns';
import { Play, CheckCircle, XCircle, Clock, Loader2 } from 'lucide-react';
import Link from 'next/link';

interface Run {
  id: string;
  agentId: string;
  agentName?: string;
  model?: string;
  status: 'running' | 'completed' | 'failed' | 'cancelled';
  input: string;
  startedAt: string;
  duration?: number;
  totalTokens: number;
  cost: number;
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

export function RecentRuns() {
  const [runs, setRuns] = useState<Run[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    async function fetchRuns() {
      try {
        const response = await fetch('/api/runs?limit=10');
        if (response.ok) {
          const data = await response.json();
          setRuns(data.runs || []);
        }
      } catch (error) {
        console.error('Failed to fetch runs:', error);
      } finally {
        setLoading(false);
      }
    }

    fetchRuns();
    const interval = setInterval(fetchRuns, 10000);
    return () => clearInterval(interval);
  }, []);

  if (loading) {
    return (
      <Card>
        <div className="flex items-center justify-between mb-4">
          <Skeleton className="h-5 w-32" />
          <Skeleton className="h-4 w-16" />
        </div>
        <div className="space-y-3">
          {[...Array(5)].map((_, i) => (
            <div key={i} className="flex items-center gap-3 p-3">
              <Skeleton className="h-8 w-8 rounded-full" />
              <div className="flex-1 space-y-2">
                <Skeleton className="h-4 w-3/4" />
                <Skeleton className="h-3 w-1/2" />
              </div>
              <Skeleton className="h-6 w-16" />
            </div>
          ))}
        </div>
      </Card>
    );
  }

  return (
    <Card>
      <div className="flex items-center justify-between mb-4">
        <h3 className="text-lg font-medium text-text-primary">Recent Runs</h3>
        <Link
          href="/runs"
          className="text-sm text-accent hover:text-accent-hover transition-colors"
        >
          View all
        </Link>
      </div>

      {runs.length === 0 ? (
        <div className="py-8 text-center text-text-muted">
          <Play className="w-8 h-8 mx-auto mb-2 opacity-50" />
          <p>No runs yet</p>
          <p className="text-sm">Start an agent to see activity here</p>
        </div>
      ) : (
        <div className="space-y-1">
          {runs.map((run) => {
            const config = statusConfig[run.status];
            const Icon = config.icon;

            return (
              <Link
                key={run.id}
                href={`/runs/${run.id}`}
                className="flex items-center gap-3 p-3 rounded-lg hover:bg-bg-tertiary transition-colors group"
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
                  <Icon className={`w-4 h-4 ${config.iconClass}`} />
                </div>

                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2">
                    <span className="text-sm font-medium text-text-primary truncate">
                      {run.agentName || run.agentId}
                    </span>
                    {run.model && (
                      <span className="text-xs text-text-muted truncate">
                        {run.model}
                      </span>
                    )}
                  </div>
                  <p className="text-xs text-text-secondary truncate">
                    {run.input.slice(0, 60)}
                    {run.input.length > 60 ? '...' : ''}
                  </p>
                </div>

                <div className="flex items-center gap-3 text-right">
                  <div className="hidden sm:block">
                    <p className="text-xs text-text-secondary">
                      {run.totalTokens.toLocaleString()} tokens
                    </p>
                    <p className="text-xs text-text-muted">
                      ${run.cost.toFixed(4)}
                    </p>
                  </div>
                  <div>
                    <Badge variant={config.variant} size="sm">
                      {config.label}
                    </Badge>
                    <p className="text-xs text-text-muted mt-1">
                      {formatDistanceToNow(new Date(run.startedAt), {
                        addSuffix: true,
                      })}
                    </p>
                  </div>
                </div>
              </Link>
            );
          })}
        </div>
      )}
    </Card>
  );
}
