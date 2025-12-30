'use client';

import { useState } from 'react';
import { Card } from '@/components/ui/Card';
import { Button } from '@/components/ui/Button';
import { Input } from '@/components/ui/Input';
import { Badge } from '@/components/ui/Badge';
import { X, Users, Bot, CheckCircle } from 'lucide-react';

interface Agent {
  id: string;
  name: string;
  model: string;
}

interface CreateSwarmModalProps {
  isOpen: boolean;
  onClose: () => void;
  onCreated: () => void;
  agents: Agent[];
}

const STRATEGIES = [
  {
    id: 'hierarchical',
    name: 'Hierarchical',
    description: 'One leader agent coordinates others',
  },
  {
    id: 'round-robin',
    name: 'Round Robin',
    description: 'Tasks distributed in rotation',
  },
  {
    id: 'consensus',
    name: 'Consensus',
    description: 'Agents vote on decisions',
  },
  {
    id: 'auction',
    name: 'Auction',
    description: 'Agents bid for tasks based on capability',
  },
  {
    id: 'pipeline',
    name: 'Pipeline',
    description: 'Sequential processing through agents',
  },
  {
    id: 'debate',
    name: 'Debate',
    description: 'Agents argue perspectives to reach conclusion',
  },
];

export function CreateSwarmModal({
  isOpen,
  onClose,
  onCreated,
  agents,
}: CreateSwarmModalProps) {
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [strategy, setStrategy] = useState('hierarchical');
  const [selectedAgents, setSelectedAgents] = useState<string[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const toggleAgent = (agentId: string) => {
    setSelectedAgents((prev) =>
      prev.includes(agentId)
        ? prev.filter((id) => id !== agentId)
        : [...prev, agentId]
    );
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();

    if (!name.trim()) {
      setError('Name is required');
      return;
    }

    if (selectedAgents.length < 2) {
      setError('Select at least 2 agents');
      return;
    }

    setLoading(true);
    setError(null);

    try {
      const response = await fetch('/api/swarms', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: name.trim(),
          description: description.trim() || undefined,
          strategy,
          agentIds: selectedAgents,
          config: {
            maxIterations: 10,
            timeout: 300000,
          },
        }),
      });

      if (!response.ok) {
        const data = await response.json();
        throw new Error(data.error || 'Failed to create swarm');
      }

      setName('');
      setDescription('');
      setStrategy('hierarchical');
      setSelectedAgents([]);
      onCreated();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to create swarm');
    } finally {
      setLoading(false);
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
            <h2 className="text-lg font-semibold text-text-primary">
              Create Swarm
            </h2>
          </div>
          <button
            onClick={onClose}
            className="p-1 rounded-lg hover:bg-bg-hover transition-colors"
          >
            <X className="w-5 h-5 text-text-muted" />
          </button>
        </div>

        <form onSubmit={handleSubmit} className="space-y-6">
          {error && (
            <div className="p-3 bg-error/10 border border-error/20 rounded-lg text-error text-sm">
              {error}
            </div>
          )}

          {/* Basic Info */}
          <div className="space-y-4">
            <div>
              <label className="block text-sm text-text-secondary mb-1">
                Name *
              </label>
              <Input
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="My Swarm"
                required
              />
            </div>

            <div>
              <label className="block text-sm text-text-secondary mb-1">
                Description
              </label>
              <textarea
                value={description}
                onChange={(e) => setDescription(e.target.value)}
                placeholder="What does this swarm do?"
                rows={2}
                className="w-full px-3 py-2 bg-bg-elevated border border-border-primary rounded-lg text-text-primary placeholder:text-text-muted focus:outline-none focus:ring-2 focus:ring-accent/50 resize-none"
              />
            </div>
          </div>

          {/* Strategy */}
          <div>
            <label className="block text-sm text-text-secondary mb-2">
              Strategy *
            </label>
            <div className="grid grid-cols-2 gap-2">
              {STRATEGIES.map((s) => (
                <button
                  key={s.id}
                  type="button"
                  onClick={() => setStrategy(s.id)}
                  className={`p-3 rounded-lg border text-left transition-colors ${
                    strategy === s.id
                      ? 'border-accent bg-accent/10'
                      : 'border-border-primary bg-bg-tertiary hover:border-border-secondary'
                  }`}
                >
                  <div className="font-medium text-sm text-text-primary">
                    {s.name}
                  </div>
                  <p className="text-xs text-text-muted mt-0.5">
                    {s.description}
                  </p>
                </button>
              ))}
            </div>
          </div>

          {/* Agents */}
          <div>
            <label className="block text-sm text-text-secondary mb-2">
              Select Agents * (min 2)
            </label>
            {agents.length === 0 ? (
              <div className="p-4 bg-bg-tertiary rounded-lg text-center text-text-muted">
                <Bot className="w-8 h-8 mx-auto mb-2 opacity-50" />
                <p className="text-sm">No agents available</p>
                <p className="text-xs mt-1">Create agents first</p>
              </div>
            ) : (
              <div className="grid grid-cols-2 gap-2 max-h-48 overflow-y-auto">
                {agents.map((agent) => (
                  <button
                    key={agent.id}
                    type="button"
                    onClick={() => toggleAgent(agent.id)}
                    className={`p-3 rounded-lg border text-left transition-colors ${
                      selectedAgents.includes(agent.id)
                        ? 'border-accent bg-accent/10'
                        : 'border-border-primary bg-bg-tertiary hover:border-border-secondary'
                    }`}
                  >
                    <div className="flex items-center justify-between">
                      <div className="flex items-center gap-2">
                        <Bot className="w-4 h-4 text-accent" />
                        <span className="font-medium text-sm text-text-primary truncate">
                          {agent.name}
                        </span>
                      </div>
                      {selectedAgents.includes(agent.id) && (
                        <CheckCircle className="w-4 h-4 text-accent" />
                      )}
                    </div>
                    <p className="text-xs text-text-muted mt-1 truncate">
                      {agent.model}
                    </p>
                  </button>
                ))}
              </div>
            )}
            {selectedAgents.length > 0 && (
              <p className="text-xs text-text-muted mt-2">
                {selectedAgents.length} agent{selectedAgents.length !== 1 ? 's' : ''}{' '}
                selected
              </p>
            )}
          </div>

          <div className="flex gap-3 pt-4 border-t border-border-primary">
            <Button type="button" variant="ghost" onClick={onClose} className="flex-1">
              Cancel
            </Button>
            <Button
              type="submit"
              variant="primary"
              disabled={loading || !name.trim() || selectedAgents.length < 2}
              className="flex-1"
            >
              {loading ? 'Creating...' : 'Create Swarm'}
            </Button>
          </div>
        </form>
      </Card>
    </div>
  );
}

