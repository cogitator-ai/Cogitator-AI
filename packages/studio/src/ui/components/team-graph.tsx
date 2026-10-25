import { useState } from 'react';
import { ListTodo, Mail, Users } from 'lucide-react';
import type { TeamMemberRecord, TeamRecord, TeamTaskRecord } from '../../protocol';
import { teamEdges, type TeamEdge } from '../../team';
import { timeAgo } from '../format';

const NODE_W = 168;
const NODE_H = 58;
const GAP_X = 56;
const LEAD_GAP_Y = 120;
const MESSAGES_SHOWN = 50;

const NODE_CLASS: Record<TeamMemberRecord['status'], string> = {
  idle: 'node-idle',
  working: 'node-running',
  stopped: 'node-skipped',
  failed: 'node-failed',
};

const STOP_TEXT: Record<string, string> = {
  completed: 'every task completed',
  'no-tasks': 'the lead answered without tasks',
  stalled: 'nobody could go on with the tasks left',
  'turn-limit': 'the agents used up their turns',
};

function truncate(text: string, length: number): string {
  return text.length > length ? `${text.slice(0, length - 1)}…` : text;
}

function plural(count: number, word: string): string {
  return `${count} ${word}${count === 1 ? '' : 's'}`;
}

/** The lead centred on top, the members in a row below it. */
function layout(team: TeamRecord): Map<string, { x: number; y: number }> {
  const members = team.members.filter((agent) => agent.role === 'member');
  const rowWidth = Math.max(members.length * NODE_W + (members.length - 1) * GAP_X, NODE_W);
  const positions = new Map<string, { x: number; y: number }>();
  positions.set(team.lead, { x: (rowWidth - NODE_W) / 2, y: 0 });
  members.forEach((agent, index) =>
    positions.set(agent.name, { x: index * (NODE_W + GAP_X), y: LEAD_GAP_Y })
  );
  return positions;
}

function edgeLabel(edge: TeamEdge): string {
  return [
    edge.assignments > 0 && plural(edge.assignments, 'task'),
    edge.messages > 0 && plural(edge.messages, 'msg'),
  ]
    .filter(Boolean)
    .join(' · ');
}

/**
 * The agents of a team as a graph: the lead and its members with their status and task, an
 * arrow for every pair that exchanged tasks or messages, labelled with how many.
 */
export function TeamGraph({ team }: { team: TeamRecord }) {
  const positions = layout(team);
  const edges = teamEdges(team);
  const keys = new Set(edges.map((edge) => `${edge.from}\u0000${edge.to}`));
  const width = Math.max(...[...positions.values()].map((p) => p.x + NODE_W), NODE_W);
  const height = LEAD_GAP_Y + NODE_H + 70;

  return (
    <svg
      className="workflow-graph team-graph"
      viewBox={`-2 -2 ${width + 4} ${height + 4}`}
      width={width + 4}
      height={height + 4}
      role="group"
      aria-label="Team graph"
      data-testid="team-graph"
    >
      <defs>
        <marker
          id="team-arrow"
          viewBox="0 0 10 10"
          refX="9"
          refY="5"
          markerWidth="6"
          markerHeight="6"
          orient="auto-start-reverse"
        >
          <path d="M 0 1 L 9 5 L 0 9 z" className="edge-head" />
        </marker>
      </defs>
      {edges.map((edge) => {
        const a = positions.get(edge.from);
        const b = positions.get(edge.to);
        if (!a || !b) return null;
        const both = a.y === b.y;
        const reverse = keys.has(`${edge.to}\u0000${edge.from}`);
        const shift = reverse ? (edge.from < edge.to ? -10 : 10) : 0;
        let path: string;
        let label: { x: number; y: number };
        if (both) {
          const x1 = a.x + NODE_W / 2 + shift;
          const x2 = b.x + NODE_W / 2 + shift;
          const y = a.y + NODE_H + 2;
          const depth = 34 + Math.abs(x2 - x1) / 8 + (reverse && edge.from > edge.to ? 16 : 0);
          path = `M ${x1} ${y} C ${x1} ${y + depth}, ${x2} ${y + depth}, ${x2} ${y + 4}`;
          label = { x: (x1 + x2) / 2, y: y + depth * 0.75 + 4 };
        } else {
          const down = a.y < b.y;
          const x1 = a.x + NODE_W / 2 + shift;
          const y1 = down ? a.y + NODE_H : a.y;
          const x2 = b.x + NODE_W / 2 + shift;
          const y2 = down ? b.y - 3 : b.y + NODE_H + 3;
          const mid = (y1 + y2) / 2;
          path = `M ${x1} ${y1} C ${x1} ${mid}, ${x2} ${mid}, ${x2} ${y2}`;
          label = { x: (x1 + x2) / 2 + (shift === 0 ? 0 : shift * 3), y: mid };
        }
        const kind = edge.assignments > 0 ? 'edge-assign' : 'edge-message';
        return (
          <g key={`${edge.from}-${edge.to}`} data-testid={`team-edge-${edge.from}-${edge.to}`}>
            <path d={path} className={`edge ${kind}`} markerEnd="url(#team-arrow)" />
            <text className="edge-label" x={label.x} y={label.y} textAnchor="middle">
              {edgeLabel(edge)}
            </text>
          </g>
        );
      })}
      {team.members.map((agent) => {
        const position = positions.get(agent.name);
        if (!position) return null;
        const doing =
          agent.status === 'working'
            ? agent.currentTask
              ? `on ${agent.currentTask}`
              : (agent.reason ?? 'working')
            : agent.status;
        const sub = `${doing} · ${plural(agent.turns, 'turn')}`;
        return (
          <g
            key={agent.name}
            transform={`translate(${position.x}, ${position.y})`}
            className={`node ${NODE_CLASS[agent.status]} node-${agent.role}`}
            data-testid={`team-node-${agent.name}`}
            data-status={agent.status}
            aria-label={`${agent.name}, ${agent.role}, ${sub}`}
          >
            <title>{agent.error ? `${agent.name}: ${agent.error}` : agent.name}</title>
            <rect className="node-card" width={NODE_W} height={NODE_H} rx="10" />
            <circle className="node-dot" cx={18} cy={NODE_H / 2} r={4} />
            <text className="node-name" x={32} y={24}>
              {truncate(agent.name, 16)}
              {agent.role === 'lead' && <tspan className="node-role"> lead</tspan>}
            </text>
            <text className="node-sub" x={32} y={41}>
              {truncate(sub, 22)}
            </text>
          </g>
        );
      })}
    </svg>
  );
}

