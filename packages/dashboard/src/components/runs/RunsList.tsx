'use client';

import { useState, useEffect, useMemo } from 'react';
import Link from 'next/link';
import { Card } from '@/components/ui/Card';
import { Button } from '@/components/ui/Button';
import { Badge } from '@/components/ui/Badge';
import { Input } from '@/components/ui/Input';
import { cn } from '@/lib/cn';
import { Search, Clock, Zap, Bot, ChevronRight, Play } from 'lucide-react';
import { formatDistanceToNow } from 'date-fns';

interface Run {
  id: string;
  agent_id: string | null;
  status: 'running' | 'completed' | 'failed' | 'cancelled';
  input: string;
  output: string | null;
  total_tokens: number;
  duration: number | null;
  started_at: string;
  completed_at: string | null;
}

interface Agent {
  id: string;
  name: string;
}

type StatusFilter = 'all' | 'running' | 'completed' | 'failed' | 'cancelled';

const statusConfig = {
  running: { variant: 'info' as const, label: 'Running', pulse: true },
  completed: { variant: 'success' as const, label: 'Completed', pulse: false },
  failed: { variant: 'error' as const, label: 'Failed', pulse: false },
  cancelled: { variant: 'warning' as const, label: 'Cancelled', pulse: false },
};

function RunRowSkeleton() {
  return (
    <div className="flex items-center gap-4 px-4 py-4 animate-pulse">
      <div className="w-2 h-2 rounded-full bg-bg-elevated" />
      <div className="flex-1">
        <div className="h-4 w-24 bg-bg-elevated rounded mb-2" />
        <div className="h-3 w-64 bg-bg-elevated rounded" />
      </div>
      <div className="h-4 w-32 bg-bg-elevated rounded" />
      <div className="h-4 w-20 bg-bg-elevated rounded" />
    </div>
  );
}

export function RunsList() {
  const [runs, setRuns] = useState<Run[]>([]);
  const [agents, setAgents] = useState<Map<string, Agent>>(new Map());
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [search, setSearch] = useState('');
  const [statusFilter, setStatusFilter] = useState<StatusFilter>('all');

  useEffect(() => {
    Promise.all([
      fetch('/api/runs').then((res) => res.json()),
      fetch('/api/agents').then((res) => res.json()),
    ])
      .then(([runsData, agentsData]) => {
        setRuns(runsData);
        const agentMap = new Map<string, Agent>();
        for (const agent of agentsData) {
          agentMap.set(agent.id, agent);
        }
        setAgents(agentMap);
        setLoading(false);
      })
      .catch((err) => {
        setError(err.message);
        setLoading(false);
      });
  }, []);

  const filteredRuns = useMemo(() => {
    return runs.filter((run) => {
      if (search && !run.input.toLowerCase().includes(search.toLowerCase())) {
        return false;
      }
      if (statusFilter !== 'all' && run.status !== statusFilter) {
        return false;
      }
      return true;
    });
  }, [runs, search, statusFilter]);

  const runningCount = useMemo(() => {
    return runs.filter((r) => r.status === 'running').length;
  }, [runs]);

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-semibold text-text-primary">Runs</h1>
          <p className="text-text-secondary mt-1">View and analyze agent execution history</p>
        </div>
        {runningCount > 0 && (
          <Badge variant="info" pulse>
            {runningCount} Running
          </Badge>
        )}
      </div>

      <div className="flex items-center gap-4">
        <div className="flex-1 max-w-md">
          <Input
            placeholder="Search runs..."
            icon={<Search className="w-4 h-4" />}
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
        </div>
        <div className="flex items-center gap-2">
          <Button
            variant={statusFilter === 'all' ? 'outline' : 'ghost'}
            size="sm"
            onClick={() => setStatusFilter('all')}
          >
            All
          </Button>
          {Object.entries(statusConfig).map(([status, config]) => (
            <Button
              key={status}
              variant={statusFilter === status ? 'outline' : 'ghost'}
              size="sm"
              onClick={() => setStatusFilter(status as StatusFilter)}
            >
              {config.label}
            </Button>
          ))}
        </div>
      </div>

      {error && (
        <div className="p-4 bg-error/10 border border-error/20 rounded-lg text-error text-sm">
          {error}
        </div>
      )}

      <Card padding="none">
        {loading ? (
          <div className="divide-y divide-border-subtle">
            {[1, 2, 3, 4, 5].map((i) => (
              <RunRowSkeleton key={i} />
            ))}
          </div>
        ) : filteredRuns.length === 0 ? (
          <div className="text-center py-12">
            <Play className="w-12 h-12 text-text-muted mx-auto mb-4" />
            <h3 className="text-lg font-medium text-text-primary mb-2">
              {runs.length === 0 ? 'No runs yet' : 'No runs match your filters'}
            </h3>
            <p className="text-text-secondary">
              {runs.length === 0
                ? 'Run an agent to see execution history here'
                : 'Try adjusting your search or filters'}
            </p>
          </div>
        ) : (
          <div className="divide-y divide-border-subtle">
            {filteredRuns.map((run, index) => {
              const config = statusConfig[run.status] || statusConfig.completed;
              const agent = run.agent_id ? agents.get(run.agent_id) : null;
              return (
                <Link
                  key={run.id}
                  href={`/dashboard/runs/${run.id}`}
                  className="flex items-center gap-4 px-4 py-4 hover:bg-bg-hover transition-colors animate-fade-in"
                  style={{ animationDelay: `${index * 30}ms` }}
                >
                  <div
                    className={cn(
                      'w-2 h-2 rounded-full flex-shrink-0',
                      run.status === 'running' && 'bg-info pulse-live',
                      run.status === 'completed' && 'bg-success',
                      run.status === 'failed' && 'bg-error',
                      run.status === 'cancelled' && 'bg-warning'
                    )}
                  />

                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2 mb-1">
                      <span className="font-medium text-sm text-text-primary font-mono">
                        {run.id.slice(0, 12)}...
                      </span>
                      <Badge variant={config.variant} size="sm" pulse={config.pulse}>
                        {config.label}
                      </Badge>
                    </div>
                    <p className="text-sm text-text-secondary truncate">{run.input}</p>
                  </div>

                  {agent && (
                    <div className="flex items-center gap-2 text-sm text-text-tertiary">
                      <Bot className="w-4 h-4" />
                      <span>{agent.name}</span>
                    </div>
                  )}

                  <div className="flex items-center gap-6 text-xs text-text-tertiary">
                    {run.duration && (
                      <div className="flex items-center gap-1.5">
                        <Clock className="w-3.5 h-3.5" />
                        <span>{(run.duration / 1000).toFixed(1)}s</span>
                      </div>
                    )}
                    <div className="flex items-center gap-1.5">
                      <Zap className="w-3.5 h-3.5" />
                      <span>{run.total_tokens.toLocaleString()}</span>
                    </div>
                    <span className="text-text-muted w-24 text-right">
                      {formatDistanceToNow(new Date(run.started_at), { addSuffix: true })}
                    </span>
                  </div>

                  <ChevronRight className="w-4 h-4 text-text-muted" />
                </Link>
              );
            })}
          </div>
        )}
      </Card>
    </div>
  );
}
