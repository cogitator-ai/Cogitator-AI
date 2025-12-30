'use client';

import { useEffect, useState } from 'react';
import { Card } from '@/components/ui/Card';
import { Badge } from '@/components/ui/Badge';
import { Skeleton } from '@/components/ui/Skeleton';
import { Bot, Circle } from 'lucide-react';
import Link from 'next/link';

interface Agent {
  id: string;
  name: string;
  model: string;
  status: 'online' | 'offline' | 'busy';
  totalRuns: number;
  lastRunAt: string | null;
}

const statusConfig = {
  online: { label: 'Online', color: 'bg-success', variant: 'success' as const },
  busy: { label: 'Busy', color: 'bg-warning', variant: 'warning' as const },
  offline: { label: 'Offline', color: 'bg-text-muted', variant: 'outline' as const },
};

export function ActiveAgents() {
  const [agents, setAgents] = useState<Agent[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    async function fetchAgents() {
      try {
        const response = await fetch('/api/agents');
        if (response.ok) {
          const data = await response.json();
          setAgents(data);
        }
      } catch (error) {
        console.error('Failed to fetch agents:', error);
      } finally {
        setLoading(false);
      }
    }

    fetchAgents();
    const interval = setInterval(fetchAgents, 15000);
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
          {[...Array(3)].map((_, i) => (
            <div key={i} className="flex items-center gap-3 p-2">
              <Skeleton className="h-8 w-8 rounded-full" />
              <div className="flex-1 space-y-1">
                <Skeleton className="h-4 w-24" />
                <Skeleton className="h-3 w-16" />
              </div>
              <Skeleton className="h-5 w-14" />
            </div>
          ))}
        </div>
      </Card>
    );
  }

  const activeAgents = agents.filter((a) => a.status !== 'offline');
  const displayAgents = activeAgents.length > 0 ? activeAgents : agents.slice(0, 5);

  return (
    <Card>
      <div className="flex items-center justify-between mb-4">
        <h3 className="text-lg font-medium text-text-primary">Agents</h3>
        <Link
          href="/agents"
          className="text-sm text-accent hover:text-accent-hover transition-colors"
        >
          View all
        </Link>
      </div>

      {agents.length === 0 ? (
        <div className="py-6 text-center text-text-muted">
          <Bot className="w-8 h-8 mx-auto mb-2 opacity-50" />
          <p>No agents configured</p>
          <p className="text-sm">Create an agent to get started</p>
        </div>
      ) : (
        <div className="space-y-2">
          {displayAgents.map((agent) => {
            const config = statusConfig[agent.status as keyof typeof statusConfig] || statusConfig.offline;

            return (
              <Link
                key={agent.id}
                href={`/agents/${agent.id}`}
                className="flex items-center gap-3 p-2 rounded-lg hover:bg-bg-tertiary transition-colors"
              >
                <div className="relative">
                  <div className="w-8 h-8 rounded-full bg-accent/10 flex items-center justify-center">
                    <Bot className="w-4 h-4 text-accent" />
                  </div>
                  <Circle
                    className={`absolute -bottom-0.5 -right-0.5 w-3 h-3 ${config.color} rounded-full fill-current`}
                  />
                </div>

                <div className="flex-1 min-w-0">
                  <p className="text-sm font-medium text-text-primary truncate">
                    {agent.name}
                  </p>
                  <p className="text-xs text-text-muted truncate">{agent.model}</p>
                </div>

                <Badge variant={config.variant} size="sm">
                  {config.label}
                </Badge>
              </Link>
            );
          })}
        </div>
      )}
    </Card>
  );
}
