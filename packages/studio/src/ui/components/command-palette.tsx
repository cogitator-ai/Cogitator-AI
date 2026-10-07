import { useEffect, useMemo, useRef, useState, type KeyboardEvent, type ReactNode } from 'react';
import {
  Activity,
  Bot,
  CornerDownLeft,
  GitFork,
  Keyboard,
  LayoutDashboard,
  Moon,
  Plus,
  Search,
  Sun,
  Workflow,
  type LucideIcon,
} from 'lucide-react';
import type { RunRecord } from '../../protocol';
import { api } from '../api';
import { agentModel, excerpt, timeAgo } from '../format';
import { navigate } from '../router';
import { useStudio } from '../store';
import { resolvedTheme, toggleTheme } from '../theme';
import { Kbd } from './common';

interface Command {
  id: string;
  group: string;
  label: string;
  hint?: ReactNode;
  icon: LucideIcon;
  /** Words it is also found by. */
  keywords?: string;
  run: () => void;
}

function score(command: Command, query: string): number {
  if (!query) return 1;
  const label = command.label.toLowerCase();
  const haystack = `${label} ${command.keywords ?? ''} ${command.group}`.toLowerCase();
  if (label.startsWith(query)) return 3;
  if (label.split(/[\s/:-]+/).some((word) => word.startsWith(query))) return 2;
  return query.split(/\s+/).every((word) => haystack.includes(word)) ? 1 : 0;
}

function runCommand(run: RunRecord, group: string): Command {
  return {
    id: `run-${run.id}`,
    group,
    label: excerpt(run.input, 70) || run.id,
    hint: `${run.target} · ${timeAgo(run.startedAt)}`,
    icon: run.kind === 'workflow' ? Workflow : run.kind === 'fork' ? GitFork : Activity,
    keywords: `${run.target} ${run.output ?? ''}`,
    run: () => navigate('runs', run.id),
  };
}

