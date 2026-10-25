import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { HostEvent, SwarmEventRecord } from '../protocol.js';
import { StudioStore } from '../server/store.js';
import { applyTeamEvent, emptyTeam, teamEdges, TEAM_MESSAGES_KEPT } from '../team.js';

const dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

let clock = 0;
const event = (type: string, data: unknown, agentName?: string): SwarmEventRecord => ({
  type,
  data,
  at: ++clock,
  ...(agentName && { agentName }),
});

const task = (id: string, extra: Record<string, unknown> = {}) => ({
  id,
  title: `Task ${id}`,
  status: 'pending',
  dependsOn: [],
  createdBy: 'lead',
  createdAt: 1,
  updatedAt: 1,
  ...extra,
});

describe('team record', () => {
  it('builds the team, its tasks, assignments and messages from the events of a run', () => {
    let team = applyTeamEvent(
      undefined,
      event('team:start', { lead: 'lead', members: ['alice', 'bob'] })
    );
    const steps: SwarmEventRecord[] = [
      event('team:task-created', { task: task('t1'), by: 'lead' }),
      event('team:task-created', { task: task('t2', { dependsOn: ['t1'] }), by: 'lead' }),
      event('team:task-assigned', {
        task: task('t1', { owner: 'alice' }),
        assignee: 'alice',
        by: 'lead',
      }),
      event('team:member-started', {
        member: 'alice',
        role: 'member',
        turn: 1,
        reason: 'task',
        taskId: 't1',
      }),
      event('team:task-claimed', {
        task: task('t1', { owner: 'alice', status: 'in_progress' }),
        member: 'alice',
      }),
      event('team:message-sent', {
        id: 'm1',
        from: 'alice',
        to: ['bob'],
        broadcast: false,
        content: 'notes in t1',
      }),
      event('team:task-completed', {
        task: task('t1', { owner: 'alice', status: 'completed', result: 'facts' }),
        by: 'alice',
        unblocked: ['t2'],
      }),
      event('team:member-finished', { member: 'alice', role: 'member', turn: 1, status: 'idle' }),
    ];
    for (const step of steps) team = applyTeamEvent(team, step);

    expect(team?.tasks.map((entry) => [entry.id, entry.status, entry.owner])).toEqual([
      ['t1', 'completed', 'alice'],
      ['t2', 'pending', undefined],
    ]);
    expect(team?.tasks[0].result).toBe('facts');
    expect(team?.assignments).toEqual([
      expect.objectContaining({ taskId: 't1', by: 'lead', to: 'alice' }),
    ]);
    expect(team?.members.find((agent) => agent.name === 'alice')).toMatchObject({
      status: 'idle',
      turns: 1,
      reason: 'task',
    });
    expect(team?.members.find((agent) => agent.name === 'alice')?.currentTask).toBeUndefined();
    expect(teamEdges(team!)).toEqual([
      { from: 'lead', to: 'alice', messages: 0, assignments: 1 },
      { from: 'alice', to: 'bob', messages: 1, assignments: 0 },
    ]);

    team = applyTeamEvent(team, event('team:complete', { stopReason: 'completed' }));
    expect(team?.stopReason).toBe('completed');
  });

  it('marks a working agent and the task it works on', () => {
    let team = emptyTeam('lead', ['alice']);
    team = applyTeamEvent(
      team,
      event('team:member-started', { member: 'alice', role: 'member', turn: 2, taskId: 't9' })
    )!;
    expect(team.members[1]).toMatchObject({ status: 'working', turns: 2, currentTask: 't9' });
    team = applyTeamEvent(
      team,
      event('team:member-finished', { member: 'alice', status: 'failed', error: 'offline' })
    )!;
    expect(team.members[1]).toMatchObject({ status: 'failed', error: 'offline' });
  });

  it('ignores events without a team, of other strategies, or that do not parse', () => {
    expect(
      applyTeamEvent(undefined, event('team:task-created', { task: task('t1') }))
    ).toBeUndefined();
    const team = emptyTeam('lead', ['alice']);
    applyTeamEvent(team, event('debate:turn', { agent: 'alice' }));
    applyTeamEvent(team, event('team:task-created', { task: { id: 't1', status: 'weird' } }));
    applyTeamEvent(team, event('team:message-sent', { content: 'no sender' }));
    expect(team).toEqual(emptyTeam('lead', ['alice']));
  });

  it('keeps the newest messages only', () => {
    const team = emptyTeam('lead', ['alice']);
    for (let i = 0; i < TEAM_MESSAGES_KEPT + 5; i++) {
      applyTeamEvent(
        team,
        event('team:message-sent', { id: `m${i}`, from: 'alice', to: ['lead'], content: `${i}` })
      );
    }
    expect(team.messages).toHaveLength(TEAM_MESSAGES_KEPT);
    expect(team.messages[0].id).toBe('m5');
  });
});

describe('store of swarm runs', () => {
  it('starts a team from the registry and applies its events to the run', () => {
    const dir = mkdtempSync(join(tmpdir(), 'cogitator-studio-team-'));
    dirs.push(dir);
    const store = new StudioStore(dir, () => null);
    store.setRegistry({
      agents: [],
      workflows: [],
      swarms: [
        {
          key: 'crew',
          name: 'crew',
          strategy: 'team',
          agents: ['lead', 'alice'],
          lead: 'lead',
          members: ['alice'],
        },
      ],
    });
    const apply = (hostEvent: HostEvent) => store.apply(hostEvent);

    apply({
      type: 'run.started',
      runId: 'sw1',
      kind: 'swarm',
      target: 'crew',
      input: 'go',
      rootRunId: 'sw1',
      startedAt: 1,
    });
    expect(store.getRun('sw1')?.team?.members.map((agent) => agent.name)).toEqual([
      'lead',
      'alice',
    ]);

    const change = apply({
      type: 'swarm.event',
      runId: 'sw1',
      event: event('team:task-created', { task: task('t1'), by: 'lead' }),
    });
    expect(change.runs.map((run) => run.id)).toEqual(['sw1']);
    expect(store.getRun('sw1')?.team?.tasks).toHaveLength(1);
    expect(
      apply({ type: 'swarm.event', runId: 'missing', event: event('team:start', {}) }).runs
    ).toEqual([]);

    apply({
      type: 'swarm.event',
      runId: 'sw1',
      event: event('team:member-started', { member: 'alice', role: 'member', turn: 1 }),
    });
    apply({ type: 'run.failed', runId: 'sw1', error: 'boom', endedAt: 5, stopped: false });
    const reloaded = new StudioStore(dir, () => null).getRun('sw1');
    expect(reloaded?.team?.members.find((agent) => agent.name === 'alice')?.status).toBe('idle');
    expect(reloaded?.team?.tasks[0].id).toBe('t1');
  });
});
