'use client';

import { useEffect, useState, useCallback } from 'react';
import { Sidebar } from '@/components/layout/Sidebar';
import { Header } from '@/components/layout/Header';
import { Card } from '@/components/ui/Card';
import { Button } from '@/components/ui/Button';
import { Badge } from '@/components/ui/Badge';
import { Input } from '@/components/ui/Input';
import { Skeleton } from '@/components/ui/Skeleton';
import {
  Download,
  Trash2,
  Check,
  AlertCircle,
  Server,
  Cloud,
  Key,
  Eye,
  EyeOff,
  RefreshCw,
  HardDrive,
  Cpu,
} from 'lucide-react';
import { formatDistanceToNow } from 'date-fns';

interface OllamaModel {
  name: string;
  displayName: string;
  size: number;
  sizeFormatted: string;
  parameterSize: string;
  family: string;
  quantization: string;
  modifiedAt: string;
  isDownloaded: boolean;
}

interface AvailableModel {
  name: string;
  description: string;
  size: string;
  isDownloaded: boolean;
}

interface CloudProvider {
  id: string;
  name: string;
  models: string[];
  configured: boolean;
}

interface ModelsData {
  ollama: {
    available: boolean;
    version?: string;
    models: OllamaModel[];
  };
  available: AvailableModel[];
  cloud: CloudProvider[];
}

interface PullProgress {
  status: string;
  percent?: number;
  completed?: number;
  total?: number;
}