const COLUMNS: Array<{ status: TeamTaskRecord['status']; label: string }> = [
  { status: 'pending', label: 'Pending' },
  { status: 'in_progress', label: 'In progress' },
  { status: 'completed', label: 'Completed' },
];

function blockers(task: TeamTaskRecord, tasks: readonly TeamTaskRecord[]): string[] {
  if (task.status !== 'pending') return [];
  return task.dependsOn.filter(
    (id) => tasks.find((candidate) => candidate.id === id)?.status !== 'completed'
  );
}

/** The shared task list as three columns, one per status. */
export function TaskBoard({ tasks }: { tasks: readonly TeamTaskRecord[] }) {
  const [open, setOpen] = useState<string>();
  if (tasks.length === 0) return <div className="panel-body muted">No tasks yet</div>;
  return (
    <div className="team-board" data-testid="team-board">
      {COLUMNS.map((column) => {
        const items = tasks.filter((task) => task.status === column.status);
        return (
          <div key={column.status} className="team-column" data-status={column.status}>
            <div className="team-column-head">
              {column.label} <span className="count">{items.length}</span>
            </div>
            {items.map((task) => {
              const waits = blockers(task, tasks);
              const expanded = open === task.id;
              const detail = task.result ?? task.note;
              return (
                <button
                  type="button"
                  key={task.id}
                  className={`team-task ${expanded ? 'team-task-open' : ''}`}
                  data-testid={`team-task-${task.id}`}
                  data-status={task.status}
                  aria-expanded={expanded}
                  onClick={() => setOpen(expanded ? undefined : task.id)}
                >
                  <span className="team-task-head">
                    <code>{task.id}</code>
                    <span className="team-owner">{task.owner ?? 'unassigned'}</span>
                  </span>
                  <span className="team-task-title">{task.title}</span>
                  {waits.length > 0 && (
                    <span className="team-task-meta">waits for {waits.join(', ')}</span>
                  )}
                  {detail && <span className="team-task-detail">{detail}</span>}
                  {expanded && task.description && (
                    <span className="team-task-detail">{task.description}</span>
                  )}
                </button>
              );
            })}
          </div>
        );
      })}
    </div>
  );
}

/** A team run: its graph, its task list and the messages between its agents. */
export function TeamPanel({ team, live }: { team: TeamRecord; live: boolean }) {
  const done = team.tasks.filter((task) => task.status === 'completed').length;
  const messages = team.messages.slice(-MESSAGES_SHOWN);
  return (
    <>
      <section className="panel" data-testid="team-panel">
        <div className="panel-head">
          <div className="panel-title">
            <Users size={14} />
            Team
          </div>
          <span className="muted">
            {team.stopReason
              ? `Ended: ${STOP_TEXT[team.stopReason] ?? team.stopReason}`
              : live
                ? 'Live'
                : ''}
          </span>
        </div>
        <div className="canvas" style={{ minHeight: 220 }}>
          <TeamGraph team={team} />
        </div>
      </section>
      <section className="panel">
        <div className="panel-head">
          <div className="panel-title">
            <ListTodo size={14} />
            Tasks{' '}
            <span className="count">
              {done}/{team.tasks.length}
            </span>
          </div>
        </div>
        <TaskBoard tasks={team.tasks} />
      </section>
      <section className="panel">
        <div className="panel-head">
          <div className="panel-title">
            <Mail size={14} />
            Messages <span className="count">{team.messages.length}</span>
          </div>
          <span className="muted">From agents of the team, never from the user</span>
        </div>
        {messages.length === 0 ? (
          <div className="panel-body muted">No messages yet</div>
        ) : (
          messages.map((message) => (
            <div key={message.id} className="list-row team-message" data-testid="team-message">
              <span className="mono team-route">
                {message.from} → {message.broadcast ? 'everyone' : message.to.join(', ')}
              </span>
              <span className="grow">{message.content}</span>
              <span className="muted">{timeAgo(message.at)}</span>
            </div>
          ))
        )}
      </section>
    </>
  );
}
