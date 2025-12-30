'use client';

import { useEffect, useState, useRef } from 'react';
import { Sidebar } from '@/components/layout/Sidebar';
import { Header } from '@/components/layout/Header';
import { Card } from '@/components/ui/Card';
import { Button } from '@/components/ui/Button';
import { Badge } from '@/components/ui/Badge';
import { Input } from '@/components/ui/Input';
import { Skeleton } from '@/components/ui/Skeleton';
import {
  Save,
  RotateCcw,
  Check,
  AlertCircle,
  Settings,
  Key,
  Cloud,
  Server,
  Database,
  Eye,
  EyeOff,
} from 'lucide-react';
import dynamic from 'next/dynamic';

const MonacoEditor = dynamic(() => import('@monaco-editor/react'), {
  ssr: false,
  loading: () => <Skeleton className="h-96 w-full" />,
});

interface ConfigData {
  cogitator: {
    llm: {
      provider: string;
      model: string;
      temperature?: number;
      maxTokens?: number;
    };
    memory?: {
      adapter: string;
      redis?: { url: string };
      postgres?: { url: string };
    };
    sandbox?: {
      enabled: boolean;
      type: string;
      timeout?: number;
    };
    limits?: {
      maxTurns?: number;
      maxTokens?: number;
      maxCost?: number;
    };
  };
  environment: Record<string, string | undefined>;
}

interface ProviderStatus {
  id: string;
  name: string;
  configured: boolean;
  icon: typeof Cloud;
}

const defaultYaml = `# Cogitator Configuration
llm:
  provider: openai
  model: gpt-4o-mini
  temperature: 0.7
  maxTokens: 4096

memory:
  adapter: postgres
  postgres:
    url: postgresql://cogitator:cogitator@localhost:5432/cogitator

sandbox:
  enabled: false
  type: docker
  timeout: 30000

limits:
  maxTurns: 10
  maxTokens: 100000
  maxCost: 1.0
`;

