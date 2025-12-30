'use client';

import { useEffect, useState } from 'react';
import { Card } from '@/components/ui/Card';
import { Badge } from '@/components/ui/Badge';
import { Skeleton } from '@/components/ui/Skeleton';
import { Database, Server, Cpu, CheckCircle, XCircle, AlertCircle } from 'lucide-react';

interface HealthData {
  status: 'healthy' | 'degraded' | 'unhealthy';
  services: {
    database: { status: 'up' | 'down'; latency?: number };
    redis: { status: 'up' | 'down'; latency?: number };
    ollama: { status: 'up' | 'down'; models?: string[] };
  };
  uptime: number;
}

const statusConfig = {
  up: { icon: CheckCircle, color: 'text-success', bg: 'bg-success/10' },
  down: { icon: XCircle, color: 'text-error', bg: 'bg-error/10' },
};

const overallStatusConfig = {
  healthy: { variant: 'success' as const, label: 'All systems operational' },
  degraded: { variant: 'warning' as const, label: 'Partial outage' },
  unhealthy: { variant: 'error' as const, label: 'System issues' },
};

export function SystemHealth() {
  const [health, setHealth] = useState<HealthData | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    async function fetchHealth() {
      try {
        const response = await fetch('/api/health');
        if (response.ok) {
          const data = await response.json();
          setHealth(data);
        }
      } catch (error) {
        console.error('Failed to fetch health:', error);
        setHealth({
          status: 'unhealthy',
          services: {
            database: { status: 'down' },
            redis: { status: 'down' },
            ollama: { status: 'down' },
          },
          uptime: 0,
        });
      } finally {
        setLoading(false);
      }
    }

    fetchHealth();
    const interval = setInterval(fetchHealth, 30000);
    return () => clearInterval(interval);
  }, []);

  if (loading) {
    return (
      <Card>
        <div className="flex items-center justify-between mb-4">
          <Skeleton className="h-5 w-32" />
          <Skeleton className="h-5 w-20" />
        </div>
        <div className="space-y-3">
          {[...Array(3)].map((_, i) => (
            <div key={i} className="flex items-center gap-3 p-2">
              <Skeleton className="h-8 w-8 rounded" />
              <div className="flex-1">
                <Skeleton className="h-4 w-20" />
              </div>
              <Skeleton className="h-4 w-12" />
            </div>
          ))}
        </div>
      </Card>
    );
  }

  const services = [
    {
      name: 'PostgreSQL',
      key: 'database' as const,
      icon: Database,
      detail: health?.services.database.latency
        ? `${health.services.database.latency}ms`
        : undefined,
    },
    {
      name: 'Redis',
      key: 'redis' as const,
      icon: Server,
      detail: health?.services.redis.latency
        ? `${health.services.redis.latency}ms`
        : undefined,
    },
    {
      name: 'Ollama',
      key: 'ollama' as const,
      icon: Cpu,
      detail: health?.services.ollama.models?.length
        ? `${health.services.ollama.models.length} models`
        : undefined,
    },
  ];

  const overallConfig = overallStatusConfig[health?.status || 'unhealthy'];

  return (
    <Card>
      <div className="flex items-center justify-between mb-4">
        <h3 className="text-lg font-medium text-text-primary">System Health</h3>
        <Badge variant={overallConfig.variant} size="sm">
          {health?.status || 'unknown'}
        </Badge>
      </div>

      <div className="space-y-2">
        {services.map((service) => {
          const serviceHealth = health?.services[service.key];
          const status = serviceHealth?.status || 'down';
          const config = statusConfig[status];
          const Icon = config.icon;
          const ServiceIcon = service.icon;

          return (
            <div
              key={service.key}
              className="flex items-center gap-3 p-2 rounded-lg"
            >
              <div className={`p-2 rounded ${config.bg}`}>
                <ServiceIcon className={`w-4 h-4 ${config.color}`} />
              </div>

              <div className="flex-1">
                <p className="text-sm font-medium text-text-primary">
                  {service.name}
                </p>
                {service.detail && (
                  <p className="text-xs text-text-muted">{service.detail}</p>
                )}
              </div>

              <Icon className={`w-4 h-4 ${config.color}`} />
            </div>
          );
        })}
      </div>

      {health && (
        <div className="mt-4 pt-3 border-t border-border-primary">
          <p className="text-xs text-text-muted text-center">
            Uptime: {formatUptime(health.uptime)}
          </p>
        </div>
      )}
    </Card>
  );
}

function formatUptime(seconds: number): string {
  const days = Math.floor(seconds / 86400);
  const hours = Math.floor((seconds % 86400) / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);

  if (days > 0) return `${days}d ${hours}h`;
  if (hours > 0) return `${hours}h ${minutes}m`;
  return `${minutes}m`;
}
