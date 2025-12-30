'use client';

import { useState, useEffect } from 'react';
import { Node } from '@xyflow/react';
import { Card } from '@/components/ui/Card';
import { Button } from '@/components/ui/Button';
import { Input } from '@/components/ui/Input';
import { X, Trash2, Bot, Wrench, Code, User, Clock } from 'lucide-react';

interface NodeConfigModalProps {
  isOpen: boolean;
  onClose: () => void;
  node: Node;
  onSave: (nodeId: string, config: Record<string, unknown>) => void;
  onDelete: () => void;
}

interface AgentOption {
  id: string;
  name: string;
  model: string;
}

interface ToolOption {
  name: string;
  description: string;
}

const nodeTypeConfig = {
  agent: { icon: Bot, label: 'Agent Node', color: '#3b82f6' },
  tool: { icon: Wrench, label: 'Tool Node', color: '#10b981' },
  function: { icon: Code, label: 'Function Node', color: '#8b5cf6' },
  human: { icon: User, label: 'Human Approval', color: '#f59e0b' },
  delay: { icon: Clock, label: 'Delay Node', color: '#6b7280' },
};

export function NodeConfigModal({
  isOpen,
  onClose,
  node,
  onSave,
  onDelete,
}: NodeConfigModalProps) {
  const [label, setLabel] = useState('');
  const [config, setConfig] = useState<Record<string, unknown>>({});
  const [agents, setAgents] = useState<AgentOption[]>([]);
  const [tools, setTools] = useState<ToolOption[]>([]);
  const [loading, setLoading] = useState(false);

  const nodeType = node?.data?.nodeType as string;
  const typeConfig = nodeTypeConfig[nodeType as keyof typeof nodeTypeConfig];
  const Icon = typeConfig?.icon || Bot;

  useEffect(() => {
    if (isOpen && node) {
      setLabel(node.data.label as string);
      setConfig((node.data.config as Record<string, unknown>) || {});

      if (nodeType === 'agent') {
        fetch('/api/agents')
          .then((res) => res.json())
          .then(setAgents)
          .catch(console.error);
      }

      if (nodeType === 'tool') {
        fetch('/api/tools')
          .then((res) => res.json())
          .then(setTools)
          .catch(console.error);
      }
    }
  }, [isOpen, node, nodeType]);

  const handleSave = () => {
    setLoading(true);
    onSave(node.id, { ...config, label });
    setLoading(false);
  };

  if (!isOpen) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center">
      <div
        className="absolute inset-0 bg-black/50 backdrop-blur-sm"
        onClick={onClose}
      />

      <Card className="relative w-full max-w-lg mx-4 z-10 animate-fade-in max-h-[80vh] overflow-y-auto">
        <div className="flex items-center justify-between mb-6">
          <div className="flex items-center gap-3">
            <div
              className="p-2 rounded-lg"
              style={{ backgroundColor: `${typeConfig?.color}20` }}
            >
              <Icon className="w-5 h-5" style={{ color: typeConfig?.color }} />
            </div>
            <h2 className="text-lg font-semibold text-text-primary">
              {typeConfig?.label || 'Configure Node'}
            </h2>
          </div>
          <button
            onClick={onClose}
            className="p-1 rounded-lg hover:bg-bg-hover transition-colors"
          >
            <X className="w-5 h-5 text-text-muted" />
          </button>
        </div>

        <div className="space-y-4">
          {/* Label */}
          <div>
            <label className="block text-sm text-text-secondary mb-1">Label</label>
            <Input
              value={label}
              onChange={(e) => setLabel(e.target.value)}
              placeholder="Node label"
            />
          </div>

          {/* Agent-specific config */}
          {nodeType === 'agent' && (
            <>
              <div>
                <label className="block text-sm text-text-secondary mb-1">
                  Select Agent
                </label>
                <select
                  value={(config.agentId as string) || ''}
                  onChange={(e) =>
                    setConfig({ ...config, agentId: e.target.value })
                  }
                  className="w-full px-3 py-2 bg-bg-elevated border border-border-primary rounded-lg text-text-primary focus:outline-none focus:ring-2 focus:ring-accent/50"
                >
                  <option value="">Select an agent...</option>
                  {agents.map((agent) => (
                    <option key={agent.id} value={agent.id}>
                      {agent.name} ({agent.model})
                    </option>
                  ))}
                </select>
              </div>

              <div>
                <label className="block text-sm text-text-secondary mb-1">
                  Input Mapping
                </label>
                <Input
                  value={(config.inputMapping as string) || ''}
                  onChange={(e) =>
                    setConfig({ ...config, inputMapping: e.target.value })
                  }
                  placeholder="e.g., {{ state.previousOutput }}"
                />
                <p className="text-xs text-text-muted mt-1">
                  Template for agent input from workflow state
                </p>
              </div>
            </>
          )}

          {/* Tool-specific config */}
          {nodeType === 'tool' && (
            <>
              <div>
                <label className="block text-sm text-text-secondary mb-1">
                  Select Tool
                </label>
                <select
                  value={(config.toolName as string) || ''}
                  onChange={(e) =>
                    setConfig({ ...config, toolName: e.target.value })
                  }
                  className="w-full px-3 py-2 bg-bg-elevated border border-border-primary rounded-lg text-text-primary focus:outline-none focus:ring-2 focus:ring-accent/50"
                >
                  <option value="">Select a tool...</option>
                  {tools.map((tool) => (
                    <option key={tool.name} value={tool.name}>
                      {tool.name}
                    </option>
                  ))}
                </select>
              </div>

              <div>
                <label className="block text-sm text-text-secondary mb-1">
                  Arguments (JSON)
                </label>
                <textarea
                  value={(config.arguments as string) || '{}'}
                  onChange={(e) =>
                    setConfig({ ...config, arguments: e.target.value })
                  }
                  placeholder='{"param": "value"}'
                  rows={3}
                  className="w-full px-3 py-2 bg-bg-elevated border border-border-primary rounded-lg text-text-primary placeholder:text-text-muted focus:outline-none focus:ring-2 focus:ring-accent/50 resize-none font-mono text-sm"
                />
              </div>
            </>
          )}

          {/* Function-specific config */}
          {nodeType === 'function' && (
            <div>
              <label className="block text-sm text-text-secondary mb-1">
                Function Code
              </label>
              <textarea
                value={(config.code as string) || ''}
                onChange={(e) => setConfig({ ...config, code: e.target.value })}
                placeholder="return { result: state.input * 2 };"
                rows={6}
                className="w-full px-3 py-2 bg-bg-elevated border border-border-primary rounded-lg text-text-primary placeholder:text-text-muted focus:outline-none focus:ring-2 focus:ring-accent/50 resize-none font-mono text-sm"
              />
              <p className="text-xs text-text-muted mt-1">
                JavaScript function body. Access state via `state` variable.
              </p>
            </div>
          )}

          {/* Human approval config */}
          {nodeType === 'human' && (
            <>
              <div>
                <label className="block text-sm text-text-secondary mb-1">
                  Approval Message
                </label>
                <textarea
                  value={(config.message as string) || ''}
                  onChange={(e) =>
                    setConfig({ ...config, message: e.target.value })
                  }
                  placeholder="Please review and approve..."
                  rows={3}
                  className="w-full px-3 py-2 bg-bg-elevated border border-border-primary rounded-lg text-text-primary placeholder:text-text-muted focus:outline-none focus:ring-2 focus:ring-accent/50 resize-none"
                />
              </div>

              <div>
                <label className="block text-sm text-text-secondary mb-1">
                  Timeout (seconds)
                </label>
                <Input
                  type="number"
                  value={(config.timeout as number) || 3600}
                  onChange={(e) =>
                    setConfig({ ...config, timeout: parseInt(e.target.value) })
                  }
                  min={60}
                  max={86400}
                />
              </div>
            </>
          )}

          {/* Delay config */}
          {nodeType === 'delay' && (
            <div>
              <label className="block text-sm text-text-secondary mb-1">
                Delay (seconds)
              </label>
              <Input
                type="number"
                value={(config.delay as number) || 5}
                onChange={(e) =>
                  setConfig({ ...config, delay: parseInt(e.target.value) })
                }
                min={1}
                max={86400}
              />
            </div>
          )}

          {/* Output Key */}
          <div>
            <label className="block text-sm text-text-secondary mb-1">
              Output Key
            </label>
            <Input
              value={(config.outputKey as string) || ''}
              onChange={(e) =>
                setConfig({ ...config, outputKey: e.target.value })
              }
              placeholder="e.g., processedData"
            />
            <p className="text-xs text-text-muted mt-1">
              Key to store this node's output in workflow state
            </p>
          </div>
        </div>

        <div className="flex gap-3 pt-6 mt-6 border-t border-border-primary">
          <Button
            type="button"
            variant="danger"
            onClick={onDelete}
            className="gap-1"
          >
            <Trash2 className="w-4 h-4" />
            Delete
          </Button>
          <div className="flex-1" />
          <Button type="button" variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button
            type="button"
            variant="primary"
            onClick={handleSave}
            disabled={loading}
          >
            {loading ? 'Saving...' : 'Save'}
          </Button>
        </div>
      </Card>
    </div>
  );
}

