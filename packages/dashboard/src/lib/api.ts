import type { Agent, Run, LogEntry, AnalyticsData, DashboardStats, SystemHealth, TraceSpan } from '@/types';

const API_BASE = '/api';

async function fetchJSON<T>(url: string, options?: RequestInit): Promise<T> {
  const response = await fetch(`${API_BASE}${url}`, {
    headers: {
      'Content-Type': 'application/json',
      ...options?.headers,
    },
    ...options,
  });

  if (!response.ok) {
    const error = await response.json().catch(() => ({ message: 'Unknown error' }));
    throw new Error(error.message || `HTTP ${response.status}`);
  }

  return response.json();
}

export const api = {
  async getAgents(): Promise<Agent[]> {
    return fetchJSON('/agents');
  },

  async getAgent(id: string): Promise<Agent> {
    return fetchJSON(`/agents/${id}`);
  },

  async createAgent(data: Partial<Agent>): Promise<Agent> {
    return fetchJSON('/agents', {
      method: 'POST',
      body: JSON.stringify(data),
    });
  },

  async updateAgent(id: string, data: Partial<Agent>): Promise<Agent> {
    return fetchJSON(`/agents/${id}`, {
      method: 'PATCH',
      body: JSON.stringify(data),
    });
  },

  async deleteAgent(id: string): Promise<void> {
    return fetchJSON(`/agents/${id}`, {
      method: 'DELETE',
    });
  },

  async getRuns(options?: { agentId?: string; status?: string; limit?: number }): Promise<{ runs: Run[]; stats: unknown }> {
    const params = new URLSearchParams();
    if (options?.agentId) params.set('agentId', options.agentId);
    if (options?.status) params.set('status', options.status);
    if (options?.limit) params.set('limit', String(options.limit));
    const query = params.toString();
    return fetchJSON(`/runs${query ? `?${query}` : ''}`);
  },

  async getRun(id: string): Promise<Run> {
    return fetchJSON(`/runs/${id}`);
  },

  async getRunTrace(id: string): Promise<TraceSpan[]> {
    const run = await fetchJSON<Run>(`/runs/${id}`);
    return run.spans || [];
  },

  async getAnalytics(period: 'hour' | 'day' | 'week' | 'month' = 'day'): Promise<AnalyticsData> {
    return fetchJSON(`/analytics?period=${period}`);
  },

  async getDashboardStats(): Promise<DashboardStats> {
    return fetchJSON('/analytics');
  },

  async getLogs(options?: { level?: string; limit?: number; since?: string }): Promise<{ logs: LogEntry[]; stats: unknown }> {
    const params = new URLSearchParams();
    if (options?.level) params.set('level', options.level);
    if (options?.limit) params.set('limit', String(options.limit));
    if (options?.since) params.set('since', options.since);
    const query = params.toString();
    return fetchJSON(`/logs${query ? `?${query}` : ''}`);
  },

  async getConfig(): Promise<unknown> {
    return fetchJSON('/config');
  },

  async updateConfig(config: unknown): Promise<void> {
    return fetchJSON('/config', {
      method: 'PUT',
      body: JSON.stringify(config),
    });
  },

  async getModels(): Promise<{ id: string; name: string; provider: string; pricing: { input: number; output: number } }[]> {
    return fetchJSON('/models');
  },

  async getHealth(): Promise<SystemHealth> {
    return fetchJSON('/health');
  },
};
