'use client';

import { useState, useEffect } from 'react';
import { Sidebar } from '@/components/layout/Sidebar';
import { Header } from '@/components/layout/Header';
import { Card } from '@/components/ui/Card';
import { Button } from '@/components/ui/Button';
import { Input } from '@/components/ui/Input';
import { Badge } from '@/components/ui/Badge';
import { Skeleton } from '@/components/ui/Skeleton';
import {
  Plus,
  Search,
  Users,
  Play,
  Settings,
  Trash2,
  Bot,
  MessageSquare,
  Activity,
} from 'lucide-react';
import { CreateSwarmModal } from '@/components/swarms/CreateSwarmModal';
import { SwarmDetailModal } from '@/components/swarms/SwarmDetailModal';

interface Swarm {
  id: string;
  name: string;
  description?: string;
  strategy: string;
  config: Record<string, unknown>;
  agentIds: string[];
  totalRuns: number;
  lastRunAt?: string;
  createdAt: string;
}

interface Agent {
  id: string;
  name: string;
  model: string;
}

const strategyConfig = {
  hierarchical: { label: 'Hierarchical', color: 'bg-blue-500/10 text-blue-400' },
  'round-robin': { label: 'Round Robin', color: 'bg-green-500/10 text-green-400' },
  consensus: { label: 'Consensus', color: 'bg-purple-500/10 text-purple-400' },
  auction: { label: 'Auction', color: 'bg-amber-500/10 text-amber-400' },
  pipeline: { label: 'Pipeline', color: 'bg-cyan-500/10 text-cyan-400' },
  debate: { label: 'Debate', color: 'bg-pink-500/10 text-pink-400' },
};

