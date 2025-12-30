'use client';

import { useState } from 'react';
import { Card } from '@/components/ui/Card';
import { Button } from '@/components/ui/Button';
import { Input } from '@/components/ui/Input';
import { X, GitBranch } from 'lucide-react';

interface Workflow {
  id: string;
  name: string;
  description?: string;
  definition: unknown;
  totalRuns: number;
  lastRunAt?: string;
  createdAt: string;
}

interface CreateWorkflowModalProps {
  isOpen: boolean;
  onClose: () => void;
  onCreated: (workflow: Workflow) => void;
}

export function CreateWorkflowModal({
  isOpen,
  onClose,
  onCreated,
}: CreateWorkflowModalProps) {
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();

    if (!name.trim()) {
      setError('Name is required');
      return;
    }

    setLoading(true);
    setError(null);

    try {
      const response = await fetch('/api/workflows', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: name.trim(),
          description: description.trim() || undefined,
          definition: {
            nodes: [
              {
                id: 'start',
                type: 'workflow',
                position: { x: 250, y: 50 },
                data: { label: 'Start', nodeType: 'start', config: {} },
              },
              {
                id: 'end',
                type: 'workflow',
                position: { x: 250, y: 400 },
                data: { label: 'End', nodeType: 'end', config: {} },
              },
            ],
            edges: [],
          },
        }),
      });

      if (!response.ok) {
        const data = await response.json();
        throw new Error(data.error || 'Failed to create workflow');
      }

      const workflow = await response.json();
      setName('');
      setDescription('');
      onCreated(workflow);
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to create workflow');
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

      <Card className="relative w-full max-w-md mx-4 z-10 animate-fade-in">
        <div className="flex items-center justify-between mb-6">
          <div className="flex items-center gap-3">
            <div className="p-2 bg-accent/10 rounded-lg">
              <GitBranch className="w-5 h-5 text-accent" />
            </div>
            <h2 className="text-lg font-semibold text-text-primary">
              Create Workflow
            </h2>
          </div>
          <button
            onClick={onClose}
            className="p-1 rounded-lg hover:bg-bg-hover transition-colors"
          >
            <X className="w-5 h-5 text-text-muted" />
          </button>
        </div>

        <form onSubmit={handleSubmit} className="space-y-4">
          {error && (
            <div className="p-3 bg-error/10 border border-error/20 rounded-lg text-error text-sm">
              {error}
            </div>
          )}

          <div>
            <label className="block text-sm text-text-secondary mb-1">
              Name *
            </label>
            <Input
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="My Workflow"
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
              placeholder="What does this workflow do?"
              rows={3}
              className="w-full px-3 py-2 bg-bg-elevated border border-border-primary rounded-lg text-text-primary placeholder:text-text-muted focus:outline-none focus:ring-2 focus:ring-accent/50 resize-none"
            />
          </div>

          <div className="flex gap-3 pt-4">
            <Button type="button" variant="ghost" onClick={onClose} className="flex-1">
              Cancel
            </Button>
            <Button
              type="submit"
              variant="primary"
              disabled={loading || !name.trim()}
              className="flex-1"
            >
              {loading ? 'Creating...' : 'Create Workflow'}
            </Button>
          </div>
        </form>
      </Card>
    </div>
  );
}

