import type { SwarmEventRecord, TeamMemberRecord, TeamRecord, TeamTaskRecord } from './protocol.js';

/** Most messages a team record keeps, the newest ones. */
export const TEAM_MESSAGES_KEPT = 500;
/** Longest text of a task result, a note or a message a team record keeps. */
const TEXT_KEPT = 4000;

type UnknownRecord = Record<string, unknown>;

function isRecord(value: unknown): value is UnknownRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function str(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

function strings(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === 'string')
    : [];
}

function clip(text: string): string {
  return text.length > TEXT_KEPT ? `${text.slice(0, TEXT_KEPT)}…` : text;
}

const TASK_STATUSES = new Set<TeamTaskRecord['status']>(['pending', 'in_progress', 'completed']);
const MEMBER_STATUSES = new Set<TeamMemberRecord['status']>([
  'idle',
  'working',
  'stopped',
  'failed',
]);

function taskOf(value: unknown): TeamTaskRecord | undefined {
  if (!isRecord(value)) return undefined;
  const id = str(value.id);
  const title = str(value.title);
  const status = str(value.status);
  if (
    !id ||
    title === undefined ||
    !status ||
    !TASK_STATUSES.has(status as TeamTaskRecord['status'])
  )
    return undefined;
  const description = str(value.description);
  const owner = str(value.owner);
  const result = str(value.result);
  const note = str(value.note);
  return {
    id,
    title,
    ...(description !== undefined && { description: clip(description) }),
    status: status as TeamTaskRecord['status'],
    ...(owner !== undefined && { owner }),
    dependsOn: strings(value.dependsOn),
    createdBy: str(value.createdBy) ?? 'system',
    ...(result !== undefined && { result: clip(result) }),
    ...(note !== undefined && { note: clip(note) }),
  };
}

function member(team: TeamRecord, name: string): TeamMemberRecord {
  let found = team.members.find((candidate) => candidate.name === name);
  if (!found) {
    found = { name, role: name === team.lead ? 'lead' : 'member', status: 'idle', turns: 0 };
    team.members.push(found);
  }
  return found;
}

function putTask(team: TeamRecord, task: TeamTaskRecord): void {
  const index = team.tasks.findIndex((candidate) => candidate.id === task.id);
  if (index === -1) team.tasks.push(task);
  else team.tasks[index] = task;
}

/** A team as it stands before its first event: its agents idle, no tasks, no messages. */
export function emptyTeam(lead: string, members: readonly string[]): TeamRecord {
  return {
    lead,
    members: [
      { name: lead, role: 'lead', status: 'idle', turns: 0 },
      ...members.map((name): TeamMemberRecord => ({
        name,
        role: 'member',
        status: 'idle',
        turns: 0,
      })),
    ],
    tasks: [],
    messages: [],
    assignments: [],
  };
}

/**
 * The team record after an event of its swarm run: `team:start` begins it, the task and member
 * events change it. Events of other strategies and events that do not parse leave it as it is.
 * The record is changed in place and returned.
 */
export function applyTeamEvent(
  team: TeamRecord | undefined,
  event: SwarmEventRecord
): TeamRecord | undefined {
  const data = isRecord(event.data) ? event.data : {};
  if (event.type === 'team:start') {
    const lead = str(data.lead);
    return lead ? emptyTeam(lead, strings(data.members)) : team;
  }
  if (!team) return undefined;

  switch (event.type) {
    case 'team:task-created':
    case 'team:task-claimed':
    case 'team:task-updated':
    case 'team:task-completed': {
      const task = taskOf(data.task);
      if (task) putTask(team, task);
      break;
    }
    case 'team:task-assigned': {
      const task = taskOf(data.task);
      const to = str(data.assignee);
      if (task) putTask(team, task);
      if (task && to) {
        team.assignments.push({ taskId: task.id, by: str(data.by) ?? team.lead, to, at: event.at });
      }
      break;
    }
    case 'team:message-sent': {
      const id = str(data.id);
      const from = str(data.from);
      if (!id || !from) break;
      team.messages.push({
        id,
        from,
        to: strings(data.to),
        broadcast: data.broadcast === true,
        content: clip(str(data.content) ?? ''),
        at: event.at,
      });
      if (team.messages.length > TEAM_MESSAGES_KEPT) {
        team.messages.splice(0, team.messages.length - TEAM_MESSAGES_KEPT);
      }
      break;
    }
    case 'team:member-started': {
      const name = str(data.member);
      if (!name) break;
      const agent = member(team, name);
      agent.status = 'working';
      if (typeof data.turn === 'number') agent.turns = data.turn;
      const reason = str(data.reason);
      if (reason) agent.reason = reason;
      const taskId = str(data.taskId);
      if (taskId) agent.currentTask = taskId;
      else delete agent.currentTask;
      break;
    }
    case 'team:member-finished': {
      const name = str(data.member);
      if (!name) break;
      const agent = member(team, name);
      const status = str(data.status);
      agent.status =
        status && MEMBER_STATUSES.has(status as TeamMemberRecord['status'])
          ? (status as TeamMemberRecord['status'])
          : 'idle';
      const error = str(data.error);
      if (error) agent.error = clip(error);
      const working = team.tasks.find(
        (task) => task.owner === name && task.status === 'in_progress'
      );
      if (working) agent.currentTask = working.id;
      else delete agent.currentTask;
      break;
    }
    case 'team:complete': {
      const reason = str(data.stopReason);
      if (reason) team.stopReason = reason;
      for (const agent of team.members) if (agent.status === 'working') agent.status = 'idle';
      break;
    }
  }
  return team;
}

/** Messages and assignments between two agents of a team, for the edges of its graph. */
export interface TeamEdge {
  from: string;
  to: string;
  messages: number;
  assignments: number;
}

/** Every pair of agents that exchanged messages or tasks, with how many, in first-seen order. */
export function teamEdges(team: TeamRecord): TeamEdge[] {
  const edges = new Map<string, TeamEdge>();
  const edge = (from: string, to: string) => {
    const key = `${from}\u0000${to}`;
    let found = edges.get(key);
    if (!found) {
      found = { from, to, messages: 0, assignments: 0 };
      edges.set(key, found);
    }
    return found;
  };
  for (const assignment of team.assignments) {
    const by = assignment.by === 'system' ? team.lead : assignment.by;
    if (by !== assignment.to) edge(by, assignment.to).assignments++;
  }
  for (const message of team.messages) {
    for (const to of message.to) if (to !== message.from) edge(message.from, to).messages++;
  }
  return [...edges.values()];
}
