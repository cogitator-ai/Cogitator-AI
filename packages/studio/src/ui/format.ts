import type { AgentInfo, RegistryInfo } from '../protocol';

/** USD as the studio shows it; `priced: false` means no model of the run has a known price. */
export function formatCost(usd: number | undefined, priced = true): string {
  if (usd === undefined || (!priced && usd === 0)) return 'unpriced';
  if (usd === 0) return '$0';
  if (usd < 0.0001) return '<$0.0001';
  if (usd < 1) return `$${usd.toFixed(4)}`;
  return `$${usd.toFixed(2)}`;
}

export function formatDuration(ms: number | undefined): string {
  if (ms === undefined) return '';
  if (ms < 1000) return `${Math.round(ms)} ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(ms < 10_000 ? 2 : 1)} s`;
  const minutes = Math.floor(ms / 60_000);
  return `${minutes} min ${Math.round((ms % 60_000) / 1000)} s`;
}

export function formatTokens(count: number | undefined): string {
  if (count === undefined) return '';
  return count >= 10_000 ? `${(count / 1000).toFixed(1)}k` : String(count);
}

export function timeAgo(at: number, now = Date.now()): string {
  const seconds = Math.max(0, Math.round((now - at) / 1000));
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 48) return `${hours} h ago`;
  return new Date(at).toLocaleDateString();
}

export function pretty(value: unknown): string {
  if (typeof value === 'string') return value;
  try {
    return JSON.stringify(value, null, 2) ?? String(value);
  } catch {
    return String(value);
  }
}

export function excerpt(text: string | undefined, length = 90): string {
  const flat = (text ?? '').replace(/\s+/g, ' ').trim();
  return flat.length > length ? `${flat.slice(0, length - 1)}…` : flat;
}

export function formatCount(count: number): string {
  if (count >= 1_000_000) return `${(count / 1_000_000).toFixed(1)}M`;
  if (count >= 10_000) return `${(count / 1000).toFixed(1)}k`;
  return count.toLocaleString('en-US');
}

export function formatDay(at: number): string {
  return new Date(at).toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}

export function formatTime(at: number): string {
  return new Date(at).toLocaleString('en-US', {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });
}

/** The model an agent runs on: its own, or the runtime's default. */
export function agentModel(agent: AgentInfo, registry: RegistryInfo): string {
  return agent.model ?? registry.defaultModel ?? 'default model';
}
