'use client';

import { useState, useEffect } from 'react';
import { Card } from '@/components/ui/Card';
import { Button } from '@/components/ui/Button';
import { Input } from '@/components/ui/Input';
import {
  X,
  Bot,
  ChevronDown,
  ChevronUp,
  Wrench,
  Brain,
  Settings2,
  Sparkles,
} from 'lucide-react';

interface CreateAgentModalProps {
  isOpen: boolean;
  onClose: () => void;
  onCreated: () => void;
  initialData?: AgentFormData;
}

interface AgentFormData {
  name: string;
  model: string;
  description: string;
  instructions: string;
  temperature: number;
  topP: number;
  maxTokens: number | null;
  tools: string[];
  memoryEnabled: boolean;
  maxIterations: number;
}

interface ModelOption {
  id: string;
  name: string;
  provider: string;
}

interface ToolOption {
  name: string;
  description: string;
  requiresApproval: boolean;
}

const DEFAULT_FORM_DATA: AgentFormData = {
  name: '',
  model: '',
  description: '',
  instructions: 'You are a helpful assistant.',
  temperature: 0.7,
  topP: 1.0,
  maxTokens: null,
  tools: [],
  memoryEnabled: true,
  maxIterations: 10,
};

export function CreateAgentModal({
  isOpen,
  onClose,
  onCreated,
  initialData,
}: CreateAgentModalProps) {
  const [formData, setFormData] = useState<AgentFormData>(DEFAULT_FORM_DATA);
  const [models, setModels] = useState<ModelOption[]>([]);
  const [tools, setTools] = useState<ToolOption[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [showAdvanced, setShowAdvanced] = useState(false);

  const isEditing = !!initialData;

  useEffect(() => {
    if (isOpen) {
      if (initialData) {
        setFormData(initialData);
      } else {
        setFormData(DEFAULT_FORM_DATA);
      }
      setError(null);
      setShowAdvanced(false);

      // Fetch available models
      fetch('/api/models')
        .then((res) => res.json())
        .then((data) => {
          const options: ModelOption[] = [];

          if (data.ollama?.available) {
            for (const m of data.ollama.models || []) {
              options.push({
                id: m.name,
                name: m.displayName || m.name,
                provider: 'ollama',
              });
            }
          }

          for (const provider of data.cloud || []) {
            if (provider.configured) {
              for (const m of provider.models) {
                options.push({
                  id: m,
                  name: m,
                  provider: provider.name,
                });
              }
            }
          }

          setModels(options);
          if (options.length > 0 && !formData.model) {
            setFormData((prev) => ({ ...prev, model: options[0].id }));
          }
        })
        .catch(console.error);

      // Fetch available tools
      fetch('/api/tools')
        .then((res) => res.json())
        .then((data) => {
          setTools(data || []);
        })
        .catch(console.error);
    }
  }, [isOpen, initialData]);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();

    if (!formData.name.trim() || !formData.model || !formData.instructions.trim()) {
      setError('Name, model, and instructions are required');
      return;
    }

    setLoading(true);
    setError(null);

    try {
      const response = await fetch('/api/agents', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: formData.name.trim(),
          model: formData.model,
          description: formData.description.trim() || undefined,
          instructions: formData.instructions.trim(),
          temperature: formData.temperature,
          topP: formData.topP,
          maxTokens: formData.maxTokens || undefined,
          tools: formData.tools,
          memoryEnabled: formData.memoryEnabled,
          maxIterations: formData.maxIterations,
        }),
      });

      if (!response.ok) {
        const data = await response.json();
        throw new Error(data.error || 'Failed to create agent');
      }

      setFormData(DEFAULT_FORM_DATA);
      onCreated();
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to create agent');
    } finally {
      setLoading(false);
    }
  };

  const toggleTool = (toolName: string) => {
    setFormData((prev) => ({
      ...prev,
      tools: prev.tools.includes(toolName)
        ? prev.tools.filter((t) => t !== toolName)
        : [...prev.tools, toolName],
    }));
  };

  if (!isOpen) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center">
      <div
        className="absolute inset-0 bg-black/50 backdrop-blur-sm"
        onClick={onClose}
      />

      <Card className="relative w-full max-w-2xl mx-4 z-10 animate-fade-in max-h-[90vh] overflow-y-auto">
        <div className="flex items-center justify-between mb-6 sticky top-0 bg-bg-secondary pt-4 -mt-4 pb-4 border-b border-border-primary">
          <div className="flex items-center gap-3">
            <div className="p-2 bg-accent/10 rounded-lg">
              <Bot className="w-5 h-5 text-accent" />
            </div>
            <h2 className="text-lg font-semibold text-text-primary">
              {isEditing ? 'Edit Agent' : 'Create Agent'}
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
          <section className="space-y-4">
            <h3 className="text-sm font-medium text-text-secondary flex items-center gap-2">
              <Sparkles className="w-4 h-4" />
              Basic Information
            </h3>

            <div className="grid grid-cols-2 gap-4">
              <div>
                <label className="block text-sm text-text-secondary mb-1">
                  Name *
                </label>
                <Input
                  value={formData.name}
                  onChange={(e) =>
                    setFormData((prev) => ({ ...prev, name: e.target.value }))
                  }
                  placeholder="My Agent"
                  required
                />
              </div>

              <div>
                <label className="block text-sm text-text-secondary mb-1">
                  Model *
                </label>
                <select
                  value={formData.model}
                  onChange={(e) =>
                    setFormData((prev) => ({ ...prev, model: e.target.value }))
                  }
                  className="w-full px-3 py-2 bg-bg-elevated border border-border-primary rounded-lg text-text-primary focus:outline-none focus:ring-2 focus:ring-accent/50"
                  required
                >
                  {models.length === 0 ? (
                    <option value="">No models available</option>
                  ) : (
                    <>
                      {models.filter((m) => m.provider === 'ollama').length > 0 && (
                        <optgroup label="Local (Ollama)">
                          {models
                            .filter((m) => m.provider === 'ollama')
                            .map((m) => (
                              <option key={m.id} value={m.id}>
                                {m.name}
                              </option>
                            ))}
                        </optgroup>
                      )}
                      {models.filter((m) => m.provider !== 'ollama').length > 0 && (
                        <optgroup label="Cloud">
                          {models
                            .filter((m) => m.provider !== 'ollama')
                            .map((m) => (
                              <option key={m.id} value={m.id}>
                                {m.name} ({m.provider})
                              </option>
                            ))}
                        </optgroup>
                      )}
                    </>
                  )}
                </select>
              </div>
            </div>

            <div>
              <label className="block text-sm text-text-secondary mb-1">
                Description
              </label>
              <Input
                value={formData.description}
                onChange={(e) =>
                  setFormData((prev) => ({ ...prev, description: e.target.value }))
                }
                placeholder="What does this agent do?"
              />
            </div>

            <div>
              <label className="block text-sm text-text-secondary mb-1">
                System Instructions *
              </label>
              <textarea
                value={formData.instructions}
                onChange={(e) =>
                  setFormData((prev) => ({ ...prev, instructions: e.target.value }))
                }
                placeholder="You are a helpful assistant..."
                rows={4}
                className="w-full px-3 py-2 bg-bg-elevated border border-border-primary rounded-lg text-text-primary placeholder:text-text-muted focus:outline-none focus:ring-2 focus:ring-accent/50 resize-none font-mono text-sm"
                required
              />
            </div>
          </section>

          {/* Tools */}
          <section className="space-y-4">
            <h3 className="text-sm font-medium text-text-secondary flex items-center gap-2">
              <Wrench className="w-4 h-4" />
              Tools
              {formData.tools.length > 0 && (
                <span className="text-xs bg-accent/20 text-accent px-2 py-0.5 rounded-full">
                  {formData.tools.length} selected
                </span>
              )}
            </h3>

            <div className="grid grid-cols-2 gap-2">
              {tools.map((tool) => (
                <button
                  key={tool.name}
                  type="button"
                  onClick={() => toggleTool(tool.name)}
                  className={`p-3 rounded-lg border text-left transition-colors ${
                    formData.tools.includes(tool.name)
                      ? 'border-accent bg-accent/10'
                      : 'border-border-primary bg-bg-tertiary hover:border-border-secondary'
                  }`}
                >
                  <div className="flex items-center justify-between">
                    <span className="font-medium text-sm text-text-primary">
                      {tool.name}
                    </span>
                    {tool.requiresApproval && (
                      <span className="text-xs text-warning">⚠️</span>
                    )}
                  </div>
                  <p className="text-xs text-text-muted mt-1 line-clamp-2">
                    {tool.description}
                  </p>
                </button>
              ))}
              {tools.length === 0 && (
                <p className="col-span-2 text-sm text-text-muted text-center py-4">
                  No tools available
                </p>
              )}
            </div>
          </section>

          {/* Memory */}
          <section className="space-y-4">
            <h3 className="text-sm font-medium text-text-secondary flex items-center gap-2">
              <Brain className="w-4 h-4" />
              Memory
            </h3>

            <label className="flex items-center gap-3 p-3 bg-bg-tertiary rounded-lg cursor-pointer">
              <input
                type="checkbox"
                checked={formData.memoryEnabled}
                onChange={(e) =>
                  setFormData((prev) => ({
                    ...prev,
                    memoryEnabled: e.target.checked,
                  }))
                }
                className="w-4 h-4 rounded border-border-primary accent-accent"
              />
              <div>
                <span className="text-sm text-text-primary">Enable Memory</span>
                <p className="text-xs text-text-muted">
                  Remember conversation history across runs
                </p>
              </div>
            </label>
          </section>

          {/* Advanced Settings */}
          <section className="space-y-4">
            <button
              type="button"
              onClick={() => setShowAdvanced(!showAdvanced)}
              className="flex items-center gap-2 text-sm font-medium text-text-secondary hover:text-text-primary transition-colors"
            >
              <Settings2 className="w-4 h-4" />
              Advanced Settings
              {showAdvanced ? (
                <ChevronUp className="w-4 h-4" />
              ) : (
                <ChevronDown className="w-4 h-4" />
              )}
            </button>

            {showAdvanced && (
              <div className="space-y-4 p-4 bg-bg-tertiary rounded-lg">
                <div className="grid grid-cols-2 gap-4">
                  <div>
                    <label className="block text-sm text-text-secondary mb-1">
                      Temperature ({formData.temperature})
                    </label>
                    <input
                      type="range"
                      min="0"
                      max="2"
                      step="0.1"
                      value={formData.temperature}
                      onChange={(e) =>
                        setFormData((prev) => ({
                          ...prev,
                          temperature: parseFloat(e.target.value),
                        }))
                      }
                      className="w-full accent-accent"
                    />
                    <div className="flex justify-between text-xs text-text-muted mt-1">
                      <span>Precise</span>
                      <span>Creative</span>
                    </div>
                  </div>

                  <div>
                    <label className="block text-sm text-text-secondary mb-1">
                      Top P ({formData.topP})
                    </label>
                    <input
                      type="range"
                      min="0"
                      max="1"
                      step="0.05"
                      value={formData.topP}
                      onChange={(e) =>
                        setFormData((prev) => ({
                          ...prev,
                          topP: parseFloat(e.target.value),
                        }))
                      }
                      className="w-full accent-accent"
                    />
                  </div>
                </div>

                <div className="grid grid-cols-2 gap-4">
                  <div>
                    <label className="block text-sm text-text-secondary mb-1">
                      Max Tokens
                    </label>
                    <Input
                      type="number"
                      value={formData.maxTokens || ''}
                      onChange={(e) =>
                        setFormData((prev) => ({
                          ...prev,
                          maxTokens: e.target.value
                            ? parseInt(e.target.value)
                            : null,
                        }))
                      }
                      placeholder="Auto"
                      min={1}
                      max={100000}
                    />
                  </div>

                  <div>
                    <label className="block text-sm text-text-secondary mb-1">
                      Max Iterations
                    </label>
                    <Input
                      type="number"
                      value={formData.maxIterations}
                      onChange={(e) =>
                        setFormData((prev) => ({
                          ...prev,
                          maxIterations: parseInt(e.target.value) || 10,
                        }))
                      }
                      min={1}
                      max={100}
                    />
                    <p className="text-xs text-text-muted mt-1">
                      Max tool call iterations
                    </p>
                  </div>
                </div>
              </div>
            )}
          </section>

          <div className="flex gap-3 pt-4 border-t border-border-primary">
            <Button
              type="button"
              variant="ghost"
              onClick={onClose}
              className="flex-1"
            >
              Cancel
            </Button>
            <Button
              type="submit"
              variant="primary"
              disabled={
                loading ||
                !formData.name.trim() ||
                !formData.model ||
                !formData.instructions.trim()
              }
              className="flex-1"
            >
              {loading
                ? isEditing
                  ? 'Saving...'
                  : 'Creating...'
                : isEditing
                  ? 'Save Changes'
                  : 'Create Agent'}
            </Button>
          </div>
        </form>
      </Card>
    </div>
  );
}
