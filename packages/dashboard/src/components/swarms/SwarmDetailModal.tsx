'use client';

import { useState } from 'react';
import { Card } from '@/components/ui/Card';
import { Button } from '@/components/ui/Button';
import { Badge } from '@/components/ui/Badge';
import {
  X,
  Users,
  Play,
  Bot,
  MessageSquare,
  Activity,
  Clock,
} from 'lucide-react';

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

interface SwarmDetailModalProps {
  isOpen: boolean;
  onClose: () => void;
  swarm: Swarm;
  agents: Agent[];
  onUpdated: () => void;
}

const strategyConfig = {
  hierarchical: { label: 'Hierarchical', color: 'bg-blue-500/10 text-blue-400' },
  'round-robin': { label: 'Round Robin', color: 'bg-green-500/10 text-green-400' },
  consensus: { label: 'Consensus', color: 'bg-purple-500/10 text-purple-400' },
  auction: { label: 'Auction', color: 'bg-amber-500/10 text-amber-400' },
  pipeline: { label: 'Pipeline', color: 'bg-cyan-500/10 text-cyan-400' },
  debate: { label: 'Debate', color: 'bg-pink-500/10 text-pink-400' },
};

export function SwarmDetailModal({
  isOpen,
  onClose,
  swarm,
  agents,
  onUpdated,
}: SwarmDetailModalProps) {
  const [running, setRunning] = useState(false);
  const [input, setInput] = useState('');
  const [output, setOutput] = useState<string | null>(null);

  const strategy =
    strategyConfig[swarm.strategy as keyof typeof strategyConfig] ||
    strategyConfig.hierarchical;

  const swarmAgents = agents.filter((a) => swarm.agentIds.includes(a.id));

  const runSwarm = async () => {
    if (!input.trim()) return;

    setRunning(true);
    setOutput(null);

    try {
      const response = await fetch(`/api/swarms/${swarm.id}/run`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ input: input.trim() }),
      });

      if (response.ok) {
        const result = await response.json();
        setOutput(result.output || JSON.stringify(result, null, 2));
        onUpdated();
      } else {
        const error = await response.json();
        setOutput(`Error: ${error.error || 'Run failed'}`);
      }
    } catch (error) {
      setOutput(`Error: ${error instanceof Error ? error.message : 'Run failed'}`);
    } finally {
      setRunning(false);
    }
  };

  if (!isOpen) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center">
      <div
        className="absolute inset-0 bg-black/50 backdrop-blur-sm"
        onClick={onClose}
      />

      <Card className="relative w-full max-w-2xl mx-4 z-10 animate-fade-in max-h-[90vh] overflow-y-auto">
        <div className="flex items-center justify-between mb-6">
          <div className="flex items-center gap-3">
            <div className="p-2 bg-accent/10 rounded-lg">
              <Users className="w-5 h-5 text-accent" />
            </div>
            <div>
              <h2 className="text-lg font-semibold text-text-primary">
                {swarm.name}
              </h2>
              <Badge variant="outline" size="sm" className={strategy.color}>
                {strategy.label}
              </Badge>
            </div>
          </div>
          <button
            onClick={onClose}
            className="p-1 rounded-lg hover:bg-bg-hover transition-colors"
          >
            <X className="w-5 h-5 text-text-muted" />
          </button>
        </div>

        {swarm.description && (
          <p className="text-text-secondary mb-6">{swarm.description}</p>
        )}

        {/* Agents */}
        <div className="mb-6">
          <h3 className="text-sm font-medium text-text-secondary mb-3 flex items-center gap-2">
            <Bot className="w-4 h-4" />
            Agents ({swarmAgents.length})
          </h3>
          <div className="grid grid-cols-2 gap-2">
            {swarmAgents.map((agent) => (
              <div
                key={agent.id}
                className="p-3 bg-bg-tertiary rounded-lg border border-border-primary"
              >
                <div className="flex items-center gap-2">
                  <Bot className="w-4 h-4 text-accent" />
                  <span className="font-medium text-text-primary">
                    {agent.name}
                  </span>
                </div>
                <p className="text-xs text-text-muted mt-1">{agent.model}</p>
              </div>
            ))}
          </div>
        </div>

        {/* Stats */}
        <div className="grid grid-cols-2 gap-4 mb-6">
          <div className="p-3 bg-bg-tertiary rounded-lg">
            <div className="flex items-center gap-2 text-text-muted mb-1">
              <Activity className="w-4 h-4" />
              <span className="text-sm">Total Runs</span>
            </div>
            <p className="text-2xl font-semibold text-text-primary">
              {swarm.totalRuns}
            </p>
          </div>
          <div className="p-3 bg-bg-tertiary rounded-lg">
            <div className="flex items-center gap-2 text-text-muted mb-1">
              <Clock className="w-4 h-4" />
              <span className="text-sm">Last Run</span>
            </div>
            <p className="text-sm text-text-primary">
              {swarm.lastRunAt
                ? new Date(swarm.lastRunAt).toLocaleString()
                : 'Never'}
            </p>
          </div>
        </div>

        {/* Run Swarm */}
        <div className="space-y-4 p-4 bg-bg-tertiary rounded-lg">
          <h3 className="text-sm font-medium text-text-secondary flex items-center gap-2">
            <Play className="w-4 h-4" />
            Run Swarm
          </h3>

          <textarea
            value={input}
            onChange={(e) => setInput(e.target.value)}
            placeholder="Enter input for the swarm..."
            rows={3}
            className="w-full px-3 py-2 bg-bg-elevated border border-border-primary rounded-lg text-text-primary placeholder:text-text-muted focus:outline-none focus:ring-2 focus:ring-accent/50 resize-none"
            disabled={running}
          />

          <Button
            variant="primary"
            onClick={runSwarm}
            disabled={running || !input.trim()}
            className="w-full gap-2"
          >
            {running ? (
              <>
                <div className="w-4 h-4 border-2 border-white/30 border-t-white rounded-full animate-spin" />
                Running...
              </>
            ) : (
              <>
                <Play className="w-4 h-4" />
                Run Swarm
              </>
            )}
          </Button>

          {output && (
            <div className="mt-4">
              <h4 className="text-sm font-medium text-text-secondary mb-2">
                Output
              </h4>
              <pre className="p-3 bg-bg-primary rounded-lg text-sm text-text-primary whitespace-pre-wrap overflow-x-auto max-h-64">
                {output}
              </pre>
            </div>
          )}
        </div>

        <div className="flex justify-end pt-6">
          <Button variant="ghost" onClick={onClose}>
            Close
          </Button>
        </div>
      </Card>
    </div>
  );
}

