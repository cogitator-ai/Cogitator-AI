import {
  Activity,
  Bot,
  Keyboard,
  LayoutDashboard,
  Monitor,
  Moon,
  Network,
  Search,
  Sun,
  Workflow,
  type LucideIcon,
} from 'lucide-react';
import type { ReactNode } from 'react';
import { MOD } from '../hotkeys';
import { href } from '../router';
import { useStudio } from '../store';
import { resolvedTheme, setTheme, toggleTheme, useTheme, type ThemePreference } from '../theme';
import { Kbd } from './common';

export function Logo({ className }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 32 32" aria-hidden="true">
      <rect width="32" height="32" rx="8" fill="currentColor" />
      <path
        d="M21 11.2A7 7 0 1 0 21 20.8"
        fill="none"
        stroke="var(--bg)"
        strokeWidth="3"
        strokeLinecap="round"
      />
      <circle cx="16" cy="16" r="2" fill="var(--bg)" />
    </svg>
  );
}

function NavLink({
  to,
  icon: Icon,
  active,
  children,
  meta,
  testId,
}: {
  to: string[];
  icon: LucideIcon;
  active: boolean;
  children: ReactNode;
  meta?: ReactNode;
  testId?: string;
}) {
  return (
    <a
      href={href(...to)}
      className={`sb-link ${active ? 'active' : ''}`}
      aria-current={active ? 'page' : undefined}
      data-testid={testId}
    >
      <Icon size={15} />
      <span className="sb-text truncate">{children}</span>
      {meta !== undefined && <span className="sb-meta">{meta}</span>}
    </a>
  );
}

const THEMES: Array<{ value: ThemePreference; icon: LucideIcon; label: string }> = [
  { value: 'system', icon: Monitor, label: 'System theme' },
  { value: 'light', icon: Sun, label: 'Light theme' },
  { value: 'dark', icon: Moon, label: 'Dark theme' },
];

export function Sidebar({
  route,
  onSearch,
  onShortcuts,
}: {
  route: string[];
  onSearch: () => void;
  onShortcuts: () => void;
}) {
  const host = useStudio((state) => state.host);
  const project = useStudio((state) => state.project);
  const connected = useStudio((state) => state.connected);
  const runs = useStudio((state) => state.runs);
  const theme = useTheme();
  const registry = host.state === 'ready' ? host.registry : undefined;
  const is = (...parts: string[]) => parts.every((part, i) => route[i] === part);
  const live = new Set(
    Object.values(runs)
      .filter((run) => run.status === 'running' || run.status === 'waiting')
      .map((run) => run.target)
  );
  const state = connected ? host.state : 'offline';
  const stateLabel: Record<typeof state, string> = {
    ready: 'Project loaded',
    starting: 'Loading the project',
    restarting: 'Reloading the project',
    failed: 'The project does not load',
    offline: 'Reconnecting to cogitator dev',
  };

  return (
    <nav className="sidebar" aria-label="Studio">
      <div className="sb-top">
        <a className="sb-brand" href="#/">
          <Logo className="sb-mark" />
          <span className="sb-text" style={{ minWidth: 0 }}>
            <div className="sb-name">Cogitator Studio</div>
            <div className="sb-project">
              <span className="dot" data-state={state} />
              <span className="truncate">{project || 'project'}</span>
            </div>
          </span>
        </a>
        <button type="button" className="sb-search" onClick={onSearch} data-testid="open-palette">
          <Search size={14} />
          <span>Search</span>
          <Kbd keys={[MOD, 'K']} />
        </button>
      </div>
      <div className="sb-nav">
        <NavLink to={[]} icon={LayoutDashboard} active={route.length === 0}>
          Overview
        </NavLink>
        <NavLink
          to={['runs']}
          icon={Activity}
          active={route[0] === 'runs' || route[0] === 'compare'}
          testId="nav-runs"
          meta={live.size > 0 ? <span className="spinner" aria-label="runs going" /> : undefined}
        >
          Runs
        </NavLink>

        <div className="sb-section">
          <div className="sb-section-title">Agents</div>
          {registry?.agents.map((agent) => (
            <NavLink
              key={agent.key}
              to={['agents', agent.key]}
              icon={Bot}
              active={is('agents', agent.key)}
              testId={`agent-${agent.key}`}
              meta={
                live.has(agent.key) ? <span className="dot" data-state="starting" /> : undefined
              }
            >
              {agent.name}
            </NavLink>
          ))}
          {registry?.agents.length === 0 && <div className="sb-empty">None registered</div>}
          {!registry && <div className="skeleton" style={{ height: 22, margin: '4px 8px' }} />}
        </div>

        {registry && registry.workflows.length > 0 && (
          <div className="sb-section">
            <div className="sb-section-title">Workflows</div>
            {registry.workflows.map((workflow) => (
              <NavLink
                key={workflow.key}
                to={['workflows', workflow.key]}
                icon={Workflow}
                active={is('workflows', workflow.key)}
                meta={
                  live.has(workflow.key) ? (
                    <span className="dot" data-state="starting" />
                  ) : undefined
                }
              >
                {workflow.name}
              </NavLink>
            ))}
          </div>
        )}

        {registry && registry.swarms.length > 0 && (
          <div className="sb-section">
            <div className="sb-section-title">Swarms</div>
            {registry.swarms.map((swarm) => (
              <div
                key={swarm.key}
                className="sb-link sb-static"
                data-tip={`${swarm.strategy}: ${swarm.agents.join(', ')}`}
              >
                <Network size={15} />
                <span className="sb-text truncate">{swarm.name}</span>
                <span className="sb-meta">{swarm.strategy}</span>
              </div>
            ))}
          </div>
        )}
      </div>
      <div className="sb-footer">
        <div className="sb-conn" data-tip={stateLabel[state]}>
          <span className="dot" data-state={state} />
          <span>{connected ? 'Live' : 'Offline'}</span>
        </div>
        <div className="sb-tools">
          <div className="seg seg-icons sb-themes" role="group" aria-label="Theme">
            {THEMES.map(({ value, icon: Icon, label }) => (
              <button
                key={value}
                type="button"
                aria-pressed={theme === value}
                aria-label={label}
                data-tip={label}
                onClick={() => setTheme(value)}
              >
                <Icon size={13} />
              </button>
            ))}
          </div>
          <button
            type="button"
            className="btn btn-ghost btn-icon btn-sm sb-theme-toggle"
            onClick={toggleTheme}
            aria-label="Switch theme"
            data-tip="Switch theme"
          >
            {resolvedTheme() === 'dark' ? <Sun size={14} /> : <Moon size={14} />}
          </button>
          <button
            type="button"
            className="btn btn-ghost btn-icon btn-sm"
            onClick={onShortcuts}
            aria-label="Keyboard shortcuts"
            data-tip="Shortcuts"
          >
            <Keyboard size={14} />
          </button>
        </div>
      </div>
    </nav>
  );
}
