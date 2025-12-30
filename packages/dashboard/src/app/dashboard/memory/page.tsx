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
  Search,
  Brain,
  MessageSquare,
  Trash2,
  Clock,
  Bot,
  ChevronRight,
  Filter,
} from 'lucide-react';
import { formatDistanceToNow } from 'date-fns';

interface Thread {
  id: string;
  agentId?: string;
  title?: string;
  metadata: Record<string, unknown>;
  messageCount: number;
  lastMessageAt?: string;
  createdAt: string;
  updatedAt: string;
}

interface Agent {
  id: string;
  name: string;
}

export default function MemoryPage() {
  const [threads, setThreads] = useState<Thread[]>([]);
  const [agents, setAgents] = useState<Agent[]>([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState('');
  const [selectedAgent, setSelectedAgent] = useState<string>('');
  const [selectedThread, setSelectedThread] = useState<Thread | null>(null);

  useEffect(() => {
    fetchData();
  }, [selectedAgent]);

  const fetchData = async () => {
    try {
      setLoading(true);
      const params = new URLSearchParams();
      if (selectedAgent) params.set('agentId', selectedAgent);

      const [threadsRes, agentsRes] = await Promise.all([
        fetch(`/api/threads?${params}`),
        fetch('/api/agents'),
      ]);

      if (threadsRes.ok) {
        const data = await threadsRes.json();
        setThreads(data);
      }

      if (agentsRes.ok) {
        const data = await agentsRes.json();
        setAgents(data);
      }
    } catch (error) {
      console.error('Failed to fetch data:', error);
    } finally {
      setLoading(false);
    }
  };

  const deleteThread = async (threadId: string) => {
    if (!confirm('Are you sure you want to delete this thread?')) return;

    try {
      const response = await fetch(`/api/threads/${threadId}`, {
        method: 'DELETE',
      });

      if (response.ok) {
        setThreads(threads.filter((t) => t.id !== threadId));
        if (selectedThread?.id === threadId) {
          setSelectedThread(null);
        }
      }
    } catch (error) {
      console.error('Failed to delete thread:', error);
    }
  };

  const getAgentName = (agentId?: string) => {
    if (!agentId) return 'Unknown Agent';
    return agents.find((a) => a.id === agentId)?.name || 'Unknown Agent';
  };

  const filteredThreads = threads.filter((t) =>
    (t.title || t.id).toLowerCase().includes(search.toLowerCase())
  );

  return (
    <div className="flex h-screen overflow-hidden">
      <Sidebar />
      <div className="flex-1 flex flex-col overflow-hidden">
        <Header />
        <main className="flex-1 flex overflow-hidden">
          {/* Thread List */}
          <div className="w-96 border-r border-border-subtle bg-bg-secondary flex flex-col">
            <div className="p-4 border-b border-border-subtle space-y-4">
              <div className="flex items-center justify-between">
                <h2 className="text-lg font-semibold text-text-primary flex items-center gap-2">
                  <Brain className="w-5 h-5 text-accent" />
                  Memory
                </h2>
                <Badge variant="outline">{threads.length} threads</Badge>
              </div>

              <Input
                placeholder="Search threads..."
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                icon={<Search className="w-4 h-4" />}
              />

              <div className="flex items-center gap-2">
                <Filter className="w-4 h-4 text-text-muted" />
                <select
                  value={selectedAgent}
                  onChange={(e) => setSelectedAgent(e.target.value)}
                  className="flex-1 px-3 py-1.5 bg-bg-elevated border border-border-primary rounded-lg text-sm text-text-primary focus:outline-none focus:ring-2 focus:ring-accent/50"
                >
                  <option value="">All Agents</option>
                  {agents.map((agent) => (
                    <option key={agent.id} value={agent.id}>
                      {agent.name}
                    </option>
                  ))}
                </select>
              </div>
            </div>

            <div className="flex-1 overflow-auto">
              {loading ? (
                <div className="p-4 space-y-3">
                  {[...Array(5)].map((_, i) => (
                    <Skeleton key={i} className="h-20" />
                  ))}
                </div>
              ) : filteredThreads.length === 0 ? (
                <div className="p-4 text-center py-12">
                  <MessageSquare className="w-12 h-12 mx-auto mb-4 text-text-muted opacity-50" />
                  <p className="text-text-secondary">No threads found</p>
                </div>
              ) : (
                <div className="p-2 space-y-1">
                  {filteredThreads.map((thread) => (
                    <button
                      key={thread.id}
                      onClick={() => setSelectedThread(thread)}
                      className={`w-full p-3 rounded-lg text-left transition-colors ${
                        selectedThread?.id === thread.id
                          ? 'bg-accent/10 border border-accent'
                          : 'bg-bg-tertiary hover:bg-bg-hover border border-transparent'
                      }`}
                    >
                      <div className="flex items-start justify-between">
                        <div className="flex-1 min-w-0">
                          <div className="flex items-center gap-2">
                            <MessageSquare className="w-4 h-4 text-accent flex-shrink-0" />
                            <span className="font-medium text-text-primary truncate">
                              {thread.title || 'Untitled Thread'}
                            </span>
                          </div>
                          <div className="flex items-center gap-2 mt-1 text-xs text-text-muted">
                            <Bot className="w-3 h-3" />
                            <span>{getAgentName(thread.agentId)}</span>
                          </div>
                        </div>
                        <div className="flex items-center gap-2">
                          <Badge variant="outline" size="sm">
                            {thread.messageCount}
                          </Badge>
                          <ChevronRight className="w-4 h-4 text-text-muted" />
                        </div>
                      </div>
                      {thread.lastMessageAt && (
                        <div className="flex items-center gap-1 mt-2 text-xs text-text-muted">
                          <Clock className="w-3 h-3" />
                          <span>
                            {formatDistanceToNow(new Date(thread.lastMessageAt), {
                              addSuffix: true,
                            })}
                          </span>
                        </div>
                      )}
                    </button>
                  ))}
                </div>
              )}
            </div>
          </div>

          {/* Thread Detail */}
          <div className="flex-1 flex flex-col bg-bg-primary">
            {selectedThread ? (
              <>
                {/* Thread Header */}
                <div className="p-4 border-b border-border-subtle bg-bg-secondary flex items-center justify-between">
                  <div>
                    <h3 className="font-semibold text-text-primary">
                      {selectedThread.title || 'Untitled Thread'}
                    </h3>
                    <div className="flex items-center gap-3 mt-1 text-sm text-text-muted">
                      <span className="flex items-center gap-1">
                        <Bot className="w-4 h-4" />
                        {getAgentName(selectedThread.agentId)}
                      </span>
                      <span className="flex items-center gap-1">
                        <MessageSquare className="w-4 h-4" />
                        {selectedThread.messageCount} messages
                      </span>
                    </div>
                  </div>
                  <Button
                    variant="danger"
                    size="sm"
                    onClick={() => deleteThread(selectedThread.id)}
                  >
                    <Trash2 className="w-4 h-4" />
                    Delete
                  </Button>
                </div>

                {/* Thread Content */}
                <div className="flex-1 overflow-auto p-6">
                  <div className="max-w-3xl mx-auto space-y-4">
                    <Card>
                      <h4 className="font-medium text-text-primary mb-4">
                        Thread Info
                      </h4>
                      <div className="space-y-3 text-sm">
                        <div className="flex justify-between">
                          <span className="text-text-muted">ID</span>
                          <span className="text-text-primary font-mono">
                            {selectedThread.id}
                          </span>
                        </div>
                        <div className="flex justify-between">
                          <span className="text-text-muted">Created</span>
                          <span className="text-text-primary">
                            {new Date(selectedThread.createdAt).toLocaleString()}
                          </span>
                        </div>
                        <div className="flex justify-between">
                          <span className="text-text-muted">Updated</span>
                          <span className="text-text-primary">
                            {new Date(selectedThread.updatedAt).toLocaleString()}
                          </span>
                        </div>
                        <div className="flex justify-between">
                          <span className="text-text-muted">Messages</span>
                          <span className="text-text-primary">
                            {selectedThread.messageCount}
                          </span>
                        </div>
                      </div>
                    </Card>

                    {Object.keys(selectedThread.metadata).length > 0 && (
                      <Card>
                        <h4 className="font-medium text-text-primary mb-4">
                          Metadata
                        </h4>
                        <pre className="text-sm bg-bg-tertiary p-3 rounded-lg overflow-x-auto">
                          {JSON.stringify(selectedThread.metadata, null, 2)}
                        </pre>
                      </Card>
                    )}

                    <Card className="bg-bg-tertiary border-dashed">
                      <div className="text-center py-8 text-text-muted">
                        <Brain className="w-12 h-12 mx-auto mb-4 opacity-50" />
                        <p className="text-sm">
                          Message history is stored in the memory adapter.
                        </p>
                        <p className="text-xs mt-1">
                          Use the Playground to view and continue conversations.
                        </p>
                      </div>
                    </Card>
                  </div>
                </div>
              </>
            ) : (
              <div className="flex-1 flex items-center justify-center">
                <div className="text-center">
                  <Brain className="w-16 h-16 mx-auto mb-4 text-text-muted opacity-50" />
                  <h3 className="text-lg font-medium text-text-primary mb-2">
                    Select a Thread
                  </h3>
                  <p className="text-text-secondary max-w-sm">
                    Choose a thread from the list to view its details and metadata.
                  </p>
                </div>
              </div>
            )}
          </div>
        </main>
      </div>
    </div>
  );
}
