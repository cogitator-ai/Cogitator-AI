import { useCallback, useEffect, useRef, useState } from 'react';
import { LoaderCircle, RefreshCw, TriangleAlert, WifiOff } from 'lucide-react';
import { CommandPalette } from './components/command-palette';
import { ShortcutsDialog } from './components/shortcuts';
import { Sidebar } from './components/sidebar';
import { dialogOpen, isTyping, useKeydown } from './hotkeys';
import { navigate, useRoute } from './router';
import { connect, useStudio } from './store';
import { AgentView } from './views/agent';
import { CompareView } from './views/compare';
import { OverviewView } from './views/overview';
import { RunView } from './views/run';
import { RunsView } from './views/runs';
import { WorkflowView } from './views/workflow';

function HostBanner() {
  const host = useStudio((state) => state.host);
  const connected = useStudio((state) => state.connected);
  const loaded = useStudio((state) => state.loaded);
  if (!connected && loaded)
    return (
      <div className="banner banner-warn" role="status">
        <WifiOff size={14} />
        <span>Lost the connection to cogitator dev, reconnecting.</span>
      </div>
    );
  if (host.state === 'starting')
    return (
      <div className="banner" role="status">
        <LoaderCircle size={14} style={{ animation: 'spin 1s linear infinite' }} />
        <span>Loading the project</span>
      </div>
    );
  if (host.state === 'restarting')
    return (
      <div className="banner" role="status" data-testid="reloading">
        <RefreshCw size={14} style={{ animation: 'spin 1s linear infinite' }} />
        <span>Reloading: {host.reason}</span>
      </div>
    );
  if (host.state === 'failed')
    return (
      <div className="banner banner-error" role="alert" data-testid="host-error">
        <div className="banner-row">
          <TriangleAlert size={15} />
          The project does not load
        </div>
        <pre>{host.error}</pre>
        <span>Fix the code and save, the studio reloads it.</span>
      </div>
    );
  return null;
}

function Page({ route }: { route: string[] }) {
  const [section, id, extra] = route;
  if (section === 'agents' && id) return <AgentView key={id} agentKey={id} threadId={extra} />;
  if (section === 'runs' && id) return <RunView key={id} runId={id} />;
  if (section === 'runs') return <RunsView />;
  if (section === 'compare' && id && extra)
    return <CompareView key={`${id}-${extra}`} originalId={id} forkId={extra} />;
  if (section === 'workflows' && id) return <WorkflowView key={id} workflowKey={id} />;
  return <OverviewView />;
}

export function App() {
  const route = useRoute();
  const [palette, setPalette] = useState(false);
  const [shortcuts, setShortcuts] = useState(false);
  const pendingG = useRef(0);
  useEffect(() => connect(), []);

  const openShortcuts = useCallback(() => {
    setPalette(false);
    setShortcuts(true);
  }, []);

  useKeydown((event) => {
    if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k') {
      event.preventDefault();
      setShortcuts(false);
      setPalette((open) => !open);
      return;
    }
    if (event.metaKey || event.ctrlKey || event.altKey) return;
    if (isTyping(event) || dialogOpen()) return;
    if (event.key === '?') {
      event.preventDefault();
      openShortcuts();
    } else if (event.key === '/') {
      event.preventDefault();
      const search = document.querySelector<HTMLElement>('[data-search]');
      if (search) search.focus();
      else setPalette(true);
    } else if (event.key === 'g') {
      pendingG.current = Date.now();
    } else if (Date.now() - pendingG.current < 900) {
      pendingG.current = 0;
      if (event.key === 'o') navigate();
      if (event.key === 'r') navigate('runs');
    }
  });

  return (
    <div className="app">
      <Sidebar route={route} onSearch={() => setPalette(true)} onShortcuts={openShortcuts} />
      <main className="main">
        <HostBanner />
        <Page route={route} />
      </main>
      {palette && <CommandPalette onClose={() => setPalette(false)} onShortcuts={openShortcuts} />}
      {shortcuts && <ShortcutsDialog onClose={() => setShortcuts(false)} />}
    </div>
  );
}
