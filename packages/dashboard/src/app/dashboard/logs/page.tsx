'use client';

import { useEffect, useState, useRef } from 'react';
import { Card } from '@/components/ui/Card';
import { Badge } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import { Input } from '@/components/ui/Input';
import { Search, RefreshCw, ArrowDown, AlertCircle, Info, AlertTriangle, Bug } from 'lucide-react';
import { format } from 'date-fns';

interface LogEntry {
  id: string;
  timestamp: string;
  level: 'debug' | 'info' | 'warn' | 'error';
  message: string;
  source?: string;
  agentId?: string;
  runId?: string;
  metadata?: Record<string, unknown>;
}

const levelConfig = {
  debug: {
    icon: Bug,
    variant: 'outline' as const,
    color: 'text-text-muted',
    bg: 'bg-bg-tertiary',
  },
  info: {
    icon: Info,
    variant: 'info' as const,
    color: 'text-info',
    bg: 'bg-info/10',
  },
  warn: {
    icon: AlertTriangle,
    variant: 'warning' as const,
    color: 'text-warning',
    bg: 'bg-warning/10',
  },
  error: {
    icon: AlertCircle,
    variant: 'error' as const,
    color: 'text-error',
    bg: 'bg-error/10',
  },
};

export default function LogsPage() {
  const [logs, setLogs] = useState<LogEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState('');
  const [levelFilter, setLevelFilter] = useState<string | null>(null);
  const [autoScroll, setAutoScroll] = useState(true);
  const [expandedLogs, setExpandedLogs] = useState<Set<string>>(new Set());
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    async function fetchLogs() {
      try {
        let url = '/api/logs?limit=500';
        if (levelFilter) url += `&level=${levelFilter}`;

        const response = await fetch(url);
        if (response.ok) {
          const data = await response.json();
          setLogs(data.logs || []);
        }
      } catch (error) {
        console.error('Failed to fetch logs:', error);
      } finally {
        setLoading(false);
      }
    }

    fetchLogs();
    const interval = setInterval(fetchLogs, 5000);
    return () => clearInterval(interval);
  }, [levelFilter]);

  useEffect(() => {
    if (autoScroll && containerRef.current) {
      containerRef.current.scrollTop = containerRef.current.scrollHeight;
    }
  }, [logs, autoScroll]);

  const filteredLogs = logs.filter((log) =>
    log.message.toLowerCase().includes(search.toLowerCase())
  );

  const toggleExpand = (id: string) => {
    setExpandedLogs((prev) => {
      const next = new Set(prev);
      if (next.has(id)) {
        next.delete(id);
      } else {
        next.add(id);
      }
      return next;
    });
  };

  return (
    <div className="h-full max-w-7xl mx-auto flex flex-col">
      {/* Header */}
      <div className="flex-shrink-0 space-y-4 mb-4">
        <div className="flex items-center justify-between animate-fade-in">
          <div>
            <h1 className="text-2xl font-semibold text-text-primary">Logs</h1>
            <p className="text-text-secondary mt-1">Real-time system and agent logs</p>
          </div>
          <div className="flex items-center gap-2">
            <Button
              variant={autoScroll ? 'primary' : 'ghost'}
              size="sm"
              onClick={() => setAutoScroll(!autoScroll)}
              className="gap-2"
            >
              <ArrowDown className="w-4 h-4" />
              Auto-scroll
            </Button>
            <Button variant="ghost" size="sm" onClick={() => setLoading(true)} className="gap-2">
              <RefreshCw className={`w-4 h-4 ${loading ? 'animate-spin' : ''}`} />
              Refresh
            </Button>
          </div>
        </div>

        <div className="flex flex-col sm:flex-row gap-4 animate-fade-in">
          <Input
            placeholder="Filter logs..."
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            icon={<Search className="w-4 h-4" />}
            className="sm:max-w-md"
          />
          <div className="flex gap-2">
            <Button
              variant={levelFilter === null ? 'primary' : 'ghost'}
              size="sm"
              onClick={() => setLevelFilter(null)}
            >
              All
            </Button>
            {['debug', 'info', 'warn', 'error'].map((level) => (
              <Button
                key={level}
                variant={levelFilter === level ? 'primary' : 'ghost'}
                size="sm"
                onClick={() => setLevelFilter(level)}
              >
                {level.charAt(0).toUpperCase() + level.slice(1)}
              </Button>
            ))}
          </div>
        </div>
      </div>

      {/* Log Container */}
      <Card className="flex-1 overflow-hidden p-0">
        <div ref={containerRef} className="h-full overflow-auto font-mono text-sm">
          {filteredLogs.length === 0 ? (
            <div className="p-8 text-center text-text-muted">
              {loading ? 'Loading logs...' : 'No logs to display'}
            </div>
          ) : (
            <div className="divide-y divide-border-primary">
              {filteredLogs.map((log) => {
                const config = levelConfig[log.level];
                const Icon = config.icon;
                const isExpanded = expandedLogs.has(log.id);

                return (
                  <div
                    key={log.id}
                    className={`p-3 hover:bg-bg-tertiary transition-colors cursor-pointer ${
                      log.level === 'error' ? 'bg-error/5' : ''
                    }`}
                    onClick={() => log.metadata && toggleExpand(log.id)}
                  >
                    <div className="flex items-start gap-3">
                      <span className="text-text-muted text-xs w-20 flex-shrink-0">
                        {format(new Date(log.timestamp), 'HH:mm:ss.SSS')}
                      </span>
                      <div className={`p-1 rounded ${config.bg}`}>
                        <Icon className={`w-3 h-3 ${config.color}`} />
                      </div>
                      <Badge
                        variant={config.variant}
                        size="sm"
                        className="flex-shrink-0 w-14 justify-center"
                      >
                        {log.level}
                      </Badge>
                      <div className="flex-1 min-w-0">
                        <p className={`break-all ${config.color}`}>{log.message}</p>
                        {log.source && (
                          <p className="text-xs text-text-muted mt-1">Source: {log.source}</p>
                        )}
                        {isExpanded && log.metadata && (
                          <pre className="mt-2 p-2 bg-bg-primary rounded text-xs overflow-auto">
                            {JSON.stringify(log.metadata, null, 2)}
                          </pre>
                        )}
                      </div>
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      </Card>
    </div>
  );
}