export default function ConfigPage() {
  const [config, setConfig] = useState<ConfigData | null>(null);
  const [yaml, setYaml] = useState(defaultYaml);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const [hasChanges, setHasChanges] = useState(false);
  const [activeTab, setActiveTab] = useState<'config' | 'providers'>('providers');
  const [showKeys, setShowKeys] = useState<Record<string, boolean>>({});
  const [apiKeys, setApiKeys] = useState<Record<string, string>>({});
  const [savingKeys, setSavingKeys] = useState(false);
  const originalYamlRef = useRef(defaultYaml);

  const providers: ProviderStatus[] = [
    {
      id: 'ollama',
      name: 'Ollama (Local)',
      configured: config?.environment?.OLLAMA_URL !== undefined,
      icon: Server,
    },
    {
      id: 'openai',
      name: 'OpenAI',
      configured: !!config?.environment?.OPENAI_API_KEY,
      icon: Cloud,
    },
    {
      id: 'anthropic',
      name: 'Anthropic',
      configured: !!config?.environment?.ANTHROPIC_API_KEY,
      icon: Cloud,
    },
    {
      id: 'google',
      name: 'Google AI',
      configured: !!config?.environment?.GOOGLE_API_KEY,
      icon: Cloud,
    },
  ];

  useEffect(() => {
    async function fetchConfig() {
      try {
        const response = await fetch('/api/config');
        if (response.ok) {
          const data = await response.json();
          setConfig(data);

          const yamlContent = configToYaml(data.cogitator);
          setYaml(yamlContent);
          originalYamlRef.current = yamlContent;
        }
      } catch (error) {
        console.error('Failed to fetch config:', error);
      } finally {
        setLoading(false);
      }
    }

    fetchConfig();
  }, []);

  const handleEditorChange = (value: string | undefined) => {
    if (value !== undefined) {
      setYaml(value);
      setHasChanges(value !== originalYamlRef.current);
      setError(null);
      setSaved(false);
    }
  };

  const handleSave = async () => {
    setSaving(true);
    setError(null);
    setSaved(false);

    try {
      const configObj = yamlToConfig(yaml);

      const response = await fetch('/api/config', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(configObj),
      });

      if (!response.ok) {
        const data = await response.json();
        throw new Error(data.error || 'Failed to save config');
      }

      originalYamlRef.current = yaml;
      setHasChanges(false);
      setSaved(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to save');
    } finally {
      setSaving(false);
    }
  };

  const handleReset = () => {
    setYaml(originalYamlRef.current);
    setHasChanges(false);
    setError(null);
    setSaved(false);
  };

  const toggleShowKey = (provider: string) => {
    setShowKeys((prev) => ({ ...prev, [provider]: !prev[provider] }));
  };

  const handleKeyChange = (provider: string, value: string) => {
    setApiKeys((prev) => ({ ...prev, [provider]: value }));
  };

  const saveApiKey = async (provider: string) => {
    const key = apiKeys[provider];
    if (!key) return;

    setSavingKeys(true);
    try {
      const envVar =
        provider === 'openai'
          ? 'OPENAI_API_KEY'
          : provider === 'anthropic'
            ? 'ANTHROPIC_API_KEY'
            : provider === 'google'
              ? 'GOOGLE_API_KEY'
              : null;

      if (!envVar) return;

      // In a real implementation, this would save to a secure store
      // For now, we just show a message that env vars need to be set manually
      alert(
        `To configure ${provider}, set the ${envVar} environment variable.\n\nExample:\n${envVar}=${key.slice(0, 10)}...`
      );
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
          <div className="max-w-5xl mx-auto space-y-6">
            {/* Header */}
            <div className="flex items-center justify-between animate-fade-in">
              <div>
                <h1 className="text-2xl font-semibold text-text-primary">
                  Configuration
                </h1>
                <p className="text-text-secondary mt-1">
                  Manage Cogitator runtime settings and providers
                </p>
              </div>
            </div>

            {/* Tabs */}
            <div className="flex gap-2 border-b border-border-subtle pb-4">
              <Button
                variant={activeTab === 'providers' ? 'primary' : 'ghost'}
                size="sm"
                onClick={() => setActiveTab('providers')}
                className="gap-2"
              >
                <Key className="w-4 h-4" />
                Providers
              </Button>
              <Button
                variant={activeTab === 'config' ? 'primary' : 'ghost'}
                size="sm"
                onClick={() => setActiveTab('config')}
                className="gap-2"
              >
                <Settings className="w-4 h-4" />
                Runtime Config
              </Button>
            </div>

            {/* Providers Tab */}
            {activeTab === 'providers' && (
              <div className="space-y-6 animate-fade-in">
                {/* Provider Cards */}
                <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                  {providers.map((provider) => (
                    <Card key={provider.id} className="space-y-4">
                      <div className="flex items-center justify-between">
                        <div className="flex items-center gap-3">
                          <div
                            className={`p-2 rounded-lg ${
                              provider.configured
                                ? 'bg-success/10'
                                : 'bg-bg-tertiary'
                            }`}
                          >
                            <provider.icon
                              className={`w-5 h-5 ${
                                provider.configured
                                  ? 'text-success'
                                  : 'text-text-muted'
                              }`}
                            />
                          </div>
                          <div>
                            <h3 className="font-medium text-text-primary">
                              {provider.name}
                            </h3>
                            <Badge
                              variant={provider.configured ? 'success' : 'outline'}
                              size="sm"
                            >
                              {provider.configured ? 'Configured' : 'Not configured'}
                            </Badge>
                          </div>
                        </div>
                      </div>

                      {provider.id !== 'ollama' && (
                        <div className="space-y-2">
                          <label className="text-sm text-text-secondary">
                            API Key
                          </label>
                          <div className="flex gap-2">
                            <div className="relative flex-1">
                              <Input
                                type={showKeys[provider.id] ? 'text' : 'password'}
                                value={apiKeys[provider.id] || ''}
                                onChange={(e) =>
                                  handleKeyChange(provider.id, e.target.value)
                                }
                                placeholder={
                                  provider.configured
                                    ? '••••••••••••••••'
                                    : 'Enter API key...'
                                }
                              />
                              <button
                                type="button"
                                onClick={() => toggleShowKey(provider.id)}
                                className="absolute right-3 top-1/2 -translate-y-1/2 text-text-muted hover:text-text-primary"
                              >
                                {showKeys[provider.id] ? (
                                  <EyeOff className="w-4 h-4" />
                                ) : (
                                  <Eye className="w-4 h-4" />
                                )}
                              </button>
                            </div>
                            <Button
                              variant="outline"
                              size="sm"
                              onClick={() => saveApiKey(provider.id)}
                              disabled={!apiKeys[provider.id] || savingKeys}
                            >
                              Save
                            </Button>
                          </div>
                          <p className="text-xs text-text-muted">
                            API keys are stored as environment variables
                          </p>
                        </div>
                      )}

                      {provider.id === 'ollama' && (
                        <div className="space-y-2">
                          <label className="text-sm text-text-secondary">
                            Base URL
                          </label>
                          <Input
                            value={
                              config?.environment?.OLLAMA_URL ||
                              'http://localhost:11434'
                            }
                            disabled
                            className="bg-bg-tertiary"
                          />
                          <p className="text-xs text-text-muted">
                            Set OLLAMA_URL environment variable to change
                          </p>
                        </div>
                      )}
                    </Card>
                  ))}
                </div>

                {/* Database Config */}
                <Card>
                  <div className="flex items-center gap-3 mb-4">
                    <div className="p-2 bg-accent/10 rounded-lg">
                      <Database className="w-5 h-5 text-accent" />
                    </div>
                    <div>
                      <h3 className="font-medium text-text-primary">
                        Database & Memory
                      </h3>
                      <p className="text-sm text-text-secondary">
                        PostgreSQL and Redis connections
                      </p>
                    </div>
                  </div>

                  <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                    <div>
                      <label className="block text-sm text-text-secondary mb-1">
                        PostgreSQL
                      </label>
                      <Input
                        value={config?.environment?.DATABASE_URL || 'Not configured'}
                        disabled
                        className="bg-bg-tertiary font-mono text-xs"
                      />
                    </div>
                    <div>
                      <label className="block text-sm text-text-secondary mb-1">
                        Redis
                      </label>
                      <Input
                        value={config?.environment?.REDIS_URL || 'Not configured'}
                        disabled
                        className="bg-bg-tertiary font-mono text-xs"
                      />
                    </div>
                  </div>

                  <p className="text-xs text-text-muted mt-4">
                    Set DATABASE_URL and REDIS_URL environment variables to configure
                    connections.
                  </p>
                </Card>
              </div>
            )}

            {/* Config Tab */}
            {activeTab === 'config' && (
              <div className="grid grid-cols-1 lg:grid-cols-3 gap-6 animate-fade-in">
                {/* Editor */}
                <div className="lg:col-span-2">
                  <Card className="p-0 overflow-hidden">
                    <div className="border-b border-border-primary p-3 flex items-center justify-between bg-bg-secondary">
                      <span className="text-sm font-medium text-text-secondary">
                        cogitator.yaml
                      </span>
                      <div className="flex items-center gap-2">
                        {error && (
                          <Badge variant="error" size="sm" className="gap-1">
                            <AlertCircle className="w-3 h-3" />
                            {error}
                          </Badge>
                        )}
                        {hasChanges && !error && (
                          <Badge variant="warning" size="sm">
                            Unsaved changes
                          </Badge>
                        )}
                        {hasChanges && (
                          <Button
                            variant="ghost"
                            size="sm"
                            onClick={handleReset}
                            className="gap-1"
                          >
                            <RotateCcw className="w-3 h-3" />
                            Reset
                          </Button>
                        )}
                        <Button
                          variant="primary"
                          size="sm"
                          onClick={handleSave}
                          disabled={saving || !hasChanges}
                          className="gap-1"
                        >
                          {saving ? (
                            <>Saving...</>
                          ) : saved ? (
                            <>
                              <Check className="w-3 h-3" />
                              Saved
                            </>
                          ) : (
                            <>
                              <Save className="w-3 h-3" />
                              Save
                            </>
                          )}
                        </Button>
                      </div>
                    </div>
                    {loading ? (
                      <Skeleton className="h-96 w-full" />
                    ) : (
                      <MonacoEditor
                        height="500px"
                        language="yaml"
                        theme="vs-dark"
                        value={yaml}
                        onChange={handleEditorChange}
                        options={{
                          minimap: { enabled: false },
                          fontSize: 14,
                          lineNumbers: 'on',
                          scrollBeyondLastLine: false,
                          wordWrap: 'on',
                          tabSize: 2,
                          padding: { top: 16 },
                        }}
                      />
                    )}
                  </Card>
                </div>

                {/* Sidebar */}
                <div className="space-y-4">
                  <Card>
                    <h3 className="text-lg font-medium text-text-primary mb-4 flex items-center gap-2">
                      <Settings className="w-5 h-5" />
                      Environment
                    </h3>
                    {loading ? (
                      <div className="space-y-3">
                        {[...Array(5)].map((_, i) => (
                          <div key={i} className="flex justify-between">
                            <Skeleton className="h-4 w-32" />
                            <Skeleton className="h-4 w-16" />
                          </div>
                        ))}
                      </div>
                    ) : (
                      <div className="space-y-3">
                        {Object.entries(config?.environment || {}).map(
                          ([key, value]) => (
                            <div
                              key={key}
                              className="flex items-center justify-between text-sm"
                            >
                              <span className="text-text-secondary font-mono text-xs">
                                {key}
                              </span>
                              {value ? (
                                <Badge variant="success" size="sm">
                                  Set
                                </Badge>
                              ) : (
                                <Badge variant="outline" size="sm">
                                  Not set
                                </Badge>
                              )}
                            </div>
                          )
                        )}
                      </div>
                    )}
                  </Card>

                  <Card>
                    <h3 className="text-sm font-medium text-text-secondary mb-2">
                      Quick Tips
                    </h3>
                    <ul className="text-xs text-text-muted space-y-1.5">
                      <li>• Use YAML format for configuration</li>
                      <li>• Changes require restart to take effect</li>
                      <li>• Set API keys in environment variables</li>
                      <li>• Use Ctrl+S to save quickly</li>
                    </ul>
                  </Card>
                </div>
              </div>
            )}
          </div>
        </main>
      </div>
    </div>
  );
}

function configToYaml(config: ConfigData['cogitator'] | null): string {
  if (!config) return defaultYaml;

  const lines: string[] = ['# Cogitator Configuration'];

  lines.push('llm:');
  lines.push(`  provider: ${config.llm.provider}`);
  lines.push(`  model: ${config.llm.model}`);
  if (config.llm.temperature !== undefined) {
    lines.push(`  temperature: ${config.llm.temperature}`);
  }
  if (config.llm.maxTokens !== undefined) {
    lines.push(`  maxTokens: ${config.llm.maxTokens}`);
  }

  if (config.memory) {
    lines.push('');
    lines.push('memory:');
    lines.push(`  adapter: ${config.memory.adapter}`);
    if (config.memory.postgres?.url) {
      lines.push('  postgres:');
      lines.push(`    url: ${config.memory.postgres.url}`);
    }
    if (config.memory.redis?.url) {
      lines.push('  redis:');
      lines.push(`    url: ${config.memory.redis.url}`);
    }
  }

  if (config.sandbox) {
    lines.push('');
    lines.push('sandbox:');
    lines.push(`  enabled: ${config.sandbox.enabled}`);
    lines.push(`  type: ${config.sandbox.type}`);
    if (config.sandbox.timeout !== undefined) {
      lines.push(`  timeout: ${config.sandbox.timeout}`);
    }
  }

  if (config.limits) {
    lines.push('');
    lines.push('limits:');
    if (config.limits.maxTurns !== undefined) {
      lines.push(`  maxTurns: ${config.limits.maxTurns}`);
    }
    if (config.limits.maxTokens !== undefined) {
      lines.push(`  maxTokens: ${config.limits.maxTokens}`);
    }
    if (config.limits.maxCost !== undefined) {
      lines.push(`  maxCost: ${config.limits.maxCost}`);
    }
  }

  return lines.join('\n');
}

function yamlToConfig(yaml: string): ConfigData['cogitator'] {
  const config: ConfigData['cogitator'] = {
    llm: { provider: 'openai', model: 'gpt-4o-mini' },
  };

  const lines = yaml.split('\n');
  let currentSection = '';
  let currentSubsection = '';

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;

    const indent = line.search(/\S/);

    if (indent === 0 && trimmed.endsWith(':')) {
      currentSection = trimmed.slice(0, -1);
      currentSubsection = '';
    } else if (indent === 2 && trimmed.endsWith(':')) {
      currentSubsection = trimmed.slice(0, -1);
    } else if (trimmed.includes(':')) {
      const [key, ...valueParts] = trimmed.split(':');
      const value = valueParts.join(':').trim();

      if (currentSection === 'llm') {
        if (key === 'provider') config.llm.provider = value;
        else if (key === 'model') config.llm.model = value;
        else if (key === 'temperature') config.llm.temperature = parseFloat(value);
        else if (key === 'maxTokens') config.llm.maxTokens = parseInt(value);
      } else if (currentSection === 'memory') {
        if (!config.memory) config.memory = { adapter: 'postgres' };
        if (key === 'adapter') config.memory.adapter = value;
        else if (currentSubsection === 'postgres' && key === 'url') {
          config.memory.postgres = { url: value };
        } else if (currentSubsection === 'redis' && key === 'url') {
          config.memory.redis = { url: value };
        }
      } else if (currentSection === 'sandbox') {
        if (!config.sandbox) config.sandbox = { enabled: false, type: 'docker' };
        if (key === 'enabled') config.sandbox.enabled = value === 'true';
        else if (key === 'type') config.sandbox.type = value;
        else if (key === 'timeout') config.sandbox.timeout = parseInt(value);
      } else if (currentSection === 'limits') {
        if (!config.limits) config.limits = {};
        if (key === 'maxTurns') config.limits.maxTurns = parseInt(value);
        else if (key === 'maxTokens') config.limits.maxTokens = parseInt(value);
        else if (key === 'maxCost') config.limits.maxCost = parseFloat(value);
      }
    }
  }

  return config;
}