export default function SwarmsPage() {
  const [swarms, setSwarms] = useState<Swarm[]>([]);
  const [agents, setAgents] = useState<Agent[]>([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState('');
  const [showCreateModal, setShowCreateModal] = useState(false);
  const [selectedSwarm, setSelectedSwarm] = useState<Swarm | null>(null);

  useEffect(() => {
    fetchData();
  }, []);

  const fetchData = async () => {
    try {
      const [swarmsRes, agentsRes] = await Promise.all([
        fetch('/api/swarms'),
        fetch('/api/agents'),
      ]);

      if (swarmsRes.ok) {
        const swarmsData = await swarmsRes.json();
        setSwarms(swarmsData.swarms || []);
      }

      if (agentsRes.ok) {
        const agentsData = await agentsRes.json();
        setAgents(agentsData);
      }
    } catch (error) {
      console.error('Failed to fetch data:', error);
    } finally {
      setLoading(false);
    }
  };

  const deleteSwarm = async (id: string) => {
    if (!confirm('Are you sure you want to delete this swarm?')) return;

    try {
      const response = await fetch(`/api/swarms/${id}`, { method: 'DELETE' });
      if (response.ok) {
        setSwarms(swarms.filter((s) => s.id !== id));
      }
    } catch (error) {
      console.error('Failed to delete swarm:', error);
    }
  };

  const getAgentNames = (agentIds: string[]) => {
    return agentIds
      .map((id) => agents.find((a) => a.id === id)?.name || 'Unknown')
      .slice(0, 3);
  };

  const filteredSwarms = swarms.filter(
    (s) =>
      s.name.toLowerCase().includes(search.toLowerCase()) ||
      s.strategy.toLowerCase().includes(search.toLowerCase())
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
                  Swarms
                </h1>
                <p className="text-text-secondary mt-1">
                  Multi-agent coordination and collaboration
                </p>
              </div>
              <Button
                variant="primary"
                className="gap-2"
                onClick={() => setShowCreateModal(true)}
              >
                <Plus className="w-4 h-4" />
                New Swarm
              </Button>
            </div>

            {/* Search */}
            <div className="animate-fade-in" style={{ animationDelay: '100ms' }}>
              <Input
                placeholder="Search swarms..."
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                icon={<Search className="w-4 h-4" />}
                className="max-w-md"
              />
            </div>

            {/* Swarms Grid */}
            {loading ? (
              <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
                {[...Array(6)].map((_, i) => (
                  <Card key={i}>
                    <Skeleton className="h-6 w-32 mb-2" />
                    <Skeleton className="h-4 w-48 mb-4" />
                    <Skeleton className="h-20" />
                  </Card>
                ))}
              </div>
            ) : filteredSwarms.length === 0 ? (
              <Card className="py-12 text-center">
                <Users className="w-12 h-12 mx-auto mb-4 text-text-muted opacity-50" />
                <h3 className="text-lg font-medium text-text-primary mb-2">
                  {search ? 'No swarms found' : 'No swarms yet'}
                </h3>
                <p className="text-text-secondary mb-4">
                  {search
                    ? 'Try a different search term'
                    : 'Create a swarm to coordinate multiple agents'}
                </p>
                {!search && (
                  <Button
                    variant="primary"
                    className="gap-2"
                    onClick={() => setShowCreateModal(true)}
                  >
                    <Plus className="w-4 h-4" />
                    Create Swarm
                  </Button>
                )}
              </Card>
            ) : (
              <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
                {filteredSwarms.map((swarm, index) => {
                  const strategy =
                    strategyConfig[swarm.strategy as keyof typeof strategyConfig] ||
                    strategyConfig.hierarchical;
                  const agentNames = getAgentNames(swarm.agentIds);

                  return (
                    <Card
                      key={swarm.id}
                      className="animate-fade-in hover:border-accent/50 transition-colors cursor-pointer"
                      style={{ animationDelay: `${(index + 2) * 50}ms` }}
                      onClick={() => setSelectedSwarm(swarm)}
                    >
                      <div className="flex items-start justify-between mb-4">
                        <div className="flex items-center gap-3">
                          <div className="p-2 bg-accent/10 rounded-lg">
                            <Users className="w-5 h-5 text-accent" />
                          </div>
                          <div>
                            <h3 className="font-medium text-text-primary">
                              {swarm.name}
                            </h3>
                            <Badge
                              variant="outline"
                              size="sm"
                              className={strategy.color}
                            >
                              {strategy.label}
                            </Badge>
                          </div>
                        </div>
                        <div className="flex gap-1">
                          <button
                            onClick={(e) => {
                              e.stopPropagation();
                              deleteSwarm(swarm.id);
                            }}
                            className="p-1.5 rounded-lg hover:bg-error/10 text-text-muted hover:text-error transition-colors"
                          >
                            <Trash2 className="w-4 h-4" />
                          </button>
                        </div>
                      </div>

                      {swarm.description && (
                        <p className="text-sm text-text-secondary mb-4 line-clamp-2">
                          {swarm.description}
                        </p>
                      )}

                      {/* Agents */}
                      <div className="mb-4">
                        <div className="flex items-center gap-2 text-xs text-text-muted mb-2">
                          <Bot className="w-3 h-3" />
                          <span>Agents ({swarm.agentIds.length})</span>
                        </div>
                        <div className="flex flex-wrap gap-1">
                          {agentNames.map((name, i) => (
                            <Badge key={i} variant="outline" size="sm">
                              {name}
                            </Badge>
                          ))}
                          {swarm.agentIds.length > 3 && (
                            <Badge variant="outline" size="sm">
                              +{swarm.agentIds.length - 3}
                            </Badge>
                          )}
                        </div>
                      </div>

                      {/* Stats */}
                      <div className="flex items-center gap-4 pt-4 border-t border-border-subtle">
                        <div className="flex items-center gap-1 text-xs text-text-muted">
                          <Activity className="w-3 h-3" />
                          <span>{swarm.totalRuns} runs</span>
                        </div>
                      </div>
                    </Card>
                  );
                })}
              </div>
            )}
          </div>
        </main>
      </div>

      <CreateSwarmModal
        isOpen={showCreateModal}
        onClose={() => setShowCreateModal(false)}
        onCreated={() => {
          fetchData();
          setShowCreateModal(false);
        }}
        agents={agents}
      />

      {selectedSwarm && (
        <SwarmDetailModal
          isOpen={!!selectedSwarm}
          onClose={() => setSelectedSwarm(null)}
          swarm={selectedSwarm}
          agents={agents}
          onUpdated={fetchData}
        />
      )}
    </div>
  );
}
