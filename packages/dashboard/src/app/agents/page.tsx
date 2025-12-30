'use client';

import { useEffect, useState, useCallback } from 'react';
import { Sidebar } from '@/components/layout/Sidebar';
import { Header } from '@/components/layout/Header';
import { Card } from '@/components/ui/Card';
import { Badge } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import { Input } from '@/components/ui/Input';
import { Skeleton } from '@/components/ui/Skeleton';
import { CreateAgentModal } from '@/components/agents/CreateAgentModal';
import { Bot, Plus, Search, Activity, Zap, DollarSign } from 'lucide-react';
import Link from 'next/link';
import { formatDistanceToNow } from 'date-fns';

interface Agent {
  id: string;
  name: string;
  model: string;
  status: 'online' | 'offline' | 'busy';
  totalRuns: number;
  totalTokens: number;
  totalCost: number;
  lastRunAt: string | null;
  createdAt: string;
}

const statusConfig = {
  online: { variant: 'success' as const, label: 'Online' },
  busy: { variant: 'warning' as const, label: 'Busy' },
  offline: { variant: 'outline' as const, label: 'Offline' },
};

export default function AgentsPage() {
  const [agents, setAgents] = useState<Agent[]>([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState('');
  const [showCreateModal, setShowCreateModal] = useState(false);

  const fetchAgents = useCallback(async () => {
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
  }, []);

  useEffect(() => {
    fetchAgents();
  }, [fetchAgents]);

  const filteredAgents = agents.filter(
    (agent) =>
      agent.name.toLowerCase().includes(search.toLowerCase()) ||
      agent.model.toLowerCase().includes(search.toLowerCase())
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
                  Agents
                </h1>
                <p className="text-text-secondary mt-1">
                  Manage and monitor your AI agents
                </p>
              </div>
              <Button
                variant="primary"
                className="gap-2"
                onClick={() => setShowCreateModal(true)}
              >
                <Plus className="w-4 h-4" />
                New Agent
              </Button>
            </div>

            {/* Search */}
            <div className="animate-fade-in" style={{ animationDelay: '100ms' }}>
              <Input
                placeholder="Search agents..."
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                icon={<Search className="w-4 h-4" />}
                className="max-w-md"
              />
            </div>

            {/* Agents Grid */}
            {loading ? (
              <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
                {[...Array(6)].map((_, i) => (
                  <Card key={i}>
                    <div className="flex items-start gap-4">
                      <Skeleton className="h-12 w-12 rounded-xl" />
                      <div className="flex-1 space-y-2">
                        <Skeleton className="h-5 w-32" />
                        <Skeleton className="h-4 w-24" />
                      </div>
                    </div>
                    <div className="mt-4 grid grid-cols-3 gap-4">
                      <Skeleton className="h-12" />
                      <Skeleton className="h-12" />
                      <Skeleton className="h-12" />
                    </div>
                  </Card>
                ))}
              </div>
            ) : filteredAgents.length === 0 ? (
              <Card className="py-12 text-center">
                <Bot className="w-12 h-12 mx-auto mb-4 text-text-muted opacity-50" />
                <h3 className="text-lg font-medium text-text-primary mb-2">
                  {search ? 'No agents found' : 'No agents yet'}
                </h3>
                <p className="text-text-secondary mb-4">
                  {search
                    ? 'Try a different search term'
                    : 'Create your first agent to get started'}
                </p>
                {!search && (
                  <Button
                    variant="primary"
                    className="gap-2"
                    onClick={() => setShowCreateModal(true)}
                  >
                    <Plus className="w-4 h-4" />
                    Create Agent
                  </Button>
                )}
              </Card>
            ) : (
              <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
                {filteredAgents.map((agent, index) => {
                  const config = statusConfig[agent.status as keyof typeof statusConfig] || statusConfig.offline;

                  return (
                    <Link
                      key={agent.id}
                      href={`/agents/${agent.id}`}
                      className="animate-fade-in"
                      style={{ animationDelay: `${(index + 2) * 50}ms` }}
                    >
                      <Card className="h-full hover:border-accent/50 transition-colors">
                        <div className="flex items-start gap-4">
                          <div className="p-3 bg-accent/10 rounded-xl">
                            <Bot className="w-6 h-6 text-accent" />
                          </div>
                          <div className="flex-1 min-w-0">
                            <div className="flex items-center gap-2">
                              <h3 className="font-medium text-text-primary truncate">
                                {agent.name}
                              </h3>
                              <Badge variant={config.variant} size="sm">
                                {config.label}
                              </Badge>
                            </div>
                            <p className="text-sm text-text-secondary truncate">
                              {agent.model}
                            </p>
                          </div>
                        </div>

                        <div className="mt-4 grid grid-cols-3 gap-4">
                          <div className="text-center p-2 bg-bg-tertiary rounded-lg">
                            <Activity className="w-4 h-4 mx-auto text-text-muted mb-1" />
                            <p className="text-sm font-medium text-text-primary">
                              {agent.totalRuns}
                            </p>
                            <p className="text-xs text-text-muted">Runs</p>
                          </div>
                          <div className="text-center p-2 bg-bg-tertiary rounded-lg">
                            <Zap className="w-4 h-4 mx-auto text-text-muted mb-1" />
                            <p className="text-sm font-medium text-text-primary">
                              {formatNumber(agent.totalTokens)}
                            </p>
                            <p className="text-xs text-text-muted">Tokens</p>
                          </div>
                          <div className="text-center p-2 bg-bg-tertiary rounded-lg">
                            <DollarSign className="w-4 h-4 mx-auto text-text-muted mb-1" />
                            <p className="text-sm font-medium text-text-primary">
                              ${agent.totalCost.toFixed(2)}
                            </p>
                            <p className="text-xs text-text-muted">Cost</p>
                          </div>
                        </div>

                        {agent.lastRunAt && (
                          <p className="mt-3 text-xs text-text-muted text-center">
                            Last run{' '}
                            {formatDistanceToNow(new Date(agent.lastRunAt), {
                              addSuffix: true,
                            })}
                          </p>
                        )}
                      </Card>
                    </Link>
                  );
                })}
              </div>
            )}
          </div>
        </main>
      </div>

      <CreateAgentModal
        isOpen={showCreateModal}
        onClose={() => setShowCreateModal(false)}
        onCreated={fetchAgents}
      />
    </div>
  );
}

function formatNumber(num: number): string {
  if (num >= 1000000) return `${(num / 1000000).toFixed(1)}M`;
  if (num >= 1000) return `${(num / 1000).toFixed(1)}K`;
  return num.toString();
}
