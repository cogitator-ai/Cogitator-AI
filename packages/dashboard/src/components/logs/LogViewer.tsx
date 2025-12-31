'use client';

import { useState, useEffect, useRef, useMemo } from 'react';
import { Button } from '@/components/ui/Button';
import { Input } from '@/components/ui/Input';
import { cn } from '@/lib/cn';
import {
  Search,
  Play,
  Pause,
  Trash2,
  Download,
  ChevronDown,
  FileText,
} from 'lucide-react';
import { format } from 'date-fns';

interface LogEntry {
  id: string;
  timestamp: Date;
  level: 'debug' | 'info' | 'warn' | 'error';
  message: string;
  source: string;
  metadata?: Record<string, unknown>;
}

interface ApiLog {
  id: string;
  level: string;
  message: string;
  source: string | null;
  metadata: Record<string, unknown> | null;
  created_at: string;
}

const levelConfig = {
  debug: { color: 'text-text-tertiary', bg: 'bg-text-tertiary/10' },
  info: { color: 'text-info', bg: 'bg-info/10' },
  warn: { color: 'text-warning', bg: 'bg-warning/10' },
  error: { color: 'text-error', bg: 'bg-error/10' },
};

function normalizeLevel(level: string): LogEntry['level'] {
  const l = level.toLowerCase();
  if (l === 'warning') return 'warn';
  if (['debug', 'info', 'warn', 'error'].includes(l)) return l as LogEntry['level'];
  return 'info';
}

function apiLogToLogEntry(log: ApiLog): LogEntry {
  return {
    id: log.id,
    timestamp: new Date(log.created_at),
    level: normalizeLevel(log.level),
    message: log.message,
    source: log.source || 'unknown',
    metadata: log.metadata || undefined,
  };
}

