'use client';

import { useState } from 'react';
import dynamic from 'next/dynamic';
import { Card, CardHeader, CardTitle } from '@/components/ui/Card';
import { Button } from '@/components/ui/Button';
import { Badge } from '@/components/ui/Badge';
import { cn } from '@/lib/cn';
import { Save, RotateCcw, Check, AlertTriangle, FileCode, Eye } from 'lucide-react';

const Editor = dynamic(
  () => import('@monaco-editor/react').then((mod) => mod.default),
  { ssr: false }
);

const DEFAULT_CONFIG = `# Cogitator Configuration
# Documentation: https://cogitator.dev/docs/config

llm:
  defaultProvider: openai
  defaultModel: gpt-4o
  providers:
    openai:
      apiKey: \${OPENAI_API_KEY}
    anthropic:
      apiKey: \${ANTHROPIC_API_KEY}
    google:
      apiKey: \${GOOGLE_API_KEY}

limits:
  maxConcurrentRuns: 10
  defaultTimeout: 120000
  maxTokensPerRun: 100000

memory:
  adapter: redis
  redis:
    url: redis:
    prefix: cogitator
  postgres:
    url: postgresql:
    
sandbox:
  enabled: true
  defaultType: docker
  docker:
    image: cogitator/sandbox:latest
    resources:
      cpus: 1
      memory: 512m
    timeout: 30000
    network:
      enabled: false

agents:
  - name: Research Agent
    model: gpt-4o
    instructions: |
      You are a research assistant specialized in 
      finding and analyzing information from the web.
    tools:
      - web_search
      - read_url
      
  - name: Code Assistant
    model: claude-3-5-sonnet
    instructions: |
      You are a coding assistant that helps with
      code review, refactoring, and documentation.
    tools:
      - code_exec
      - filesystem
`;

export function ConfigEditor() {
  const [config, setConfig] = useState(DEFAULT_CONFIG);
  const [savedConfig, setSavedConfig] = useState(DEFAULT_CONFIG);
  const [activeTab, setActiveTab] = useState<'edit' | 'preview'>('edit');
  const [errors, setErrors] = useState<string[]>([]);

  const hasChanges = config !== savedConfig;

  const handleSave = () => {
    try {
      setSavedConfig(config);
      setErrors([]);
    } catch (e) {
      setErrors(['Invalid YAML syntax']);
    }
  };

  const handleReset = () => {
    setConfig(savedConfig);
    setErrors([]);
  };

  return (
    <div className="h-full flex">
      {/* Editor */}
      <div className="flex-1 flex flex-col border-r border-border-subtle">
        {/* Toolbar */}
        <div className="flex items-center justify-between p-4 border-b border-border-subtle bg-bg-secondary">
          <div className="flex items-center gap-2">
            <Button
              variant={activeTab === 'edit' ? 'default' : 'ghost'}
              size="sm"
              onClick={() => setActiveTab('edit')}
              className="gap-2"
            >
              <FileCode className="w-4 h-4" />
              Edit
            </Button>
            <Button
              variant={activeTab === 'preview' ? 'default' : 'ghost'}
              size="sm"
              onClick={() => setActiveTab('preview')}
              className="gap-2"
            >
              <Eye className="w-4 h-4" />
              Preview
            </Button>
          </div>
          <div className="flex items-center gap-2">
            {hasChanges && (
              <Badge variant="warning" size="sm">
                Unsaved changes
              </Badge>
            )}
            <Button
              variant="ghost"
              size="sm"
              onClick={handleReset}
              disabled={!hasChanges}
            >
              <RotateCcw className="w-4 h-4" />
            </Button>
            <Button
              variant="primary"
              size="sm"
              onClick={handleSave}
              disabled={!hasChanges}
              className="gap-2"
            >
              <Save className="w-4 h-4" />
              Save
            </Button>
          </div>
        </div>

        {/* Monaco Editor */}
        <div className="flex-1">
          {activeTab === 'edit' ? (
            <Editor
              height="100%"
              defaultLanguage="yaml"
              value={config}
              onChange={(value) => setConfig(value || '')}
              theme="vs-dark"
              options={{
                minimap: { enabled: false },
                fontSize: 14,
                fontFamily: "'JetBrains Mono', 'Fira Code', monospace",
                lineNumbers: 'on',
                scrollBeyondLastLine: false,
                wordWrap: 'on',
                tabSize: 2,
                renderLineHighlight: 'line',
                padding: { top: 16 },
              }}
            />
          ) : (
            <div className="h-full overflow-auto p-6 bg-bg-primary">
              <pre className="text-sm font-mono text-text-primary whitespace-pre-wrap">
                {config}
              </pre>
            </div>
          )}
        </div>

        {/* Errors */}
        {errors.length > 0 && (
          <div className="p-4 bg-error/10 border-t border-error/20">
            {errors.map((error, i) => (
              <div key={i} className="flex items-center gap-2 text-sm text-error">
                <AlertTriangle className="w-4 h-4" />
                {error}
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Sidebar */}
      <div className="w-80 bg-bg-secondary p-4 space-y-4 overflow-auto">
        <Card>
          <CardHeader>
            <CardTitle>Configuration Help</CardTitle>
          </CardHeader>
          <div className="space-y-3 text-sm">
            <div>
              <h4 className="font-medium text-text-primary mb-1">LLM Providers</h4>
              <p className="text-text-secondary">
                Configure API keys and settings for different LLM providers.
              </p>
            </div>
            <div>
              <h4 className="font-medium text-text-primary mb-1">Memory</h4>
              <p className="text-text-secondary">
                Set up Redis or PostgreSQL for conversation history and context.
              </p>
            </div>
            <div>
              <h4 className="font-medium text-text-primary mb-1">Sandbox</h4>
              <p className="text-text-secondary">
                Configure Docker-based isolated execution for tools.
              </p>
            </div>
            <div>
              <h4 className="font-medium text-text-primary mb-1">Agents</h4>
              <p className="text-text-secondary">
                Define agent configurations with models, instructions, and tools.
              </p>
            </div>
          </div>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Environment Variables</CardTitle>
          </CardHeader>
          <div className="space-y-2 text-xs font-mono">
            <div className="flex justify-between">
              <span className="text-text-secondary">OPENAI_API_KEY</span>
              <Badge variant="success" size="sm">
                <Check className="w-3 h-3" />
              </Badge>
            </div>
            <div className="flex justify-between">
              <span className="text-text-secondary">ANTHROPIC_API_KEY</span>
              <Badge variant="success" size="sm">
                <Check className="w-3 h-3" />
              </Badge>
            </div>
            <div className="flex justify-between">
              <span className="text-text-secondary">GOOGLE_API_KEY</span>
              <Badge variant="warning" size="sm">
                Missing
              </Badge>
            </div>
          </div>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Quick Actions</CardTitle>
          </CardHeader>
          <div className="space-y-2">
            <Button variant="outline" size="sm" className="w-full justify-start">
              Reset to defaults
            </Button>
            <Button variant="outline" size="sm" className="w-full justify-start">
              Import from file
            </Button>
            <Button variant="outline" size="sm" className="w-full justify-start">
              Export configuration
            </Button>
          </div>
        </Card>
      </div>
    </div>
  );
}