/** Everything in the studio a few keystrokes away: pages, agents, workflows, runs and actions. */
export function CommandPalette({
  onClose,
  onShortcuts,
}: {
  onClose: () => void;
  onShortcuts: () => void;
}) {
  const host = useStudio((state) => state.host);
  const runs = useStudio((state) => state.runs);
  const [query, setQuery] = useState('');
  const [active, setActive] = useState(0);
  const [found, setFound] = useState<RunRecord[]>([]);
  const list = useRef<HTMLDivElement>(null);
  const normalized = query.trim().toLowerCase();

  useEffect(() => {
    if (normalized.length < 2) {
      setFound([]);
      return;
    }
    let current = true;
    const timer = setTimeout(() => {
      api
        .runs({ q: normalized })
        .then((response) => current && setFound(response.runs.slice(0, 8)))
        .catch(() => current && setFound([]));
    }, 120);
    return () => {
      current = false;
      clearTimeout(timer);
    };
  }, [normalized]);

  const commands = useMemo(() => {
    const registry = host.state === 'ready' ? host.registry : undefined;
    const all: Command[] = [
      {
        id: 'overview',
        group: 'Go to',
        label: 'Overview',
        icon: LayoutDashboard,
        hint: <Kbd keys={['G', 'O']} />,
        run: () => navigate(),
      },
      {
        id: 'runs',
        group: 'Go to',
        label: 'Runs',
        icon: Activity,
        keywords: 'history traces',
        hint: <Kbd keys={['G', 'R']} />,
        run: () => navigate('runs'),
      },
      ...(registry?.agents ?? []).map((agent): Command => ({
        id: `agent-${agent.key}`,
        group: 'Agents',
        label: agent.name,
        hint: registry ? agentModel(agent, registry) : agent.model,
        icon: Bot,
        keywords: `chat ${agent.key} ${agent.description ?? ''}`,
        run: () => navigate('agents', agent.key),
      })),
      ...(registry?.workflows ?? []).map((workflow): Command => ({
        id: `workflow-${workflow.key}`,
        group: 'Workflows',
        label: workflow.name,
        hint: `${workflow.nodes.length} nodes`,
        icon: Workflow,
        keywords: `run ${workflow.key}`,
        run: () => navigate('workflows', workflow.key),
      })),
      ...(registry?.agents ?? []).map((agent): Command => ({
        id: `new-${agent.key}`,
        group: 'Actions',
        label: `New thread with ${agent.name}`,
        icon: Plus,
        keywords: 'chat message start',
        run: () => navigate('agents', agent.key),
      })),
      {
        id: 'theme',
        group: 'Actions',
        label: resolvedTheme() === 'dark' ? 'Switch to light theme' : 'Switch to dark theme',
        icon: resolvedTheme() === 'dark' ? Sun : Moon,
        keywords: 'theme appearance dark light mode',
        run: toggleTheme,
      },
      {
        id: 'shortcuts',
        group: 'Actions',
        label: 'Keyboard shortcuts',
        icon: Keyboard,
        hint: <Kbd keys={['?']} />,
        keywords: 'keys help hotkeys',
        run: onShortcuts,
      },
    ];
    const matching = all
      .map((command) => ({ command, score: score(command, normalized) }))
      .filter((entry) => entry.score > 0)
      .sort((a, b) => b.score - a.score)
      .map((entry) => entry.command);
    const recent = normalized
      ? found.map((run) => runCommand(run, 'Runs'))
      : Object.values(runs)
          .filter((run) => !run.parentRunId)
          .sort((a, b) => b.startedAt - a.startedAt)
          .slice(0, 5)
          .map((run) => runCommand(run, 'Recent runs'));
    const order = ['Go to', 'Agents', 'Workflows', 'Recent runs', 'Runs', 'Actions'];
    return [...matching, ...recent].sort((a, b) => order.indexOf(a.group) - order.indexOf(b.group));
  }, [host, runs, found, normalized, onShortcuts]);

  useEffect(() => setActive(0), [normalized]);
  useEffect(() => {
    list.current?.querySelector(`[data-index="${active}"]`)?.scrollIntoView({ block: 'nearest' });
  }, [active]);

  const choose = (command: Command | undefined) => {
    if (!command) return;
    onClose();
    command.run();
  };

  const onKeyDown = (event: KeyboardEvent) => {
    if (event.key === 'ArrowDown' || (event.ctrlKey && event.key === 'n')) {
      event.preventDefault();
      setActive((index) => Math.min(index + 1, commands.length - 1));
    } else if (event.key === 'ArrowUp' || (event.ctrlKey && event.key === 'p')) {
      event.preventDefault();
      setActive((index) => Math.max(index - 1, 0));
    } else if (event.key === 'Enter') {
      event.preventDefault();
      choose(commands[active]);
    } else if (event.key === 'Escape') {
      event.preventDefault();
      onClose();
    }
  };

  let group = '';
  return (
    <div className="overlay" onMouseDown={onClose} data-dialog>
      <div
        className="palette"
        role="dialog"
        aria-modal="true"
        aria-label="Command palette"
        onMouseDown={(event) => event.stopPropagation()}
        onKeyDown={onKeyDown}
        data-testid="command-palette"
      >
        <div className="palette-input">
          <Search size={17} />
          <input
            autoFocus
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Search agents, workflows, runs and actions"
            role="combobox"
            aria-expanded="true"
            aria-controls="palette-list"
            aria-activedescendant={commands[active] ? `palette-${commands[active].id}` : undefined}
            data-testid="palette-input"
          />
          <Kbd keys={['Esc']} />
        </div>
        <div className="palette-list" id="palette-list" role="listbox" ref={list}>
          {commands.length === 0 && <div className="palette-empty">Nothing matches.</div>}
          {commands.map((command, index) => {
            const heading = command.group !== group ? command.group : undefined;
            group = command.group;
            const Icon = command.icon;
            return (
              <div key={command.id}>
                {heading && <div className="palette-group">{heading}</div>}
                <div
                  id={`palette-${command.id}`}
                  className="palette-item"
                  role="option"
                  aria-selected={index === active}
                  data-index={index}
                  onMouseMove={() => index !== active && setActive(index)}
                  onClick={() => choose(command)}
                >
                  <Icon size={15} />
                  <span className="palette-label">{command.label}</span>
                  {command.hint && <span className="palette-hint">{command.hint}</span>}
                </div>
              </div>
            );
          })}
        </div>
        <div className="palette-foot">
          <span>
            <Kbd keys={['↑', '↓']} /> navigate
          </span>
          <span>
            <kbd className="kbd">
              <CornerDownLeft size={10} />
            </kbd>{' '}
            open
          </span>
          <span>
            <Kbd keys={['Esc']} /> close
          </span>
        </div>
      </div>
    </div>
  );
}