export default function ModelsPage() {
  const [data, setData] = useState<ModelsData | null>(null);
  const [loading, setLoading] = useState(true);
  const [pulling, setPulling] = useState<Record<string, PullProgress>>({});
  const [deleting, setDeleting] = useState<string | null>(null);
  const [showApiKeys, setShowApiKeys] = useState(false);
  const [apiKeys, setApiKeys] = useState({
    openai: '',
    anthropic: '',
    google: '',
  });
  const [savingKeys, setSavingKeys] = useState(false);

  const fetchModels = useCallback(async () => {
    try {
      const response = await fetch('/api/models');
      if (response.ok) {
        const result = await response.json();
        setData(result);
      }
    } catch (error) {
      console.error('Failed to fetch models:', error);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchModels();
  }, [fetchModels]);

  const pullModel = async (name: string) => {
    setPulling((prev) => ({ ...prev, [name]: { status: 'Starting...' } }));

    try {
      const response = await fetch('/api/models/pull', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name }),
      });

      if (!response.ok || !response.body) {
        throw new Error('Failed to pull model');
      }

      const reader = response.body.getReader();
      const decoder = new TextDecoder();

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        const lines = decoder.decode(value).split('\n').filter(Boolean);
        for (const line of lines) {
          if (line.startsWith('data: ')) {
            try {
              const progress = JSON.parse(line.slice(6)) as PullProgress;
              if (progress.status === 'done') {
                setPulling((prev) => {
                  const next = { ...prev };
                  delete next[name];
                  return next;
                });
                fetchModels();
              } else {
                setPulling((prev) => ({ ...prev, [name]: progress }));
              }
            } catch {
            }
          }
        }
      }
    } catch (error) {
      console.error('Failed to pull model:', error);
      setPulling((prev) => {
        const next = { ...prev };
        delete next[name];
        return next;
      });
    }
  };

  const deleteModel = async (name: string) => {
    if (!confirm(`Delete model "${name}"? This cannot be undone.`)) return;

    setDeleting(name);
    try {
      const response = await fetch('/api/models/delete', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name }),
      });

      if (response.ok) {
        fetchModels();
      }
    } catch (error) {
      console.error('Failed to delete model:', error);
    } finally {
      setDeleting(null);
    }
  };

  const saveApiKeys = async () => {
    setSavingKeys(true);
    try {
      const response = await fetch('/api/models', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          action: 'save_api_keys',
          ...apiKeys,
        }),
      });

      if (response.ok) {
        fetchModels();
        setApiKeys({ openai: '', anthropic: '', google: '' });
        setShowApiKeys(false);
      }
    } catch (error) {
      console.error('Failed to save API keys:', error);
    } finally {
      setSavingKeys(false);
    }
  };

  return (
    <div className="flex h-screen overflow-hidden">
      <Sidebar />
      <div className="flex-1 flex flex-col overflow-hidden">
        <Header />
        <main className="flex-1 overflow-auto p-6 bg-bg-primary bg-noise">
          <div className="max-w-6xl mx-auto space-y-6">
            {/* Header */}
            <div className="flex items-center justify-between animate-fade-in">
              <div>
                <h1 className="text-2xl font-semibold text-text-primary">
                  Models
                </h1>
                <p className="text-text-secondary mt-1">
                  Manage local and cloud AI models
                </p>
              </div>
              <Button
                variant="ghost"
                size="sm"
                onClick={() => {
                  setLoading(true);
                  fetchModels();
                }}
                className="gap-2"
              >
                <RefreshCw className={`w-4 h-4 ${loading ? 'animate-spin' : ''}`} />
                Refresh
              </Button>
            </div>

            {/* Ollama Status */}
            <Card className="animate-fade-in" style={{ animationDelay: '100ms' }}>
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-3">
                  <div className={`p-3 rounded-xl ${data?.ollama.available ? 'bg-success/10' : 'bg-error/10'}`}>
                    <Server className={`w-6 h-6 ${data?.ollama.available ? 'text-success' : 'text-error'}`} />
                  </div>
                  <div>
                    <h3 className="font-medium text-text-primary">Ollama</h3>
                    <p className="text-sm text-text-secondary">
                      {data?.ollama.available
                        ? `Running v${data.ollama.version}`
                        : 'Not connected'}
                    </p>
                  </div>
                </div>
                <Badge variant={data?.ollama.available ? 'success' : 'error'}>
                  {data?.ollama.available ? 'Online' : 'Offline'}
                </Badge>
              </div>
            </Card>

            {/* Downloaded Models */}
            <Card className="animate-fade-in" style={{ animationDelay: '150ms' }}>
              <div className="flex items-center justify-between mb-4">
                <h3 className="text-lg font-medium text-text-primary flex items-center gap-2">
                  <HardDrive className="w-5 h-5" />
                  Downloaded Models
                </h3>
                <span className="text-sm text-text-muted">
                  {data?.ollama.models.length || 0} models
                </span>
              </div>

              {loading ? (
                <div className="space-y-3">
                  {[...Array(3)].map((_, i) => (
                    <div key={i} className="flex items-center gap-4 p-3">
                      <Skeleton className="h-10 w-10 rounded-lg" />
                      <div className="flex-1 space-y-2">
                        <Skeleton className="h-4 w-48" />
                        <Skeleton className="h-3 w-32" />
                      </div>
                      <Skeleton className="h-8 w-20" />
                    </div>
                  ))}
                </div>
              ) : !data?.ollama.available ? (
                <div className="py-8 text-center text-text-muted">
                  <AlertCircle className="w-8 h-8 mx-auto mb-2 opacity-50" />
                  <p>Ollama is not running</p>
                  <p className="text-sm mt-1">Start Ollama to manage local models</p>
                </div>
              ) : data.ollama.models.length === 0 ? (
                <div className="py-8 text-center text-text-muted">
                  <Cpu className="w-8 h-8 mx-auto mb-2 opacity-50" />
                  <p>No models downloaded</p>
                  <p className="text-sm mt-1">Download a model from the list below</p>
                </div>
              ) : (
                <div className="space-y-2">
                  {data.ollama.models.map((model) => (
                    <div
                      key={model.name}
                      className="flex items-center gap-4 p-3 rounded-lg bg-bg-tertiary"
                    >
                      <div className="p-2 bg-accent/10 rounded-lg">
                        <Cpu className="w-5 h-5 text-accent" />
                      </div>
                      <div className="flex-1 min-w-0">
                        <p className="font-medium text-text-primary">
                          {model.displayName}
                        </p>
                        <p className="text-sm text-text-secondary">
                          {model.parameterSize} • {model.sizeFormatted} • {model.quantization}
                        </p>
                      </div>
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={() => deleteModel(model.name)}
                        disabled={deleting === model.name}
                        className="text-error hover:bg-error/10"
                      >
                        {deleting === model.name ? (
                          <RefreshCw className="w-4 h-4 animate-spin" />
                        ) : (
                          <Trash2 className="w-4 h-4" />
                        )}
                      </Button>
                    </div>
                  ))}
                </div>
              )}
            </Card>

            {/* Available Models */}
            <Card className="animate-fade-in" style={{ animationDelay: '200ms' }}>
              <div className="flex items-center justify-between mb-4">
                <h3 className="text-lg font-medium text-text-primary flex items-center gap-2">
                  <Download className="w-5 h-5" />
                  Available Models
                </h3>
              </div>

              <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                {data?.available.map((model) => {
                  const progress = pulling[model.name];
                  const isPulling = !!progress;

                  return (
                    <div
                      key={model.name}
                      className="flex items-center gap-3 p-3 rounded-lg border border-border-primary"
                    >
                      <div className="flex-1 min-w-0">
                        <p className="font-medium text-text-primary text-sm">
                          {model.name}
                        </p>
                        <p className="text-xs text-text-muted truncate">
                          {model.description}
                        </p>
                        <p className="text-xs text-text-secondary mt-1">
                          {model.size}
                        </p>
                      </div>

                      {isPulling ? (
                        <div className="w-32">
                          <div className="flex items-center justify-between text-xs mb-1">
                            <span className="text-text-muted truncate">
                              {progress.status}
                            </span>
                            {progress.percent !== undefined && (
                              <span className="text-accent">{progress.percent}%</span>
                            )}
                          </div>
                          <div className="h-1.5 bg-bg-tertiary rounded-full overflow-hidden">
                            <div
                              className="h-full bg-accent transition-all duration-300"
                              style={{ width: `${progress.percent || 0}%` }}
                            />
                          </div>
                        </div>
                      ) : model.isDownloaded ? (
                        <Badge variant="success" size="sm" className="gap-1">
                          <Check className="w-3 h-3" />
                          Installed
                        </Badge>
                      ) : (
                        <Button
                          variant="primary"
                          size="sm"
                          onClick={() => pullModel(model.name)}
                          disabled={!data?.ollama.available}
                          className="gap-1"
                        >
                          <Download className="w-3 h-3" />
                          Pull
                        </Button>
                      )}
                    </div>
                  );
                })}
              </div>
            </Card>

            {/* Cloud Providers */}
            <Card className="animate-fade-in" style={{ animationDelay: '250ms' }}>
              <div className="flex items-center justify-between mb-4">
                <h3 className="text-lg font-medium text-text-primary flex items-center gap-2">
                  <Cloud className="w-5 h-5" />
                  Cloud Providers
                </h3>
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => setShowApiKeys(!showApiKeys)}
                  className="gap-2"
                >
                  <Key className="w-4 h-4" />
                  {showApiKeys ? 'Hide' : 'Configure'} API Keys
                </Button>
              </div>

              {showApiKeys && (
                <div className="mb-6 p-4 bg-bg-tertiary rounded-lg space-y-4">
                  <div>
                    <label className="block text-sm text-text-secondary mb-1">
                      OpenAI API Key
                    </label>
                    <Input
                      type="password"
                      placeholder="sk-..."
                      value={apiKeys.openai}
                      onChange={(e) =>
                        setApiKeys((prev) => ({ ...prev, openai: e.target.value }))
                      }
                    />
                  </div>
                  <div>
                    <label className="block text-sm text-text-secondary mb-1">
                      Anthropic API Key
                    </label>
                    <Input
                      type="password"
                      placeholder="sk-ant-..."
                      value={apiKeys.anthropic}
                      onChange={(e) =>
                        setApiKeys((prev) => ({ ...prev, anthropic: e.target.value }))
                      }
                    />
                  </div>
                  <div>
                    <label className="block text-sm text-text-secondary mb-1">
                      Google API Key
                    </label>
                    <Input
                      type="password"
                      placeholder="AIza..."
                      value={apiKeys.google}
                      onChange={(e) =>
                        setApiKeys((prev) => ({ ...prev, google: e.target.value }))
                      }
                    />
                  </div>
                  <Button
                    variant="primary"
                    onClick={saveApiKeys}
                    disabled={savingKeys}
                    className="w-full"
                  >
                    {savingKeys ? 'Saving...' : 'Save API Keys'}
                  </Button>
                </div>
              )}

              <div className="space-y-3">
                {data?.cloud.map((provider) => (
                  <div
                    key={provider.id}
                    className="flex items-center gap-4 p-3 rounded-lg border border-border-primary"
                  >
                    <div className="flex-1">
                      <div className="flex items-center gap-2">
                        <p className="font-medium text-text-primary">
                          {provider.name}
                        </p>
                        <Badge
                          variant={provider.configured ? 'success' : 'outline'}
                          size="sm"
                        >
                          {provider.configured ? 'Configured' : 'Not configured'}
                        </Badge>
                      </div>
                      <p className="text-sm text-text-muted mt-1">
                        {provider.models.map((m: { id: string; name: string } | string) =>
                          typeof m === 'string' ? m : m.name
                        ).join(', ')}
                      </p>
                    </div>
                  </div>
                ))}
              </div>
            </Card>
          </div>
        </main>
      </div>
    </div>
  );
}
