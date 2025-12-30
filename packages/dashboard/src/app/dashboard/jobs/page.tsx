'use client';

import { useEffect, useState } from 'react';
import { Sidebar } from '@/components/layout/Sidebar';
import { Header } from '@/components/layout/Header';
import { Briefcase, Clock, CheckCircle2, XCircle, Loader2, Ban, RefreshCw } from 'lucide-react';
import Link from 'next/link';

interface Job {
  id: string;
  type: 'agent' | 'workflow' | 'swarm';
  targetId: string;
  input: string;
  status: 'pending' | 'running' | 'completed' | 'failed' | 'cancelled';
  output?: string;
  error?: string;
  progress?: number;
  createdAt: string;
  startedAt?: string;
  completedAt?: string;
}

interface QueueStats {
  pending: number;
  running: number;
  completed: number;
  failed: number;
}

const statusConfig: Record<string, { icon: typeof Clock; color: string; bg: string; animate?: boolean }> = {
  pending: { icon: Clock, color: 'text-yellow-400', bg: 'bg-yellow-400/10' },
  running: { icon: Loader2, color: 'text-blue-400', bg: 'bg-blue-400/10', animate: true },
  completed: { icon: CheckCircle2, color: 'text-green-400', bg: 'bg-green-400/10' },
  failed: { icon: XCircle, color: 'text-red-400', bg: 'bg-red-400/10' },
  cancelled: { icon: Ban, color: 'text-text-tertiary', bg: 'bg-bg-tertiary' },
};

export default function JobsPage() {
  const [jobs, setJobs] = useState<Job[]>([]);
  const [stats, setStats] = useState<QueueStats | null>(null);
  const [loading, setLoading] = useState(true);
  const [filter, setFilter] = useState<string>('all');

  async function fetchData() {
    try {
      const [jobsRes, statsRes] = await Promise.all([
        fetch(`/api/jobs${filter !== 'all' ? `?status=${filter}` : ''}`),
        fetch('/api/jobs?stats=true'),
      ]);

      if (jobsRes.ok) {
        const data = await jobsRes.json();
        setJobs(data);
      }
      if (statsRes.ok) {
        const data = await statsRes.json();
        setStats(data);
      }
    } catch (error) {
      console.error('Failed to fetch jobs:', error);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    fetchData();
    const interval = setInterval(fetchData, 5000);
    return () => clearInterval(interval);
  }, [filter]);

  async function cancelJob(id: string) {
    try {
      const response = await fetch(`/api/jobs/${id}`, { method: 'DELETE' });
      if (response.ok) {
        fetchData();
      }
    } catch (error) {
      console.error('Failed to cancel job:', error);
    }
  }

  return (
    <div className="flex h-screen overflow-hidden">
      <Sidebar />
      <div className="flex-1 flex flex-col overflow-hidden">
        <Header />
        <main className="flex-1 overflow-auto p-6 bg-bg-primary bg-noise">
          <div className="max-w-7xl mx-auto space-y-6">
            <div className="flex items-center justify-between animate-fade-in">
              <div>
                <h1 className="text-2xl font-semibold text-text-primary flex items-center gap-3">
                  <Briefcase className="w-7 h-7 text-accent-primary" />
                  Background Jobs
                </h1>
                <p className="text-text-secondary mt-1">
                  Monitor and manage background tasks
                </p>
              </div>
              <button
                onClick={() => fetchData()}
                className="px-4 py-2 bg-bg-secondary border border-border-primary rounded-lg text-text-secondary hover:text-text-primary hover:border-border-hover transition-all flex items-center gap-2"
              >
                <RefreshCw className="w-4 h-4" />
                Refresh
              </button>
            </div>

            {/* Stats */}
            {stats && (
              <div className="grid grid-cols-2 md:grid-cols-4 gap-4 animate-fade-in" style={{ animationDelay: '100ms' }}>
                {Object.entries(stats).map(([key, value]) => {
                  const config = statusConfig[key as keyof typeof statusConfig];
                  const Icon = config?.icon || Clock;
                  return (
                    <button
                      key={key}
                      onClick={() => setFilter(filter === key ? 'all' : key)}
                      className={`p-4 rounded-xl border transition-all ${
                        filter === key
                          ? 'bg-accent-primary/10 border-accent-primary'
                          : 'bg-bg-secondary border-border-primary hover:border-border-hover'
                      }`}
                    >
                      <div className="flex items-center justify-between">
                        <span className="text-text-secondary capitalize">{key}</span>
                        <Icon className={`w-5 h-5 ${config?.color || 'text-text-tertiary'} ${config?.animate ? 'animate-spin' : ''}`} />
                      </div>
                      <div className="text-2xl font-semibold text-text-primary mt-2">{value}</div>
                    </button>
                  );
                })}
              </div>
            )}

            {/* Jobs List */}
            <div className="bg-bg-secondary border border-border-primary rounded-xl overflow-hidden animate-fade-in" style={{ animationDelay: '200ms' }}>
              {loading ? (
                <div className="p-8 text-center">
                  <Loader2 className="w-8 h-8 animate-spin text-accent-primary mx-auto" />
                </div>
              ) : jobs.length === 0 ? (
                <div className="p-8 text-center text-text-secondary">
                  No jobs found
                </div>
              ) : (
                <div className="divide-y divide-border-primary">
                  {jobs.map((job) => {
                    const config = statusConfig[job.status];
                    const Icon = config.icon;
                    return (
                      <div key={job.id} className="p-4 hover:bg-bg-tertiary/50 transition-colors">
                        <div className="flex items-center justify-between">
                          <div className="flex items-center gap-4">
                            <div className={`w-10 h-10 rounded-lg ${config.bg} flex items-center justify-center`}>
                              <Icon className={`w-5 h-5 ${config.color} ${config.animate ? 'animate-spin' : ''}`} />
                            </div>
                            <div>
                              <Link href={`/jobs/${job.id}`} className="text-text-primary hover:text-accent-primary transition-colors font-medium">
                                {job.id}
                              </Link>
                              <div className="text-sm text-text-secondary">
                                {job.type} • {job.targetId}
                              </div>
                            </div>
                          </div>
                          <div className="flex items-center gap-4">
                            <div className="text-right">
                              <div className="text-sm text-text-tertiary">
                                {new Date(job.createdAt).toLocaleString()}
                              </div>
                              {job.progress !== undefined && job.status === 'running' && (
                                <div className="text-sm text-accent-primary">
                                  {job.progress}% complete
                                </div>
                              )}
                            </div>
                            {(job.status === 'pending' || job.status === 'running') && (
                              <button
                                onClick={() => cancelJob(job.id)}
                                className="px-3 py-1.5 text-sm bg-red-500/10 text-red-400 rounded-lg hover:bg-red-500/20 transition-colors"
                              >
                                Cancel
                              </button>
                            )}
                          </div>
                        </div>
                        {job.error && (
                          <div className="mt-3 text-sm text-red-400 bg-red-500/10 rounded-lg p-3">
                            {job.error}
                          </div>
                        )}
                      </div>
                    );
                  })}
                </div>
              )}
            </div>
          </div>
        </main>
      </div>
    </div>
  );
}
