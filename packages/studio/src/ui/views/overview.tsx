import {
  Activity,
  ArrowRight,
  Bot,
  Clock,
  Coins,
  Gauge,
  MessageSquare,
  Wrench,
  Workflow,
} from 'lucide-react';
import type { StudioStats, TargetStats } from '../../protocol';
import { Empty, Topbar } from '../components/common';
import { RunTable } from '../components/run-table';
import { agentModel, formatCost, formatCount, formatDay, formatDuration, timeAgo } from '../format';
import { href } from '../router';
import { useStudio } from '../store';

function Stat({
  icon: Icon,
  label,
  value,
  foot,
}: {
  icon: typeof Activity;
  label: string;
  value: string;
  foot: string;
}) {
  return (
    <div className="stat">
      <div className="stat-label">
        <Icon size={13} />
        {label}
      </div>
      <div className="stat-value">{value}</div>
      <div className="stat-foot">{foot}</div>
    </div>
  );
}

function Stats({ stats }: { stats: StudioStats }) {
  const finished = stats.byStatus.completed + stats.byStatus.failed;
  const rate = finished > 0 ? (stats.byStatus.completed / finished) * 100 : undefined;
  const today = stats.activity.at(-1)?.runs ?? 0;
  return (
    <div className="stats" data-testid="stats">
      <Stat
        icon={Activity}
        label="Runs"
        value={formatCount(stats.runs)}
        foot={`${formatCount(today)} today`}
      />
      <Stat
        icon={Gauge}
        label="Success rate"
        value={
          rate === undefined
            ? '-'
            : `${rate >= 99.95 || rate < 0.05 ? rate.toFixed(0) : rate.toFixed(1)}%`
        }
        foot={`${formatCount(stats.byStatus.failed)} failed`}
      />
      <Stat
        icon={Coins}
        label="Spend"
        value={formatCost(stats.cost, stats.priced)}
        foot={`${formatCount(stats.inputTokens + stats.outputTokens)} tokens`}
      />
      <Stat
        icon={Clock}
        label="Latency p50"
        value={stats.duration ? formatDuration(stats.duration.p50) : '-'}
        foot={stats.duration ? `p95 ${formatDuration(stats.duration.p95)}` : 'no finished runs'}
      />
    </div>
  );
}

function ActivityChart({ stats }: { stats: StudioStats }) {
  const peak = Math.max(1, ...stats.activity.map((day) => day.runs));
  const first = stats.activity[0];
  const last = stats.activity.at(-1);
  return (
    <div className="panel">
      <div className="panel-head">
        <div className="panel-title">Activity</div>
        <span className="muted">last {stats.activity.length} days</span>
      </div>
      <div className="panel-body">
        <div className="chart" role="img" aria-label="Runs per day">
          {stats.activity.map((day) => (
            <div
              key={day.day}
              className="chart-col"
              data-tip={`${formatDay(day.day)}: ${day.runs} run${day.runs === 1 ? '' : 's'}${day.failed ? `, ${day.failed} failed` : ''}`}
            >
              <div className="chart-bar" style={{ height: `${(day.runs / peak) * 100}%` }}>
                {day.failed > 0 && (
                  <div
                    className="chart-bar-failed"
                    style={{ height: `${(day.failed / Math.max(day.runs, 1)) * 100}%` }}
                  />
                )}
              </div>
            </div>
          ))}
        </div>
        <div className="chart-axis">
          <span>{first ? formatDay(first.day) : ''}</span>
          <span>{last ? 'Today' : ''}</span>
        </div>
      </div>
    </div>
  );
}

