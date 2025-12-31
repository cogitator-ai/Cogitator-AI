'use client';

import { useState, useEffect, useMemo } from 'react';
import Link from 'next/link';
import { Card } from '@/components/ui/Card';
import { Button } from '@/components/ui/Button';
import { Input } from '@/components/ui/Input';
import { cn } from '@/lib/cn';
import { Bot, Plus, Search, Zap, DollarSign, Activity, MoreVertical, Loader2 } from 'lucide-react';
import { formatDistanceToNow } from 'date-fns';

interface Agent {
  id: string;
  name: string;
  model: string;
  description: string | null;
  total_runs: number;
  total_tokens: number;
  total_cost: number;
  last_run_at: string | null;
}

type StatusFilter = 'all' | 'active' | 'inactive';

function getAgentStatus(agent: Agent): 'online' | 'busy' | 'offline' {
  if (!agent.last_run_at) return 'offline';
  const lastRun = new Date(agent.last_run_at);
  const minutesAgo = (Date.now() - lastRun.getTime()) / 1000 / 60;
  if (minutesAgo < 1) return 'busy';
  if (minutesAgo < 30) return 'online';
  return 'offline';
}

const statusConfig = {
  online: { color: 'bg-success', label: 'Online' },
  busy: { color: 'bg-warning', label: 'Busy' },
  offline: { color: 'bg-text-tertiary', label: 'Offline' },
};

function AgentCardSkeleton() {
  return (
    <Card className="h-full animate-pulse">
      <div className="flex items-start justify-between mb-4">
        <div className="flex items-center gap-3">
          <div className="w-10 h-10 rounded-lg bg-bg-elevated" />
          <div>
            <div className="h-4 w-24 bg-bg-elevated rounded" />
            <div className="h-3 w-16 bg-bg-elevated rounded mt-1" />
          </div>
        </div>
      </div>
      <div className="h-10 bg-bg-elevated rounded mb-4" />
      <div className="grid grid-cols-3 gap-3 pt-4 border-t border-border-subtle">
        {[1, 2, 3].map((i) => (
          <div key={i} className="text-center">
            <div className="h-8 bg-bg-elevated rounded" />
          </div>
        ))}
      </div>
    </Card>
  );
}

