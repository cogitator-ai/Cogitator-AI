import { useEffect, useState } from 'react';
import { Activity, Network, Play, Users } from 'lucide-react';
import type { RunRecord } from '../../protocol';
import { emptyTeam } from '../../team';
import { api } from '../api';
import { Empty, ErrorText, Kbd, messageOf, StatusBadge, Topbar } from '../components/common';
import { TeamGraph } from '../components/team-graph';
import { formatDuration, timeAgo } from '../format';
import { MOD } from '../hotkeys';
import { href, navigate } from '../router';
import { loadRuns, useStudio } from '../store';

/**
 * A swarm of the registry: a form to run it, its runs, and for a team the graph of its latest
 * run, which fills in live while the run goes.
 */
export function SwarmView({ swarmKey }: { swarmKey: string }) {
  const host = useStudio((state) => state.host);
  const runs = useStudio((state) => state.runs);
  const swarm =
    host.state === 'ready'
      ? host.registry.swarms.find((candidate) => candidate.key === swarmKey)
      : undefined;
  const [input, setInput] = useState('');
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    void loadRuns({ target: swarmKey, kind: 'swarm' }).catch(() => undefined);
  }, [swarmKey]);

  const crumbs = [{ label: swarm?.name ?? swarmKey }];
  if (host.state !== 'ready')
    return (
      <>
        <Topbar crumbs={crumbs} />
        <div className="scroll">
          <Empty icon={Network} title="Waiting for the project" />
        </div>
      </>
    );
  if (!swarm)
    return (
      <>
        <Topbar crumbs={crumbs} />
        <div className="scroll">
          <Empty icon={Network} title={`No swarm ${swarmKey}`}>
            It is not in the registry of this project anymore.
          </Empty>
        </div>
      </>
    );

  const history = Object.values(runs)
    .filter((run): run is RunRecord => run.kind === 'swarm' && run.target === swarmKey)
    .sort((a, b) => b.startedAt - a.startedAt);
  const latest = history[0];
  const team =
    latest?.team ??
    (swarm.strategy === 'team' && swarm.lead
      ? emptyTeam(swarm.lead, swarm.members ?? [])
      : undefined);
  const empty = !input.trim();

  const start = async () => {
    if (empty || busy) return;
    setError(undefined);
    setBusy(true);
    try {
      const started = await api.runSwarm(swarmKey, input.trim());
      navigate('runs', started.runId);
    } catch (failure) {
      setError(messageOf(failure));
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <Topbar
        crumbs={crumbs}
        actions={
          <button
            type="button"
            className="btn btn-primary btn-sm"
            disabled={empty || busy}
            onClick={() => void start()}
          >
            <Play size={12} fill="currentColor" />
            Run
          </button>
        }
      />
      <div className="scroll">
        <div className="page">
          <div className="page-head">
            <div>
              <h1 className="page-title">{swarm.name}</h1>
              <div className="page-sub">
                {swarm.strategy} swarm of {swarm.agents.length} agents
              </div>
            </div>
          </div>
          <div className="workflow-layout">
            <section className="panel">
              <div className="panel-head">
                <div className="panel-title">
                  <Users size={14} />
                  {team ? 'Team' : 'Agents'}
                </div>
                {latest && (
                  <a className="link" href={href('runs', latest.id)}>
                    Latest run, {timeAgo(latest.startedAt)}
                  </a>
                )}
              </div>
              {team ? (
                <div className="canvas" style={{ minHeight: 220 }}>
                  <TeamGraph team={team} />
                </div>
              ) : (
                swarm.agents.map((name) => (
                  <div key={name} className="list-row">
                    <span className="mono">{name}</span>
                  </div>
                ))
              )}
            </section>
            <div className="side-stack">
              <section className="panel">
                <div className="panel-head">
                  <div className="panel-title">
                    <Play size={14} />
                    Run it
                  </div>
                  <Kbd keys={[MOD, 'Enter']} />
                </div>
                <div className="panel-body">
                  <label className="field">
                    <span>Input</span>
                    <textarea
                      className="input"
                      rows={6}
                      value={input}
                      placeholder="What the swarm should do"
                      onChange={(event) => setInput(event.target.value)}
                      onKeyDown={(event) => {
                        if ((event.metaKey || event.ctrlKey) && event.key === 'Enter') {
                          event.preventDefault();
                          void start();
                        }
                      }}
                      data-testid="swarm-input"
                    />
                  </label>
                  <button
                    type="button"
                    className="btn btn-primary"
                    style={{ width: '100%' }}
                    disabled={empty || busy}
                    onClick={() => void start()}
                    data-testid="run-swarm"
                  >
                    {busy ? <span className="spinner" /> : <Play size={12} fill="currentColor" />}
                    Run {swarm.name}
                  </button>
                  {error && <ErrorText>{error}</ErrorText>}
                </div>
              </section>
              <section className="panel">
                <div className="panel-head">
                  <div className="panel-title">
                    <Activity size={14} />
                    Runs <span className="count">{history.length}</span>
                  </div>
                </div>
                {history.length === 0 && (
                  <div className="panel-body muted">
                    No runs yet. Run it to watch the agents work.
                  </div>
                )}
                {history.slice(0, 12).map((run) => (
                  <a key={run.id} className="list-row" href={href('runs', run.id)}>
                    <StatusBadge status={run.status} />
                    <span className="grow truncate">{run.input}</span>
                    <span className="muted num">
                      {formatDuration((run.endedAt ?? Date.now()) - run.startedAt)}
                    </span>
                    <span className="muted">{timeAgo(run.startedAt)}</span>
                  </a>
                ))}
                {history.length > 12 && (
                  <a className="list-row link" href={href('runs')}>
                    All {history.length} runs
                  </a>
                )}
              </section>
            </div>
          </div>
        </div>
      </div>
    </>
  );
}