function StatusBreakdown({ stats }: { stats: StudioStats }) {
  const rows: Array<{ key: keyof StudioStats['byStatus']; label: string }> = [
    { key: 'completed', label: 'Completed' },
    { key: 'failed', label: 'Failed' },
    { key: 'stopped', label: 'Stopped' },
    { key: 'running', label: 'Running' },
    { key: 'waiting', label: 'Needs approval' },
  ];
  return (
    <div className="panel">
      <div className="panel-head">
        <div className="panel-title">Outcomes</div>
      </div>
      <div className="panel-body breakdown">
        {rows.map(({ key, label }) => {
          const count = stats.byStatus[key];
          const share = stats.runs > 0 ? (count / stats.runs) * 100 : 0;
          return (
            <div key={key} className="breakdown-row">
              <div className="breakdown-label">
                <span className="subtle">{label}</span>
                <span className="num">{formatCount(count)}</span>
              </div>
              <div className="meter">
                <span data-status={key} style={{ width: `${share}%` }} />
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

function plural(count: number, noun: string): string {
  return `${formatCount(count)} ${noun}${count === 1 ? '' : 's'}`;
}

function usageOf(stats: StudioStats | undefined, kind: TargetStats['kind'], key: string) {
  return stats?.targets.find((target) => target.kind === kind && target.target === key);
}

/** The project at a glance: what it has, what ran, what it cost and how it went. */
export function OverviewView() {
  const host = useStudio((state) => state.host);
  const project = useStudio((state) => state.project);
  const stats = useStudio((state) => state.stats);
  const runs = useStudio((state) => state.runs);
  const recent = Object.values(runs)
    .filter((run) => !run.parentRunId)
    .sort((a, b) => b.startedAt - a.startedAt)
    .slice(0, 6);

  if (host.state !== 'ready')
    return (
      <>
        <Topbar crumbs={[{ label: 'Overview' }]} />
        <div className="scroll">
          <Empty icon={Bot} title="Waiting for the project">
            The studio shows the project once its registry loads.
          </Empty>
        </div>
      </>
    );

  const { registry, memory } = host;
  return (
    <>
      <Topbar crumbs={[{ label: 'Overview' }]} />
      <div className="scroll">
        <div className="page" data-testid="overview">
          <div className="page-head">
            <div>
              <h1 className="page-title">{project}</h1>
              <div className="page-sub">
                {registry.agents.length} agent{registry.agents.length === 1 ? '' : 's'}
                {registry.workflows.length > 0 &&
                  `, ${registry.workflows.length} workflow${registry.workflows.length === 1 ? '' : 's'}`}
                {registry.swarms.length > 0 &&
                  `, ${registry.swarms.length} swarm${registry.swarms.length === 1 ? '' : 's'}`}
                {memory === 'studio' ? ', threads kept by the studio' : ', memory of the project'}
              </div>
            </div>
            {registry.agents[0] && (
              <a className="btn btn-primary" href={href('agents', registry.agents[0].key)}>
                <MessageSquare size={14} />
                Chat with {registry.agents[0].name}
              </a>
            )}
          </div>

          {stats ? (
            <>
              <Stats stats={stats} />
              <div className="activity">
                <ActivityChart stats={stats} />
                <StatusBreakdown stats={stats} />
              </div>
            </>
          ) : (
            <div className="skeleton" style={{ height: 96, borderRadius: 12 }} />
          )}

          <h2 className="section-title">Agents</h2>
          {registry.agents.length === 0 ? (
            <div className="panel">
              <Empty icon={Bot} title="No agents yet">
                Export them as <code>agents</code> from <code>src/cogitator.ts</code>.
              </Empty>
            </div>
          ) : (
            <div className="entities">
              {registry.agents.map((agent) => {
                const usage = usageOf(stats, 'agent', agent.key);
                return (
                  <a key={agent.key} className="entity" href={href('agents', agent.key)}>
                    <div className="entity-head">
                      <span className="entity-icon">
                        <Bot size={15} />
                      </span>
                      <div style={{ minWidth: 0 }}>
                        <div className="entity-name truncate">{agent.name}</div>
                        <div className="muted mono truncate">{agentModel(agent, registry)}</div>
                      </div>
                    </div>
                    <div className="entity-desc">
                      {agent.description ?? agent.instructions ?? 'An agent of this project.'}
                    </div>
                    <div className="entity-foot">
                      <span>
                        <Wrench size={12} />
                        {agent.tools.length} tool{agent.tools.length === 1 ? '' : 's'}
                      </span>
                      <span>
                        <Activity size={12} />
                        {plural(usage?.runs ?? 0, 'run')}
                      </span>
                      {usage && <span>{timeAgo(usage.lastRunAt)}</span>}
                    </div>
                  </a>
                );
              })}
            </div>
          )}

          {registry.workflows.length > 0 && (
            <>
              <h2 className="section-title">Workflows</h2>
              <div className="entities">
                {registry.workflows.map((workflow) => {
                  const usage = usageOf(stats, 'workflow', workflow.key);
                  return (
                    <a key={workflow.key} className="entity" href={href('workflows', workflow.key)}>
                      <div className="entity-head">
                        <span className="entity-icon">
                          <Workflow size={15} />
                        </span>
                        <div style={{ minWidth: 0 }}>
                          <div className="entity-name truncate">{workflow.name}</div>
                          <div className="muted mono truncate">{workflow.nodes.join(' → ')}</div>
                        </div>
                      </div>
                      <div className="entity-foot">
                        <span>{workflow.nodes.length} nodes</span>
                        <span>
                          <Activity size={12} />
                          {plural(usage?.runs ?? 0, 'run')}
                        </span>
                        {usage && <span>{timeAgo(usage.lastRunAt)}</span>}
                      </div>
                    </a>
                  );
                })}
              </div>
            </>
          )}

          <h2 className="section-title">
            Recent runs
            {recent.length > 0 && (
              <a className="link" href={href('runs')}>
                All runs <ArrowRight size={12} style={{ verticalAlign: -2 }} />
              </a>
            )}
          </h2>
          {recent.length === 0 ? (
            <div className="panel">
              <Empty icon={Activity} title="No runs yet">
                Chat with an agent or run a workflow, every run shows up here with its trace and
                cost.
              </Empty>
            </div>
          ) : (
            <RunTable runs={recent} />
          )}
        </div>
      </div>
    </>
  );
}