export function AgentsList() {
  const [agents, setAgents] = useState<Agent[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [search, setSearch] = useState('');
  const [statusFilter, setStatusFilter] = useState<StatusFilter>('all');

  useEffect(() => {
    fetch('/api/agents')
      .then((res) => {
        if (!res.ok) throw new Error('Failed to fetch agents');
        return res.json();
      })
      .then((data) => {
        setAgents(data);
        setLoading(false);
      })
      .catch((err) => {
        setError(err.message);
        setLoading(false);
      });
  }, []);

  const filteredAgents = useMemo(() => {
    return agents.filter((agent) => {
      if (search && !agent.name.toLowerCase().includes(search.toLowerCase())) {
        return false;
      }
      if (statusFilter !== 'all') {
        const status = getAgentStatus(agent);
        if (statusFilter === 'active' && status === 'offline') return false;
        if (statusFilter === 'inactive' && status !== 'offline') return false;
      }
      return true;
    });
  }, [agents, search, statusFilter]);

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-semibold text-text-primary">Agents</h1>
          <p className="text-text-secondary mt-1">Manage and monitor your AI agents</p>
        </div>
        <Button variant="primary" className="gap-2">
          <Plus className="w-4 h-4" />
          Create Agent
        </Button>
      </div>

      <div className="flex items-center gap-4">
        <div className="flex-1 max-w-md">
          <Input
            placeholder="Search agents..."
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
          <Button
            variant={statusFilter === 'active' ? 'outline' : 'ghost'}
            size="sm"
            onClick={() => setStatusFilter('active')}
          >
            Active
          </Button>
          <Button
            variant={statusFilter === 'inactive' ? 'outline' : 'ghost'}
            size="sm"
            onClick={() => setStatusFilter('inactive')}
          >
            Inactive
          </Button>
        </div>
      </div>

      {error && (
        <div className="p-4 bg-error/10 border border-error/20 rounded-lg text-error text-sm">
          {error}
        </div>
      )}

      {loading ? (
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
          {[1, 2, 3, 4, 5, 6].map((i) => (
            <AgentCardSkeleton key={i} />
          ))}
        </div>
      ) : filteredAgents.length === 0 ? (
        <div className="text-center py-12">
          <Bot className="w-12 h-12 text-text-muted mx-auto mb-4" />
          <h3 className="text-lg font-medium text-text-primary mb-2">
            {agents.length === 0 ? 'No agents yet' : 'No agents match your filters'}
          </h3>
          <p className="text-text-secondary mb-4">
            {agents.length === 0
              ? 'Create your first agent to get started'
              : 'Try adjusting your search or filters'}
          </p>
          {agents.length === 0 && (
            <Button variant="primary" className="gap-2">
              <Plus className="w-4 h-4" />
              Create Agent
            </Button>
          )}
        </div>
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
          {filteredAgents.map((agent, index) => {
            const status = getAgentStatus(agent);
            const config = statusConfig[status];
            return (
              <Link key={agent.id} href={`/dashboard/agents/${agent.id}`}>
                <Card
                  hover
                  className="h-full animate-fade-in"
                  style={{ animationDelay: `${index * 50}ms` }}
                >
                  <div className="flex items-start justify-between mb-4">
                    <div className="flex items-center gap-3">
                      <div
                        className={cn(
                          'w-10 h-10 rounded-lg flex items-center justify-center',
                          status === 'online' && 'bg-success/10',
                          status === 'busy' && 'bg-warning/10',
                          status === 'offline' && 'bg-bg-elevated'
                        )}
                      >
                        <Bot
                          className={cn(
                            'w-5 h-5',
                            status === 'online' && 'text-success',
                            status === 'busy' && 'text-warning',
                            status === 'offline' && 'text-text-tertiary'
                          )}
                        />
                      </div>
                      <div>
                        <h3 className="font-medium text-text-primary">{agent.name}</h3>
                        <p className="text-xs text-text-tertiary">{agent.model}</p>
                      </div>
                    </div>
                    <div className="flex items-center gap-2">
                      <span
                        className={cn(
                          'w-2 h-2 rounded-full',
                          config.color,
                          status === 'busy' && 'animate-pulse'
                        )}
                      />
                      <Button variant="ghost" size="icon" className="h-8 w-8">
                        <MoreVertical className="w-4 h-4" />
                      </Button>
                    </div>
                  </div>

                  <p className="text-sm text-text-secondary mb-4 line-clamp-2">
                    {agent.description || 'No description'}
                  </p>

                  <div className="grid grid-cols-3 gap-3 pt-4 border-t border-border-subtle">
                    <div className="text-center">
                      <div className="flex items-center justify-center gap-1 text-text-tertiary mb-1">
                        <Activity className="w-3.5 h-3.5" />
                      </div>
                      <p className="text-sm font-medium text-text-primary">{agent.total_runs}</p>
                      <p className="text-xs text-text-muted">runs</p>
                    </div>
                    <div className="text-center">
                      <div className="flex items-center justify-center gap-1 text-text-tertiary mb-1">
                        <Zap className="w-3.5 h-3.5" />
                      </div>
                      <p className="text-sm font-medium text-text-primary">
                        {agent.total_tokens >= 1000000
                          ? `${(agent.total_tokens / 1000000).toFixed(1)}M`
                          : agent.total_tokens >= 1000
                            ? `${(agent.total_tokens / 1000).toFixed(0)}K`
                            : agent.total_tokens}
                      </p>
                      <p className="text-xs text-text-muted">tokens</p>
                    </div>
                    <div className="text-center">
                      <div className="flex items-center justify-center gap-1 text-text-tertiary mb-1">
                        <DollarSign className="w-3.5 h-3.5" />
                      </div>
                      <p className="text-sm font-medium text-text-primary">
                        ${Number(agent.total_cost).toFixed(agent.total_cost >= 1 ? 0 : 2)}
                      </p>
                      <p className="text-xs text-text-muted">cost</p>
                    </div>
                  </div>

                  {agent.last_run_at && (
                    <p className="text-xs text-text-muted mt-3 text-center">
                      Last run {formatDistanceToNow(new Date(agent.last_run_at), { addSuffix: true })}
                    </p>
                  )}
                </Card>
              </Link>
            );
          })}
        </div>
      )}
    </div>
  );
}