export function LogViewer() {
  const [logs, setLogs] = useState<LogEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [isLive, setIsLive] = useState(true);
  const [search, setSearch] = useState('');
  const [levelFilter, setLevelFilter] = useState<LogEntry['level'] | 'all'>('all');
  const [expandedLog, setExpandedLog] = useState<string | null>(null);
  const [lastUpdate, setLastUpdate] = useState(new Date());
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    fetch('/api/logs?limit=100')
      .then((res) => res.json())
      .then((data) => {
        if (data.logs) {
          setLogs(data.logs.map(apiLogToLogEntry));
        }
        setLoading(false);
        setLastUpdate(new Date());
      })
      .catch((err) => {
        console.error('Failed to fetch logs:', err);
        setLoading(false);
      });
  }, []);

  useEffect(() => {
    if (!isLive) return;

    const eventSource = new EventSource('/api/events');

    const handleLogEvent = (event: MessageEvent) => {
      try {
        const log = JSON.parse(event.data);
        const entry = apiLogToLogEntry(log);
        setLogs((prev) => [entry, ...prev.slice(0, 199)]);
        setLastUpdate(new Date());
      } catch (err) {
        console.error('Failed to parse log event:', err);
      }
    };

    eventSource.addEventListener('cogitator:log:entry', handleLogEvent);
    eventSource.addEventListener('message', (event) => {
      if (event.data.includes('"level"')) {
        handleLogEvent(event);
      }
    });

    eventSource.onerror = () => {
      console.warn('SSE connection error, will retry...');
    };

    return () => {
      eventSource.close();
    };
  }, [isLive]);

  useEffect(() => {
    if (isLive && containerRef.current) {
      containerRef.current.scrollTop = 0;
    }
  }, [logs, isLive]);

  const filteredLogs = useMemo(() => {
    return logs.filter((log) => {
      if (levelFilter !== 'all' && log.level !== levelFilter) return false;
      if (search && !log.message.toLowerCase().includes(search.toLowerCase())) {
        return false;
      }
      return true;
    });
  }, [logs, search, levelFilter]);

  const clearLogs = () => setLogs([]);

  const downloadLogs = () => {
    const content = filteredLogs
      .map((log) => `${format(log.timestamp, 'yyyy-MM-dd HH:mm:ss.SSS')} [${log.level.toUpperCase()}] [${log.source}] ${log.message}`)
      .join('\n');
    const blob = new Blob([content], { type: 'text/plain' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `cogitator-logs-${format(new Date(), 'yyyy-MM-dd-HHmmss')}.txt`;
    a.click();
    URL.revokeObjectURL(url);
  };

  return (
    <div className="h-full flex flex-col">
      <div className="flex items-center justify-between p-4 border-b border-border-subtle bg-bg-secondary">
        <div className="flex items-center gap-4">
          <div className="w-64">
            <Input
              placeholder="Search logs..."
              icon={<Search className="w-4 h-4" />}
              value={search}
              onChange={(e) => setSearch(e.target.value)}
            />
          </div>
          <div className="flex items-center gap-1">
            <Button
              variant={levelFilter === 'all' ? 'default' : 'ghost'}
              size="sm"
              onClick={() => setLevelFilter('all')}
            >
              All
            </Button>
            {(['debug', 'info', 'warn', 'error'] as const).map((level) => (
              <Button
                key={level}
                variant={levelFilter === level ? 'default' : 'ghost'}
                size="sm"
                onClick={() => setLevelFilter(level)}
                className={cn(levelFilter === level && levelConfig[level].color)}
              >
                {level.charAt(0).toUpperCase() + level.slice(1)}
              </Button>
            ))}
          </div>
        </div>
        <div className="flex items-center gap-2">
          <Button
            variant={isLive ? 'primary' : 'outline'}
            size="sm"
            onClick={() => setIsLive(!isLive)}
            className="gap-2"
          >
            {isLive ? <Pause className="w-4 h-4" /> : <Play className="w-4 h-4" />}
            {isLive ? 'Pause' : 'Resume'}
          </Button>
          <Button variant="ghost" size="sm" onClick={clearLogs}>
            <Trash2 className="w-4 h-4" />
          </Button>
          <Button variant="ghost" size="sm" onClick={downloadLogs}>
            <Download className="w-4 h-4" />
          </Button>
        </div>
      </div>

      {isLive && (
        <div className="flex items-center gap-2 px-4 py-2 bg-accent/5 border-b border-accent/20">
          <span className="w-2 h-2 rounded-full bg-accent pulse-live" />
          <span className="text-xs text-accent">Live tail enabled</span>
        </div>
      )}

      <div
        ref={containerRef}
        className="flex-1 overflow-auto font-mono text-sm bg-bg-primary"
      >
        {loading ? (
          <div className="flex items-center justify-center h-full text-text-tertiary">
            Loading logs...
          </div>
        ) : filteredLogs.length === 0 ? (
          <div className="flex flex-col items-center justify-center h-full text-text-tertiary">
            <FileText className="w-12 h-12 mb-4 opacity-50" />
            <p>{logs.length === 0 ? 'No logs yet' : 'No logs matching your filters'}</p>
          </div>
        ) : (
          filteredLogs.map((log) => {
            const config = levelConfig[log.level];
            const isExpanded = expandedLog === log.id;

            return (
              <div
                key={log.id}
                className={cn(
                  'border-b border-border-subtle hover:bg-bg-hover transition-colors',
                  isExpanded && 'bg-bg-secondary'
                )}
              >
                <button
                  className="w-full px-4 py-2 flex items-start gap-4 text-left"
                  onClick={() => setExpandedLog(isExpanded ? null : log.id)}
                >
                  <span className="text-text-muted w-24 flex-shrink-0">
                    {format(log.timestamp, 'HH:mm:ss.SSS')}
                  </span>

                  <span
                    className={cn(
                      'w-14 flex-shrink-0 px-1.5 py-0.5 rounded text-xs font-medium text-center',
                      config.bg,
                      config.color
                    )}
                  >
                    {log.level.toUpperCase()}
                  </span>

                  <span className="text-text-tertiary w-28 flex-shrink-0 truncate">
                    {log.source}
                  </span>

                  <span className="flex-1 text-text-primary truncate">
                    {log.message}
                  </span>

                  {log.metadata && (
                    <ChevronDown
                      className={cn(
                        'w-4 h-4 text-text-muted transition-transform',
                        isExpanded && 'rotate-180'
                      )}
                    />
                  )}
                </button>

                {isExpanded && log.metadata && (
                  <div className="px-4 pb-3 pt-1 ml-[168px]">
                    <pre className="text-xs text-text-secondary bg-bg-elevated rounded p-2 overflow-x-auto">
                      {JSON.stringify(log.metadata, null, 2)}
                    </pre>
                  </div>
                )}
              </div>
            );
          })
        )}
      </div>

      <div className="flex items-center justify-between px-4 py-2 border-t border-border-subtle bg-bg-secondary text-xs text-text-muted">
        <span>{filteredLogs.length} entries</span>
        <span>
          {isLive ? 'Auto-refreshing' : 'Paused'} • Last updated:{' '}
          {format(lastUpdate, 'HH:mm:ss')}
        </span>
      </div>
    </div>
  );
}
