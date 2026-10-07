import { useEffect } from 'react';
import { Empty } from './components/common';
import { href, useRoute } from './router';
import { connect, useStudio } from './store';
import { AgentView } from './views/agent';
import { CompareView } from './views/compare';
import { RunView } from './views/run';
import { RunsView } from './views/runs';
import { WorkflowView } from './views/workflow';

function HostBanner() {
  const host = useStudio((state) => state.host);
  const connected = useStudio((state) => state.connected);
  if (!connected) return <div className="banner banner-warn">Reconnecting to cogitator dev…</div>;
  if (host.state === 'starting') return <div className="banner">Loading the project…</div>;
  if (host.state === 'restarting')
    return (
      <div className="banner" data-testid="reloading">
        Reloading: {host.reason}
      </div>
    );
  if (host.state === 'failed') {
    return (
      <div className="banner banner-error" data-testid="host-error">
        <strong>The project does not load.</strong>
        <pre>{host.error}</pre>
        <span>Fix the code and save, the studio reloads it.</span>
      </div>
    );
  }
  return null;
}

function Sidebar({ route }: { route: string[] }) {
  const host = useStudio((state) => state.host);
  const project = useStudio((state) => state.project);
  const registry = host.state === 'ready' ? host.registry : undefined;
  const is = (...parts: string[]) => parts.every((part, i) => route[i] === part);
  return (
    <nav className="sidebar">
      <a className="brand" href="#/">
        <span className="logo" />
        <span>
          <strong>Cogitator Studio</strong>
          <span className="muted">{project}</span>
        </span>
      </a>
      <div className="nav-group">
        <div className="nav-title">Agents</div>
        {registry?.agents.map((agent) => (
          <a
            key={agent.key}
            href={href('agents', agent.key)}
            className={is('agents', agent.key) ? 'active' : ''}
            data-testid={`agent-${agent.key}`}
          >
            {agent.name}
          </a>
        ))}
        {registry?.agents.length === 0 && <span className="muted">none registered</span>}
      </div>
      {registry && registry.workflows.length > 0 && (
        <div className="nav-group">
          <div className="nav-title">Workflows</div>
          {registry.workflows.map((workflow) => (
            <a
              key={workflow.key}
              href={href('workflows', workflow.key)}
              className={is('workflows', workflow.key) ? 'active' : ''}
            >
              {workflow.name}
            </a>
          ))}
        </div>
      )}
      {registry && registry.swarms.length > 0 && (
        <div className="nav-group">
          <div className="nav-title">Swarms</div>
          {registry.swarms.map((swarm) => (
            <span
              key={swarm.key}
              className="nav-static"
              title={`${swarm.strategy}: ${swarm.agents.join(', ')}`}
            >
              {swarm.name} <span className="muted">{swarm.strategy}</span>
            </span>
          ))}
        </div>
      )}
      <div className="nav-group">
        <a
          href={href('runs')}
          className={route[0] === 'runs' && route.length === 1 ? 'active' : ''}
          data-testid="nav-runs"
        >
          Runs
        </a>
      </div>
    </nav>
  );
}

function Overview() {
  const host = useStudio((state) => state.host);
  if (host.state !== 'ready') return <Empty>Waiting for the project…</Empty>;
  return (
    <div className="overview">
      <h1>Agents</h1>
      <div className="cards">
        {host.registry.agents.map((agent) => (
          <a key={agent.key} className="card" href={href('agents', agent.key)}>
            <strong>{agent.name}</strong>
            <span className="muted">{agent.description ?? agent.instructions.slice(0, 120)}</span>
            <span className="muted">
              {agent.model ?? 'default model'} · {agent.tools.length} tool
              {agent.tools.length === 1 ? '' : 's'}
            </span>
          </a>
        ))}
      </div>
    </div>
  );
}

export function App() {
  const route = useRoute();
  useEffect(() => connect(), []);
  let content;
  if (route[0] === 'agents' && route[1])
    content = <AgentView key={route[1]} agentKey={route[1]} threadId={route[2]} />;
  else if (route[0] === 'runs' && route[1]) content = <RunView key={route[1]} runId={route[1]} />;
  else if (route[0] === 'runs') content = <RunsView />;
  else if (route[0] === 'compare' && route[1] && route[2])
    content = <CompareView originalId={route[1]} forkId={route[2]} />;
  else if (route[0] === 'workflows' && route[1])
    content = <WorkflowView key={route[1]} workflowKey={route[1]} />;
  else content = <Overview />;
  return (
    <div className="app">
      <Sidebar route={route} />
      <main className="main">
        <HostBanner />
        {content}
      </main>
    </div>
  );
}
